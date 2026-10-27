import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { closeSync, openSync, unlinkSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { fakeCtx } from "../helpers/fake-pi";
import { createBrowserClient } from "../../src/client";
import { cdpError, type CdpError } from "../../src/cdp/errors";
import { type CdpEvent, type CdpTransport } from "../../src/cdp/types";
import { defineBrowserTool } from "../../src/util/tool";
import { err, ok, type Result } from "../../src/util/result";
import type { ProfilePin } from "../../src/profile/store";
import type { SeedDeps } from "../../src/profile/bind";
import type { ProfileWindowRequest } from "../../src/profile/launch";

type MockTransportOptions = {
  connectResult?: () => Promise<Result<void, CdpError>>;
  state?: () => "open" | "closed" | "connecting";
  requestResult?: (method: string, params: Record<string, unknown>) => Promise<Result<unknown, CdpError> | undefined>;
  actualEndpoint?: () => { readonly wsUrl?: string; readonly browserId?: string; readonly userDataDir?: string } | undefined;
};

const createMockTransport = (opts: MockTransportOptions = {}): {
  transport: CdpTransport;
  connectCalls: number;
  requestCalls: Array<{ method: string; params: Record<string, unknown> }>;
  setConnectResult: (fn: () => Promise<Result<void, CdpError>>) => void;
  setState: (st: "open" | "closed" | "connecting") => void;
} => {
  let connectCalls = 0;
  const requestCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let connectFn = opts.connectResult ?? (() => Promise.resolve(ok(undefined)));
  let currentState = opts.state ? opts.state() : "closed";

  const transport: CdpTransport = {
    connect: async () => {
      connectCalls++;
      const res = await connectFn();
      if (res.success) currentState = "open";
      return res;
    },
    close: () => {
      currentState = "closed";
      return Promise.resolve();
    },
    request: async (method, params) => {
      requestCalls.push({ method, params });
      if (opts.requestResult) {
        const custom = await opts.requestResult(method, params);
        if (custom !== undefined) return custom;
      }
      if (method === "Target.createTarget") return ok({ targetId: "t1" });
      if (method === "Target.setDiscoverTargets") return ok({});
      if (method === "Target.getTargets") {
        return ok({
          targetInfos: [{ targetId: "t1", type: "page", title: "Test", url: "https://test.local" }],
        });
      }
      if (method === "Target.attachToTarget") return ok({ sessionId: "s1" });
      if (method === "Browser.getWindowForTarget") return ok({ windowId: 1 });
      if (method === "Runtime.evaluate") return ok({ result: { type: "string", value: "test" } });
      return ok({});
    },
    events: (): AsyncIterable<CdpEvent> => ({
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise(() => {
          // No events needed for basic lifecycle
        }),
      }),
    }),
    state: () => currentState,
    onClose: () => () => undefined,
    ...(opts.actualEndpoint ? { actualEndpoint: opts.actualEndpoint } : {}),
  };

  return {
    transport,
    get connectCalls() {
      return connectCalls;
    },
    requestCalls,
    setConnectResult: (fn) => {
      connectFn = fn;
    },
    setState: (st) => {
      currentState = st;
    },
  };
};

