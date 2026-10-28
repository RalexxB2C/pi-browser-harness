import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createDaemonTransport } from "../../src/daemon/transport";
import { DAEMON_RECONNECT_METHOD, deserialize, serialize, type WireControl, type WireRequest } from "../../src/daemon/protocol";
import { createBrowserClient } from "../../src/client";
import type { ProfilePin } from "../../src/profile/store";
import type { SeedDeps } from "../../src/profile/bind";
import type { ProfileWindowRequest } from "../../src/profile/launch";
import { ok } from "../../src/util/result";

const SKIP = process.platform === "win32" ? "the fake daemon listens on a temp socket file" : false;

type FakeDaemon = {
  readonly socketPath: string;
  readonly connections: Socket[];
  readonly registers: string[];
  readonly dispose: () => Promise<void>;
};

// `onRegister` decides what the daemon answers; the default acks like the real one.
const startFakeDaemon = (
  onRegister: (conn: Socket, clientId: string) => void = (conn, clientId) => {
    const ack: WireControl = { type: "control", action: "registered", clientId };
    conn.write(serialize(ack) + "\n");
  },
  onRequest?: (conn: Socket, msg: WireRequest) => void,
): Promise<FakeDaemon> =>
  new Promise((resolve) => {
    const dir = mkdtempSync(join(tmpdir(), "pbh-transport-"));
    const socketPath = join(dir, "d.sock");
    const connections: Socket[] = [];
    const registers: string[] = [];
    const server: Server = createServer((conn) => {
      connections.push(conn);
      conn.on("error", () => undefined);
      const rl = createInterface({ input: conn, crlfDelay: Infinity });
      rl.on("line", (line) => {
        const msg = deserialize(line);
        if (msg?.type === "control" && msg.action === "register") {
          registers.push(msg.clientId);
          onRegister(conn, msg.clientId);
        } else if (msg?.type === "request" && onRequest) {
          onRequest(conn, msg);
        }
      });
    });
    server.listen(socketPath, () => {
      resolve({
        socketPath,
        connections,
        registers,
        dispose: () =>
          new Promise((done) => {
            for (const c of connections) c.destroy();
            server.close(() => {
              rmSync(dir, { recursive: true, force: true });
              done();
            });
          }),
      });
    });
  });

