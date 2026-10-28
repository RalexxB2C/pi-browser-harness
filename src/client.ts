import { DAEMON_RECONNECT_METHOD } from "./daemon/protocol";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { parseJson } from "./schemas/parse";
import { type Result, err, ok } from "./util/result";
import { safeJs } from "./util/js-template";
import { type Mutex, createMutex } from "./util/mutex";
import { discoverEndpoint, type CdpEndpoint } from "./cdp/discovery";
import { type CdpError, cdpError } from "./cdp/errors";
import type { CdpTransport } from "./cdp/types";
import { type CdpSession, createCdpSession } from "./cdp/session";
import { type OwnershipRegistry, createOwnershipRegistry, reconcileOwnership } from "./cdp/ownership";
import { ensureHarnessWindow, openHarnessTab } from "./cdp/target-factory";
import { seedProfileWindow, type SeedDeps, verifyConnectedBrowserIdentity } from "./profile/bind";
import type { ProfilePin } from "./profile/store";
import type { DaemonStatus, DialogInfo, PageInfo, PageInfoResult, TabInfo } from "./cdp/types";

export type ProfileContext =
  | { readonly kind: "unresolved" }
  | { readonly kind: "default" }
  | { readonly kind: "named"; readonly contextId: string };

export type BrowserClientOptions = {
  readonly namespace: string;
  readonly transport: CdpTransport;
  readonly remote?: {
    readonly cdpUrl: string;
    readonly browserId: string;
    readonly userDataDir?: string;
  };
  readonly initialOwnership?: {
    readonly namespace?: string;
    readonly browserId?: string;
    readonly userDataDir?: string;
    readonly profilePin?: { readonly userDataDir: string; readonly profileDir: string };
    readonly ownedTargetIds?: ReadonlyArray<string>;
    readonly harnessWindowTargetId?: string;
    readonly harnessWindowId?: number;
    readonly profileContext?: ProfileContext;
    readonly profileContextId?: string;
  };
  readonly profilePin?: ProfilePin | null;
  readonly onOwnershipChange?: (snapshot: {
    readonly browserId?: string | undefined;
    readonly userDataDir?: string | undefined;
    readonly profilePin?: { readonly userDataDir: string; readonly profileDir: string } | undefined;
    readonly ownedTargetIds: ReadonlyArray<string>;
    readonly harnessWindowTargetId: string | undefined;
    readonly harnessWindowId: number | undefined;
    readonly profileContext?: ProfileContext | undefined;
  }) => void;
  readonly seedDeps?: SeedDeps;
  readonly discoverEndpoint?: () => Promise<Result<CdpEndpoint, CdpError>>;
};

export type BrowserClient = {
  readonly namespace: string;
  browserId(): string | undefined;
  latchedFailure(): CdpError | null;
  ensureAlive(): Promise<Result<void, CdpError>>;
  status(): DaemonStatus;
  // `reconnectNow` is for explicit human demand (/browser-setup, /browser-reload-daemon): it asks the
  // daemon to dial Chrome immediately even if it is cooling down after a failed attempt.
  start(opts?: { readonly reconnectNow?: boolean; readonly retrySetup?: boolean }): Promise<Result<void, CdpError>>;
  stop(): Promise<void>;
  detach(): Promise<void>;
  closeOwnedTabs(): Promise<void>;
  evaluateJs(expression: string, sessionId?: string): Promise<Result<unknown, CdpError>>;
  pageInfo(): Promise<Result<PageInfoResult, CdpError>>;
  takeDialog(): DialogInfo | null;
  listTabs(includeInternal?: boolean): Promise<Result<ReadonlyArray<TabInfo>, CdpError>>;
  switchTab(targetId: string): Promise<Result<void, CdpError>>;
  newTab(url?: string): Promise<Result<string, CdpError>>;
  closeTab(targetId: string): Promise<Result<void, CdpError>>;
  owns(targetId: string): boolean;
  ownership(): OwnershipRegistry;
  current(): { readonly sessionId: string; readonly targetId: string } | null;
  session(): CdpSession;
  transport(): CdpTransport;
  userDataDir(): string | undefined;
  profilePin(): ProfilePin | null;
  profileGeneration(): number;
  setProfilePin(pin: ProfilePin | null): void;
  profileContext(): ProfileContext;
  setProfileContext(context: ProfileContext): void;
  profileContextId(): string | undefined;
  setProfileContextId(contextId: string | undefined): void;
  verifyProfileIdentity(): Promise<Result<void, CdpError>>;
  seedPinnedProfileWindow(): Promise<Result<string, CdpError>>;
  mutationMutex(): Mutex;
};

