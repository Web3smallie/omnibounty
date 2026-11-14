// EVM confirmation timeouts: ethers' tx.wait() polls for a receipt with
// no deadline, so a stalled RPC leaves the sponsorship flow hanging in
// "pending" forever. waitForTxReceipt races the wait against a bounded
// timer and reports a timeout as its own error — never as a revert, and
// never as proof the transaction failed. Pure and DOM-free; fully
// unit-testable with mock tx handles and short timeouts. (NEAR waits are
// user-paced wallet confirmations and are deliberately untouched.)

/// Default confirmation budget: Base Sepolia mines ~2s blocks, so 120s
/// tolerates deep congestion and flaky public RPCs while still bounding
/// every wait the UI can sit in.
export const TX_CONFIRM_TIMEOUT_MS = 120000;

/// Rejection for a confirmation that outlasted its budget. Carries the
/// submitted hash so the UI can link it; the transaction may still
/// confirm afterwards — callers must offer re-check (Resume +
/// reconcile), never blind resubmission.
export class TxConfirmTimeoutError extends Error {
  constructor(txHash, timeoutMs = TX_CONFIRM_TIMEOUT_MS) {
    super(
      `Confirmation timed out after ${Math.round(timeoutMs / 1000)}s for transaction ${txHash ?? "(unknown hash)"}. ` +
        "This is not proof it failed — it may still confirm. Check its status before retrying."
    );
    this.name = "TxConfirmTimeoutError";
    this.code = "TX_CONFIRM_TIMEOUT";
    this.txHash = typeof txHash === "string" && txHash.length > 0 ? txHash : null;
  }
}

/// Await tx.wait() with a deadline. Resolves/rejects exactly as the
/// underlying wait when it settles in time; on timeout rejects with
/// TxConfirmTimeoutError and permanently ignores the late settlement (a
/// handler stays attached so a late rejection never surfaces
/// unhandled). The timer is cleared on every in-time settle.
export function waitForTxReceipt(tx, { timeoutMs = TX_CONFIRM_TIMEOUT_MS, txHash } = {}) {
  const hash = typeof txHash === "string" && txHash.length > 0 ? txHash : tx?.hash ?? null;
  const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : TX_CONFIRM_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new TxConfirmTimeoutError(hash, budget));
    }, budget);
    Promise.resolve()
      .then(() => tx.wait())
      .then(
        (receipt) => {
          if (settled) return; // late success after timeout: ignored
          settled = true;
          clearTimeout(timer);
          resolve(receipt);
        },
        (e) => {
          if (settled) return; // late failure after timeout: swallowed
          settled = true;
          clearTimeout(timer);
          reject(e); // wait-time throws (reverts etc.) pass through untouched
        }
      );
  });
}
