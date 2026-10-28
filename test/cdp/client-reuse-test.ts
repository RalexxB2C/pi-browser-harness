import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createBrowserClient } from "../../src/client";
import { createStubTransport, type Canned } from "../domains/fake-client";
import { ok } from "../../src/util/result";
import type { ProfilePin } from "../../src/profile/store";
import type { BrowserCandidate } from "../../src/profile/browser-process";
import { selectBrowserCandidate } from "../../src/profile/browser-process";
import type { ProfileWindowRequest } from "../../src/profile/launch";
import type { SeedDeps } from "../../src/profile/bind";

const PAGE_JSON = JSON.stringify({ url: "https://one.test/", title: "One", w: 1, h: 2, sx: 0, sy: 0, pw: 3, ph: 4 });

const chromeExe = "/opt/google/chrome/chrome";
const cftExe = "/home/u/.agent-browser/browsers/chrome-150.0.7871.115/chrome";
const sentinelUrl = "file:///tmp/pi-harness-sentinel.html";

const defaultPin: ProfilePin = {
  userDataDir: "/home/u/.config/google-chrome",
  profileDir: "Default",
  label: "Default (personal@example.com)",
  savedAt: "",
};

const workPin: ProfilePin = {
  userDataDir: "/home/u/.config/google-chrome",
  profileDir: "Profile 1",
  label: "Work (work@example.com)",
  savedAt: "",
};

const createMockSeedDeps = (opts: {
  readonly candidates?: ReadonlyArray<BrowserCandidate>;
  readonly launches: ProfileWindowRequest[];
  readonly targetUserDataDir: string;
}): SeedDeps => ({
  detectRunningBrowser: () => Promise.resolve(selectBrowserCandidate(
    opts.candidates ?? [
      { exePath: cftExe },
      { exePath: chromeExe, explicitUserDataDir: opts.targetUserDataDir },
    ],
    opts.targetUserDataDir,
  )),
  resolveBrowserExecutable: (r) => Promise.resolve(r?.ambiguous ? undefined : r?.exePath ?? chromeExe),
  openProfileWindow: (req) => {
    opts.launches.push(req);
    return Promise.resolve(ok({
      sentinelUrl,
      cleanup: () => Promise.resolve(),
      kill: () => undefined,
    }));
  },
  deadlineMs: 2_000,
  pollMs: 10,
});

const createMockStub = (
  canned: Canned = {},
  pin: ProfilePin = defaultPin,
  browserId = "b1",
) =>
  createStubTransport(canned, {
    wsUrl: `ws://127.0.0.1:9222/devtools/browser/${browserId}`,
    browserId,
    userDataDir: pin.userDataDir,
  });

