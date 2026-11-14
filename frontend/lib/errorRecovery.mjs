// Error-boundary decision logic: secret redaction, error reporting,
// retry budgeting, and reset-key derivation. Pure and DOM-free so the
// whole policy is unit-testable with mocks; ErrorBoundary.tsx and the
// route error files are thin shells over these functions.

/// Consecutive same-state retries before the fallback stops offering
/// retry and points at a page reload instead (error-loop prevention).
export const MAX_BOUNDARY_RETRIES = 3;

/// Cap for surfaced error text.
const MESSAGE_CAP = 200;

/// Redact credential-shaped text from an error message. Covers NEAR
/// full-access keys, PEM private blocks, and password/secret/mnemonic/
/// seed-labeled values (query params included). Hex hashes and addresses
/// are deliberately left intact: transaction hashes and digests are
/// public chain data the UI is supposed to display.
export function redactSecrets(text) {
  if (typeof text !== "string" || text === "") return "";
  return text
    .replace(/\bed25519:[A-Za-z0-9+/=]{10,}/g, "ed25519:[redacted]")
    .replace(
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
      "[redacted private key]"
    )
    .replace(
      /((?:password|passwd|secret|mnemonic|seed(?:\s*phrase)?)\s*[:=]\s*)([^\s&;,}"']+)/gi,
      "$1[redacted]"
    );
}

/// Safe { name, message } for display: capped, redacted, never throws.
export function describeComponentError(error) {
  const name = error instanceof Error && typeof error.name === "string" ? error.name : "Error";
  const raw = error instanceof Error ? error.message : String(error ?? "Something went wrong.");
  const clean = raw.trim() === "" ? "Something went wrong." : raw.trim();
  const capped = clean.length > MESSAGE_CAP ? `${clean.slice(0, MESSAGE_CAP)}…` : clean;
  return { name, message: redactSecrets(capped) };
}

/// Log one diagnostic record for a boundary catch and return it. The
/// record carries the boundary label, the redacted message, and React's
/// component stack (component names only — no props or wallet data), so
/// the log is useful without ever holding credentials. `log` is
/// injectable for tests and defaults to console.error.
export function reportComponentError(opts = {}) {
  const { label, error, componentStack = null, log = console.error } = opts ?? {};
  const { name, message } = describeComponentError(error);
  const record = {
    boundary: typeof label === "string" && label !== "" ? label : "component",
    name,
    message,
    componentStack: typeof componentStack === "string" ? componentStack : null,
  };
  try {
    log(`[error-boundary:${record.boundary}] ${record.name}: ${record.message}`, record);
  } catch {
    // Diagnostics must never break rendering.
  }
  return record;
}

/// Stable reset key from route/section segments; empty parts are skipped
/// so call sites can pass conditionals straight in.
export function boundaryResetKey(...parts) {
  return parts.filter((p) => p !== null && p !== undefined && String(p) !== "").join(":");
}

/// True while another same-state retry is allowed.
export function boundaryCanRetry(attempts) {
  const n = Number.isInteger(attempts) && attempts >= 0 ? attempts : 0;
  return n < MAX_BOUNDARY_RETRIES;
}

/// Initial boundary state for a reset key.
export function initialBoundaryState(resetKey) {
  return { error: null, attempts: 0, resetKey };
}

/// Mirror of getDerivedStateFromProps: a changed reset key (navigation
/// to another bounty/route, form switch) clears the failure and the
/// retry budget; an unchanged key returns null (keep state).
export function deriveBoundaryStateFromProps(props, state) {
  const next = props?.resetKey;
  if (next !== state?.resetKey) return initialBoundaryState(next);
  return null;
}

/// State after a manual retry press. Clears the error and spends one
/// retry from the budget; callers check boundaryCanRetry first and show
/// the reload hint once the budget is spent.
export function nextBoundaryRetryState(state) {
  const attempts = Number.isInteger(state?.attempts) && state.attempts >= 0 ? state.attempts : 0;
  return { error: null, attempts: attempts + 1, resetKey: state?.resetKey };
}
