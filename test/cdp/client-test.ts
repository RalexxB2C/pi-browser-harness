import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createBrowserClient } from "../../src/client";
import { createStubTransport, flush, type Canned } from "../domains/fake-client";
import { ok } from "../../src/util/result";
import type { ProfilePin } from "../../src/profile/store";
import type { BrowserCandidate } from "../../src/profile/browser-process";
import { selectBrowserCandidate } from "../../src/profile/browser-process";
import type { ProfileWindowRequest } from "../../src/profile/launch";
import type { SeedDeps } from "../../src/profile/bind";

const PAGE_JSON = JSON.stringify({ url: "https://one.test/", title: "One", w: 1, h: 2, sx: 0, sy: 0, pw: 3, ph: 4 });

const started = async (canned: Canned = {}) => {
  const stub = createStubTransport({
    "Target.setDiscoverTargets": ok({}),
    "Target.getTargets": ok({
      targetInfos: [
        { targetId: "t1", type: "page", title: "One", url: "https://one.test/" },
        { targetId: "t2", type: "page", title: "Two", url: "https://two.test/" },
      ],
    }),
    "Target.attachToTarget": [ok({ sessionId: "s1" }), ok({ sessionId: "s2" })],
    "Browser.getWindowForTarget": ok({ windowId: 7 }),
    "Target.activateTarget": ok({}),
    "Runtime.evaluate": ok({ result: { type: "string", value: PAGE_JSON } }),
    ...canned,
  });
  const client = createBrowserClient({
    namespace: "test",
    transport: stub.transport,
    remote: { cdpUrl: "ws://127.0.0.1:1/devtools/browser/abc", browserId: "abc" },
    initialOwnership: { ownedTargetIds: ["t1"] },
  });
  const r = await client.start();
  assert.equal(r.success, true);
  return { stub, client };
};

describe("BrowserClient.pageInfo", () => {
  test("a plain page is tagged kind: page and keeps the PageInfo fields", async () => {
    const { client } = await started();
    const info = await client.pageInfo();
    assert.equal(info.success, true);
    assert.equal(info.data.kind, "page");
    assert.equal(info.data.url, "https://one.test/");
    assert.equal("dialog" in info.data, false);
  });

  test("a pending dialog is tagged kind: dialog and still narrows with `\"dialog\" in`", async () => {
    const { stub, client } = await started();
    stub.emit({ method: "Page.javascriptDialogOpening", sessionId: "s1", params: { type: "confirm", message: "sure?" } });
    await flush();
    const info = await client.pageInfo();
    assert.equal(info.success, true);
    assert.equal(info.data.kind, "dialog");
    assert.equal("dialog" in info.data, true);
    assert.equal(info.data.dialog.message, "sure?");
  });
});

describe("BrowserClient.detach", () => {
  test("detaches every tracked session, not only the current one", async () => {
    const { stub, client } = await started();
    const switched = await client.switchTab("t2");
    assert.equal(switched.success, true);
    await client.detach();
    const detached = stub.calls
      .filter((c) => c.method === "Target.detachFromTarget")
      .map((c) => c.params["sessionId"]);
    assert.deepEqual(detached.sort(), ["s1", "s2"]);
    assert.equal(client.current(), null);
  });
});