describe("BrowserClient ticket #10: safe target reuse in fresh clients", () => {
  test("fresh client with eligible persisted ownership in resolved default context reuses target with zero launches", async () => {
    const launches: ProfileWindowRequest[] = [];
    const seedDeps = createMockSeedDeps({ launches, targetUserDataDir: defaultPin.userDataDir });

    const stub = createMockStub({
      "Target.setDiscoverTargets": ok({}),
      "Target.getTargets": ok({
        targetInfos: [
          { targetId: "hw-default", type: "page", title: "Existing Default Tab", url: "https://example.test/" },
          { targetId: "foreign-user-tab", type: "page", title: "User Tab", url: "https://user.test/" },
        ],
      }),
      "Target.attachToTarget": [ok({ sessionId: "s-hw" })],
      "Browser.getWindowForTarget": [ok({ windowId: 10 }), ok({ windowId: 999 })],
      "Target.activateTarget": ok({}),
      "Runtime.evaluate": ok({ result: { type: "string", value: PAGE_JSON } }),
    }, defaultPin);

    const client = createBrowserClient({
      namespace: "test-reuse-default",
      transport: stub.transport,
      remote: { cdpUrl: "ws://127.0.0.1:9222/devtools/browser/b1", browserId: "b1", userDataDir: defaultPin.userDataDir },
      profilePin: defaultPin,
      initialOwnership: {
        namespace: "test-reuse-default",
        browserId: "b1",
        userDataDir: defaultPin.userDataDir,
        profilePin: defaultPin,
        ownedTargetIds: ["hw-default"],
        harnessWindowTargetId: "hw-default",
        profileContext: { kind: "default" },
      },
      seedDeps,
    });

    const r = await client.start();
    assert.equal(r.success, true, r.success ? "" : r.error.message);
    assert.equal(launches.length, 0, "must reuse target with zero launches");
    assert.equal(client.owns("hw-default"), true, "must own reused harness window");
    assert.equal(client.owns("foreign-user-tab"), false, "must not adopt foreign user tab");
    assert.equal(client.profileContext().kind, "default");
    assert.equal(client.profileContextId(), undefined, "default context has no browserContextId");
  });

  test("fresh client with eligible persisted ownership in resolved named context reuses target with zero launches", async () => {
    const launches: ProfileWindowRequest[] = [];
    const seedDeps = createMockSeedDeps({ launches, targetUserDataDir: workPin.userDataDir });

    const stub = createMockStub({
      "Target.setDiscoverTargets": ok({}),
      "Target.getTargets": ok({
        targetInfos: [
          { targetId: "hw-work", type: "page", title: "Work Tab", url: "https://work.test/", browserContextId: "ctx-work" },
          { targetId: "foreign-user-tab", type: "page", title: "User Tab", url: "https://user.test/", browserContextId: "ctx-other" },
        ],
      }),
      "Target.attachToTarget": [ok({ sessionId: "s-work" })],
      "Browser.getWindowForTarget": [ok({ windowId: 11 }), ok({ windowId: 999 })],
      "Target.activateTarget": ok({}),
      "Runtime.evaluate": ok({ result: { type: "string", value: PAGE_JSON } }),
    }, workPin);

    const client = createBrowserClient({
      namespace: "test-reuse-named",
      transport: stub.transport,
      remote: { cdpUrl: "ws://127.0.0.1:9222/devtools/browser/b1", browserId: "b1", userDataDir: workPin.userDataDir },
      profilePin: workPin,
      initialOwnership: {
        namespace: "test-reuse-named",
        browserId: "b1",
        userDataDir: workPin.userDataDir,
        profilePin: workPin,
        ownedTargetIds: ["hw-work"],
        harnessWindowTargetId: "hw-work",
        profileContext: { kind: "named", contextId: "ctx-work" },
      },
      seedDeps,
    });

    const r = await client.start();
    assert.equal(r.success, true, r.success ? "" : r.error.message);
    assert.equal(launches.length, 0, "must reuse target with zero launches");
    assert.equal(client.owns("hw-work"), true);
    assert.equal(client.owns("foreign-user-tab"), false);
    assert.equal(client.profileContext().kind, "named");
    assert.equal(client.profileContextId(), "ctx-work");
  });

  test("fresh client without eligible ownership does not adopt foreign tabs and launches verified service window", async () => {
    const launches: ProfileWindowRequest[] = [];
    const seedDeps = createMockSeedDeps({ launches, targetUserDataDir: defaultPin.userDataDir });

    const stub = createMockStub({
      "Target.setDiscoverTargets": ok({}),
      "Target.getTargets": [
        // Before seed: only foreign tab exists
        ok({ targetInfos: [{ targetId: "foreign-tab", type: "page", title: "Foreign", url: "https://foreign.test/" }] }),
        // Poll for sentinel
        ok({ targetInfos: [
          { targetId: "foreign-tab", type: "page", title: "Foreign", url: "https://foreign.test/" },
          { targetId: "new-seed", type: "page", title: "", url: sentinelUrl },
        ] }),
        // After reset
        ok({ targetInfos: [
          { targetId: "foreign-tab", type: "page", title: "Foreign", url: "https://foreign.test/" },
          { targetId: "new-seed", type: "page", title: "", url: "about:blank" },
        ] }),
      ],
      "Target.attachToTarget": [ok({ sessionId: "s-seed" }), ok({ sessionId: "s-main" })],
      "Browser.getWindowForTarget": [ok({ windowId: 42 }), ok({ windowId: 42 }), ok({ windowId: 999 })],
      "Page.navigate": ok({}),
      "Target.detachFromTarget": ok({}),
      "Target.activateTarget": ok({}),
      "Runtime.evaluate": ok({ result: { type: "string", value: PAGE_JSON } }),
    }, defaultPin);

    const client = createBrowserClient({
      namespace: "test-no-ownership",
      transport: stub.transport,
      remote: { cdpUrl: "ws://127.0.0.1:9222/devtools/browser/b1", browserId: "b1", userDataDir: defaultPin.userDataDir },
      profilePin: defaultPin,
      initialOwnership: { namespace: "test-no-ownership", ownedTargetIds: [] },
      seedDeps,
    });

    const r = await client.start();
    assert.equal(r.success, true, r.success ? "" : r.error.message);
    assert.equal(launches.length, 1, "must launch 1 verified window when ownership is absent");
    assert.equal(client.owns("new-seed"), true, "must own newly seeded window");
    assert.equal(client.owns("foreign-tab"), false, "foreign tab must never be adopted");
    assert.equal(client.profileContext().kind, "default");
  });

  test("fresh client with stale target in ownership does not adopt foreign tabs and launches verified window", async () => {
    const launches: ProfileWindowRequest[] = [];
    const seedDeps = createMockSeedDeps({ launches, targetUserDataDir: defaultPin.userDataDir });

    const stub = createMockStub({
      "Target.setDiscoverTargets": ok({}),
      "Target.getTargets": [
        // Stale target is gone; only foreign tab exists
        ok({ targetInfos: [{ targetId: "foreign-tab", type: "page", title: "Foreign", url: "https://foreign.test/" }] }),
        // Poll sentinel
        ok({ targetInfos: [
          { targetId: "foreign-tab", type: "page", title: "Foreign", url: "https://foreign.test/" },
          { targetId: "seeded-tab", type: "page", title: "", url: sentinelUrl },
        ] }),
        ok({ targetInfos: [
          { targetId: "foreign-tab", type: "page", title: "Foreign", url: "https://foreign.test/" },
          { targetId: "seeded-tab", type: "page", title: "", url: "about:blank" },
        ] }),
      ],
      "Target.attachToTarget": [ok({ sessionId: "s-seed" }), ok({ sessionId: "s-main" })],
      "Browser.getWindowForTarget": [ok({ windowId: 43 }), ok({ windowId: 43 }), ok({ windowId: 999 })],
      "Page.navigate": ok({}),
      "Target.detachFromTarget": ok({}),
      "Target.activateTarget": ok({}),
      "Runtime.evaluate": ok({ result: { type: "string", value: PAGE_JSON } }),
    }, defaultPin);

    const client = createBrowserClient({
      namespace: "test-stale-target",
      transport: stub.transport,
      remote: { cdpUrl: "ws://127.0.0.1:9222/devtools/browser/b1", browserId: "b1", userDataDir: defaultPin.userDataDir },
      profilePin: defaultPin,
      initialOwnership: {
        namespace: "test-stale-target",
        browserId: "b1",
        userDataDir: defaultPin.userDataDir,
        profilePin: defaultPin,
        ownedTargetIds: ["stale-dead-tab"],
        harnessWindowTargetId: "stale-dead-tab",
      },
      seedDeps,
    });

    const r = await client.start();
    assert.equal(r.success, true, r.success ? "" : r.error.message);
    assert.equal(launches.length, 1, "must launch 1 verified window when target is stale");
    assert.equal(client.owns("seeded-tab"), true);
    assert.equal(client.owns("stale-dead-tab"), false, "stale tab must be pruned");
    assert.equal(client.owns("foreign-tab"), false, "foreign tab must never be adopted");
  });

  test("browser identity change clears old ownership, prevents foreign-tab adoption, and launches in new browser", async () => {
    const launches: ProfileWindowRequest[] = [];
    const seedDeps = createMockSeedDeps({ launches, targetUserDataDir: defaultPin.userDataDir });

    const stub = createMockStub({
      "Target.setDiscoverTargets": ok({}),
      "Target.getTargets": [
        // Connected to browser B: coincidental tab "tab-from-a" exists as a user tab in browser B!
        ok({ targetInfos: [
          { targetId: "tab-from-a", type: "page", title: "User's tab in browser B", url: "https://user-b.test/" },
        ] }),
        // Sentinel poll
        ok({ targetInfos: [
          { targetId: "tab-from-a", type: "page", title: "User's tab in browser B", url: "https://user-b.test/" },
          { targetId: "seed-b", type: "page", title: "", url: sentinelUrl },
        ] }),
        ok({ targetInfos: [
          { targetId: "tab-from-a", type: "page", title: "User's tab in browser B", url: "https://user-b.test/" },
          { targetId: "seed-b", type: "page", title: "", url: "about:blank" },
        ] }),
      ],
      "Target.attachToTarget": [ok({ sessionId: "s-seed" }), ok({ sessionId: "s-main" })],
      "Browser.getWindowForTarget": [ok({ windowId: 50 }), ok({ windowId: 50 }), ok({ windowId: 999 })],
      "Page.navigate": ok({}),
      "Target.detachFromTarget": ok({}),
      "Target.activateTarget": ok({}),
      "Runtime.evaluate": ok({ result: { type: "string", value: PAGE_JSON } }),
    }, defaultPin, "browser-b");

    // Client was configured with remote browser "browser-a", but transport connects to "browser-b"
    const client = createBrowserClient({
      namespace: "test-browser-change",
      transport: stub.transport,
      remote: { cdpUrl: "ws://127.0.0.1:9222/devtools/browser/browser-b", browserId: "browser-a", userDataDir: defaultPin.userDataDir },
      profilePin: defaultPin,
      initialOwnership: {
        namespace: "test-browser-change",
        browserId: "browser-a",
        userDataDir: defaultPin.userDataDir,
        profilePin: defaultPin,
        ownedTargetIds: ["tab-from-a"],
        harnessWindowTargetId: "tab-from-a",
        profileContext: { kind: "default" },
      },
      seedDeps,
    });

    const r = await client.start();
    assert.equal(r.success, true, r.success ? "" : r.error.message);
    assert.equal(launches.length, 1, "must launch in new browser, never adopt old id in new browser");
    assert.equal(client.owns("seed-b"), true);
    assert.equal(client.owns("tab-from-a"), false, "tab-from-a in browser B must NOT be adopted");
  });

  test("reuse is gated by browser identity: ambiguous candidates fail before spawn with 0 launches", async () => {
    const launches: ProfileWindowRequest[] = [];
    const chromeCandidate: BrowserCandidate = { exePath: chromeExe };
    const cftCandidate: BrowserCandidate = { exePath: cftExe };
    const seedDeps = createMockSeedDeps({
      candidates: [chromeCandidate, cftCandidate],
      launches,
      targetUserDataDir: defaultPin.userDataDir,
    });

    const stub = createMockStub({
      "Target.setDiscoverTargets": ok({}),
      "Target.getTargets": ok({
        targetInfos: [
          { targetId: "hw-tab", type: "page", title: "Tab", url: "https://example.test/" },
        ],
      }),
    }, defaultPin);

    const client = createBrowserClient({
      namespace: "test-ambiguous-reuse",
      transport: stub.transport,
      remote: { cdpUrl: "ws://127.0.0.1:9222/devtools/browser/b1", browserId: "b1", userDataDir: defaultPin.userDataDir },
      profilePin: defaultPin,
      initialOwnership: {
        namespace: "test-ambiguous-reuse",
        browserId: "b1",
        userDataDir: defaultPin.userDataDir,
        profilePin: defaultPin,
        ownedTargetIds: ["hw-tab"],
        harnessWindowTargetId: "hw-tab",
        profileContext: { kind: "default" },
      },
      seedDeps,
    });

    const r = await client.start();
    assert.equal(r.success, false, "ambiguous identity must reject reuse");
    assert.equal(r.error.kind, "discovery_failed");
    assert.match(r.error.message, /ambiguous/i);
    assert.equal(launches.length, 0, "must fail before any spawn");
  });

  test("context absence alone does not establish profile membership for unowned tabs", async () => {
    const launches: ProfileWindowRequest[] = [];
    const seedDeps = createMockSeedDeps({ launches, targetUserDataDir: defaultPin.userDataDir });

    const stub = createMockStub({
      "Target.setDiscoverTargets": ok({}),
      "Target.getTargets": [
        // Multiple unowned user tabs exist with NO browserContextId (default context)
        ok({
          targetInfos: [
            { targetId: "user-gmail", type: "page", title: "Gmail", url: "https://mail.google.com/" },
            { targetId: "user-docs", type: "page", title: "Docs", url: "https://docs.google.com/" },
          ],
        }),
        // Sentinel poll
        ok({
          targetInfos: [
            { targetId: "user-gmail", type: "page", title: "Gmail", url: "https://mail.google.com/" },
            { targetId: "user-docs", type: "page", title: "Docs", url: "https://docs.google.com/" },
            { targetId: "harness-seed", type: "page", title: "", url: sentinelUrl },
          ],
        }),
        ok({
          targetInfos: [
            { targetId: "user-gmail", type: "page", title: "Gmail", url: "https://mail.google.com/" },
            { targetId: "user-docs", type: "page", title: "Docs", url: "https://docs.google.com/" },
            { targetId: "harness-seed", type: "page", title: "", url: "about:blank" },
          ],
        }),
      ],
      "Target.attachToTarget": [ok({ sessionId: "s-seed" }), ok({ sessionId: "s-main" })],
      "Browser.getWindowForTarget": [ok({ windowId: 99 }), ok({ windowId: 99 }), ok({ windowId: 999 }), ok({ windowId: 999 })],
      "Page.navigate": ok({}),
      "Target.detachFromTarget": ok({}),
      "Target.activateTarget": ok({}),
      "Runtime.evaluate": ok({ result: { type: "string", value: PAGE_JSON } }),
    }, defaultPin);

    const client = createBrowserClient({
      namespace: "test-context-absence",
      transport: stub.transport,
      remote: { cdpUrl: "ws://127.0.0.1:9222/devtools/browser/b1", browserId: "b1", userDataDir: defaultPin.userDataDir },
      profilePin: defaultPin,
      initialOwnership: { namespace: "test-context-absence", ownedTargetIds: [] },
      seedDeps,
    });

    const r = await client.start();
    assert.equal(r.success, true);
    assert.equal(launches.length, 1, "must launch verified window rather than adopting unowned context-less tabs");
    assert.equal(client.owns("user-gmail"), false);
    assert.equal(client.owns("user-docs"), false);
    assert.equal(client.owns("harness-seed"), true);
  });

  test("profile pin change clears ownership and prevents adopting old window", () => {
    const launches: ProfileWindowRequest[] = [];
    const seedDeps = createMockSeedDeps({ launches, targetUserDataDir: defaultPin.userDataDir });

    const stub = createMockStub({
      "Target.setDiscoverTargets": ok({}),
      "Target.getTargets": ok({
        targetInfos: [
          { targetId: "hw-work", type: "page", title: "Work Tab", url: "https://work.test/", browserContextId: "ctx-work" },
        ],
      }),
    }, workPin);

    const client = createBrowserClient({
      namespace: "test-pin-change",
      transport: stub.transport,
      remote: { cdpUrl: "ws://127.0.0.1:9222/devtools/browser/b1", browserId: "b1", userDataDir: workPin.userDataDir },
      profilePin: workPin,
      initialOwnership: {
        namespace: "test-pin-change",
        browserId: "b1",
        userDataDir: workPin.userDataDir,
        profilePin: workPin,
        ownedTargetIds: ["hw-work"],
        harnessWindowTargetId: "hw-work",
        profileContext: { kind: "named", contextId: "ctx-work" },
      },
      seedDeps,
    });

    assert.equal(client.owns("hw-work"), true);
    assert.equal(client.ownership().harnessWindow(), "hw-work");

    client.setProfilePin(defaultPin);
    assert.equal(client.owns("hw-work"), false, "ownership must be cleared on pin change");
    assert.equal(client.ownership().harnessWindow(), undefined, "harness window must be cleared on pin change");
    assert.equal(client.profileContext().kind, "unresolved");
  });

  test("fresh client with restored ownership from different pin rejects reuse and launches verified window", async () => {
    const launches: ProfileWindowRequest[] = [];
    const seedDeps = createMockSeedDeps({ launches, targetUserDataDir: defaultPin.userDataDir });

    const stub = createMockStub({
      "Target.setDiscoverTargets": ok({}),
      "Target.getTargets": [
        ok({
          targetInfos: [
            { targetId: "hw-work", type: "page", title: "Work Tab", url: "https://work.test/", browserContextId: "ctx-work" },
          ],
        }),
        // Sentinel poll
        ok({
          targetInfos: [
            { targetId: "hw-work", type: "page", title: "Work Tab", url: "https://work.test/", browserContextId: "ctx-work" },
            { targetId: "seed-default", type: "page", title: "", url: sentinelUrl },
          ],
        }),
        ok({
          targetInfos: [
            { targetId: "hw-work", type: "page", title: "Work Tab", url: "https://work.test/", browserContextId: "ctx-work" },
            { targetId: "seed-default", type: "page", title: "", url: "about:blank" },
          ],
        }),
      ],
      "Target.attachToTarget": [ok({ sessionId: "s-seed" }), ok({ sessionId: "s-main" })],
      "Browser.getWindowForTarget": [ok({ windowId: 77 }), ok({ windowId: 77 }), ok({ windowId: 999 })],
      "Page.navigate": ok({}),
      "Target.detachFromTarget": ok({}),
      "Target.activateTarget": ok({}),
      "Runtime.evaluate": ok({ result: { type: "string", value: PAGE_JSON } }),
    }, defaultPin);

    // Initial ownership was for workPin, but client is started with defaultPin
    const client = createBrowserClient({
      namespace: "test-pin-mismatch",
      transport: stub.transport,
      remote: { cdpUrl: "ws://127.0.0.1:9222/devtools/browser/b1", browserId: "b1", userDataDir: defaultPin.userDataDir },
      profilePin: defaultPin,
      initialOwnership: {
        namespace: "test-pin-mismatch",
        browserId: "b1",
        userDataDir: workPin.userDataDir,
        profilePin: workPin,
        ownedTargetIds: ["hw-work"],
        harnessWindowTargetId: "hw-work",
        profileContext: { kind: "named", contextId: "ctx-work" },
      },
      seedDeps,
    });

    const r = await client.start();
    assert.equal(r.success, true);
    assert.equal(launches.length, 1, "must launch new window for Default pin, not reuse Work pin window");
    assert.equal(client.owns("hw-work"), false, "must not own work window");
    assert.equal(client.owns("seed-default"), true, "must own new default window");
  });

  test("unpinned snapshot -> pinned profile rejects reuse and launches verified window", async () => {
    const launches: ProfileWindowRequest[] = [];
    const seedDeps = createMockSeedDeps({ launches, targetUserDataDir: workPin.userDataDir });

    const stub = createMockStub({
      "Target.setDiscoverTargets": ok({}),
      "Target.getTargets": [
        ok({
          targetInfos: [
            { targetId: "unpinned-tab", type: "page", title: "Unpinned", url: "https://unpinned.test/" },
          ],
        }),
        // Sentinel poll
        ok({
          targetInfos: [
            { targetId: "unpinned-tab", type: "page", title: "Unpinned", url: "https://unpinned.test/" },
            { targetId: "seed-work", type: "page", title: "", url: sentinelUrl, browserContextId: "ctx-work" },
          ],
        }),
        ok({
          targetInfos: [
            { targetId: "unpinned-tab", type: "page", title: "Unpinned", url: "https://unpinned.test/" },
            { targetId: "seed-work", type: "page", title: "", url: "about:blank", browserContextId: "ctx-work" },
          ],
        }),
      ],
      "Target.attachToTarget": [ok({ sessionId: "s-seed" }), ok({ sessionId: "s-work" })],
      "Browser.getWindowForTarget": [ok({ windowId: 88 }), ok({ windowId: 88 }), ok({ windowId: 999 })],
      "Page.navigate": ok({}),
      "Target.detachFromTarget": ok({}),
      "Target.activateTarget": ok({}),
      "Runtime.evaluate": ok({ result: { type: "string", value: PAGE_JSON } }),
    }, workPin);

    // Unpinned snapshot has no profilePin in initialOwnership
    const client = createBrowserClient({
      namespace: "test-unpinned-to-pinned",
      transport: stub.transport,
      remote: { cdpUrl: "ws://127.0.0.1:9222/devtools/browser/b1", browserId: "b1", userDataDir: workPin.userDataDir },
      profilePin: workPin,
      initialOwnership: {
        namespace: "test-unpinned-to-pinned",
        browserId: "b1",
        userDataDir: workPin.userDataDir,
        ownedTargetIds: ["unpinned-tab"],
        harnessWindowTargetId: "unpinned-tab",
      },
      seedDeps,
    });

    const r = await client.start();
    assert.equal(r.success, true);
    assert.equal(launches.length, 1, "unpinned snapshot must not be reused when client has a pinned profile");
    assert.equal(client.owns("unpinned-tab"), false);
    assert.equal(client.owns("seed-work"), true);
  });

  test("pin change invalidates active session, health TTL and page cache so subsequent ordinary reads access new profile", async () => {
    const launches: ProfileWindowRequest[] = [];
    const seedDeps = createMockSeedDeps({ launches, targetUserDataDir: defaultPin.userDataDir });

    const WORK_PAGE = JSON.stringify({
      url: "https://work.test/",
      title: "Work Page",
      w: 800,
      h: 600,
      sx: 0,
      sy: 0,
      pw: 800,
      ph: 600,
    });
    const DEFAULT_PAGE = JSON.stringify({
      url: "https://default.test/",
      title: "Default Page",
      w: 800,
      h: 600,
      sx: 0,
      sy: 0,
      pw: 800,
      ph: 600,
    });

    const stub = createMockStub({
      "Target.setDiscoverTargets": ok({}),
      "Target.getTargets": [
        // Work initial start: ensureHarnessWindow checks existing
        ok({ targetInfos: [{ targetId: "hw-work", type: "page", title: "Work Tab", url: "https://work.test/", browserContextId: "ctx-work" }] }),
        // Work initial start: session.attachFirstPage discovers pages
        ok({ targetInfos: [{ targetId: "hw-work", type: "page", title: "Work Tab", url: "https://work.test/", browserContextId: "ctx-work" }] }),
        // After pin change to Default: ensureHarnessWindow checks existing
        ok({ targetInfos: [{ targetId: "hw-work", type: "page", title: "Work Tab", url: "https://work.test/", browserContextId: "ctx-work" }] }),
        // Default seedProfileWindow poll for sentinel
        ok({ targetInfos: [
          { targetId: "hw-work", type: "page", title: "Work Tab", url: "https://work.test/", browserContextId: "ctx-work" },
          { targetId: "seed-def", type: "page", title: "", url: sentinelUrl },
        ] }),
        // Default attachFirstPage discovers pages
        ok({ targetInfos: [
          { targetId: "hw-work", type: "page", title: "Work Tab", url: "https://work.test/", browserContextId: "ctx-work" },
          { targetId: "seed-def", type: "page", title: "", url: "about:blank" },
        ] }),
      ],
      "Target.attachToTarget": [ok({ sessionId: "s-work" }), ok({ sessionId: "s-seed" }), ok({ sessionId: "s-def" })],
      "Browser.getWindowForTarget": [ok({ windowId: 10 }), ok({ windowId: 20 }), ok({ windowId: 20 }), ok({ windowId: 999 })],
      "Target.detachFromTarget": ok({}),
      "Page.navigate": ok({}),
      "Target.activateTarget": ok({}),
      "Runtime.evaluate": [
        ok({ result: { type: "string", value: WORK_PAGE } }),
        ok({ result: { type: "string", value: DEFAULT_PAGE } }),
      ],
    }, defaultPin);

    const client = createBrowserClient({
      namespace: "test-pin-change-read",
      transport: stub.transport,
      remote: { cdpUrl: "ws://127.0.0.1:9222/devtools/browser/b1", browserId: "b1", userDataDir: workPin.userDataDir },
      profilePin: workPin,
      initialOwnership: {
        namespace: "test-pin-change-read",
        browserId: "b1",
        userDataDir: workPin.userDataDir,
        profilePin: workPin,
        ownedTargetIds: ["hw-work"],
        harnessWindowTargetId: "hw-work",
        profileContext: { kind: "named", contextId: "ctx-work" },
      },
      seedDeps,
    });

    const r1 = await client.start();
    assert.equal(r1.success, true);
    assert.equal(client.current()?.targetId, "hw-work");

    const p1 = await client.pageInfo();
    assert.equal(p1.success, true);
    assert.match(p1.data.kind === "page" ? p1.data.title : "", /Work Page/);

    client.setProfilePin(defaultPin);
    assert.equal(client.current(), null, "active session must be detached on pin change");

    const p2 = await client.pageInfo();
    assert.equal(p2.success, true);
    assert.match(p2.data.kind === "page" ? p2.data.title : "", /Default Page/);
    assert.equal(client.current()?.targetId, "seed-def");
    assert.equal(launches.length, 1, "must launch window for Default profile");
  });

  test("X2: client without constructor initialOwnership tracks registry provenance: stop/start same browser reuses with zero launches, different browser invalidates", async () => {
    const launches: ProfileWindowRequest[] = [];
    const seedDeps = createMockSeedDeps({ launches, targetUserDataDir: workPin.userDataDir });

    let activeBrowserId = "browser-1";
    const stub = createStubTransport({
      "Target.setDiscoverTargets": ok({}),
      "Target.getTargets": [
        // 1. Initial start before seed: empty
        ok({ targetInfos: [] }),
        // 2. Initial start seed poll: sentinel
        ok({ targetInfos: [{ targetId: "seed-1", type: "page", title: "", url: sentinelUrl, browserContextId: "ctx-work" }] }),
        // 3. Initial start attachFirstPage: about:blank
        ok({ targetInfos: [{ targetId: "seed-1", type: "page", title: "Work", url: "about:blank", browserContextId: "ctx-work" }] }),
        // 4. Same-browser restart ensureHarnessWindow checks existing
        ok({ targetInfos: [{ targetId: "seed-1", type: "page", title: "Work", url: "about:blank", browserContextId: "ctx-work" }] }),
        // 5. Same-browser restart attachFirstPage
        ok({ targetInfos: [{ targetId: "seed-1", type: "page", title: "Work", url: "about:blank", browserContextId: "ctx-work" }] }),
        // 6. Browser 2 ensureHarnessWindow: coincidental unowned tab in B2
        ok({ targetInfos: [{ targetId: "seed-1", type: "page", title: "Foreign in B2", url: "https://foreign.test/" }] }),
        // 7. Browser 2 seed poll: sentinel
        ok({ targetInfos: [
          { targetId: "seed-1", type: "page", title: "Foreign in B2", url: "https://foreign.test/" },
          { targetId: "seed-2", type: "page", title: "", url: sentinelUrl, browserContextId: "ctx-work" },
        ] }),
        // 8. Browser 2 attachFirstPage: about:blank
        ok({ targetInfos: [
          { targetId: "seed-1", type: "page", title: "Foreign in B2", url: "https://foreign.test/" },
          { targetId: "seed-2", type: "page", title: "", url: "about:blank", browserContextId: "ctx-work" },
        ] }),
      ],
      "Target.attachToTarget": [
        ok({ sessionId: "s-seed1" }),
        ok({ sessionId: "s-main1" }),
        ok({ sessionId: "s-main1-restart" }),
        ok({ sessionId: "s-seed2" }),
        ok({ sessionId: "s-main2" }),
      ],
      "Browser.getWindowForTarget": [
        ok({ windowId: 10 }),
        ok({ windowId: 10 }),
        ok({ windowId: 10 }),
        ok({ windowId: 20 }),
        ok({ windowId: 20 }),
        ok({ windowId: 999 }),
      ],
      "Page.navigate": ok({}),
      "Target.detachFromTarget": ok({}),
      "Target.activateTarget": ok({}),
      "Runtime.evaluate": ok({ result: { type: "string", value: PAGE_JSON } }),
    });

    const dynamicTransport = {
      ...stub.transport,
      actualEndpoint: () => ({
        wsUrl: `ws://127.0.0.1:9222/devtools/browser/${activeBrowserId}`,
        browserId: activeBrowserId,
        userDataDir: workPin.userDataDir,
      }),
    };

    // No constructor initialOwnership!
    const client = createBrowserClient({
      namespace: "test-dynamic-provenance",
      transport: dynamicTransport,
      profilePin: workPin,
      seedDeps,
    });

    const r1 = await client.start();
    assert.equal(r1.success, true);
    assert.equal(launches.length, 1, "initial start must seed 1 window");
    assert.equal(client.owns("seed-1"), true);

    await client.stop();

    const r2 = await client.start();
    assert.equal(r2.success, true);
    assert.equal(launches.length, 1, "same browser restart must reuse existing window with zero launches");
    assert.equal(client.owns("seed-1"), true);

    await client.stop();

    activeBrowserId = "browser-2";

    const r3 = await client.start();
    assert.equal(r3.success, true);
    assert.equal(launches.length, 2, "browser change must invalidate old registry and launch new window in B2");
    assert.equal(client.owns("seed-1"), false, "old window must be cleared on browser change");
    assert.equal(client.owns("seed-2"), true, "must own new window in B2");
  });

  test("R4: profile pin change during in-flight seed invalidates publication and does not adopt old context under new pin", async () => {
    let seedBlocked = true;
    let seedResolved: () => void = () => undefined;
    const seedBlockPromise = new Promise<void>((resolve) => {
      seedResolved = resolve;
    });

    const launches: ProfileWindowRequest[] = [];
    const seedDeps: SeedDeps = {
      detectRunningBrowser: () => Promise.resolve({
        running: true,
        exePath: chromeExe,
        explicitUserDataDir: workPin.userDataDir,
      }),
      resolveBrowserExecutable: () => Promise.resolve(chromeExe),
      openProfileWindow: async (req) => {
        launches.push(req);
        if (seedBlocked) {
          await seedBlockPromise;
        }
        return ok({ sentinelUrl: "file:///tmp/sentinel-race.html", cleanup: () => Promise.resolve(), kill: () => undefined });
      },
      deadlineMs: 2_000,
      pollMs: 10,
    };

    const stub = createStubTransport({
      "Target.setDiscoverTargets": ok({}),
      "Target.getTargets": [
        ok({ targetInfos: [{ targetId: "seed-race", type: "page", title: "", url: "file:///tmp/sentinel-race.html", browserContextId: "ctx-work" }] }),
        ok({ targetInfos: [{ targetId: "seed-race", type: "page", title: "", url: "about:blank", browserContextId: "ctx-work" }] }),
      ],
      "Target.attachToTarget": [ok({ sessionId: "s-race" })],
      "Browser.getWindowForTarget": ok({ windowId: 99 }),
      "Page.navigate": ok({}),
      "Target.detachFromTarget": ok({}),
      "Target.activateTarget": ok({}),
      "Runtime.evaluate": ok({ result: { type: "string", value: PAGE_JSON } }),
    });

    const transport = {
      ...stub.transport,
      actualEndpoint: () => ({
        wsUrl: "ws://127.0.0.1:9222/devtools/browser/b1",
        browserId: "b1",
        userDataDir: workPin.userDataDir,
      }),
    };

    const client = createBrowserClient({
      namespace: "test-pin-race",
      transport,
      profilePin: workPin,
      seedDeps,
      discoverEndpoint: () => Promise.resolve(ok({ wsUrl: "ws://127.0.0.1:9222/devtools/browser/b1" })),
    });

    const inFlightStart = client.start();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(launches.length, 1);

    client.setProfilePin(defaultPin);
    assert.equal(client.profilePin()?.profileDir, "Default");

    seedBlocked = false;
    seedResolved();

    const r = await inFlightStart;
    assert.equal(r.success, false);
    assert.match(r.error.message, /profile pin changed/i);
    assert.equal(client.owns("seed-race"), false, "old seed tab must NOT be owned under new pin");
    assert.equal(client.ownership().harnessWindow(), undefined);
    assert.equal(client.profileContext().kind, "unresolved");
  });

  test("barrier verify -> spawn race: pin change during identity verification aborts before launch", async () => {
    let verifyBlocked = true;
    let verifyResolved: () => void = () => undefined;
    const verifyBlockPromise = new Promise<void>((resolve) => {
      verifyResolved = resolve;
    });

    const launches: ProfileWindowRequest[] = [];
    const seedDeps: SeedDeps = {
      detectRunningBrowser: async () => {
        if (verifyBlocked) {
          await verifyBlockPromise;
        }
        return {
          running: true,
          exePath: chromeExe,
          explicitUserDataDir: workPin.userDataDir,
        };
      },
      resolveBrowserExecutable: () => Promise.resolve(chromeExe),
      openProfileWindow: (req) => {
        launches.push(req);
        return Promise.resolve(ok({ sentinelUrl: "file:///tmp/s.html", cleanup: () => Promise.resolve(), kill: () => undefined }));
      },
    };

    const stub = createStubTransport({
      "Target.setDiscoverTargets": ok({}),
      "Target.getTargets": ok({ targetInfos: [] }),
    });

    const transport = {
      ...stub.transport,
      actualEndpoint: () => ({
        wsUrl: "ws://127.0.0.1:9222/devtools/browser/b1",
        browserId: "b1",
        userDataDir: workPin.userDataDir,
      }),
    };

    const client = createBrowserClient({
      namespace: "test-verify-spawn-race",
      transport,
      profilePin: workPin,
      seedDeps,
      discoverEndpoint: () => Promise.resolve(ok({ wsUrl: "ws://127.0.0.1:9222/devtools/browser/b1" })),
    });

    const inFlightStart = client.start();
    await new Promise((r) => setTimeout(r, 10));

    client.setProfilePin(defaultPin);

    verifyBlocked = false;
    verifyResolved();

    const r = await inFlightStart;
    assert.equal(r.success, false);
    assert.match(r.error.message, /profile pin changed/i);
    assert.equal(launches.length, 0, "pre-launch generation check must prevent spawn");
  });

  test("null and ABA pin changes: Pin A -> null -> Pin A is detected by generation identity and rejects publication", async () => {
    let seedBlocked = true;
    let seedResolved: () => void = () => undefined;
    const seedBlockPromise = new Promise<void>((resolve) => {
      seedResolved = resolve;
    });

    const launches: ProfileWindowRequest[] = [];
    const seedDeps: SeedDeps = {
      detectRunningBrowser: () => Promise.resolve({
        running: true,
        exePath: chromeExe,
        explicitUserDataDir: workPin.userDataDir,
      }),
      resolveBrowserExecutable: () => Promise.resolve(chromeExe),
      openProfileWindow: async (req) => {
        launches.push(req);
        if (seedBlocked) {
          await seedBlockPromise;
        }
        return ok({ sentinelUrl: "file:///tmp/sentinel-aba.html", cleanup: () => Promise.resolve(), kill: () => undefined });
      },
    };

    const stub = createStubTransport({
      "Target.setDiscoverTargets": ok({}),
      "Target.getTargets": [
        ok({ targetInfos: [{ targetId: "seed-aba", type: "page", title: "", url: "file:///tmp/sentinel-aba.html", browserContextId: "ctx-work" }] }),
        ok({ targetInfos: [{ targetId: "seed-aba", type: "page", title: "", url: "about:blank", browserContextId: "ctx-work" }] }),
      ],
      "Target.attachToTarget": [ok({ sessionId: "s-aba" })],
      "Browser.getWindowForTarget": ok({ windowId: 99 }),
      "Page.navigate": ok({}),
      "Target.detachFromTarget": ok({}),
      "Target.activateTarget": ok({}),
      "Runtime.evaluate": ok({ result: { type: "string", value: PAGE_JSON } }),
    });

    const transport = {
      ...stub.transport,
      actualEndpoint: () => ({
        wsUrl: "ws://127.0.0.1:9222/devtools/browser/b1",
        browserId: "b1",
        userDataDir: workPin.userDataDir,
      }),
    };

    const client = createBrowserClient({
      namespace: "test-pin-aba",
      transport,
      profilePin: workPin,
      seedDeps,
      discoverEndpoint: () => Promise.resolve(ok({ wsUrl: "ws://127.0.0.1:9222/devtools/browser/b1" })),
    });

    const inFlightStart = client.start();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(launches.length, 1);

    client.setProfilePin(null);
    client.setProfilePin(workPin);

    seedBlocked = false;
    seedResolved();

    const r = await inFlightStart;
    assert.equal(r.success, false);
    assert.match(r.error.message, /profile pin changed/i);
    assert.equal(client.owns("seed-aba"), false, "ABA race must not publish old seed window");
  });

  test("Q1: constructor opts.remote does not authorize daemon spawn when transport evidence is absent", async () => {
    const launches: ProfileWindowRequest[] = [];
    const seedDeps: SeedDeps = {
      detectRunningBrowser: () => Promise.resolve({
        running: true,
        exePath: chromeExe,
        explicitUserDataDir: workPin.userDataDir,
      }),
      resolveBrowserExecutable: () => Promise.resolve(chromeExe),
      openProfileWindow: (req) => {
        launches.push(req);
        return Promise.resolve(ok({ sentinelUrl: "file:///tmp/s.html", cleanup: () => Promise.resolve(), kill: () => undefined }));
      },
    };

    const stub = createStubTransport({
      "Target.setDiscoverTargets": ok({}),
      "Target.getTargets": ok({ targetInfos: [] }),
    });

    const client = createBrowserClient({
      namespace: "test-remote-bypass",
      transport: stub.transport,
      remote: {
        cdpUrl: "ws://127.0.0.1:9222/devtools/browser/remote-b",
        browserId: "remote-b",
        userDataDir: workPin.userDataDir,
      },
      profilePin: workPin,
      seedDeps,
    });

    const r = await client.start();
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "discovery_failed");
    assert.match(r.error.message, /no verified user-data-dir endpoint linkage/i);
    assert.equal(launches.length, 0, "constructor remote must not authorize spawn without transport evidence");
  });

  test("Q6: initialOwnership without matching namespace does not preload IDs or adopt tabs", () => {
    const stub = createStubTransport({
      "Target.setDiscoverTargets": ok({}),
      "Target.getTargets": ok({ targetInfos: [] }),
    });

    const client = createBrowserClient({
      namespace: "target-namespace",
      transport: stub.transport,
      initialOwnership: {
        ownedTargetIds: ["unproven-1", "unproven-2"],
        harnessWindowTargetId: "unproven-1",
        harnessWindowId: 42,
      },
    });

    assert.equal(client.owns("unproven-1"), false, "unproven tabs must not be owned");
    assert.equal(client.owns("unproven-2"), false);
    assert.equal(client.ownership().harnessWindow(), undefined);
    assert.equal(client.ownership().harnessWindowId(), undefined);
    assert.equal(client.profileContext().kind, "unresolved");
  });
});
