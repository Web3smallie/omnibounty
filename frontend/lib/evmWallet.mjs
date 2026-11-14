// EVM wallet lifecycle: connection/account/network state machine for the
// injected provider. Pure and DOM-free; the component inspects the
// provider object and dispatches here, so every transition — connects,
// disconnects, account/network swaps, raced refreshes — is unit-testable
// with mocks.
//
// Rules:
// - Event payloads apply synchronously (instant UI); a refresh always
//   follows to confirm against live reads.
// - Async completions carry attempt ids; stale ones are ignored, so a
//   slow refresh can never restore an obsolete account or chain.
// - A failed READ changes nothing: transient RPC failures must not wipe
//   a working connection mid-flow (fresh events still supersede).
// - Any fresh wallet signal clears the last error; only a failed
//   connect/switch with no superseding signal keeps one.
// State: { address, chainId (bigint|null), ready, error, attempt }.

/// First usable account from listAccounts results or an accountsChanged
/// payload. Accepts address strings and { address } entries; empty,
/// missing, or malformed input means disconnected (null), never "".
export function firstAccount(accounts) {
  if (!Array.isArray(accounts)) return null;
  for (const a of accounts) {
    const s = typeof a === "string" ? a : a?.address;
    if (typeof s === "string" && s.length > 0) return s;
  }
  return null;
}

/// Normalize a chain id from any provider shape: bigint, integer
/// number, decimal string, or 0x hex string (the chainChanged payload
/// form). Anything else — including negatives — yields null.
export function parseChainId(value) {
  try {
    if (typeof value === "bigint") return value >= 0n ? value : null;
    if (typeof value === "number") {
      if (!Number.isInteger(value) || value < 0) return null;
      return BigInt(value);
    }
    if (typeof value === "string") {
      const s = value.trim();
      if (s === "") return null;
      const b = BigInt(s);
      return b >= 0n ? b : null;
    }
    return null;
  } catch {
    return null;
  }
}

export function initialEvmState() {
  return { address: null, chainId: null, ready: false, error: null, attempt: 0 };
}

export function evmWalletReducer(state, action) {
  switch (action?.type) {
    case "PROVIDER_ABSENT":
      return { address: null, chainId: null, ready: false, error: null, attempt: state.attempt };
    case "PROVIDER_PRESENT":
      if (state.ready) return state;
      return { ...state, ready: true };
    case "ACCOUNTS_CHANGED":
      return { ...state, address: firstAccount(action.accounts), error: null };
    case "CHAIN_CHANGED": {
      const parsed = parseChainId(action.chainId);
      return { ...state, chainId: parsed ?? state.chainId, error: null };
    }
    case "DISCONNECTED":
      return { ...state, address: null, chainId: null, error: null };
    case "REFRESH_START":
      return { ...state, attempt: action.attempt };
    case "REFRESH_OK": {
      if (action.attempt !== state.attempt) return state;
      const chainId = parseChainId(action.chainId);
      return {
        ...state,
        address: firstAccount(action.accounts),
        chainId: chainId ?? state.chainId,
        error: null,
      };
    }
    case "REFRESH_FAILED":
      if (action.attempt !== state.attempt) return state;
      return state;
    case "CONNECT_START":
    case "SWITCH_START":
      return { ...state, error: null, attempt: action.attempt };
    case "CONNECT_FAILED":
    case "SWITCH_FAILED":
      if (action.attempt !== state.attempt) return state;
      return { ...state, error: action.message };
    default:
      return state;
  }
}
