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

const started = async (canned: Canned = {}, closeConfirmMs?: number) => {
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
  }, {
    wsUrl: "ws://127.0.0.1:1/devtools/browser/abc",
    browserId: "abc",
  });
  const client = createBrowserClient({
    namespace: "test",
    transport: stub.transport,
    remote: { cdpUrl: "ws://127.0.0.1:1/devtools/browser/abc", browserId: "abc" },
    initialOwnership: { namespace: "test", browserId: "abc", ownedTargetIds: ["t1"] },
    ...(closeConfirmMs !== undefined ? { closeConfirmMs } : {}),
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
      }, {
        wsUrl: "ws://127.0.0.1:9222/devtools/browser/abc",
        browserId: "abc",
        userDataDir: pin.userDataDir,
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
    }, {
      wsUrl: "ws://127.0.0.1:9222/devtools/browser/abc",
      browserId: "abc",
      userDataDir: pin.userDataDir,
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
    }, {
      wsUrl: "ws://127.0.0.1:9222/devtools/browser/abc",
      browserId: "abc",
      userDataDir: pin.userDataDir,
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

  test("health reattach generation check: pin change during reattach aborts publication and latches failure", async () => {
    let seedBlocked = true;
    let seedResolved: () => void = () => undefined;
    const seedBlockPromise = new Promise<void>((resolve) => {
      seedResolved = resolve;
    });

    const launches: ProfileWindowRequest[] = [];
    const seedDeps: SeedDeps = {
      detectRunningBrowser: () => Promise.resolve({ running: true, exePath: chromeExe, explicitUserDataDir: pin.userDataDir }),
      resolveBrowserExecutable: () => Promise.resolve(chromeExe),
      openProfileWindow: async (req) => {
        launches.push(req);
        if (seedBlocked) {
          await seedBlockPromise;
        }
        return ok({ sentinelUrl, cleanup: () => Promise.resolve(), kill: () => undefined });
      },
    };

    const stub = createStubTransport({
      "Target.setDiscoverTargets": ok({}),
      "Target.getTargets": [
        // initial start
        ok({ targetInfos: [{ targetId: "tab-init", type: "page", title: "", url: sentinelUrl, browserContextId: "ctx-work" }] }),
        ok({ targetInfos: [{ targetId: "tab-init", type: "page", title: "", url: "about:blank", browserContextId: "ctx-work" }] }),
        // reattach seed
        ok({ targetInfos: [{ targetId: "tab-reattach", type: "page", title: "", url: sentinelUrl, browserContextId: "ctx-work" }] }),
        ok({ targetInfos: [{ targetId: "tab-reattach", type: "page", title: "", url: "about:blank", browserContextId: "ctx-work" }] }),
      ],
      "Target.attachToTarget": [ok({ sessionId: "s-init" }), ok({ sessionId: "s-reattach" })],
      "Browser.getWindowForTarget": ok({ windowId: 10 }),
      "Page.navigate": ok({}),
      "Target.detachFromTarget": ok({}),
      "Target.activateTarget": ok({}),
      "Runtime.evaluate": ok({ result: { type: "string", value: PAGE_JSON } }),
    }, {
      wsUrl: "ws://127.0.0.1:9222/devtools/browser/abc",
      browserId: "abc",
      userDataDir: pin.userDataDir,
    });

    const client = createBrowserClient({
      namespace: "test-reattach-generation",
      transport: stub.transport,
      remote: { cdpUrl: "ws://127.0.0.1:9222/devtools/browser/abc", browserId: "abc", userDataDir: pin.userDataDir },
      profilePin: pin,
      seedDeps,
      discoverEndpoint: () => Promise.resolve(ok({ wsUrl: "ws://127.0.0.1:9222/devtools/browser/abc" })),
    });

    seedBlocked = false;
    const r1 = await client.start();
    assert.equal(r1.success, true);
    assert.equal(launches.length, 1);

    seedBlocked = true;

    // Invalidate session and clear ownership so reattach must seed
    await client.detach();
    client.ownership().replaceAll([]);
    client.ownership().setHarnessWindow(undefined);

    // Now call ensureAlive: sees !session.current() so triggers restart -> start -> seedIfPinned
    const inFlightReattach = client.ensureAlive();
    await new Promise((r) => setTimeout(r, 10));

    // Pin changes while reattach seed is in flight!
    const defaultPin: ProfilePin = { userDataDir: pin.userDataDir, profileDir: "Default", label: "Default", savedAt: "" };
    client.setProfilePin(defaultPin);

    seedBlocked = false;
    seedResolved();

    const r2 = await inFlightReattach;
    assert.equal(r2.success, false);
    assert.match(r2.error.message, /profile pin changed/i);

    const r3 = await client.ensureAlive();
    assert.equal(r3.success, false);
    assert.match(r3.error.message, /profile pin changed/i);
  });
});

