// Settlement polling lifecycle: bounded backoff, overlap/stale guards,
// and four explicit settlement states. Pure and DOM-free except for the
// injected scheduler, so every path is unit-testable with mocks.
// SettlementPanel.tsx drives createSettlePoller for the usedVoucher read;
// the payout-log scan (findPayoutTx) stays untouched behind it.
//
// State shape: { status, used, failures, error, attempt } where status is
// one of "checking" | "settled" | "not-settled" | "unavailable" | "failed":
//   settled      usedVoucher returned exactly true (confirmed on-chain)
//   not-settled  usedVoucher returned exactly false (relayer pending)
//   checking     first read or backing off between transient unknowns
//   unavailable  maxUnknowns consecutive unknowns: auto-polling exhausted
//   failed       permanent/unsupported error: auto-polling refused
// Only "settled" means paid. Null, malformed values, and RPC errors are
// always unknown — never success, never failure-to-settle.

export const SETTLE_BASE_DELAY_MS = 10000;
export const SETTLE_MAX_DELAY_MS = 60000;
export const SETTLE_MAX_UNKNOWNS = 5;

/// Classify a raw usedVoucher read. Only an exact boolean is evidence.
export function classifyUsedValue(value) {
  if (value === true) return "settled";
  if (value === false) return "not-settled";
  return "unknown";
}

/// Permanent poll errors stop auto-polling at once (manual retry stays
/// available). Everything else is transient: RPC/transport blips, timeouts,
/// and rate limits recover through bounded backoff. Unknown shapes fail
/// open toward transient — retrying a weird error is always safe because
/// an unknown result can never report settlement.
const PERMANENT_ERROR_CODES = new Set([
  "CALL_EXCEPTION", // eth_call reverted: wrong contract or no fallback
  "BAD_DATA", // undecodable returndata: nothing sane to retry
  "UNSUPPORTED_OPERATION",
  "INVALID_ARGUMENT",
]);

const PERMANENT_MESSAGE =
  /version mismatch|unsupported|invalid (contract )?address|invalid digest|no contract|not deployed|not a contract/i;

export function isPermanentPollError(e) {
  const code = typeof e?.code === "string" ? e.code : "";
  if (PERMANENT_ERROR_CODES.has(code)) return true;
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return PERMANENT_MESSAGE.test(msg);
}

/// Delay before the next poll after `failures` consecutive unknowns:
/// base, doubling per failure, capped at max. `failures <= 0` is the
/// normal cadence (also `base`), so a definitive read resets the budget.
export function pollDelayForFailures(failures, opts = {}) {
  const base =
    Number.isFinite(opts.baseMs) && opts.baseMs > 0 ? opts.baseMs : SETTLE_BASE_DELAY_MS;
  const max =
    Number.isFinite(opts.maxMs) && opts.maxMs > 0
      ? Math.max(opts.maxMs, base)
      : Math.max(SETTLE_MAX_DELAY_MS, base);
  const n = Number.isFinite(failures) && failures > 0 ? Math.floor(failures) : 0;
  if (n <= 0) return base;
  return Math.min(max, base * 2 ** Math.min(n - 1, 10));
}

/// One-line, capped user message for a poll failure. Never throws.
export function pollErrorMessage(e) {
  const raw = e instanceof Error ? e.message : String(e ?? "Settlement check failed.");
  const msg = raw.trim() === "" ? "Settlement check failed." : raw.trim();
  return msg.length > 200 ? `${msg.slice(0, 200)}…` : msg;
}

export function initialSettlePollState() {
  return { status: "checking", used: null, failures: 0, error: null, attempt: 0 };
}

/// Settlement state machine. ATTEMPT carries the fresh attempt id;
/// SETTLED/NOT_SETTLED/UNKNOWN/FAILED carry the settling attempt id and
/// are ignored when stale, so a slow read can never overwrite a newer
/// attempt's result. UNKNOWN counts consecutive unknowns and flips to
/// "unavailable" at maxUnknowns (default SETTLE_MAX_UNKNOWNS).
export function settlePollReducer(state, action) {
  switch (action?.type) {
    case "ATTEMPT":
      return { ...state, status: "checking", error: null, attempt: action.attempt };
    case "SETTLED":
      if (action.attempt !== state.attempt) return state;
      return { status: "settled", used: true, failures: 0, error: null, attempt: state.attempt };
    case "NOT_SETTLED":
      if (action.attempt !== state.attempt) return state;
      return { status: "not-settled", used: false, failures: 0, error: null, attempt: state.attempt };
    case "UNKNOWN": {
      if (action.attempt !== state.attempt) return state;
      const failures = state.failures + 1;
      const max = action.maxUnknowns ?? SETTLE_MAX_UNKNOWNS;
      if (failures >= max) {
        return { status: "unavailable", used: null, failures, error: action.message, attempt: state.attempt };
      }
      return { status: "checking", used: null, failures, error: action.message, attempt: state.attempt };
    }
    case "FAILED":
      if (action.attempt !== state.attempt) return state;
      return { ...state, status: "failed", used: null, error: action.message };
    default:
      return state;
  }
}