const HEALTH_TTL_MS = 30_000;
const PAGE_INFO_TTL_MS = 1_000;

const PageInfoPayload = Type.Object({
  url: Type.String(),
  title: Type.String(),
  w: Type.Number(),
  h: Type.Number(),
  sx: Type.Number(),
  sy: Type.Number(),
  pw: Type.Number(),
  ph: Type.Number(),
});

const pageInfoValidator = Compile(PageInfoPayload);

const parsePageInfoPayload = (raw: string): Result<PageInfo, CdpError> => {
  const parsed = parseJson(raw, pageInfoValidator);
  if (!parsed.success) {
    return err(cdpError("invalid_response", `page info payload is invalid: ${parsed.error}`));
  }
  const o = parsed.data;
  return ok({
    url: o.url,
    title: o.title,
    width: o.w,
    height: o.h,
    scrollX: o.sx,
    scrollY: o.sy,
    pageWidth: o.pw,
    pageHeight: o.ph,
  });
};

const samePin = (
  a?: { readonly userDataDir: string; readonly profileDir: string } | null,
  b?: ProfilePin | null,
): boolean => {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.userDataDir === b.userDataDir && a.profileDir === b.profileDir;
};

export const createBrowserClient = (opts: BrowserClientOptions): BrowserClient => {
  const transport = opts.transport;
  const initialProvenanceValid =
    opts.initialOwnership?.namespace === opts.namespace &&
    opts.initialOwnership.browserId !== undefined &&
    (opts.profilePin
      ? opts.initialOwnership.profilePin !== undefined && samePin(opts.initialOwnership.profilePin, opts.profilePin)
      : opts.initialOwnership.profilePin === undefined);

  const init = initialProvenanceValid ? opts.initialOwnership : undefined;
  const ownershipInit: { ownedTargetIds?: ReadonlyArray<string>; harnessWindowTargetId?: string; harnessWindowId?: number } = {};
  if (init?.ownedTargetIds !== undefined) {
    ownershipInit.ownedTargetIds = init.ownedTargetIds;
  }
  if (init?.harnessWindowTargetId !== undefined) {
    ownershipInit.harnessWindowTargetId = init.harnessWindowTargetId;
  }
  if (init?.harnessWindowId !== undefined) {
    ownershipInit.harnessWindowId = init.harnessWindowId;
  }
  const ownership = createOwnershipRegistry(ownershipInit);
  let profileContext: ProfileContext = init?.profileContext
    ?? (init?.profileContextId !== undefined
      ? { kind: "named", contextId: init.profileContextId }
      : { kind: "unresolved" });
  let profileContextId: string | undefined = profileContext.kind === "named" ? profileContext.contextId : undefined;

  const notifyOwnership = (): void => {
    if (opts.onOwnershipChange) {
      opts.onOwnershipChange({
        browserId: remote?.browserId ?? opts.initialOwnership?.browserId,
        userDataDir,
        profilePin: profilePin
          ? { userDataDir: profilePin.userDataDir, profileDir: profilePin.profileDir }
          : undefined,
        ownedTargetIds: ownership.list(),
        harnessWindowTargetId: ownership.harnessWindow(),
        harnessWindowId: ownership.harnessWindowId(),
        profileContext,
      });
    }
  };

  if (opts.onOwnershipChange) {
    ownership.onChange(notifyOwnership);
  }
  const session = createCdpSession(transport, ownership, async () => {
    const window = await ensureHarnessWindow(api);
    return window.success ? ok(window.data.targetId) : window;
  }, () => pinGeneration);
  const mutationMutex = createMutex();
  let latchedInitFailure: CdpError | null = null;
  let inFlightInit: Promise<Result<void, CdpError>> | null = null;
  let inExplicitRetry = false;
  let pinGeneration = 0;
  let lastHealth = 0;
  let healthCheck: Promise<Result<void, CdpError>> | null = null;
  const pageCaches = new Map<string, { readonly info: PageInfo; readonly at: number }>();
  let remote: BrowserClientOptions["remote"] | null = opts.remote ?? null;
  let userDataDir: string | undefined;
  let profilePin: ProfilePin | null = opts.profilePin ?? null;

  transport.onClose(() => {
    // Lost endpoint evidence invalidates in-flight profile work even when the pin is unchanged.
    pinGeneration++;
    userDataDir = undefined;
    remote = null;
  });

  let registryProvenance: {
    readonly namespace: string;
    readonly browserId?: string | undefined;
    readonly profilePin?: { readonly userDataDir: string; readonly profileDir: string } | undefined;
  } | null = init
    ? {
        namespace: opts.namespace,
        browserId: init.browserId,
        profilePin: init.profilePin,
      }
    : null;

  // With a pin set the window must exist BEFORE anything attaches, or attachFirstPage's bare Target.createTarget lands in the focus-derived default profile.
  const seedIfPinned = async (): Promise<Result<void, CdpError>> => {
    if (!profilePin) return ok(undefined);
    const window = await ensureHarnessWindow(api);
    if (!window.success) return window;
    return ok(undefined);
  };

  const doStart = async (
    startOpts: { readonly reconnectNow?: boolean; readonly retrySetup?: boolean } = {},
  ): Promise<Result<void, CdpError>> => {
    const currentPinGen = pinGeneration;
    if (transport.state() === "open" && session.current()) {
      latchedInitFailure = null;
      return ok(undefined);
    }
    let wsUrl: string;
    if (opts.remote?.cdpUrl) {
      wsUrl = opts.remote.cdpUrl;
    } else {
      const discover = opts.discoverEndpoint ?? discoverEndpoint;
      const discovered = await discover();
      if (!discovered.success) {
        latchedInitFailure = discovered.error;
        return discovered;
      }
      wsUrl = discovered.data.wsUrl;
    }
    const connected = await transport.connect(wsUrl, { timeoutMs: 10_000 });
    if (!connected.success) {
      latchedInitFailure = connected.error;
      return connected;
    }
    if (startOpts.reconnectNow) {
      // Only the daemon understands this; a direct Chrome transport answers "method not found",
      // which is fine because it has no cooldown to clear.
      const dialed = await transport.request(DAEMON_RECONNECT_METHOD, {}, { timeoutMs: 15_000 });
      if (!dialed.success && dialed.error.kind !== "remote_error") {
        latchedInitFailure = dialed.error;
        await transport.close();
        return dialed;
      }
    }

    // Authoritative connected transport proof ONLY: constructor opts.remote must not authorize daemon spawn
    const actual = transport.actualEndpoint?.();
    let newBrowserId: string;
    let transportUserDataDir: string | undefined;
    if (actual) {
      if (actual.wsUrl) wsUrl = actual.wsUrl;
      transportUserDataDir = actual.userDataDir;
      newBrowserId = actual.browserId ?? (actual.wsUrl ? actual.wsUrl.split("/").pop() ?? "unknown" : "unknown");
    } else {
      transportUserDataDir = undefined;
      newBrowserId = "unknown";
    }

    userDataDir = transportUserDataDir;

    if (registryProvenance !== null) {
      const browserMatches = Boolean(
        registryProvenance.browserId &&
        registryProvenance.browserId === newBrowserId &&
        newBrowserId !== "unknown",
      );
      const pinMatches =
        profilePin !== null
          ? registryProvenance.profilePin !== undefined && samePin(registryProvenance.profilePin, profilePin)
          : registryProvenance.profilePin === undefined;
      const namespaceMatches = registryProvenance.namespace === opts.namespace;

      if (!browserMatches || !pinMatches || !namespaceMatches) {
        profileContext = { kind: "unresolved" };
        profileContextId = undefined;
        ownership.replaceAll([]);
        ownership.setHarnessWindow(undefined);
        ownership.setHarnessWindowId(undefined);
        registryProvenance = null;
      }
    }

    if (pinGeneration !== currentPinGen) {
      await transport.close();
      return err(cdpError("discovery_failed", "profile pin changed during initialization"));
    }

    remote = { cdpUrl: wsUrl, browserId: newBrowserId, ...(userDataDir ? { userDataDir } : {}) };
    const seeded = await seedIfPinned();
    if (!seeded.success) {
      latchedInitFailure = seeded.error;
      await transport.close();
      return seeded;
    }

    if (pinGeneration !== currentPinGen) {
      await transport.close();
      return err(cdpError("discovery_failed", "profile pin changed during initialization"));
    }

    const attached = await session.attachFirstPage();
    if (!attached.success) {
      latchedInitFailure = attached.error;
      await transport.close();
      return attached;
    }

    if (pinGeneration !== currentPinGen) {
      await transport.close();
      return err(cdpError("discovery_failed", "profile pin changed during initialization"));
    }

    registryProvenance = {
      namespace: opts.namespace,
      browserId: newBrowserId !== "unknown" ? newBrowserId : undefined,
      profilePin: profilePin ? { userDataDir: profilePin.userDataDir, profileDir: profilePin.profileDir } : undefined,
    };

    latchedInitFailure = null;
    lastHealth = Date.now();
    pageCaches.clear();
    return ok(undefined);
  };

  const start = (
    opts: { readonly reconnectNow?: boolean; readonly retrySetup?: boolean } = {},
  ): Promise<Result<void, CdpError>> => {
    const isExplicit = Boolean(opts.reconnectNow ?? opts.retrySetup);
    if (latchedInitFailure && !isExplicit) {
      return Promise.resolve(err(latchedInitFailure));
    }
    if (inFlightInit) {
      return inFlightInit;
    }
    const running = (async () => {
      if (isExplicit) inExplicitRetry = true;
      try {
        const result = await doStart(opts);
        if (!result.success) latchedInitFailure = result.error;
        return result;
      } finally {
        inFlightInit = null;
        inExplicitRetry = false;
      }
    })();
    inFlightInit = running;
    return running;
  };

  const stop = async (): Promise<void> => {
    await session.detachAll();
    await transport.close();
    pageCaches.clear();
    lastHealth = 0;
  };

  const restart = async (): Promise<Result<void, CdpError>> => {
    await stop();
    return start();
  };

  const reattach = async (): Promise<Result<void, CdpError>> => {
    if (latchedInitFailure) return err(latchedInitFailure);
    const myGen = pinGeneration;
    const seeded = await seedIfPinned();
    if (!seeded.success) {
      latchedInitFailure = seeded.error;
      await stop();
      return seeded;
    }
    if (pinGeneration !== myGen) {
      const genErr = cdpError("discovery_failed", "profile pin changed during initialization");
      latchedInitFailure = genErr;
      await stop();
      return err(genErr);
    }
    const reattached = await session.attachFirstPage();
    if (!reattached.success) {
      latchedInitFailure = reattached.error;
      return restart();
    }
    if (pinGeneration !== myGen) {
      const genErr = cdpError("discovery_failed", "profile pin changed during initialization");
      latchedInitFailure = genErr;
      await stop();
      return err(genErr);
    }
    latchedInitFailure = null;
    pageCaches.clear();
    return ok(undefined);
  };

  // Two probes: the browser one proves the socket works, the page one proves the current session does.
  // Only transport-level failures (closed socket, timeout) mean the connection is dead. A page probe that
  // fails for a page-level reason (navigation in flight, a throwing page) still proves the session routes,
  // so it counts as alive; only a dead session id triggers a re-attach.
  const checkHealth = async (): Promise<Result<void, CdpError>> => {
    if (latchedInitFailure) return err(latchedInitFailure);
    if (transport.state() !== "open" || !session.current()) return restart();
    if (Date.now() - lastHealth < HEALTH_TTL_MS) return ok(undefined);
    const probe = await session.callBrowser("Target.getTargets", {}, { timeoutMs: 2_000 });
    if (!probe.success) return restart();
    lastHealth = Date.now();
    const jsProbe = await session.call("Runtime.evaluate", {
      expression: "1", returnByValue: true,
    }, { timeoutMs: 2_000 });
    if (jsProbe.success) return ok(undefined);
    switch (jsProbe.error.kind) {
      case "session_not_found":
        return reattach();
      case "transport_closed":
      case "timeout":
        return restart();
      case "discovery_failed":
      case "invalid_response":
      case "remote_error":
        return ok(undefined);
    }
  };

  // Concurrent callers share one in-flight check, so two tools racing after a disconnect cannot both restart the transport.
  const ensureAlive = (): Promise<Result<void, CdpError>> => {
    if (latchedInitFailure) return Promise.resolve(err(latchedInitFailure));
    if (healthCheck) return healthCheck;
    if (inFlightInit) return inFlightInit;
    const running = checkHealth().finally(() => {
      healthCheck = null;
    });
    healthCheck = running;
    return running;
  };

  const evaluateJs = async (expression: string, sessionId?: string): Promise<Result<unknown, CdpError>> => {
    if (latchedInitFailure) return err(latchedInitFailure);
    if (!sessionId && !session.current()) {
      const alive = await ensureAlive();
      if (!alive.success) return alive;
    }
    // Wrap only when the trimmed source *starts with* `return` — matching the substring anywhere silently turned expressions mentioning it into `undefined`.
    const trimmed = expression.trim();
    const isReturnStatement = /^return[\s(]/.test(trimmed);
    const wrapped = isReturnStatement ? `(function(){${expression}})()` : expression;
    const r = sessionId
      ? await session.callOnTarget("Runtime.evaluate", { expression: wrapped, returnByValue: true, awaitPromise: true }, sessionId)
      : await session.call("Runtime.evaluate", { expression: wrapped, returnByValue: true, awaitPromise: true });
    if (!r.success) return r;
    if (r.data.exceptionDetails !== undefined) {
      return err(cdpError("remote_error", `JS evaluation failed: ${JSON.stringify(r.data.exceptionDetails)}`, "Runtime.evaluate"));
    }
    return ok(r.data.result.value);
  };

  const readPageInfo = async (): Promise<Result<PageInfo, CdpError>> => {
    if (latchedInitFailure) return err(latchedInitFailure);
    if (!session.current()) {
      const alive = await ensureAlive();
      if (!alive.success) return alive;
    }
    const dirty = session.drainPageInfoInvalidations();
    const currentTid = session.current()?.targetId;
    const cached = currentTid ? pageCaches.get(currentTid) : undefined;
    if (cached && !dirty && Date.now() - cached.at < PAGE_INFO_TTL_MS) return ok(cached.info);
    const expr = safeJs`JSON.stringify((function(){var e=document.documentElement||{scrollWidth:0,scrollHeight:0};return {url:location.href,title:document.title,w:innerWidth,h:innerHeight,sx:scrollX,sy:scrollY,pw:e.scrollWidth,ph:e.scrollHeight};})())`;
    const raw = await evaluateJs(expr);
    if (!raw.success) return raw;
    if (typeof raw.data !== "string") return err(cdpError("invalid_response", "page info evaluation did not return a string"));
    const info = parsePageInfoPayload(raw.data);
    if (!info.success) return info;
    if (currentTid) pageCaches.set(currentTid, { info: info.data, at: Date.now() });
    return ok(info.data);
  };

  const pageInfo = async (): Promise<Result<PageInfoResult, CdpError>> => {
    if (latchedInitFailure) return err(latchedInitFailure);
    const d = session.takeDialog();
    if (d) return ok({ kind: "dialog", dialog: d });
    const info = await readPageInfo();
    if (!info.success) return info;
    return ok({ kind: "page", ...info.data });
  };

  const listTabs = async (includeInternal = true): Promise<Result<ReadonlyArray<TabInfo>, CdpError>> => {
    if (latchedInitFailure) return err(latchedInitFailure);
    const r = await session.callBrowser("Target.getTargets");
    if (!r.success) return r;
    const tabs = r.data.targetInfos
      .filter((t) => t.type === "page")
      .filter((t) => includeInternal || !t.url.startsWith("chrome://"))
      .map((t): TabInfo => ({
        targetId: t.targetId,
        title: t.title,
        url: t.url,
        owned: ownership.has(t.targetId),
      }));
    const live = new Set(tabs.map((t) => t.targetId));
    reconcileOwnership(ownership, live);
    for (const tid of pageCaches.keys()) {
      if (!live.has(tid)) pageCaches.delete(tid);
    }
    return ok(tabs);
  };

  const switchTab = async (targetId: string): Promise<Result<void, CdpError>> => {
    if (latchedInitFailure) return err(latchedInitFailure);
    const r = await session.switchTo(targetId);
    if (!r.success) return r;
    await session.call("Runtime.evaluate", {
      expression: safeJs`if(!document.title.startsWith('🟢'))document.title='🟢 '+document.title`,
    });
    return ok(undefined);
  };

  const newTab = async (url?: string): Promise<Result<string, CdpError>> => {
    if (latchedInitFailure) return err(latchedInitFailure);
    // ensureHarnessWindow lists live targets and reconciles ownership itself, so no listing is needed here.
    const window = await ensureHarnessWindow(api);
    if (!window.success) return window;
    let tabId: string;
    if (window.data.freshlyCreated) {
      tabId = window.data.targetId;
    } else {
      const opened = await openHarnessTab(api, window.data.targetId);
      if (!opened.success) return opened;
      tabId = opened.data;
    }

    const switched = await switchTab(tabId);
    if (!switched.success) return switched;
    if (url && url !== "about:blank") {
      const nav = await session.call("Page.navigate", { url });
      if (!nav.success) return nav;
    }
    return ok(tabId);
  };

  const closeTab = async (targetId: string): Promise<Result<void, CdpError>> => {
    if (latchedInitFailure) return err(latchedInitFailure);
    const r = await session.callBrowser("Target.closeTarget", { targetId });
    if (!r.success) return r;
    ownership.remove(targetId);
    return ok(undefined);
  };

  const closeOwnedTabs = async (): Promise<void> => {
    for (const id of ownership.list()) {
      const closed = await session.callBrowser("Target.closeTarget", { targetId: id });
      // A remote error means the browser answered (typically "no target with given id"): the tab is gone either way. A transport failure means nothing was closed, so keep the record for the next attempt.
      if (closed.success || closed.error.kind === "remote_error") ownership.remove(id);
    }
    ownership.setHarnessWindow(undefined);
    ownership.setHarnessWindowId(undefined);
  };

  const status = (): DaemonStatus => ({
    alive: transport.state() === "open" && session.current() !== null && latchedInitFailure === null,
    sessionId: session.current()?.sessionId ?? null,
    namespace: opts.namespace,
    ...(remote?.browserId !== undefined ? { remoteBrowserId: remote.browserId } : {}),
  });

  const detach = async (): Promise<void> => {
    if (transport.state() !== "open") return;
    await session.detachAll();
  };

  const api: BrowserClient = {
    namespace: opts.namespace,
    ensureAlive, status, start, stop, detach, closeOwnedTabs,
    evaluateJs, pageInfo,
    takeDialog: () => session.takeDialog(),
    listTabs, switchTab, newTab, closeTab,
    owns: (id: string) => ownership.has(id),
    ownership: () => ownership,
    current: () => session.current(),
    session: () => session,
    transport: () => transport,
    userDataDir: () => userDataDir,
    profilePin: () => profilePin,
    profileGeneration: () => pinGeneration,
    setProfilePin: (pin) => {
      const changed = !samePin(profilePin, pin);
      profilePin = pin;
      if (changed) {
        pinGeneration++;
        ownership.replaceAll([]);
        ownership.setHarnessWindow(undefined);
        ownership.setHarnessWindowId(undefined);
        profileContext = { kind: "unresolved" };
        profileContextId = undefined;
        registryProvenance = null;
        pageCaches.clear();
        lastHealth = 0;
        void detach();
        notifyOwnership();
      }
    },
    profileContext: () => profileContext,
    setProfileContext: (ctx) => {
      profileContext = ctx;
      profileContextId = ctx.kind === "named" ? ctx.contextId : undefined;
      notifyOwnership();
    },
    profileContextId: () => profileContextId,
    setProfileContextId: (contextId) => {
      if (contextId !== undefined) {
        profileContext = { kind: "named", contextId };
        profileContextId = contextId;
      } else {
        profileContext = { kind: "unresolved" };
        profileContextId = undefined;
      }
      notifyOwnership();
    },
    verifyProfileIdentity: async () => {
      if (!profilePin) return ok(undefined);
      const verified = await verifyConnectedBrowserIdentity(api, profilePin, opts.seedDeps);
      if (!verified.success) return verified;
      return ok(undefined);
    },
    seedPinnedProfileWindow: async () => {
      if (latchedInitFailure && !inExplicitRetry) return err(latchedInitFailure);
      if (!profilePin) {
        return err(cdpError("discovery_failed", "no browser profile is selected — run /browser-profile"));
      }
      const myGen = pinGeneration;
      const r = await seedProfileWindow(api, profilePin, opts.seedDeps, () => pinGeneration === myGen);
      if (pinGeneration !== myGen) {
        const genErr = cdpError("discovery_failed", "profile pin changed during initialization");
        latchedInitFailure = genErr;
        return err(genErr);
      }
      if (!r.success) {
        latchedInitFailure = r.error;
      }
      return r;
    },
    mutationMutex: () => mutationMutex,
    browserId: () => remote?.browserId ?? opts.initialOwnership?.browserId,
    latchedFailure: () => latchedInitFailure,
  };
  return api;
};
