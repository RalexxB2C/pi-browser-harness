import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createBrowserClient } from "../../src/client";
import { createStubTransport } from "../domains/fake-client";
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

describe("BrowserClient ticket #10: safe target reuse in fresh clients", () => {
  test("fresh client with eligible persisted ownership in resolved default context reuses target with zero launches", async () => {
    const launches: ProfileWindowRequest[] = [];
    const seedDeps = createMockSeedDeps({ launches, targetUserDataDir: defaultPin.userDataDir });

    const stub = createStubTransport({
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
    });

    const client = createBrowserClient({
      namespace: "test-reuse-default",
      transport: stub.transport,
      remote: { cdpUrl: "ws://127.0.0.1:9222/devtools/browser/b1", browserId: "b1", userDataDir: defaultPin.userDataDir },
      profilePin: defaultPin,
      initialOwnership: {
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

    const stub = createStubTransport({
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
    });

    const client = createBrowserClient({
      namespace: "test-reuse-named",
      transport: stub.transport,
      remote: { cdpUrl: "ws://127.0.0.1:9222/devtools/browser/b1", browserId: "b1", userDataDir: workPin.userDataDir },
      profilePin: workPin,
      initialOwnership: {
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

    const stub = createStubTransport({
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
    });

    const client = createBrowserClient({
      namespace: "test-no-ownership",
      transport: stub.transport,
      remote: { cdpUrl: "ws://127.0.0.1:9222/devtools/browser/b1", browserId: "b1", userDataDir: defaultPin.userDataDir },
      profilePin: defaultPin,
      initialOwnership: { ownedTargetIds: [] },
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

    const stub = createStubTransport({
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
    });

    const client = createBrowserClient({
      namespace: "test-stale-target",
      transport: stub.transport,
      remote: { cdpUrl: "ws://127.0.0.1:9222/devtools/browser/b1", browserId: "b1", userDataDir: defaultPin.userDataDir },
      profilePin: defaultPin,
      initialOwnership: {
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

    const stub = createStubTransport({
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
    });

    // Client was configured with remote browser "browser-a", but transport connects to "browser-b"
    const client = createBrowserClient({
      namespace: "test-browser-change",
      transport: stub.transport,
      remote: { cdpUrl: "ws://127.0.0.1:9222/devtools/browser/browser-b", browserId: "browser-a", userDataDir: defaultPin.userDataDir },
      profilePin: defaultPin,
      initialOwnership: {
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

    const stub = createStubTransport({
      "Target.setDiscoverTargets": ok({}),
      "Target.getTargets": ok({
        targetInfos: [
          { targetId: "hw-tab", type: "page", title: "Tab", url: "https://example.test/" },
        ],
      }),
    });

    const client = createBrowserClient({
      namespace: "test-ambiguous-reuse",
      transport: stub.transport,
      remote: { cdpUrl: "ws://127.0.0.1:9222/devtools/browser/b1", browserId: "b1", userDataDir: defaultPin.userDataDir },
      profilePin: defaultPin,
      initialOwnership: {
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

    const stub = createStubTransport({
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
    });

    const client = createBrowserClient({
      namespace: "test-context-absence",
      transport: stub.transport,
      remote: { cdpUrl: "ws://127.0.0.1:9222/devtools/browser/b1", browserId: "b1", userDataDir: defaultPin.userDataDir },
      profilePin: defaultPin,
      // Fresh client with no prior ownership
      initialOwnership: { ownedTargetIds: [] },
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

    const stub = createStubTransport({
      "Target.setDiscoverTargets": ok({}),
      "Target.getTargets": ok({
        targetInfos: [
          { targetId: "hw-work", type: "page", title: "Work Tab", url: "https://work.test/", browserContextId: "ctx-work" },
        ],
      }),
    });

    const client = createBrowserClient({
      namespace: "test-pin-change",
      transport: stub.transport,
      remote: { cdpUrl: "ws://127.0.0.1:9222/devtools/browser/b1", browserId: "b1", userDataDir: workPin.userDataDir },
      profilePin: workPin,
      initialOwnership: {
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

    // Changing pin to Default clears ownership
    client.setProfilePin(defaultPin);
    assert.equal(client.owns("hw-work"), false, "ownership must be cleared on pin change");
    assert.equal(client.ownership().harnessWindow(), undefined, "harness window must be cleared on pin change");
    assert.equal(client.profileContext().kind, "unresolved");
  });

  test("fresh client with restored ownership from different pin rejects reuse and launches verified window", async () => {
    const launches: ProfileWindowRequest[] = [];
    const seedDeps = createMockSeedDeps({ launches, targetUserDataDir: defaultPin.userDataDir });

    const stub = createStubTransport({
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
    });

    // Initial ownership was for workPin, but client is started with defaultPin
    const client = createBrowserClient({
      namespace: "test-pin-mismatch",
      transport: stub.transport,
      remote: { cdpUrl: "ws://127.0.0.1:9222/devtools/browser/b1", browserId: "b1", userDataDir: defaultPin.userDataDir },
      profilePin: defaultPin,
      initialOwnership: {
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
});