describe("BrowserClient initialization failure latching & recovery", () => {
  test("latches initialization failure across sequential ensureAlive and ordinary reads", async () => {
    const mock = createMockTransport({
      connectResult: () => Promise.resolve(err(cdpError("discovery_failed", "No matching Chrome process"))),
    });

    const client = createBrowserClient({
      namespace: "test-latch",
      transport: mock.transport,
      remote: { cdpUrl: "ws://127.0.0.1:9222/test", browserId: "test-b" },
    });

    const initRes = await client.start();
    assert.equal(initRes.success, false);
    assert.equal(initRes.error.kind, "discovery_failed");
    assert.equal(initRes.error.message, "No matching Chrome process");
    assert.equal(mock.connectCalls, 1);

    const aliveRes = await client.ensureAlive();
    assert.equal(aliveRes.success, false);
    assert.equal(aliveRes.error.kind, "discovery_failed");
    assert.equal(aliveRes.error.message, "No matching Chrome process");
    assert.equal(mock.connectCalls, 1, "Must NOT attempt connect again");

    const implicitStart = await client.start();
    assert.equal(implicitStart.success, false);
    assert.equal(implicitStart.error.kind, "discovery_failed");
    assert.equal(mock.connectCalls, 1, "Must NOT attempt connect again on implicit start");

    const pageRes = await client.pageInfo();
    assert.equal(pageRes.success, false);
    assert.equal(pageRes.error.kind, "discovery_failed");

    const tabsRes = await client.listTabs();
    assert.equal(tabsRes.success, false);
    assert.equal(tabsRes.error.kind, "discovery_failed");

    assert.equal(mock.connectCalls, 1, "Total connect calls must remain 1");
  });

  test("concurrent post-failure calls share latched result without extra connects", async () => {
    const mock = createMockTransport({
      connectResult: () => Promise.resolve(err(cdpError("transport_closed", "Connection refused"))),
    });

    const client = createBrowserClient({
      namespace: "test-latch-concurrent",
      transport: mock.transport,
      remote: { cdpUrl: "ws://127.0.0.1:9222/test", browserId: "test-b" },
    });

    await client.start();
    assert.equal(mock.connectCalls, 1);

    const [a, b, c] = await Promise.all([
      client.ensureAlive(),
      client.pageInfo(),
      client.start(),
    ]);

    assert.equal(a.success, false);
    assert.equal(b.success, false);
    assert.equal(c.success, false);
    assert.equal(a.error.kind, "transport_closed");
    assert.equal(b.error.kind, "transport_closed");
    assert.equal(c.error.kind, "transport_closed");
    assert.equal(mock.connectCalls, 1);
  });

  test("concurrent in-flight initialization callers share one attempt", async () => {
    let connectAttempts = 0;
    const mock = createMockTransport({
      connectResult: async () => {
        connectAttempts++;
        await new Promise((r) => setTimeout(r, 20));
        return err(cdpError("timeout", "Discovery timed out"));
      },
    });

    const client = createBrowserClient({
      namespace: "test-latch-inflight",
      transport: mock.transport,
      remote: { cdpUrl: "ws://127.0.0.1:9222/test", browserId: "test-b" },
    });

    const [r1, r2, r3] = await Promise.all([
      client.ensureAlive(),
      client.ensureAlive(),
      client.start(),
    ]);

    assert.equal(connectAttempts, 1, "Concurrent in-flight calls must coalesce into 1 attempt");
    assert.equal(r1.success, false);
    assert.equal(r2.success, false);
    assert.equal(r3.success, false);
    assert.equal(r1.error.kind, "timeout");
    assert.equal(r2.error.kind, "timeout");
    assert.equal(r3.error.kind, "timeout");

    const followUp = await client.ensureAlive();
    assert.equal(followUp.success, false);
    assert.equal(connectAttempts, 1);
  });

  test("explicit setup retry permits new attempt; failed retry keeps failure latched", async () => {
    let attempts = 0;
    const mock = createMockTransport({
      connectResult: () => {
        attempts++;
        return Promise.resolve(err(cdpError("discovery_failed", `Attempt ${attempts} failed`)));
      },
    });

    const client = createBrowserClient({
      namespace: "test-explicit-fail",
      transport: mock.transport,
      remote: { cdpUrl: "ws://127.0.0.1:9222/test", browserId: "test-b" },
    });

    const init = await client.start();
    assert.equal(init.success, false);
    assert.equal(init.error.message, "Attempt 1 failed");
    assert.equal(attempts, 1);

    const check1 = await client.ensureAlive();
    assert.equal(check1.success, false);
    assert.equal(check1.error.message, "Attempt 1 failed");
    assert.equal(attempts, 1);

    const retry = await client.start({ reconnectNow: true });
    assert.equal(retry.success, false);
    assert.equal(retry.error.message, "Attempt 2 failed");
    assert.equal(attempts, 2);

    const check2 = await client.ensureAlive();
    assert.equal(check2.success, false);
    assert.equal(check2.error.message, "Attempt 2 failed");
    assert.equal(attempts, 2);
  });

  test("explicit setup retry permits new attempt; successful retry restores normal operation", async () => {
    let shouldSucceed = false;
    let attempts = 0;
    const mock = createMockTransport({
      connectResult: () => {
        attempts++;
        if (!shouldSucceed) {
          return Promise.resolve(err(cdpError("discovery_failed", "Chrome not ready")));
        }
        return Promise.resolve(ok(undefined));
      },
    });

    const client = createBrowserClient({
      namespace: "test-explicit-success",
      transport: mock.transport,
      remote: { cdpUrl: "ws://127.0.0.1:9222/test", browserId: "test-b" },
    });

    const init = await client.start();
    assert.equal(init.success, false);
    assert.equal(attempts, 1);

    assert.equal((await client.ensureAlive()).success, false);
    assert.equal(attempts, 1);

    shouldSucceed = true;
    const recovery = await client.start({ reconnectNow: true });
    assert.equal(recovery.success, true);
    assert.equal(attempts, 2);

    const alive = await client.ensureAlive();
    assert.equal(alive.success, true);
    assert.equal(client.status().alive, true);
    assert.equal(attempts, 2);
  });

  test("pinned client: explicit setup retry restores normal operation with profilePin and launch spy", async () => {
    let launchSucceeds = false;
    const launches: ProfileWindowRequest[] = [];
    const pin: ProfilePin = {
      userDataDir: "/home/u/.config/google-chrome",
      profileDir: "Profile 1",
      label: "Work",
      savedAt: "",
    };
    const sentinelUrl = "file:///tmp/pi-sentinel.html";

    const mock = createMockTransport({
      actualEndpoint: () => ({
        wsUrl: "ws://127.0.0.1:9222/devtools/browser/abc",
        browserId: "abc",
        userDataDir: pin.userDataDir,
      }),
      requestResult: (method) => {
        if (method === "Target.getTargets") {
          return Promise.resolve(ok({
            targetInfos: launchSucceeds
              ? [
                  { targetId: "seed-tab", type: "page", title: "", url: sentinelUrl, browserContextId: "ctx-1" },
                ]
              : [],
          }));
        }
        if (method === "Target.attachToTarget") {
          return Promise.resolve(ok({ sessionId: "s-seed" }));
        }
        if (method === "Browser.getWindowForTarget") {
          return Promise.resolve(ok({ windowId: 10 }));
        }
        return Promise.resolve(undefined);
      },
    });

    const seedDeps: SeedDeps = {
      detectRunningBrowser: () => Promise.resolve({
        running: true,
        exePath: "/usr/bin/google-chrome",
        explicitUserDataDir: pin.userDataDir,
      }),
      resolveBrowserExecutable: () => Promise.resolve("/usr/bin/google-chrome"),
      openProfileWindow: (req) => {
        launches.push(req);
        if (!launchSucceeds) {
          return Promise.resolve(err("failed to launch service window"));
        }
        return Promise.resolve(ok({
          sentinelUrl,
          cleanup: () => Promise.resolve(),
          kill: () => undefined,
        }));
      },
      deadlineMs: 2_000,
      pollMs: 10,
    };

    const client = createBrowserClient({
      namespace: "test-pinned-recovery",
      transport: mock.transport,
      remote: { cdpUrl: "ws://127.0.0.1:9222/devtools/browser/abc", browserId: "abc", userDataDir: pin.userDataDir },
      profilePin: pin,
      seedDeps,
    });

    const initRes = await client.start();
    assert.equal(initRes.success, false);
    assert.match(initRes.error.message, /failed to launch/i);
    assert.equal(launches.length, 1);

    const check1 = await client.ensureAlive();
    assert.equal(check1.success, false);
    assert.match(check1.error.message, /failed to launch/i);
    assert.equal(launches.length, 1, "Ordinary ensureAlive must NOT launch new window");

    const pageRes = await client.pageInfo();
    assert.equal(pageRes.success, false);
    assert.equal(launches.length, 1, "Ordinary pageInfo must NOT launch new window");

    launchSucceeds = true;

    const retryRes = await client.start({ retrySetup: true });
    assert.equal(retryRes.success, true, retryRes.success ? "" : retryRes.error.message);
    assert.equal(launches.length, 2, "Explicit retry must permit second launch attempt");

    const alive = await client.ensureAlive();
    assert.equal(alive.success, true);
    assert.equal(client.status().alive, true);
    assert.equal(launches.length, 2, "Subsequent calls must not launch extra windows");
  });

  test("automatic reconnect failure latches the error", async () => {
    let reconnectFails = false;
    let connectCalls = 0;
    const mock = createMockTransport({
      connectResult: () => {
        connectCalls++;
        if (reconnectFails) {
          return Promise.resolve(err(cdpError("transport_closed", "Browser crashed")));
        }
        return Promise.resolve(ok(undefined));
      },
    });

    const client = createBrowserClient({
      namespace: "test-reconnect-fail",
      transport: mock.transport,
      remote: { cdpUrl: "ws://127.0.0.1:9222/test", browserId: "test-b" },
    });

    const init = await client.start();
    assert.equal(init.success, true);
    assert.equal(connectCalls, 1);

    reconnectFails = true;
    mock.setState("closed");

    const reconnectAttempt = await client.ensureAlive();
    assert.equal(reconnectAttempt.success, false);
    assert.equal(reconnectAttempt.error.message, "Browser crashed");
    assert.equal(connectCalls, 2);

    const followUp = await client.ensureAlive();
    assert.equal(followUp.success, false);
    assert.equal(followUp.error.message, "Browser crashed");
    assert.equal(connectCalls, 2, "Must not repeat reconnect attempt");
  });

  test("healthy reconnect succeeds and does not latch an error", async () => {
    let connectCalls = 0;
    const mock = createMockTransport({
      connectResult: () => {
        connectCalls++;
        return Promise.resolve(ok(undefined));
      },
    });

    const client = createBrowserClient({
      namespace: "test-healthy-reconnect",
      transport: mock.transport,
      remote: { cdpUrl: "ws://127.0.0.1:9222/test", browserId: "test-b" },
    });

    const init = await client.start();
    assert.equal(init.success, true);
    assert.equal(connectCalls, 1);

    mock.setState("closed");

    const recovered = await client.ensureAlive();
    assert.equal(recovered.success, true);
    assert.equal(connectCalls, 2);
    assert.equal(client.status().alive, true);
  });

  test("ordinary page-level errors do not latch initialization failures", async () => {
    let evalShouldFail = false;
    const mock = createMockTransport({
      requestResult: (method) => {
        if (method === "Runtime.evaluate" && evalShouldFail) {
          return Promise.resolve(err(cdpError("remote_error", "ReferenceError: foo is not defined")));
        }
        return Promise.resolve(undefined);
      },
    });

    const client = createBrowserClient({
      namespace: "test-page-errors",
      transport: mock.transport,
      remote: { cdpUrl: "ws://127.0.0.1:9222/test", browserId: "test-b" },
    });

    const init = await client.start();
    assert.equal(init.success, true);

    evalShouldFail = true;
    const evalRes = await client.evaluateJs("foo.bar()");
    assert.equal(evalRes.success, false);
    assert.equal(evalRes.error.kind, "remote_error");

    evalShouldFail = false;
    const alive = await client.ensureAlive();
    assert.equal(alive.success, true);
    assert.equal(client.status().alive, true);
  });
});

