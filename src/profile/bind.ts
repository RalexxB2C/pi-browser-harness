import type { BrowserClient } from "../client";
import type { ResultOf } from "../cdp/commands";
import { type CdpError, cdpError } from "../cdp/errors";
import { borrowSession } from "../cdp/target-factory";
import { type Result, err, map, ok, unwrapOr } from "../util/result";
import { sleep as sleepMs } from "../util/sleep";
import { detectRunningBrowser, resolveBrowserExecutable, type RunningBrowser } from "./browser-process";
import { openProfileWindow, type ProfileWindowHandle, type ProfileWindowRequest } from "./launch";
import type { ProfilePin } from "./store";

const SEED_DEADLINE_MS = 15_000;
const SEED_POLL_MS = 500;

// The machine-facing steps of seeding: process detection, executable lookup, the window launch
// and the sentinel poll's clock. Each defaults to the real implementation.
export type SeedDeps = {
  readonly detectRunningBrowser?: (preferUserDataDir?: string) => Promise<RunningBrowser>;
  readonly resolveBrowserExecutable?: (running?: RunningBrowser) => Promise<string | undefined>;
  readonly openProfileWindow?: (req: ProfileWindowRequest) => Promise<Result<ProfileWindowHandle, string>>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly deadlineMs?: number;
  readonly pollMs?: number;
};


type PageTarget = ResultOf<"Target.getTargets">["targetInfos"][number];

const pageTargets = async (client: BrowserClient): Promise<ReadonlyArray<PageTarget>> => {
  const r = await client.session().callBrowser("Target.getTargets");
  return unwrapOr(
    map(r, (d): ReadonlyArray<PageTarget> => d.targetInfos.filter((t) => t.type === "page")),
    [],
  );
};

const manualFallbackHint = (pin: ProfilePin): string =>
  `open a window for "${pin.label}" yourself (browser profile menu → ${pin.profileDir}), then retry. ` +
  `Run /browser-profile to pick a different profile, or clear the selection to use whichever window is focused.`;

export const verifyConnectedBrowserIdentity = async (
  client: BrowserClient,
  pin: ProfilePin,
  deps: SeedDeps = {},
): Promise<Result<{ exePath: string; running: RunningBrowser }, CdpError>> => {
  const detect = deps.detectRunningBrowser ?? detectRunningBrowser;
  const resolveExe = deps.resolveBrowserExecutable ?? resolveBrowserExecutable;

  const connectedDir = client.userDataDir();
  if (!connectedDir) {
    return err(cdpError(
      "discovery_failed",
      `could not verify connected browser identity for "${pin.label}": connected browser has no verified user-data-dir endpoint linkage — ${manualFallbackHint(pin)}`,
    ));
  }
  if (connectedDir !== pin.userDataDir) {
    return err(cdpError(
      "discovery_failed",
      `the selected profile "${pin.label}" belongs to ${pin.userDataDir}, but the harness is connected to ${connectedDir}. ` +
      `Run /browser-profile to choose a profile in the browser you're using.`,
    ));
  }

  const targetUserDataDir = connectedDir;
  const running = await detect(targetUserDataDir);
  if (running.ambiguous) {
    return err(cdpError(
      "discovery_failed",
      `could not verify browser identity for "${pin.label}": ${running.error ?? "ambiguous browser candidates"} — ${manualFallbackHint(pin)}`,
    ));
  }
  if (!running.running) {
    return err(cdpError(
      "discovery_failed",
      running.error
        ? `${running.error} — ${manualFallbackHint(pin)}`
        : `could not locate the browser executable needed to open "${pin.label}" — ${manualFallbackHint(pin)}`,
    ));
  }
  if (running.explicitUserDataDir && running.explicitUserDataDir !== targetUserDataDir) {
    return err(cdpError(
      "discovery_failed",
      `running browser's user-data-dir (${running.explicitUserDataDir}) does not match the pinned profile (${targetUserDataDir}) — ${manualFallbackHint(pin)}`,
    ));
  }
  const exePath = await resolveExe(running);
  if (!exePath) {
    return err(cdpError(
      "discovery_failed",
      `could not locate the browser executable needed to open "${pin.label}" — ${manualFallbackHint(pin)}`,
    ));
  }

  return ok({ exePath, running });
};

export const seedProfileWindow = async (
  client: BrowserClient,
  pin: ProfilePin,
  deps: SeedDeps = {},
): Promise<Result<string, CdpError>> => {
  const launch = deps.openProfileWindow ?? openProfileWindow;
  const sleep = deps.sleep ?? sleepMs;
  const now = deps.now ?? Date.now;
  const deadlineMs = deps.deadlineMs ?? SEED_DEADLINE_MS;
  const pollMs = deps.pollMs ?? SEED_POLL_MS;

  const verified = await verifyConnectedBrowserIdentity(client, pin, deps);
  if (!verified.success) return verified;
  const { exePath, running } = verified.data;

  const launched = await launch({
    exePath,
    profileDir: pin.profileDir,
    // ProcessSingleton keys on the user-data-dir path, so forward only the value the running browser reports: a reconstructed one may differ by case and start a SECOND browser.
    ...(running.explicitUserDataDir ? { explicitUserDataDir: running.explicitUserDataDir } : {}),
  });
  if (!launched.success) {
    return err(cdpError("discovery_failed", `${launched.error} — ${manualFallbackHint(pin)}`));
  }

  const { sentinelUrl, cleanup, kill } = launched.data;
  const deadline = now() + deadlineMs;
  let seed: PageTarget | undefined;
  while (now() < deadline && !seed) {
    await sleep(pollMs);
    seed = (await pageTargets(client)).find((t) => t.url === sentinelUrl);
  }

  if (!seed) {
    kill();
    await cleanup();
    return err(cdpError(
      "timeout",
      `couldn't open a window in "${pin.label}" automatically — ${manualFallbackHint(pin)}`,
    ));
  }

  // The sentinel's context is the profile's context — the only way to learn it.
  if (seed.browserContextId) {
    client.setProfileContext({ kind: "named", contextId: seed.browserContextId });
    client.setProfileContextId(seed.browserContextId);
  } else {
    client.setProfileContext({ kind: "default" });
  }

  const ownership = client.ownership();
  ownership.setHarnessWindow(seed.targetId);
  ownership.add(seed.targetId);
  const win = await client.session().windowId(seed.targetId);
  if (win.success) ownership.setHarnessWindowId(win.data);

  // Clears the sentinel URL from the seed tab. The session is borrowed and released so an untracked attach never outlives this call.
  const borrowed = await borrowSession(client, seed.targetId);
  if (borrowed.success) {
    try {
      await client.session().callOnTarget("Page.navigate", { url: "about:blank" }, borrowed.data.sessionId);
    } finally {
      await borrowed.data.release();
    }
  }
  await cleanup();

  return ok(seed.targetId);
};
