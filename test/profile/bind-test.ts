import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { seedProfileWindow, unlinkedEndpointHint, type SeedDeps } from "../../src/profile/bind";
import type { BrowserClient } from "../../src/client";
import type { ProfilePin } from "../../src/profile/store";
import {
  type RunningBrowser,
  type BrowserCandidate,
  selectBrowserCandidate,
  parseProcCmdline,
  userDataDirFromArgv,
} from "../../src/profile/browser-process";
import type { ProfileWindowRequest } from "../../src/profile/launch";
import { cdpError } from "../../src/cdp/errors";
import { err, ok } from "../../src/util/result";
import { createFakeClient, type Canned, type FakeClient } from "../domains/fake-client";

const pin: ProfilePin = {
  userDataDir: "/home/u/.config/google-chrome",
  profileDir: "Profile 1",
  label: "Work (work@example.com)",
  savedAt: "",
};

const SENTINEL = "file:///tmp/pi-harness-abc.html";
const EXE = "/usr/bin/google-chrome";

const page = (targetId: string, url: string, browserContextId?: string) => ({
  targetId,
  type: "page",
  title: "",
  url,
  ...(browserContextId === undefined ? {} : { browserContextId }),
});

type Seeded = {
  readonly fake: FakeClient;
  readonly client: BrowserClient;
  readonly deps: SeedDeps;
  readonly launches: ReadonlyArray<ProfileWindowRequest>;
  readonly detects: ReadonlyArray<string | undefined>;
  readonly sleeps: ReadonlyArray<number>;
  readonly contexts: ReadonlyArray<string | undefined>;
  readonly cleanups: () => number;
  readonly kills: () => number;
};

// The machine-facing steps are recorders; the clock advances by exactly the slept amount so the
// deadline is deterministic. `canned` queues the Target.getTargets answers the sentinel poll sees
// (the fake client's own attach consumes the first entry).
const seeded = async (opts: {
  readonly canned?: Canned;
  readonly running?: RunningBrowser;
  readonly exePath?: string | undefined;
  readonly launchError?: string;
  readonly deadlineMs?: number;
  readonly userDataDir?: string | undefined;
} = {}): Promise<Seeded> => {
  const fake = await createFakeClient(opts.canned === undefined ? {} : { canned: opts.canned });
  const contexts: Array<string | undefined> = [];
  const client: BrowserClient = {
    ...fake.client,
    userDataDir: () => "userDataDir" in opts ? opts.userDataDir : pin.userDataDir,
    profilePin: () => pin,
    setProfileContextId: (id) => { contexts.push(id); },
  };
  const launches: ProfileWindowRequest[] = [];
  const detects: Array<string | undefined> = [];
  const sleeps: number[] = [];
  let cleanups = 0;
  let kills = 0;
  let clock = 1_000;
  const running: RunningBrowser = opts.running ?? { running: true, exePath: EXE };
  const deps: SeedDeps = {
    detectRunningBrowser: (prefer) => { detects.push(prefer); return Promise.resolve(running); },
    resolveBrowserExecutable: (r) => {
      if (r?.ambiguous) return Promise.resolve(undefined);
      return Promise.resolve("exePath" in opts ? opts.exePath : r?.exePath ?? EXE);
    },
    openProfileWindow: (req) => {
      launches.push(req);
      if (opts.launchError !== undefined) return Promise.resolve(err(opts.launchError));
      return Promise.resolve(ok({
        sentinelUrl: SENTINEL,
        cleanup: () => { cleanups++; return Promise.resolve(); },
        kill: () => { kills++; },
      }));
    },
    sleep: (ms) => { sleeps.push(ms); clock += ms; return Promise.resolve(); },
    now: () => clock,
    deadlineMs: opts.deadlineMs ?? 1_500,
    pollMs: 500,
  };
  return { fake, client, deps, launches, detects, sleeps, contexts, cleanups: () => cleanups, kills: () => kills };
};