describe("tool wrapper presentation under initialization failure", () => {
  let tempDir: string;
  let testSocketPath: string;
  let savedSocketEnv: string | undefined;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pi-latch-test-"));
    testSocketPath = join(tempDir, "daemon.sock");
    savedSocketEnv = process.env["PI_BROWSER_SOCKET_PATH"];
    process.env["PI_BROWSER_SOCKET_PATH"] = testSocketPath;
    closeSync(openSync(testSocketPath, "w"));
    assert.equal(existsSync(testSocketPath), true, "Test socket must exist after preparation");
  });

  after(() => {
    if (savedSocketEnv === undefined) {
      Reflect.deleteProperty(process.env, "PI_BROWSER_SOCKET_PATH");
    } else {
      process.env["PI_BROWSER_SOCKET_PATH"] = savedSocketEnv;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("tool execution retains underlying error category and sanitized cause on failure", async () => {
    const mock = createMockTransport({
      connectResult: () => Promise.resolve(err(cdpError("discovery_failed", "No matching Chrome process"))),
    });

    const client = createBrowserClient({
      namespace: "test-tool-presentation",
      transport: mock.transport,
      remote: { cdpUrl: "ws://127.0.0.1:9222/test", browserId: "test-b" },
    });

    const tool = defineBrowserTool({
      name: "browser_probe_test",
      label: "Probe Test",
      description: "probe",
      promptSnippet: "probe",
      promptGuidelines: [],
      parameters: Type.Object({}),
      concurrency: "parallel",
      ensureAlive: true,
      handler: () => Promise.resolve(ok({ text: "success" })),
    });

    let registeredTool: Pick<ToolDefinition, "execute"> | undefined;
    const sink: Pick<ExtensionAPI, "registerTool"> = {
      registerTool: (td) => {
        registeredTool = td;
      },
    };
    tool.register(sink, client);
    assert.ok(registeredTool, "Tool must be registered");

    const ctx = fakeCtx();

    await assert.rejects(
      async () => {
        await registeredTool?.execute("id-1", {}, undefined, undefined, ctx.ctx);
      },
      (e: unknown) => {
        assert.ok(e instanceof Error);
        assert.match(e.message, /browser_probe_test failed \(not_connected\)/);
        assert.match(e.message, /discovery_failed/);
        assert.match(e.message, /No matching Chrome process/);
        assert.doesNotMatch(e.message, /remote debugging needs to be enabled/i);
        return true;
      },
    );

    assert.equal(mock.connectCalls, 1);

    await assert.rejects(
      async () => {
        await registeredTool?.execute("id-2", {}, undefined, undefined, ctx.ctx);
      },
      (e: unknown) => {
        assert.ok(e instanceof Error);
        assert.match(e.message, /browser_probe_test failed \(not_connected\)/);
        assert.match(e.message, /discovery_failed/);
        assert.match(e.message, /No matching Chrome process/);
        return true;
      },
    );

    assert.equal(mock.connectCalls, 1, "Must not repeat connect on subsequent tool call");
  });

  test("sequential tool calls retain root cause after daemon socket removal", async () => {
    const seqTempDir = mkdtempSync(join(tmpdir(), "pi-latch-seq-"));
    const seqSocketPath = join(seqTempDir, "seq-daemon.sock");
    const prevSocket = process.env["PI_BROWSER_SOCKET_PATH"];
    process.env["PI_BROWSER_SOCKET_PATH"] = seqSocketPath;

    closeSync(openSync(seqSocketPath, "w"));
    assert.equal(existsSync(seqSocketPath), true, "Isolated socket must exist before first tool call");

    try {
      const mock = createMockTransport({
        connectResult: () => Promise.resolve(err(cdpError("discovery_failed", "DevToolsActivePort not found in candidate directories"))),
      });

      const client = createBrowserClient({
        namespace: "test-socket-removal",
        transport: mock.transport,
        remote: { cdpUrl: "ws://127.0.0.1:9222/test", browserId: "test-b" },
      });

      const tool = defineBrowserTool({
        name: "browser_probe_socket_removal",
        label: "Socket Removal Test",
        description: "probe",
        promptSnippet: "probe",
        promptGuidelines: [],
        parameters: Type.Object({}),
        concurrency: "parallel",
        ensureAlive: true,
        handler: () => Promise.resolve(ok({ text: "success" })),
      });

      let registeredTool: Pick<ToolDefinition, "execute"> | undefined;
      tool.register({
        registerTool: (td) => {
          registeredTool = td;
        },
      }, client);
      assert.ok(registeredTool);

      const ctx = fakeCtx();

      await assert.rejects(
        async () => {
          await registeredTool?.execute("id-1", {}, undefined, undefined, ctx.ctx);
        },
        (e: unknown) => {
          assert.ok(e instanceof Error);
          assert.match(e.message, /discovery_failed/);
          assert.match(e.message, /DevToolsActivePort not found/);
          return true;
        },
      );

      unlinkSync(seqSocketPath);
      assert.equal(existsSync(seqSocketPath), false, "Isolated socket must be removed before second tool call");

      await assert.rejects(
        async () => {
          await registeredTool?.execute("id-2", {}, undefined, undefined, ctx.ctx);
        },
        (e: unknown) => {
          assert.ok(e instanceof Error);
          assert.match(e.message, /discovery_failed/);
          assert.match(e.message, /DevToolsActivePort not found/);
          assert.doesNotMatch(e.message, /Run \/browser-setup first/);
          return true;
        },
      );
    } finally {
      if (prevSocket === undefined) {
        Reflect.deleteProperty(process.env, "PI_BROWSER_SOCKET_PATH");
      } else {
        process.env["PI_BROWSER_SOCKET_PATH"] = prevSocket;
      }
      rmSync(seqTempDir, { recursive: true, force: true });
    }
  });
});