/// Framework-free settlement poller. `read` resolves the raw usedVoucher
/// value (or rejects); every transition is emitted to `onState`.
///
/// Guarantees: at most one read in flight (retry/start during a read are
/// ignored); the timer chain schedules only after a settle; stop() cancels
/// the timer and invalidates the in-flight read so its late settlement is
/// ignored (unmount-safe: no update after stop); settled/unavailable/failed
/// stop the timer until retry() restarts with a fresh outage budget.
export function createSettlePoller(opts) {
  const {
    read,
    onState,
    schedule = (fn, ms) => setTimeout(fn, ms),
    cancel = (id) => clearTimeout(id),
    baseMs = SETTLE_BASE_DELAY_MS,
    maxMs = SETTLE_MAX_DELAY_MS,
    maxUnknowns = SETTLE_MAX_UNKNOWNS,
  } = opts ?? {};
  if (typeof read !== "function") throw new Error("createSettlePoller needs a read function.");
  const emit = typeof onState === "function" ? onState : () => {};
  let state = initialSettlePollState();
  let running = false;
  let inFlight = false;
  let timer = null;

  const clearTimer = () => {
    if (timer !== null) {
      try {
        cancel(timer);
      } catch {
        // A failing test double must not break teardown.
      }
      timer = null;
    }
  };
  // Returns false when the reducer ignored the action as stale, so only
  // accepted transitions schedule or shut down.
  const update = (action) => {
    const next = settlePollReducer(state, action);
    if (next === state) return false;
    state = next;
    emit({ ...state });
    return true;
  };
  const shutdown = () => {
    running = false;
    clearTimer();
  };
  const scheduleNext = (ms) => {
    clearTimer();
    if (!running) return;
    timer = schedule(() => {
      timer = null;
      poll();
    }, ms);
  };
  const unknown = (attempt, message) => {
    if (!update({ type: "UNKNOWN", attempt, message, maxUnknowns })) return;
    if (state.status === "unavailable") shutdown();
    else scheduleNext(pollDelayForFailures(state.failures, { baseMs, maxMs }));
  };

  const poll = () => {
    if (!running || inFlight) return false;
    inFlight = true;
    const attempt = state.attempt + 1;
    update({ type: "ATTEMPT", attempt });
    Promise.resolve()
      .then(() => read())
      .then(
        (value) => {
          inFlight = false;
          if (!running || attempt !== state.attempt) {
            // Stale: stopped, or a restart is waiting on this settle.
            if (running) poll();
            return;
          }
          const verdict = classifyUsedValue(value);
          if (verdict === "settled") {
            if (update({ type: "SETTLED", attempt })) shutdown();
          } else if (verdict === "not-settled") {
            if (update({ type: "NOT_SETTLED", attempt })) {
              scheduleNext(pollDelayForFailures(0, { baseMs, maxMs }));
            }
          } else {
            unknown(attempt, "Escrow returned no usable settlement state (expected boolean).");
          }
        },
        (e) => {
          inFlight = false;
          if (!running || attempt !== state.attempt) {
            if (running) poll();
            return;
          }
          if (isPermanentPollError(e)) {
            if (update({ type: "FAILED", attempt, message: pollErrorMessage(e) })) shutdown();
          } else {
            unknown(attempt, pollErrorMessage(e));
          }
        }
      );
    return true;
  };

  return {
    /// Begin polling immediately. No-op while running. Safe to call after
    /// stop (fresh outage budget); a restart racing an in-flight read
    /// re-polls when that read settles instead of overlapping it.
    start() {
      if (running) return false;
      running = true;
      state = { ...initialSettlePollState(), attempt: state.attempt };
      return poll();
    },
    /// Poll now with a fresh outage budget: the manual recovery from
    /// unavailable/failed (and a harmless immediate re-check otherwise).
    /// Ignored while a read is in flight — never overlapping.
    retry() {
      if (inFlight) return false;
      clearTimer();
      if (!running) {
        running = true;
        state = { ...initialSettlePollState(), attempt: state.attempt };
      } else {
        state = { ...state, failures: 0, error: null };
      }
      return poll();
    },
    /// Halt everything: the timer is cancelled and any in-flight read's
    /// settlement is ignored. Emits nothing — state freezes for teardown.
    stop() {
      running = false;
      clearTimer();
      state = { ...state, attempt: state.attempt + 1 };
    },
    getState() {
      return { ...state };
    },
  };
}
