// NEAR wallet-selector initialization lifecycle: shared attempt
// memoization, environment guards, error shaping, and the init state
// machine. Pure and DOM-free except for the injected globals it probes,
// so every path is unit-testable with mocks. near.ts wires
// createSharedInitializer into getSelector; the React provider drives
// walletInitReducer.

/// Memoize an async starter across concurrent callers: one in-flight
/// attempt is shared; success is cached forever; failure clears the
/// cache so the next call retries instead of replaying a rejection.
export function createSharedInitializer(start) {
  let current = null;
  return function init() {
    if (!current) {
      current = Promise.resolve()
        .then(() => start())
        .then(
          (value) => value,
          (e) => {
            current = null;
            throw e;
          }
        );
    }
    return current;
  };
}

/// Fail fast outside a capable browser: the selector needs window +
/// readable localStorage. `root` defaults to globalThis and is
/// injectable for tests. Throws an actionable Error; returns true.
export function assertBrowserWalletEnv(root = globalThis) {
  if (!root || typeof root.window === "undefined") {
    throw new Error("NEAR wallet setup needs a browser environment.");
  }
  try {
    void root.window.localStorage;
  } catch {
    throw new Error("Browser storage is unavailable — check private mode or site privacy settings, then retry.");
  }
  return true;
}

/// One-line, capped user message for an init failure. Never throws.
export function initErrorMessage(e) {
  const raw = e instanceof Error ? e.message : String(e ?? "NEAR wallet setup failed.");
  const msg = raw.trim() === "" ? "NEAR wallet setup failed." : raw.trim();
  return msg.length > 200 ? `${msg.slice(0, 200)}…` : msg;
}

/// Init state machine: { status: "loading"|"ready"|"error", error, attempt }.
/// RESOLVE/REJECT carry the attempt id and are ignored when stale, so a
/// slow first attempt can never overwrite a newer retry's result.
export function walletInitReducer(state, action) {
  switch (action?.type) {
    case "ATTEMPT":
      return { status: "loading", error: null, attempt: action.attempt };
    case "RESOLVE":
      if (action.attempt !== state.attempt) return state;
      return { status: "ready", error: null, attempt: state.attempt };
    case "REJECT":
      if (action.attempt !== state.attempt) return state;
      return { status: "error", error: action.message, attempt: state.attempt };
    default:
      return state;
  }
}

/// Shared UI contract across the header and all four NEAR forms: show the
/// init-error + retry UI only when no account is connected and init failed.
export function shouldShowNearInitError(status, account) {
  return !account && status === "error";
}

/// Sign out through a selector handle, mirroring the provider's historic
/// swallow semantics (wallet lookup and signOut failures resolve
/// quietly); the caller always clears the account afterwards. Tolerates
/// nullish selectors. Never rejects.
export async function signOutSelector(selector) {
  try {
    const wallet = await selector?.wallet?.().catch(() => null);
    await wallet?.signOut?.().catch(() => null);
  } catch {
    // Historic behavior: disconnect never surfaces wallet errors.
  }
}
