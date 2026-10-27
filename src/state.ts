import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ProfileContext } from "./client";
import { asArrayOf, asNumber, asString, isRecord } from "./util/guards";

export type BrowserState = {
  readonly namespace: string;
  readonly browserId?: string;
  readonly userDataDir?: string;
  readonly profilePin?: { readonly userDataDir: string; readonly profileDir: string };
  readonly ownedTargetIds?: ReadonlyArray<string>;
  readonly harnessWindowTargetId?: string;
  readonly harnessWindowId?: number;
  readonly profileContext?: ProfileContext;
};

export const defaultState = (namespace = "default"): BrowserState => ({
  namespace,
  ownedTargetIds: [],
});

// Pi session JSONL is append-only and every custom entry shows up in the branch navigator, so a
// snapshot is only worth appending when it differs from the one the branch already holds (#26).
// Tab order is not a difference: ownership is a set.
const stateKey = (state: BrowserState): string =>
  JSON.stringify({
    namespace: state.namespace,
    browserId: state.browserId ?? null,
    userDataDir: state.userDataDir ?? null,
    profilePin: state.profilePin ?? null,
    ownedTargetIds: [...(state.ownedTargetIds ?? [])].sort(),
    harnessWindowTargetId: state.harnessWindowTargetId ?? null,
    harnessWindowId: state.harnessWindowId ?? null,
    profileContext: state.profileContext ?? null,
  });

export type StatePersister = {
  // Appends the snapshot unless it equals the last one persisted or restored. Returns whether it wrote.
  readonly persist: (state: BrowserState) => boolean;
  // Records a snapshot that already lives in the session (restored from the branch) without writing it.
  readonly markPersisted: (state: BrowserState) => void;
};

// Only appendEntry is needed, so a test can hand in a plain object instead of a whole ExtensionAPI.
export const createStatePersister = (pi: Pick<ExtensionAPI, "appendEntry">): StatePersister => {
  let last: string | undefined;
  return {
    persist: (state) => {
      const key = stateKey(state);
      if (key === last) return false;
      pi.appendEntry<BrowserState>("browser-harness-state", state);
      last = key;
      return true;
    },
    markPersisted: (state) => {
      last = stateKey(state);
    },
  };
};

const asPersistedState = (v: unknown): Partial<BrowserState> | undefined => {
  if (!isRecord(v)) return undefined;
  const namespace = asString(v["namespace"]);
  const browserId = asString(v["browserId"]);
  const userDataDir = asString(v["userDataDir"]);
  let profilePin: { readonly userDataDir: string; readonly profileDir: string } | undefined;
  if (isRecord(v["profilePin"])) {
    const udd = asString(v["profilePin"]["userDataDir"]);
    const pd = asString(v["profilePin"]["profileDir"]);
    if (udd !== undefined && pd !== undefined) {
      profilePin = { userDataDir: udd, profileDir: pd };
    }
  }
  const ownedTargetIds = asArrayOf(v["ownedTargetIds"], asString);
  const harnessWindowTargetId = asString(v["harnessWindowTargetId"]);
  const harnessWindowId = asNumber(v["harnessWindowId"]);
  let profileContext: ProfileContext | undefined;
  if (isRecord(v["profileContext"])) {
    const kind = asString(v["profileContext"]["kind"]);
    if (kind === "default" || kind === "unresolved") {
      profileContext = { kind };
    } else if (kind === "named") {
      const contextId = asString(v["profileContext"]["contextId"]);
      if (contextId !== undefined) {
        profileContext = { kind: "named", contextId };
      }
    }
  }
  return {
    ...(namespace !== undefined ? { namespace } : {}),
    ...(browserId !== undefined ? { browserId } : {}),
    ...(userDataDir !== undefined ? { userDataDir } : {}),
    ...(profilePin !== undefined ? { profilePin } : {}),
    ...(ownedTargetIds !== undefined ? { ownedTargetIds } : {}),
    ...(harnessWindowTargetId !== undefined ? { harnessWindowTargetId } : {}),
    ...(harnessWindowId !== undefined ? { harnessWindowId } : {}),
    ...(profileContext !== undefined ? { profileContext } : {}),
  };
};

export const restoreState = (ctx: ExtensionContext, currentNamespace?: string): BrowserState => {
  const branchEntries = ctx.sessionManager.getBranch();
  const fallback = defaultState(currentNamespace);
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    const entry = branchEntries[i];
    if (entry?.type === "custom" && entry.customType === "browser-harness-state") {
      const data = asPersistedState(entry.data);
      if (data) {
        if (data.namespace === undefined || (currentNamespace !== undefined && data.namespace !== currentNamespace)) {
          return fallback;
        }
        return {
          ...fallback,
          ...data,
          namespace: data.namespace,
        };
      }
    }
  }
  return fallback;
};
