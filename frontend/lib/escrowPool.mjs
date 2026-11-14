// Bounded concurrency for escrow-state reads. The Marketplace mounts one
// card per bounty (up to 200) and every card needs one `bounties` view
// call; firing them all at once hammers the public Base RPC. Reads routed
// through this pool run at most `limit` at a time, queue FIFO, and share
// identical in-flight reads instead of duplicating them. Pure and
// DOM-free: tasks are injected, so every path is unit-testable with
// mocks. Marketplace.tsx drives the shared `escrowReads` pool.

/// Maximum simultaneous escrow reads app-wide. Eight `eth_call`s is
/// comfortably below public-RPC rate limits while keeping a full
/// 200-card marketplace interactive (each view call resolves in ~1s).
export const ESCROW_READ_LIMIT = 8;

/// Rejection reason for queued reads nobody wants anymore (every holder
/// cancelled, e.g. cards unmounted before their turn). Callers that
/// already tore down ignore it; it never means the escrow is unreadable.
export class PoolCancelledError extends Error {
  constructor(key) {
    super(`escrow read cancelled: ${key}`);
    this.name = "PoolCancelledError";
    this.code = "POOL_CANCELLED";
  }
}

/// FIFO pool with in-flight deduplication by key.
///
/// run(key, task) -> { promise, cancel }:
/// - At most `limit` task() executions overlap; the rest queue FIFO.
/// - Concurrent runs with an equal key share one execution (no duplicate
///   RPC); each holder still gets its own promise and cancel.
/// - cancel() releases one holder and rejects that holder's promise with
///   PoolCancelledError. A queued entry with no holders left is removed;
///   an in-flight entry always runs to completion (its result still
///   serves any remaining or later holders).
/// - Results are never cached: sequential runs with an equal key each
///   execute, so a remount always re-reads instead of going stale.
/// - One task's rejection settles only its own holders; the queue drains on.
export function createReadPool({ limit = ESCROW_READ_LIMIT } = {}) {
  const max = Number.isInteger(limit) && limit > 0 ? limit : ESCROW_READ_LIMIT;
  let active = 0;
  const queue = [];
  const busy = new Map(); // key -> entry (queued or in flight)

  const pump = () => {
    while (active < max && queue.length > 0) {
      const entry = queue.shift();
      if (entry.settled) continue; // cancelled while queued (lazily swept)
      active++;
      entry.started = true;
      Promise.resolve()
        .then(() => entry.task())
        .then(
          (value) => settle(entry, true, value),
          (e) => settle(entry, false, e)
        );
    }
  };

  const settle = (entry, ok, result) => {
    if (entry.settled) return;
    entry.settled = true;
    active--;
    if (busy.get(entry.key) === entry) busy.delete(entry.key);
    for (const w of [...entry.waiters]) {
      entry.waiters.delete(w);
      if (ok) w.resolve(result);
      else w.reject(result);
    }
    pump();
  };

  const run = (key, task) => {
    if (typeof task !== "function") throw new Error("pool run needs a task function.");
    let entry = busy.get(key);
    if (!entry || entry.settled) {
      entry = { key, task, started: false, settled: false, waiters: new Set() };
      busy.set(key, entry);
      queue.push(entry);
    }
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const waiter = { resolve, reject };
    entry.waiters.add(waiter);
    let released = false;
    const cancel = () => {
      if (released) return;
      released = true;
      if (entry.waiters.delete(waiter)) {
        reject(new PoolCancelledError(key));
      }
      if (entry.waiters.size === 0 && !entry.started && !entry.settled) {
        entry.settled = true;
        if (busy.get(key) === entry) busy.delete(key);
        const at = queue.indexOf(entry);
        if (at >= 0) queue.splice(at, 1);
      }
    };
    pump();
    return { promise, cancel };
  };

  return {
    run,
    /// Live slot usage for tests and diagnostics.
    stats() {
      return { active, queued: queue.length, limit: max };
    },
  };
}

/// App-wide escrow-read pool shared by every Marketplace card, so the
/// concurrency limit holds across cards, mounts, and re-renders.
export const escrowReads = createReadPool({ limit: ESCROW_READ_LIMIT });