describe("seedProfileWindow", () => {
  test("refuses to seed when the connected browser is a different user-data-dir than the pin's", async () => {
    const s = await seeded();
    const client: BrowserClient = { ...s.client, userDataDir: () => "/home/u/.config/BraveSoftware/Brave-Browser" };
    const windowBefore = s.fake.ownership.harnessWindow();

    const r = await seedProfileWindow(client, pin, s.deps);

    assert.equal(r.success, false);
    assert.equal(r.error.kind, "discovery_failed");
    assert.match(r.error.message, /"Work \(work@example\.com\)" belongs to \/home\/u\/\.config\/google-chrome/);
    assert.match(r.error.message, /connected to \/home\/u\/\.config\/BraveSoftware\/Brave-Browser/);
    assert.match(r.error.message, /\/browser-profile/);
    assert.equal(s.fake.calls.length, 0, "no CDP traffic before the guard");
    assert.deepEqual(s.contexts, []);
    assert.deepEqual(s.detects, [], "the machine is not scanned");
    assert.deepEqual(s.launches, []);
    assert.equal(s.fake.ownership.harnessWindow(), windowBefore, "ownership is untouched");
  });

  test("the mismatch check is exact, not a prefix match", async () => {
    const s = await seeded();
    const client: BrowserClient = { ...s.client, userDataDir: () => `${pin.userDataDir}-beta` };
    const r = await seedProfileWindow(client, pin, s.deps);
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "discovery_failed");
    assert.match(r.error.message, /belongs to/);
  });

  test("polls for the sentinel, adopts the seeded tab and resets it through a borrowed session", async () => {
    const s = await seeded({
      canned: {
        "Target.getTargets": [
          ok({ targetInfos: [page("t1", "https://example.test/")] }),
          ok({ targetInfos: [page("t1", "https://example.test/")] }),
          ok({ targetInfos: [page("t1", "https://example.test/"), page("seed", SENTINEL, "ctx-9")] }),
        ],
        "Target.attachToTarget": [ok({ sessionId: "s1" }), ok({ sessionId: "s-seed" })],
        "Browser.getWindowForTarget": [ok({ windowId: 7 }), ok({ windowId: 42 })],
      },
    });

    const r = await seedProfileWindow(s.client, pin, s.deps);

    assert.ok(r.success, r.success ? "" : r.error.message);
    assert.equal(r.data, "seed");
    assert.deepEqual(s.detects, [pin.userDataDir], "the pin's dir is preferred when nothing is connected");
    assert.deepEqual(s.launches, [{ exePath: EXE, profileDir: "Profile 1" }]);
    assert.deepEqual(s.sleeps, [500, 500], "one poll missed the sentinel, the next found it");
    assert.deepEqual(s.contexts, ["ctx-9"], "the sentinel's browser context is the profile's");
    assert.equal(s.fake.ownership.harnessWindow(), "seed");
    assert.equal(s.fake.ownership.has("seed"), true);
    assert.equal(s.fake.ownership.harnessWindowId(), 42);

    const methods = s.fake.calls.map((c) => c.method);
    assert.deepEqual(methods, [
      "Target.getTargets",
      "Target.getTargets",
      "Browser.getWindowForTarget",
      "Target.attachToTarget",
      "Page.navigate",
      "Target.detachFromTarget",
    ]);
    const navigate = s.fake.callsTo("Page.navigate")[0];
    assert.ok(navigate);
    assert.deepEqual(navigate.params, { url: "about:blank" });
    assert.equal(navigate.sessionId, "s-seed", "the reset rides on the borrowed session");
    assert.deepEqual(s.fake.callsTo("Target.detachFromTarget")[0]?.params, { sessionId: "s-seed" });
    assert.equal(s.cleanups(), 1);
    assert.equal(s.kills(), 0);
  });

  test("forwards the running browser's explicit user-data-dir to the launcher", async () => {
    const s = await seeded({
      running: { running: true, exePath: EXE, explicitUserDataDir: "/home/u/.config/google-chrome" },
      canned: {
        "Target.getTargets": [
          ok({ targetInfos: [page("t1", "https://example.test/")] }),
          ok({ targetInfos: [page("seed", SENTINEL)] }),
        ],
      },
    });
    const r = await seedProfileWindow(s.client, pin, s.deps);
    assert.ok(r.success);
    assert.deepEqual(s.launches, [{ exePath: EXE, profileDir: "Profile 1", explicitUserDataDir: "/home/u/.config/google-chrome" }]);
    assert.deepEqual(s.contexts, [], "no context is recorded when the sentinel reports none");
  });

  test("a sentinel tab the harness already tracks is reset on that session without a detach", async () => {
    const s = await seeded({
      canned: {
        "Target.getTargets": [
          ok({ targetInfos: [page("t1", "https://example.test/")] }),
          ok({ targetInfos: [page("t1", SENTINEL)] }),
        ],
      },
    });
    const r = await seedProfileWindow(s.client, pin, s.deps);
    assert.ok(r.success);
    assert.equal(r.data, "t1");
    assert.equal(s.fake.callsTo("Page.navigate")[0]?.sessionId, "s1");
    assert.equal(s.fake.callsTo("Target.attachToTarget").length, 0);
    assert.equal(s.fake.callsTo("Target.detachFromTarget").length, 0);
  });

  test("the sentinel is still cleaned up when the borrowed attach fails", async () => {
    const s = await seeded({
      canned: {
        "Target.getTargets": [
          ok({ targetInfos: [page("t1", "https://example.test/")] }),
          ok({ targetInfos: [page("seed", SENTINEL)] }),
        ],
        "Target.attachToTarget": [ok({ sessionId: "s1" }), err(cdpError("remote_error", "gone"))],
      },
    });
    const r = await seedProfileWindow(s.client, pin, s.deps);
    assert.ok(r.success, "a failed reset does not fail the seed");
    assert.equal(s.fake.callsTo("Page.navigate").length, 0);
    assert.equal(s.cleanups(), 1);
  });

  test("no browser executable is a discovery failure with the manual fallback", async () => {
    const s = await seeded({ exePath: undefined });
    const r = await seedProfileWindow(s.client, pin, s.deps);
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "discovery_failed");
    assert.match(r.error.message, /could not locate the browser executable needed to open "Work \(work@example\.com\)"/);
    assert.match(r.error.message, /browser profile menu → Profile 1/);
    assert.deepEqual(s.launches, []);
    assert.equal(s.fake.calls.length, 0);
  });

  test("ambiguous browser candidates produce a precise error and zero launches before spawn", async () => {
    const s = await seeded({
      running: {
        running: true,
        ambiguous: true,
        error: "ambiguous browser identity: multiple candidates (/opt/google/chrome/chrome, /home/u/.agent-browser/browsers/chrome-150/chrome) found without an explicit user-data-dir flag for /home/u/.config/google-chrome",
      },
    });
    const r = await seedProfileWindow(s.client, pin, s.deps);
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "discovery_failed");
    assert.match(r.error.message, /could not verify browser identity/i);
    assert.match(r.error.message, /ambiguous browser identity/i);
    assert.match(r.error.message, /browser profile menu → Profile 1/);
    assert.deepEqual(s.launches, [], "zero launches on ambiguous identity");
    assert.equal(s.fake.calls.length, 0, "no CDP calls on ambiguous identity");
  });

  test("ambiguous candidate processes with absent flags in both candidate orders produce zero launches", async () => {
    const chromeCandidate: BrowserCandidate = { exePath: "/opt/google/chrome/chrome" };
    const cftCandidate: BrowserCandidate = { exePath: "/home/u/.agent-browser/browsers/chrome-150/chrome" };

    // Order 1: [Chrome, CFT]
    const s1 = await seeded({
      running: selectBrowserCandidate([chromeCandidate, cftCandidate], pin.userDataDir),
    });
    const r1 = await seedProfileWindow(s1.client, pin, s1.deps);
    assert.equal(r1.success, false);
    assert.equal(r1.error.kind, "discovery_failed");
    assert.match(r1.error.message, /ambiguous/i);
    assert.deepEqual(s1.launches, [], "order 1 produces zero launches");

    // Order 2: [CFT, Chrome]
    const s2 = await seeded({
      running: selectBrowserCandidate([cftCandidate, chromeCandidate], pin.userDataDir),
    });
    const r2 = await seedProfileWindow(s2.client, pin, s2.deps);
    assert.equal(r2.success, false);
    assert.equal(r2.error.kind, "discovery_failed");
    assert.match(r2.error.message, /ambiguous/i);
    assert.deepEqual(s2.launches, [], "order 2 produces zero launches");
  });

  test("sole CFT candidate without explicit user-data-dir flag fails closed before spawn with zero launches", async () => {
    const cftCandidate: BrowserCandidate = { exePath: "/home/u/.agent-browser/browsers/chrome-150/chrome" };
    const s = await seeded({
      running: selectBrowserCandidate([cftCandidate], pin.userDataDir),
    });
    const r = await seedProfileWindow(s.client, pin, s.deps);
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "discovery_failed");
    assert.match(r.error.message, /ambiguous/i);
    assert.deepEqual(s.launches, [], "zero launches for sole CFT candidate without explicit flag");
    assert.equal(s.fake.calls.length, 0);
  });

  test("unknown endpoint (client has no verified user-data-dir) fails closed before spawn with zero launches", async () => {
    const s = await seeded({ userDataDir: undefined });
    const r = await seedProfileWindow(s.client, pin, s.deps);
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "discovery_failed");
    assert.match(r.error.message, /no verified user-data-dir endpoint linkage/i);
    assert.match(r.error.message, /cannot be proven to belong to/i);
    assert.match(r.error.message, /\/browser-setup/);
    assert.match(r.error.message, /\/browser-profile/);
    assert.ok(r.error.message.includes(unlinkedEndpointHint(pin)));
    assert.deepEqual(s.launches, [], "zero launches on unverified endpoint");
    assert.equal(s.fake.calls.length, 0);
  });

  test("mismatched running explicit user-data-dir produces a precise error and zero launches before spawn", async () => {
    const s = await seeded({
      running: {
        running: true,
        exePath: EXE,
        explicitUserDataDir: "/home/u/.config/BraveSoftware/Brave-Browser",
      },
    });
    const r = await seedProfileWindow(s.client, pin, s.deps);
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "discovery_failed");
    assert.match(r.error.message, /user-data-dir/i);
    assert.match(r.error.message, /does not match the pinned profile/i);
    assert.deepEqual(s.launches, [], "zero launches on directory mismatch");
    assert.equal(s.fake.calls.length, 0);
  });

  test("verified positive identity permits the correct service-window launch with explicitUserDataDir", async () => {
    const chromeCandidate: BrowserCandidate = {
      exePath: EXE,
      explicitUserDataDir: pin.userDataDir,
    };
    const cftCandidate: BrowserCandidate = {
      exePath: "/home/u/.agent-browser/browsers/chrome-150/chrome",
    };
    const s = await seeded({
      running: selectBrowserCandidate([cftCandidate, chromeCandidate], pin.userDataDir),
      canned: {
        "Target.getTargets": [
          ok({ targetInfos: [page("t1", "https://example.test/")] }),
          ok({ targetInfos: [page("seed", SENTINEL, "ctx-1")] }),
        ],
        "Target.attachToTarget": [ok({ sessionId: "s1" }), ok({ sessionId: "s-seed" })],
        "Browser.getWindowForTarget": [ok({ windowId: 7 }), ok({ windowId: 42 })],
      },
    });
    const r = await seedProfileWindow(s.client, pin, s.deps);
    assert.ok(r.success, r.success ? "" : r.error.message);
    assert.deepEqual(s.launches, [{
      exePath: EXE,
      profileDir: "Profile 1",
      explicitUserDataDir: pin.userDataDir,
    }]);
  });

  test("verified positive identity with rewritten process-title explicit flag permits launch", async () => {
    const argv = parseProcCmdline(`${EXE} --user-data-dir=${pin.userDataDir}\0`);
    const explicit = userDataDirFromArgv(argv);
    assert.equal(explicit, pin.userDataDir);
    const s = await seeded({
      running: selectBrowserCandidate([
        { exePath: "/home/u/.agent-browser/browsers/chrome-150/chrome" },
        { exePath: EXE, explicitUserDataDir: explicit },
      ], pin.userDataDir),
      canned: {
        "Target.getTargets": [
          ok({ targetInfos: [page("t1", "https://example.test/")] }),
          ok({ targetInfos: [page("seed", SENTINEL, "ctx-1")] }),
        ],
        "Target.attachToTarget": [ok({ sessionId: "s1" }), ok({ sessionId: "s-seed" })],
        "Browser.getWindowForTarget": [ok({ windowId: 7 }), ok({ windowId: 42 })],
      },
    });
    const r = await seedProfileWindow(s.client, pin, s.deps);
    assert.ok(r.success);
    assert.deepEqual(s.launches, [{
      exePath: EXE,
      profileDir: "Profile 1",
      explicitUserDataDir: pin.userDataDir,
    }]);
  });

  test("a failed launch is a discovery failure carrying the launcher's reason", async () => {
    const s = await seeded({ launchError: "could not launch /usr/bin/google-chrome: ENOENT" });
    const r = await seedProfileWindow(s.client, pin, s.deps);
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "discovery_failed");
    assert.match(r.error.message, /^could not launch \/usr\/bin\/google-chrome: ENOENT — open a window for "Work/);
    assert.deepEqual(s.sleeps, [], "nothing is polled");
    assert.equal(s.fake.calls.length, 0);
  });

  test("a sentinel that never appears times out, kills the launcher and leaves ownership untouched", async () => {
    const s = await seeded({ deadlineMs: 1_500 });
    const windowBefore = s.fake.ownership.harnessWindow();
    const r = await seedProfileWindow(s.client, pin, s.deps);
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "timeout");
    assert.match(r.error.message, /couldn't open a window in "Work \(work@example\.com\)" automatically/);
    assert.deepEqual(s.sleeps, [500, 500, 500], "polls until the deadline passes");
    assert.equal(s.fake.callsTo("Target.getTargets").length, 3);
    assert.equal(s.kills(), 1);
    assert.equal(s.cleanups(), 1);
    assert.deepEqual(s.contexts, []);
    assert.equal(s.fake.ownership.harnessWindow(), windowBefore);
    assert.equal(s.fake.callsTo("Page.navigate").length, 0);
  });
});
