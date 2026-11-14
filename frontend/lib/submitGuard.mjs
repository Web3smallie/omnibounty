// Submission guards: synchronous double-submit protection, submit-time
// identity snapshots (form fields, wallet accounts, chain context), and
// async generation tracking for raced reads. Pure and DOM-free; React
// forms hold these in refs so checks run synchronously instead of
// racing state updates. Every path is unit-testable with mocks.

/// Thrown when form, wallet, or chain identity changed mid-submission.
/// `changed` names the drifted keys so callers can decide: wallet drift
/// keeps completed steps for resume, form drift restarts the run.
export class SubmitGuardError extends Error {
  constructor(changed) {
    super(`Changed during submission: ${changed.join(", ")} — review and retry.`);
    this.name = "SubmitGuardError";
    this.changed = [...changed];
  }
}

/// Synchronous busy flag: tryAcquire wins exactly once until release,
/// so a double-click before React re-renders cannot start a second
/// submission. State flags alone cannot do this (stale closures).
export function createBusyGuard() {
  let busy = false;
  return {
    tryAcquire() {
      if (busy) return false;
      busy = true;
      return true;
    },
    release() {
      busy = false;
    },
    isBusy() {
      return busy;
    },
  };
}

const sameValue = (a, b) => a === b || (Number.isNaN(a) && Number.isNaN(b));

/// Snapshot helper: capture the identities a submission depends on, then
/// assert they still hold before every transaction send.
export function createSubmitGuard(snapshot) {
  const base = { ...(snapshot ?? {}) };
  const changed = (live) => {
    const at = live ?? {};
    return Object.keys(base).filter((k) => !sameValue(base[k], at[k]));
  };
  return {
    snapshot: () => ({ ...base }),
    changed,
    assertUnchanged(live) {
      const drifted = changed(live);
      if (drifted.length > 0) throw new SubmitGuardError(drifted);
    },
  };
}

/// Generation counter for raced async reads (scans, suggestions):
/// issue() starts newer work, isCurrent(id) drops stale completions.
export function createGeneration() {
  let current = 0;
  return {
    issue() {
      current += 1;
      return current;
    },
    isCurrent(id) {
      return id === current;
    },
    current() {
      return current;
    },
  };
}
