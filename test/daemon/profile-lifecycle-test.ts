import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, type Socket } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { createBrowserClient } from "../../src/client";
import { createCdpBridge } from "../../src/daemon/bridge";
import { createIpcServer } from "../../src/daemon/server";
import { createDaemon } from "../../src/daemon/index";
import { createDaemonTransport } from "../../src/daemon/transport";
import { isDaemonRunning } from "../../src/daemon/spawn";
import { isRecord } from "../../src/util/guards";
import { deserialize, serialize, type WireMessage, type WireResponse } from "../../src/daemon/protocol";
import { readLines } from "../../src/daemon/lines";
import { ok } from "../../src/util/result";
import { waitFor } from "../helpers/wait";

test("production lifecycle: cold daemon is live before Chrome is ready; A-to-B reconnect invalidates all clients", {
  skip: process.platform === "win32" ? "temporary Unix socket fixture" : false,
  timeout: 10_000,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pbh-lifecycle-"));
  const socketPath = join(dir, "d.sock");
  const previousSocket = process.env["PI_BROWSER_SOCKET_PATH"];
  process.env["PI_BROWSER_SOCKET_PATH"] = socketPath;
  const chrome = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => chrome.once("listening", resolve));
  const address = chrome.address();
  assert.ok(address && typeof address !== "string");
  let browser = "A";
  let launches = 0;
  let releaseDiscovery: () => void = () => undefined;
  const discoveryGate = new Promise<void>((resolve) => { releaseDiscovery = resolve; });
  const methods: string[] = [];
  chrome.on("connection", (socket) => {
    socket.on("message", (data) => {
      const text = Array.isArray(data) ? Buffer.concat(data).toString("utf8")
        : data instanceof ArrayBuffer ? Buffer.from(data).toString("utf8") : data.toString("utf8");
      const request: unknown = JSON.parse(text);
      assert.ok(isRecord(request) && typeof request["method"] === "string" && typeof request["id"] === "number");
      const method = request["method"];
      methods.push(method);
      if (method === "Runtime.evaluate") return;
      const result = method === "Target.getTargets"
        ? { targetInfos: [{ targetId: "owned-A", type: "page", title: "A", url: "https://a.test/" }] }
        : method === "Target.attachToTarget"
          ? { sessionId: "session-A" }
          : method === "Browser.getWindowForTarget" ? { windowId: 7 } : {};
      socket.send(JSON.stringify({ id: request["id"], result }));
    });
  });
  const endpoint = () => ({
    wsUrl: `ws://127.0.0.1:${address.port}/devtools/browser/${browser}`,
    userDataDir: `/isolated/browser-${browser}`,
  });
  let activeSocket: WebSocket | undefined;
  const bridge = createCdpBridge({
    createWebSocket: (url) => { activeSocket = new WebSocket(url); return activeSocket; },
    discoverEndpoint: async () => { await discoveryGate; return ok(endpoint()); },
    connectTimeoutMs: 2_000,
  });
  const ipc = createIpcServer({ socketPath, provenance: bridge.provenance, awaitReady: bridge.awaitReady });
  const daemon = createDaemon({ ipcServer: ipc, cdpBridge: bridge, exit: () => undefined, log: () => undefined });
  const transport = createDaemonTransport("lifecycle-client", socketPath);
  const pin = { userDataDir: "/isolated/browser-A", profileDir: "Default", label: "A", savedAt: "" };
  const client = createBrowserClient({
    namespace: "lifecycle", transport, profilePin: pin,
    discoverEndpoint: () => Promise.resolve(ok(endpoint())),
    initialOwnership: {
      namespace: "lifecycle", browserId: "A", profilePin: pin,
      ownedTargetIds: ["owned-A"], harnessWindowTargetId: "owned-A", profileContext: { kind: "default" },
    },
    seedDeps: {
      detectRunningBrowser: () => Promise.resolve({ running: true, exePath: "/fake/chrome", explicitUserDataDir: pin.userDataDir }),
      resolveBrowserExecutable: () => Promise.resolve("/fake/chrome"),
      openProfileWindow: () => {
        launches++;
        return Promise.resolve(ok({ sentinelUrl: "file:///unused.html", cleanup: () => Promise.resolve(), kill: () => undefined }));
      },
    },
  });
  let staleSocket: Socket | undefined;
  try {
    await daemon.start();
    let settled = false;
    const starting = client.start().finally(() => { settled = true; });
    assert.equal(await isDaemonRunning(500), true);
    assert.equal(existsSync(socketPath), true);
    assert.equal(settled, false, "registration must still await Chrome while liveness already succeeds");
    releaseDiscovery();
    const started = await starting;
    assert.equal(started.success, true, started.success ? "" : started.error.message);
    assert.equal(client.owns("owned-A"), true);
    assert.equal(launches, 0);
    const staleReplies: WireMessage[] = [];
    const stale = createConnection(socketPath);
    staleSocket = stale;
    readLines(stale, (line) => { const message = deserialize(line); if (message) staleReplies.push(message); });
    await new Promise<void>((resolve) => { stale.once("connect", resolve); });
    stale.write(serialize({ type: "control", action: "register", clientId: "stale-client" }) + "\n");
    assert.ok(await waitFor(() => staleReplies.some((m) => m.type === "control" && m.action === "registered")));
    const pending = transport.request("Runtime.evaluate", { expression: "pending" }, { timeoutMs: 2_000 });
    assert.ok(await waitFor(() => methods.includes("Runtime.evaluate")));
    browser = "B";
    assert.ok(activeSocket);
    activeSocket.close();
    const reconnectReplies: WireResponse[] = [];
    await bridge.handleRequest({ type: "request", id: 999, method: "Target.createTarget", params: { url: "about:blank" } }, "lifecycle-client", (_id, reply) => { if (reply.type === "response") reconnectReplies.push(reply); });
    assert.ok(await waitFor(() => reconnectReplies.length === 1));
    assert.ok(reconnectReplies[0]?.error, "a request from A must not be replayed on the new B connection");
    stale.write(serialize({ type: "request", id: 1000, method: "Target.createTarget", params: { url: "about:blank" } }) + "\n");
    assert.ok(await waitFor(() => staleReplies.some((m) => m.type === "response" && m.id === 1000)));
    const staleReply = staleReplies.find((m) => m.type === "response" && m.id === 1000);
    assert.ok(staleReply?.type === "response" && staleReply.error);
    assert.equal(methods.includes("Target.createTarget"), false);
    assert.equal((await pending).success, false, "old connection work must fail rather than run in B");
    assert.ok(await waitFor(() => transport.state() === "closed"));
    assert.equal(transport.actualEndpoint?.(), undefined);
    assert.equal(client.current(), null);
    const retry = await client.start({ retrySetup: true });
    assert.equal(retry.success, false);
    assert.match(retry.error.message, /browser-A.*browser-B/);
    assert.deepEqual(client.ownership().list(), []);
    assert.equal(launches, 0, "profile A must not spawn a window through B");
  } finally {
    releaseDiscovery();
    staleSocket?.destroy();
    await client.stop();
    await daemon.stop();
    for (const socket of chrome.clients) socket.terminate();
    await new Promise<void>((resolve) => { chrome.close(() => { resolve(); }); });
    if (previousSocket === undefined) delete process.env["PI_BROWSER_SOCKET_PATH"];
    else process.env["PI_BROWSER_SOCKET_PATH"] = previousSocket;
    rmSync(dir, { recursive: true, force: true });
  }
});
