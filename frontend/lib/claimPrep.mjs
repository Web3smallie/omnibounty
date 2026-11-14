// Guided claim preparation: pure, browser-safe helpers for the
// contributor "Prepare claim" wizard. No network, no secrets, no React —
// every function validates pasted text or assembles JSON the existing
// submit flow already accepts. Proof semantics are NOT redefined here:
// shape, extraction, and binding checks all defer to the tested
// reclaim.mjs / validation.mjs / settlement.mjs checkers, so the wizard
// can only ever assemble bundles the contract's own gates would accept.
import {
  EVIDENCE,
  checkIdentityBinding,
  checkIdentityExtractions,
  checkPrExtractions,
  extractedOf,
} from "./reclaim.mjs";
import { extractProofFacts, validateProofShape } from "./validation.mjs";

const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/// Parse what the contributor types as "your pull request": either a full
/// https://github.com/<owner>/<repo>/pull/<n> URL or the short
/// <owner>/<repo>#<n> form. Returns { ok, repo?, prNumber?, errors? }
/// with prNumber canonicalized (no leading zeros). Pure.
export function parsePrUrl(input) {
  const s = typeof input === "string" ? input.trim() : "";
  if (s === "") return { ok: false, errors: ["Enter your pull request URL (https://github.com/<owner>/<repo>/pull/<n>)."] };
  let repo = null;
  let number = null;
  const url = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#][^\s]*)?\/?$/.exec(s);
  const short = /^([^/\s]+)\/([^/\s#]+)#(\d+)$/.exec(s);
  const m = url ?? short;
  if (!m) {
    return {
      ok: false,
      errors: ["That is not a GitHub PR link — use https://github.com/<owner>/<repo>/pull/<n> or <owner>/<repo>#<n>."],
    };
  }
  repo = `${m[1]}/${m[2]}`;
  number = m[3];
  if (!REPO_RE.test(repo)) return { ok: false, errors: [`${JSON.stringify(repo)} is not a valid owner/name slug.`] };
  const n = Number(number);
  if (!Number.isInteger(n) || n <= 0) return { ok: false, errors: [`${JSON.stringify(number)} is not a positive PR number.`] };
  return { ok: true, errors: [], repo, prNumber: String(n) };
}

/// Validate one pasted PR proof against the contributor's PR. `expected`
/// carries { repo, prNumber } from parsePrUrl; when the bounty criteria
/// already resolved, callers pass the criteria repo instead so a PR in
/// the wrong repository fails here — with a plain sentence — instead of
/// burning the 1 NEAR deposit on-chain. Returns the NORMALIZED proof
/// (submit-ready) plus display facts on success. Pure.
/**
 * @param {string} text
 * @param {{ repo?: string, prNumber?: string|number }} [expected]
 */
export function validatePastedPrProof(text, { repo, prNumber } = {}) {
  const errors = [];
  if (typeof text !== "string" || text.trim() === "") {
    return { ok: false, errors: ["Paste the PR proof JSON first (the file the prove command wrote)."] };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, errors: ["That is not valid JSON — paste the complete .json file contents."] };
  }
  const shape = validateProofShape(raw);
  if (!shape.ok) return { ok: false, errors: shape.errors.map((e) => `PR proof: ${e}`) };
  const ex = extractedOf(shape.normalized);
  if (!ex) return { ok: false, errors: ["PR proof: no extracted parameters (was it generated with the OmniBounty matchers?)."] };
  const problems = checkPrExtractions(ex, repo, String(prNumber));
  if (problems.length > 0) return { ok: false, errors: problems.map((p) => `PR proof: ${p}`) };
  const f = extractProofFacts(shape.normalized);
  if (!f.ok) return { ok: false, errors: f.errors.map((e) => `PR proof: ${e}`) };
  return {
    ok: true,
    errors: [],
    proof: shape.normalized,
    facts: { ...f.facts, owner: shape.normalized.signedClaim.claim.owner },
  };
}

/// Validate one pasted identity proof (login + numeric id present, shape
/// sound). Authorship/owner binding is checked separately by
/// checkWizardBinding once both proofs are present. Pure.
export function validatePastedIdentityProof(text) {
  if (typeof text !== "string" || text.trim() === "") {
    return { ok: false, errors: ["Paste the identity proof JSON first (the file the prove command wrote)."] };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, errors: ["That is not valid JSON — paste the complete .json file contents."] };
  }
  const shape = validateProofShape(raw);
  if (!shape.ok) return { ok: false, errors: shape.errors.map((e) => `Identity proof: ${e}`) };
  const ex = extractedOf(shape.normalized);
  if (!ex) {
    return { ok: false, errors: ["Identity proof: no extracted parameters (was it generated with the OmniBounty matchers?)."] };
  }
  const problems = checkIdentityExtractions(ex);
  if (problems.length > 0) return { ok: false, errors: problems.map((p) => `Identity proof: ${p}`) };
  return {
    ok: true,
    errors: [],
    proof: shape.normalized,
    facts: { id_login: ex.id_login, id_num: ex.id_num, owner: shape.normalized.signedClaim.claim.owner },
  };
}

