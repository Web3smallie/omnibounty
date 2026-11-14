// Relayer/pipeline status visibility: honest, evidence-based derivation
// of what the settlement tracker may claim about off-chain processing.
// Pure and DOM-free; every rule is unit-testable with injected clocks.
//
// Evidence audit: the relayer exposes NO health, ready, or status
// interface — no HTTP server, no heartbeat; its only observable outputs
// are on-chain effects (finalize dispatches, Base claims) plus
// operator-only logs. Finalization additionally has TWO triggers: the
// relayer demo path (30s poll, only with operator credentials) and the
// GitHub Actions scheduler (10-minute cadence, the normal path). The
// frontend cannot know which is active, so it must never promise 30s
// relayer action, and it can never confirm an outage — only report "no
// processing observed beyond the normal window" while its own reads are
// healthy. A missing response is never blamed on the relayer.
//
// Statuses:
//   awaiting   - pending within the normal window (no evidence of trouble)
//   processing - on-chain proof of recent pipeline action (dispatch seen)
//   delayed    - healthy reads, no progress far beyond the normal window
//   settled    - usedVoucher confirmed (existing ground truth, untouched)
//   unknown    - reads failing or settlement state unknown (P1-10 owns this)

/// Documented off-chain cadences (relayer POLL_INTERVAL_MS default and
/// the finalize-scheduler cron). Thresholds below are generous multiples
/// so normal scheduler jitter can never trip them.
export const RELAYER_POLL_SEC = 30;
export const SCHEDULER_TICK_SEC = 600;
/// Finalization overdue: 3x the scheduler cadence past maturity.
export const FINALIZE_OVERDUE_SEC = 1800;
/// Settlement overdue: 60x the relayer poll past voucher creation.
export const SETTLE_OVERDUE_SEC = 1800;

/// Seconds spent in the current stage. Never negative, never throws.
/// A non-positive start means no clock basis (missing timestamps), which
/// reports zero rather than fabricating an epoch-sized wait.
export function stageElapsedSec(enteredAtSec, nowSec) {
  if (!(enteredAtSec > 0) || !Number.isFinite(nowSec)) return 0;
  return Math.max(0, Math.floor(nowSec - enteredAtSec));
}

/// Short human duration: 45 -> "45s", 90 -> "1m 30s", 3700 -> "1h 1m".
export function formatWaitDuration(totalSec) {
  const s = Number.isFinite(totalSec) && totalSec > 0 ? Math.floor(totalSec) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${String(r).padStart(2, "0")}s`;
  return `${r}s`;
}

/// Maturity basis for finalization aging: the challenge end, falling
/// back to qualification time when the end is missing. Zero means no
/// clock basis — never overdue.
export function maturedAtSec(claim) {
  const ends = Number(claim?.challenge_ends_at);
  if (Number.isFinite(ends) && ends > 0) return ends;
  const qualified = Number(claim?.qualified_at);
  if (Number.isFinite(qualified) && qualified > 0) return qualified;
  return 0;
}

/// True only with positive evidence of a stall: matured, no dispatch or
/// voucher observed, and waiting far beyond the normal window. Any
/// observed progress clears it immediately.
export function finalizeOverdue({ maturedAt, hasProgress, nowSec }) {
  if (hasProgress) return false;
  if (!(maturedAt > 0) || !Number.isFinite(nowSec) || nowSec < maturedAt) return false;
  return nowSec - maturedAt > FINALIZE_OVERDUE_SEC;
}

/// True only for a confirmed-unsettled voucher far past its creation.
/// used === null (unknown) is NEVER overdue — P1-10 unknown states own
/// that case, and alarming on unreadable state would blame the relayer
/// for our own RPC failures.
export function settleOverdue({ voucherCreatedAt, used, nowSec }) {
  if (used !== false) return false;
  if (!(voucherCreatedAt > 0) || !Number.isFinite(nowSec)) return false;
  return nowSec - voucherCreatedAt > SETTLE_OVERDUE_SEC;
}

/// Derive the pipeline status for tracker display. `phase` comes from
/// derivePhase (untouched); `readsOk` is false when the latest poll
/// cycle errored; `nowSec` is injectable for deterministic tests.
/// Display-only: never throws, never stops polling, and settled always
/// wins so an outage can never hide a confirmed payout.
export function relayerPipelineStatus(opts = {}) {
  const {
    phase,
    claim = null,
    voucherCreatedAt = null,
    used = null,
    readsOk = true,
    nowSec = Math.floor(Date.now() / 1000),
  } = opts ?? {};
  if (phase === "paid" || used === true) return { status: "settled" };
  if (!readsOk) return { status: "unknown" };
  // Dispatch on-chain proves the pipeline acted: MPC round running.
  if (phase === "signing") return { status: "processing" };
  if (phase === "finalizing") {
    const maturedAt = maturedAtSec(claim);
    if (finalizeOverdue({ maturedAt, hasProgress: false, nowSec })) {
      return { status: "delayed", stage: "finalize", sinceSec: maturedAt };
    }
    return { status: "awaiting" };
  }
  if (phase === "settling") {
    if (used !== false) return { status: "unknown" };
    if (settleOverdue({ voucherCreatedAt, used, nowSec })) {
      return { status: "delayed", stage: "settle", sinceSec: voucherCreatedAt };
    }
    return { status: "awaiting" };
  }
  return { status: "awaiting" };
}
