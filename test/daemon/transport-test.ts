import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createDaemonTransport } from "../../src/daemon/transport";
import { deserialize, serialize, type WireControl } from "../../src/daemon/protocol";
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
});