describe("BrowserClient initialization with profile pin and machine dependencies", () => {
  const pin: ProfilePin = {
    userDataDir: "/home/u/.config/google-chrome",
    profileDir: "Profile 1",
    label: "Work (work@example.com)",
    savedAt: "",
  };
  const chromeExe = "/opt/google/chrome/chrome";
  const cftExe = "/home/u/.agent-browser/browsers/chrome-150.0.7871.115/chrome";
  const sentinelUrl = "file:///tmp/pi-harness-sentinel.html";

  test("start() with ambiguous Chrome/CFT candidates with absent flags fails with zero launches in both orders", async () => {
    const chromeCandidate: BrowserCandidate = { exePath: chromeExe };
    const cftCandidate: BrowserCandidate = { exePath: cftExe };

    for (const [name, candidates] of [
      ["[Chrome, CFT]", [chromeCandidate, cftCandidate]],
      ["[CFT, Chrome]", [cftCandidate, chromeCandidate]],
    ] as const) {
      const launches: ProfileWindowRequest[] = [];
      const seedDeps: SeedDeps = {
        detectRunningBrowser: () => Promise.resolve(selectBrowserCandidate(candidates, pin.userDataDir)),
        resolveBrowserExecutable: (r) => Promise.resolve(r?.ambiguous ? undefined : r?.exePath ?? chromeExe),
        openProfileWindow: (req) => {
          launches.push(req);
          return Promise.resolve(ok({
            sentinelUrl,
            cleanup: () => Promise.resolve(),
            kill: () => undefined,
          }));
        },
      };

      const stub = createStubTransport({
        "Target.setDiscoverTargets": ok({}),
        "Target.getTargets": ok({ targetInfos: [] }),
      });

      const client = createBrowserClient({
        namespace: "test-ambiguous",
        transport: stub.transport,
        remote: { cdpUrl: "ws://127.0.0.1:9222/devtools/browser/abc", browserId: "abc", userDataDir: pin.userDataDir },
        profilePin: pin,
        seedDeps,
      });

      const r = await client.start();
      assert.equal(r.success, false, `start() should fail for ${name}`);
      assert.equal(r.error.kind, "discovery_failed");
      assert.match(r.error.message, /ambiguous/i);
      assert.equal(launches.length, 0, `zero launches expected for ${name}`);
    }
  });

  test("start() with verified positive candidate succeeds and permits service-window launch", async () => {
    const launches: ProfileWindowRequest[] = [];
    const seedDeps: SeedDeps = {
      detectRunningBrowser: () => Promise.resolve(selectBrowserCandidate([
        { exePath: cftExe },
        { exePath: chromeExe, explicitUserDataDir: pin.userDataDir },
      ], pin.userDataDir)),
      resolveBrowserExecutable: (r) => Promise.resolve(r?.ambiguous ? undefined : r?.exePath ?? chromeExe),
      openProfileWindow: (req) => {
        launches.push(req);
        return Promise.resolve(ok({
          sentinelUrl,
          cleanup: () => Promise.resolve(),
          kill: () => undefined,
        }));
      },
      deadlineMs: 2_000,
      pollMs: 10,
    };

    const stub = createStubTransport({
      "Target.setDiscoverTargets": ok({}),
      "Target.getTargets": [
        ok({ targetInfos: [] }),
        ok({ targetInfos: [{ targetId: "seed-tab", type: "page", title: "", url: sentinelUrl, browserContextId: "ctx-work" }] }),
        ok({ targetInfos: [{ targetId: "seed-tab", type: "page", title: "", url: "about:blank", browserContextId: "ctx-work" }] }),
      ],
      "Target.attachToTarget": [ok({ sessionId: "s-seed" }), ok({ sessionId: "s-main" })],
      "Browser.getWindowForTarget": ok({ windowId: 42 }),
      "Page.navigate": ok({}),
      "Target.detachFromTarget": ok({}),
      "Target.activateTarget": ok({}),
      "Runtime.evaluate": ok({ result: { type: "string", value: PAGE_JSON } }),
    });

    const client = createBrowserClient({
      namespace: "test-verified",
      transport: stub.transport,
      remote: { cdpUrl: "ws://127.0.0.1:9222/devtools/browser/abc", browserId: "abc", userDataDir: pin.userDataDir },
      profilePin: pin,
      seedDeps,
    });

    const r = await client.start();
    assert.equal(r.success, true, r.success ? "" : r.error.message);
    assert.equal(launches.length, 1);
    assert.deepEqual(launches[0], {
      exePath: chromeExe,
      profileDir: "Profile 1",
      explicitUserDataDir: pin.userDataDir,
    });
    assert.equal(client.profileContextId(), "ctx-work");
    assert.equal(client.owns("seed-tab"), true);
  });

  test("start() with unknown endpoint (remote without userDataDir) fails closed with zero launches before spawn", async () => {
    const launches: ProfileWindowRequest[] = [];
    const seedDeps: SeedDeps = {
      detectRunningBrowser: () => Promise.resolve({ running: true, exePath: chromeExe, explicitUserDataDir: pin.userDataDir }),
      resolveBrowserExecutable: () => Promise.resolve(chromeExe),
      openProfileWindow: (req) => {
        launches.push(req);
        return Promise.resolve(ok({
          sentinelUrl,
          cleanup: () => Promise.resolve(),
          kill: () => undefined,
        }));
      },
    };

    const stub = createStubTransport({
      "Target.setDiscoverTargets": ok({}),
      "Target.getTargets": ok({ targetInfos: [] }),
    });

    const client = createBrowserClient({
      namespace: "test-unknown-endpoint",
      transport: stub.transport,
      remote: { cdpUrl: "ws://127.0.0.1:9222/devtools/browser/abc", browserId: "abc" },
      profilePin: pin,
      seedDeps,
    });

    const r = await client.start();
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "discovery_failed");
    assert.match(r.error.message, /no verified user-data-dir endpoint linkage/i);
    assert.equal(launches.length, 0, "zero launches on unverified endpoint");
  });

  test("start() with sole CFT candidate lacking explicit flag fails closed before spawn with zero launches", async () => {
    const launches: ProfileWindowRequest[] = [];
    const seedDeps: SeedDeps = {
      detectRunningBrowser: () => Promise.resolve(selectBrowserCandidate([{ exePath: cftExe }], pin.userDataDir)),
      resolveBrowserExecutable: (r) => Promise.resolve(r?.ambiguous ? undefined : r?.exePath ?? chromeExe),
      openProfileWindow: (req) => {
        launches.push(req);
        return Promise.resolve(ok({
          sentinelUrl,
          cleanup: () => Promise.resolve(),
          kill: () => undefined,
        }));
      },
    };

    const stub = createStubTransport({
      "Target.setDiscoverTargets": ok({}),
      "Target.getTargets": ok({ targetInfos: [] }),
    });

    const client = createBrowserClient({
      namespace: "test-sole-cft",
      transport: stub.transport,
      remote: { cdpUrl: "ws://127.0.0.1:9222/devtools/browser/abc", browserId: "abc", userDataDir: pin.userDataDir },
      profilePin: pin,
      seedDeps,
    });

    const r = await client.start();
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "discovery_failed");
    assert.match(r.error.message, /ambiguous/i);
    assert.equal(launches.length, 0, "zero launches for sole CFT candidate without explicit flag");
  });

  test("discovery A vs transport B: authoritative provenance of actual connected transport takes precedence and rejects mismatched pin", async () => {
    const launches: ProfileWindowRequest[] = [];
    const seedDeps: SeedDeps = {
      detectRunningBrowser: () => Promise.resolve({ running: true, exePath: chromeExe, explicitUserDataDir: pin.userDataDir }),
      resolveBrowserExecutable: () => Promise.resolve(chromeExe),
      openProfileWindow: (req) => {
        launches.push(req);
        return Promise.resolve(ok({
          sentinelUrl,
          cleanup: () => Promise.resolve(),
          kill: () => undefined,
        }));
      },
    };

    const stub = createStubTransport({
      "Target.setDiscoverTargets": ok({}),
      "Target.getTargets": ok({ targetInfos: [] }),
    });

    // Transport connects to browser B in dirB, despite remote/discovery pointing to A
    const transportWithB = {
      ...stub.transport,
      actualEndpoint: () => ({
        wsUrl: "ws://127.0.0.1:9222/devtools/browser/browser-B",
        browserId: "browser-B",
        userDataDir: "/home/u/.config/browser-B",
      }),
    };

    const client = createBrowserClient({
      namespace: "test-discovery-vs-transport",
      transport: transportWithB,
      remote: { cdpUrl: "ws://127.0.0.1:9222/devtools/browser/browser-A", browserId: "browser-A", userDataDir: pin.userDataDir },
      profilePin: pin,
      seedDeps,
    });

    const r = await client.start();
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "discovery_failed");
    assert.match(r.error.message, /belongs to \/home\/u\/\.config\/google-chrome, but the harness is connected to \/home\/u\/\.config\/browser-B/);
    assert.equal(launches.length, 0, "must fail before spawn when actual transport does not match pinned profile");
    assert.equal(client.userDataDir(), "/home/u/.config/browser-B");
    assert.equal(client.browserId(), "browser-B");
  });
});