describe("daemon transport", { skip: SKIP }, () => {
  test("a daemon that accepts but never registers makes connect() time out", async () => {
    const daemon = await startFakeDaemon(() => undefined);
    try {
      const transport = createDaemonTransport("client-a", daemon.socketPath);
      const started = Date.now();
      const r = await transport.connect("", { timeoutMs: 50 });
      assert.equal(r.success, false);
      assert.equal(r.error.kind, "timeout");
      assert.ok(Date.now() - started < 2_000, "connect() did not hang");
      assert.equal(transport.state(), "closed");
    } finally {
      await daemon.dispose();
    }
  });

  test("overlapping connect() calls share one handshake and one socket", async () => {
    const pendingAcks: Array<() => void> = [];
    const daemon = await startFakeDaemon((conn, clientId) => {
      pendingAcks.push(() => {
        const msg: WireControl = { type: "control", action: "registered", clientId };
        conn.write(serialize(msg) + "\n");
      });
    });
    try {
      const transport = createDaemonTransport("client-a", daemon.socketPath);
      const first = transport.connect("");
      const second = transport.connect("");
      await sleep(30);
      assert.equal(daemon.registers.length, 1, "exactly one register was sent");
      assert.equal(pendingAcks.length, 1, "daemon saw one handshake");
      pendingAcks[0]?.();

      const [r1, r2] = await Promise.all([first, second]);
      assert.equal(r1.success, true);
      assert.equal(r2.success, true);
      assert.equal(daemon.connections.length, 1, "only one socket was opened");
      assert.equal(transport.state(), "open");

      // Once registered, a further connect() is a no-op.
      const r3 = await transport.connect("");
      assert.equal(r3.success, true);
      assert.equal(daemon.connections.length, 1);
      await transport.close();
      assert.equal(transport.state(), "closed");
    } finally {
      await daemon.dispose();
    }
  });

  test("a shutdown reply before registration fails connect() and leaves the transport closed", async () => {
    const daemon = await startFakeDaemon((conn) => {
      const msg: WireControl = { type: "control", action: "shutdown", reason: "clientId is already connected" };
      conn.end(serialize(msg) + "\n");
    });
    try {
      const transport = createDaemonTransport("client-a", daemon.socketPath);
      const r = await transport.connect("", { timeoutMs: 500 });
      assert.equal(r.success, false);
      assert.match(r.error.message, /already connected/);
      assert.equal(transport.state(), "closed");
    } finally {
      await daemon.dispose();
    }
  });

  test("a missing socket path fails fast with a clear message", async () => {
    const transport = createDaemonTransport("client-a", join(tmpdir(), "pbh-no-such-daemon.sock"));
    const r = await transport.connect("", { timeoutMs: 500 });
    assert.equal(r.success, false);
    assert.match(r.error.message, /not running/);
    assert.equal(transport.state(), "closed");
  });

  test("close() tears the transport down and notifies close listeners once", async () => {
    const daemon = await startFakeDaemon();
    try {
      const transport = createDaemonTransport("client-a", daemon.socketPath);
      let closes = 0;
      transport.onClose(() => { closes += 1; });
      const r = await transport.connect("");
      assert.equal(r.success, true);
      await transport.close();
      await sleep(20);
      assert.equal(closes, 1);
      assert.equal(transport.state(), "closed");
    } finally {
      await daemon.dispose();
    }
  });

  test("handshake provenance: returns actual connected browser provenance when daemon provides it", async () => {
    const daemon = await startFakeDaemon((conn, clientId) => {
      const ack: WireControl = {
        type: "control",
        action: "registered",
        clientId,
        browserId: "b-daemon-1",
        userDataDir: "/home/u/.config/daemon-chrome",
        cdpUrl: "ws://127.0.0.1:9222/devtools/browser/b-daemon-1",
      };
      conn.write(serialize(ack) + "\n");
    });
    try {
      const transport = createDaemonTransport("client-prov", daemon.socketPath);
      const r = await transport.connect("");
      assert.equal(r.success, true);
      assert.deepEqual(transport.actualEndpoint?.(), {
        browserId: "b-daemon-1",
        userDataDir: "/home/u/.config/daemon-chrome",
        wsUrl: "ws://127.0.0.1:9222/devtools/browser/b-daemon-1",
      });
      await transport.close();
    } finally {
      await daemon.dispose();
    }
  });

  test("legacy handshake provenance: actualEndpoint returns undefined when daemon sends no provenance and client fails closed", async () => {
    // Daemon sends legacy registered ack with NO browserId or userDataDir
    const daemon = await startFakeDaemon((conn, clientId) => {
      const ack: WireControl = {
        type: "control",
        action: "registered",
        clientId,
      };
      conn.write(serialize(ack) + "\n");
    });
    try {
      const transport = createDaemonTransport("client-legacy", daemon.socketPath);
      const r = await transport.connect("");
      assert.equal(r.success, true);
      assert.equal(transport.actualEndpoint?.(), undefined);

      const pin: ProfilePin = {
        userDataDir: "/home/u/.config/google-chrome",
        profileDir: "Profile 1",
        label: "Work",
        savedAt: "",
      };
      const launches: ProfileWindowRequest[] = [];
      const seedDeps: SeedDeps = {
        detectRunningBrowser: () => Promise.resolve({
          running: true,
          exePath: "/usr/bin/google-chrome",
          explicitUserDataDir: pin.userDataDir,
        }),
        resolveBrowserExecutable: () => Promise.resolve("/usr/bin/google-chrome"),
        openProfileWindow: (req) => {
          launches.push(req);
          return Promise.resolve(ok({ sentinelUrl: "file:///tmp/s.html", cleanup: () => Promise.resolve(), kill: () => undefined }));
        },
      };

      const client = createBrowserClient({
        namespace: "test-legacy-daemon",
        transport,
        profilePin: pin,
        seedDeps,
      });

      const startRes = await client.start();
      assert.equal(startRes.success, false);
      assert.equal(startRes.error.kind, "discovery_failed");
      assert.match(startRes.error.message, /no verified user-data-dir endpoint linkage/i);
      assert.equal(launches.length, 0, "legacy daemon with unknown provenance must fail closed before spawn");

      await transport.close();
    } finally {
      await daemon.dispose();
    }
  });

  test("Q2: arbitrary CDP command responses cannot alter or forge transport provenance", async () => {
    const daemon = await startFakeDaemon(
      (conn, clientId) => {
        const ack: WireControl = {
          type: "control",
          action: "registered",
          clientId,
          browserId: "b-daemon-real",
          userDataDir: "/home/u/.config/real-chrome",
          cdpUrl: "ws://127.0.0.1:9222/devtools/browser/b-daemon-real",
        };
        conn.write(serialize(ack) + "\n");
      },
      (conn, req) => {
        // Return a response that maliciously contains provenance fields
        conn.write(serialize({
          type: "response",
          id: req.id,
          result: {
            browserId: "forged-browser",
            userDataDir: "/forged/dir",
            cdpUrl: "ws://forged",
          },
        }) + "\n");
      },
    );

    try {
      const transport = createDaemonTransport("client-forgery", daemon.socketPath);
      await transport.connect("");

      const res = await transport.request("Runtime.evaluate", { expression: "1" });
      assert.equal(res.success, true);

      assert.deepEqual(transport.actualEndpoint?.(), {
        browserId: "b-daemon-real",
        userDataDir: "/home/u/.config/real-chrome",
        wsUrl: "ws://127.0.0.1:9222/devtools/browser/b-daemon-real",
      });

      await transport.close();
    } finally {
      await daemon.dispose();
    }
  });

  test("Q2: control response missing evidence clears existing actualEndpoint", async () => {
    const daemon = await startFakeDaemon(
      (conn, clientId) => {
        const ack: WireControl = {
          type: "control",
          action: "registered",
          clientId,
          browserId: "b-initial",
          userDataDir: "/home/u/.config/initial",
          cdpUrl: "ws://127.0.0.1:9222/initial",
        };
        conn.write(serialize(ack) + "\n");
      },
      (conn, req) => {
        if (req.method === DAEMON_RECONNECT_METHOD) {
          // Reconnect response missing provenance fields
          conn.write(serialize({
            type: "response",
            id: req.id,
            result: { connected: true },
          }) + "\n");
        }
      },
    );

    try {
      const transport = createDaemonTransport("client-clear", daemon.socketPath);
      await transport.connect("");
      assert.ok(transport.actualEndpoint?.());

      const res = await transport.request(DAEMON_RECONNECT_METHOD, {});
      assert.equal(res.success, true);

      assert.equal(transport.actualEndpoint?.(), undefined);

      await transport.close();
    } finally {
      await daemon.dispose();
    }
  });

  test("Q3: cold registration readiness: server awaits Chrome readiness so cold start receives verified provenance", async () => {
    const daemon = await startFakeDaemon((conn, clientId) => {
      // Simulate Chrome dialing/readiness settling with a short delay
      setTimeout(() => {
        const ack: WireControl = {
          type: "control",
          action: "registered",
          clientId,
          browserId: "b-cold-ready",
          userDataDir: "/home/u/.config/cold-chrome",
          cdpUrl: "ws://127.0.0.1:9222/cold",
        };
        conn.write(serialize(ack) + "\n");
      }, 30);
    });

    try {
      const transport = createDaemonTransport("client-cold", daemon.socketPath);
      // Ordinary connect without reconnectNow
      const r = await transport.connect("", { timeoutMs: 2_000 });
      assert.equal(r.success, true);

      assert.deepEqual(transport.actualEndpoint?.(), {
        browserId: "b-cold-ready",
        userDataDir: "/home/u/.config/cold-chrome",
        wsUrl: "ws://127.0.0.1:9222/cold",
      });

      await transport.close();
    } finally {
      await daemon.dispose();
    }
  });

  test("C5-1: production connection+bridge+transport integration test for superseded A->B: pending work fails safely and no old-profile spawn/reuse", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pbh-c51-"));
    const socketPath = join(dir, "d.sock");
    const pinA: ProfilePin = {
      userDataDir: "/home/u/.config/browser-A",
      profileDir: "Profile 1",
      label: "Profile A",
      savedAt: "",
    };

    let daemonCurrentAck: WireControl = {
      type: "control",
      action: "registered",
      clientId: "client-c51",
      browserId: "browser-A",
      userDataDir: pinA.userDataDir,
      cdpUrl: "ws://127.0.0.1:9222/devtools/browser/browser-A",
    };

    const serverConnections: Socket[] = [];
    const server: Server = createServer((conn) => {
      serverConnections.push(conn);
      conn.on("error", () => undefined);
      const rl = createInterface({ input: conn, crlfDelay: Infinity });
      rl.on("line", (line) => {
        const msg = deserialize(line);
        if (msg?.type === "control" && msg.action === "register") {
          const ack = { ...daemonCurrentAck, clientId: msg.clientId };
          conn.write(serialize(ack) + "\n");
        } else if (msg?.type === "request") {
          if (msg.method === "Target.setDiscoverTargets") {
            conn.write(serialize({ type: "response", id: msg.id, result: {} }) + "\n");
          } else if (msg.method === "Target.getTargets") {
            conn.write(serialize({
              type: "response",
              id: msg.id,
              result: { targetInfos: [{ targetId: "window-A", type: "page", title: "A", url: "https://a.test/" }] },
            }) + "\n");
          } else if (msg.method === "Target.attachToTarget") {
            conn.write(serialize({ type: "response", id: msg.id, result: { sessionId: "s-A" } }) + "\n");
          } else if (msg.method === "Browser.getWindowForTarget") {
            conn.write(serialize({ type: "response", id: msg.id, result: { windowId: 7 } }) + "\n");
          } else if (msg.method === "Target.activateTarget") {
            conn.write(serialize({ type: "response", id: msg.id, result: {} }) + "\n");
          } else {
            conn.write(serialize({ type: "response", id: msg.id, result: {} }) + "\n");
          }
        }
      });
    });
    await new Promise<void>((res) => { server.listen(socketPath, () => { res(); }); });

    try {
      const launches: ProfileWindowRequest[] = [];
      const seedDeps: SeedDeps = {
        detectRunningBrowser: () => Promise.resolve({
          running: true,
          exePath: "/usr/bin/google-chrome",
          explicitUserDataDir: pinA.userDataDir,
        }),
        resolveBrowserExecutable: () => Promise.resolve("/usr/bin/google-chrome"),
        openProfileWindow: (req) => {
          launches.push(req);
          return Promise.resolve(ok({ sentinelUrl: "file:///tmp/s.html", cleanup: () => Promise.resolve(), kill: () => undefined }));
        },
      };

      const transport = createDaemonTransport("client-c51", socketPath);
      const client = createBrowserClient({
        namespace: "test-c51",
        transport,
        profilePin: pinA,
        seedDeps,
        discoverEndpoint: () => Promise.resolve(ok({ wsUrl: "ws://127.0.0.1:9222/devtools/browser/browser-A" })),
        initialOwnership: {
          namespace: "test-c51",
          browserId: "browser-A",
          userDataDir: pinA.userDataDir,
          profilePin: pinA,
          ownedTargetIds: ["window-A"],
          harnessWindowTargetId: "window-A",
          profileContext: { kind: "default" },
        },
      });

      const r1 = await client.start();
      assert.equal(r1.success, true);
      assert.equal(client.owns("window-A"), true);
      assert.equal(launches.length, 0);

      daemonCurrentAck = {
        type: "control",
        action: "registered",
        clientId: "client-c51",
        browserId: "browser-B",
        userDataDir: "/home/u/.config/browser-B",
        cdpUrl: "ws://127.0.0.1:9222/devtools/browser/browser-B",
      };

      const shutdownMsg: WireControl = { type: "control", action: "shutdown", reason: "chrome_disconnected" };
      for (const conn of serverConnections) {
        conn.write(serialize(shutdownMsg) + "\n");
      }

      await sleep(20);
      assert.equal(transport.state(), "closed", "transport must close upon shutdown notification");

      const r2 = await client.ensureAlive();
      assert.equal(r2.success, false);
      assert.match(r2.error.message, /belongs to \/home\/u\/\.config\/browser-A, but the harness is connected to \/home\/u\/\.config\/browser-B/);

      assert.equal(client.owns("window-A"), false, "old-profile window must not be owned");
      assert.equal(launches.length, 0, "no spawn allowed on mismatched connected browser");

      await transport.close();
    } finally {
      for (const c of serverConnections) c.destroy();
      await new Promise<void>((done) => { server.close(() => { done(); }); });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