describe("BrowserClient.evaluateJs", () => {
  test("sends a body with statements before its return wrapped in an awaited async function, in REPL mode", async () => {
    const { stub, client } = await started();
    stub.calls.length = 0;

    await client.evaluateJs("const t = document.title; return t");

    const [sent] = stub.calls.filter((c) => c.method === "Runtime.evaluate");
    assert.equal(sent?.params["expression"], "await (async () => {\nconst t = document.title; return t\n})()");
    assert.equal(sent.params["replMode"], true);
  });
});

describe("BrowserClient.pageInfo after a navigation command", () => {
  test("a Page.navigate that returns before Page.frameNavigated arrives still makes the next pageInfo read the page again", async () => {
    const { stub, client } = await started({ "Page.navigate": ok({ frameId: "f1" }) });
    const evaluations = (): number => stub.calls.filter((c) => c.method === "Runtime.evaluate").length;
    await client.pageInfo();
    const before = evaluations();

    await client.session().call("Page.navigate", { url: "https://two.test/" });
    await client.pageInfo();

    assert.equal(evaluations(), before + 1);
  });
});

describe("BrowserClient.closeTab", () => {
  test("a tab Chrome no longer lists after the close is closed with one Target.closeTarget and leaves the owned list", async () => {
    const { stub, client } = await started({ "Target.closeTarget": ok({ success: true }) }, 50);

    // t9 is not among the targets Chrome lists, as after a close that took.
    client.ownership().add("t9");
    const r = await client.closeTab("t9");

    assert.equal(r.success, true);
    assert.equal(stub.calls.filter((c) => c.method === "Target.closeTarget").length, 1);
    assert.equal(client.owns("t9"), false);
  });

  test("a tab Chrome still lists after the close (a page still loading) is closed twice, then reported as still open and kept owned", async () => {
    const { stub, client } = await started({ "Target.closeTarget": ok({ success: true }) }, 50);

    const r = await client.closeTab("t1");

    assert.equal(r.success, false);
    assert.equal(r.error.kind, "timeout");
    assert.match(r.error.message, /tab t1 is still open after 2 attempts/);
    assert.equal(stub.calls.filter((c) => c.method === "Target.closeTarget").length, 2);
    assert.equal(client.owns("t1"), true);
  });
});

describe("BrowserClient profile pin against a remote browser", () => {
  const PIN = { userDataDir: "/home/u/.config/google-chrome", profileDir: "Default", label: "Alice", savedAt: "" };

  // No `remote` option, so start() runs the injected discovery; no pin is set before start(), so nothing is seeded.
  const discovered = async (opts: { readonly userDataDir?: string; readonly running: boolean; readonly wsUrl?: string }) => {
    const stub = createStubTransport({
      "Target.setDiscoverTargets": ok({}),
      "Target.getTargets": ok({ targetInfos: [{ targetId: "t1", type: "page", title: "One", url: "https://one.test/" }] }),
      "Target.attachToTarget": ok({ sessionId: "s1" }),
      "Browser.getWindowForTarget": ok({ windowId: 7 }),
      "Target.activateTarget": ok({}),
      "Runtime.evaluate": ok({ result: { type: "string", value: PAGE_JSON } }),
    }, {
      wsUrl: "ws://127.0.0.1:9222/devtools/browser/abc",
      browserId: "abc",
    });
    const client = createBrowserClient({
      namespace: "test",
      transport: stub.transport,
      initialOwnership: { namespace: "test", browserId: "abc", ownedTargetIds: ["t1"] },
      discoverEndpoint: () => Promise.resolve(ok({
        wsUrl: opts.wsUrl ?? "ws://127.0.0.1:9222/devtools/browser/abc",
        ...(opts.userDataDir === undefined ? {} : { userDataDir: opts.userDataDir }),
      })),
      isBrowserRunning: () => Promise.resolve(opts.running),
    });
    const r = await client.start();
    assert.equal(r.success, true);
    return client;
  };

  test("an endpoint with no user-data-dir and no local browser process suspends the pin", async () => {
    const client = await discovered({ running: false });
    client.setProfilePin(PIN);
    assert.equal(client.profilePin(), null);
    const seeded = await client.seedPinnedProfileWindow();
    assert.equal(seeded.success, false);
  });

  test("an endpoint with no user-data-dir but a local browser process keeps the pin", async () => {
    const client = await discovered({ running: true });
    client.setProfilePin(PIN);
    assert.deepEqual(client.profilePin(), PIN);
  });

  test("an endpoint on another host suspends the pin even while an unrelated browser runs here", async () => {
    const client = await discovered({ running: true, wsUrl: "ws://example.test/devtools/browser/abc" });
    client.setProfilePin(PIN);
    assert.equal(client.profilePin(), null);
  });

  test("an endpoint from a local port file keeps the pin without asking about processes", async () => {
    const client = await discovered({ userDataDir: PIN.userDataDir, running: false });
    client.setProfilePin(PIN);
    assert.deepEqual(client.profilePin(), PIN);
  });
});