/// Split one paste into its proofs. Accepts the single-file output of
/// scripts/prove_bundle.mjs ({ prProof, identityProof }) OR one
/// standalone proof (either kind — the caller tries PR validation first,
/// then identity). Returns { ok, kind, prText?, identityText?, text? }.
/// Pure.
export function splitPastedProofs(text) {
  if (typeof text !== "string" || text.trim() === "") {
    return { ok: false, errors: ["Paste the proof JSON first."] };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, errors: ["That is not valid JSON — paste the complete .json file contents."] };
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw) && raw.prProof && raw.identityProof) {
    if (typeof raw.prProof !== "object" || typeof raw.identityProof !== "object") {
      return { ok: false, errors: ["That bundle file is malformed (prProof/identityProof must be objects)."] };
    }
    return { ok: true, kind: "bundle-output", prText: JSON.stringify(raw.prProof), identityText: JSON.stringify(raw.identityProof) };
  }
  return { ok: true, kind: "single", text };
}

/// The contract's authorship chain for the wizard's two proofs: the
/// authenticated identity must BE the PR author (login + immutable
/// numeric id) and both proofs must share the payout owner. Takes the
/// NORMALIZED proofs from the validators above. Returns a problem list
/// (empty = bound). Pure.
/**
 * @param {{ prProof?: object, identityProof?: object }} [proofs]
 */
export function checkWizardBinding({ prProof, identityProof } = {}) {
  const prEx = extractedOf(prProof);
  const idEx = extractedOf(identityProof);
  if (!prEx || !idEx) return ["Could not read extracted parameters from one of the proofs."];
  const owners = [prProof?.signedClaim?.claim?.owner, identityProof?.signedClaim?.claim?.owner];
  if (owners.some((o) => typeof o !== "string" || o.length === 0)) return ["One of the proofs has no owner."];
  return checkIdentityBinding({
    prAuthor: prEx.author,
    prAuthorId: prEx.author_id,
    idLogin: idEx.id_login,
    idNum: idEx.id_num,
    proofOwners: owners,
    recipient: owners[0],
  });
}

/// Assemble the exact claim bundle the submit flow accepts:
/// { criteria_json, proofs: [{ evidence_type: 1 }, { evidence_type: 7 }] }.
/// criteriaJson is the hash-verified text from the criteria panel (never
/// contributor-typed); the proofs are normalized validator outputs.
/// Returns { ok, errors[], bundleText? } with pretty JSON for review. Pure.
/**
 * @param {{ criteriaJson?: string, prProof?: object, identityProof?: object }} [parts]
 */
export function assembleClaimBundle({ criteriaJson, prProof, identityProof } = {}) {
  if (typeof criteriaJson !== "string" || criteriaJson.length === 0) {
    return { ok: false, errors: ["The bounty criteria have not been verified yet — wait for the criteria panel above."] };
  }
  let criteria;
  try {
    criteria = JSON.parse(criteriaJson);
  } catch {
    return { ok: false, errors: ["The verified criteria text is unreadable — reload and retry."] };
  }
  if (!prProof || typeof prProof !== "object") return { ok: false, errors: ["A validated PR proof is required."] };
  if (!identityProof || typeof identityProof !== "object") return { ok: false, errors: ["A validated identity proof is required."] };
  const bundleText = JSON.stringify(
    {
      criteria_json: criteria,
      proofs: [
        { evidence_type: EVIDENCE.Pr, proof: prProof },
        { evidence_type: EVIDENCE.Identity, proof: identityProof },
      ],
    },
    null,
    2
  );
  return { ok: true, errors: [], bundleText };
}

/// The one local command that mints both proofs. Secrets are NOT part of
/// the command — they stay in the contributor's environment or .env.local.
/**
 * @param {{ repo?: string, prNumber?: string|number }} [pr]
 */
export function buildProveCommand({ repo, prNumber } = {}) {
  return `cd frontend\nnode scripts/prove_bundle.mjs ${repo} ${prNumber} ./claim-proofs.json`;
}

/// Copy-paste template for frontend/.env.local (gitignored, auto-loaded
/// by the prove scripts). Values are placeholders, never real secrets.
export const ENV_LOCAL_TEMPLATE = `RECLAIM_APP_ID=0x...
RECLAIM_APP_SECRET=0x...
GITHUB_TOKEN=<your-own-token>`;
