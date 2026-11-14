// Pure V3 claim-progress helpers: bundle parsing, own-claim selection, and
// phase derivation for the settlement tracker. No network, no React —
// covered by test/settlement.test.mjs. Every phase here is derived from
// on-chain reads performed by the caller; nothing is simulated.
import { formatUsdc, interpretNearTxOutcome, thrownTxHash } from "./display.mjs";
import { extractProofFacts, validateProofShape } from "./validation.mjs";
import { EVIDENCE, checkIdentityBinding, extractedOf } from "./reclaim.mjs";

/// Parse the pasted V3 claim bundle: { criteria_json, proofs }. criteria_json
/// accepts the raw document object or its canonical string; proofs must be a
/// non-empty array of { evidence_type, proof } matching the contract's
/// TaggedProofArg (lib.rs): evidence_type is the u8 EvidenceType number
/// (1 = PR, 7 = identity, ...), proof is a Reclaim proof in either the raw
/// zkFetch shape or the normalized on-chain shape (B2 normalizes at submit).
/**
 * @typedef {object} ParsedBundle
 * @property {string} criteria_json
 * @property {Array<{evidence_type: number, proof: unknown}>} proofs
 * @param {string} text
 * @returns {{ok: true, bundle: ParsedBundle} | {ok: false, errors: string[]}}
 */
export function parseClaimBundle(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, errors: ["Bundle is not valid JSON."] };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["Bundle must be an object { criteria_json, proofs }."] };
  }
  const errors = [];
  let criteriaJson = raw.criteria_json ?? raw.criteriaJson;
  if (criteriaJson && typeof criteriaJson === "object") {
    try {
      criteriaJson = JSON.stringify(criteriaJson);
    } catch {
      errors.push("criteria_json is not serializable.");
    }
  }
  if (typeof criteriaJson !== "string" || criteriaJson.length === 0) {
    errors.push("criteria_json must be the bounty criteria document (object or JSON string).");
  }
  const proofs = raw.proofs;
  if (!Array.isArray(proofs) || proofs.length === 0) {
    errors.push("proofs must be a non-empty array of { evidence_type, proof }.");
  } else {
    proofs.forEach((p, i) => {
      if (!p || typeof p !== "object") errors.push(`proofs[${i}] must be an object.`);
      else if (!Number.isInteger(p.evidence_type) || p.evidence_type < 1 || p.evidence_type > 8) {
        errors.push(`proofs[${i}].evidence_type must be an EvidenceType number 1-8 (1 = PR, 7 = identity).`);
      } else if (!p.proof || typeof p.proof !== "object") errors.push(`proofs[${i}].proof must be an object.`);
    });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, bundle: { criteria_json: criteriaJson, proofs } };
}

/// Merge hash-verified criteria text into a pasted bundle that lacks it:
/// when `verifiedCriteria` is non-empty and the bundle parses to an object
/// WITHOUT criteria_json/criteriaJson, the verified document is injected
/// (as the parsed object; the contract canonicalizes before hashing, so
/// key order never matters). An explicitly pasted criteria_json always
/// wins, and unparseable bundles pass through untouched so the normal
/// parser reports the error. Pure: no network.
export function mergeVerifiedCriteria(bundleText, verifiedCriteria) {
  if (typeof verifiedCriteria !== "string" || verifiedCriteria.length === 0) return bundleText;
  let raw;
  try {
    raw = JSON.parse(bundleText);
  } catch {
    return bundleText;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bundleText;
  if (raw.criteria_json != null || raw.criteriaJson != null) return bundleText;
  let doc;
  try {
    doc = JSON.parse(verifiedCriteria);
  } catch {
    return bundleText;
  }
  return JSON.stringify({ ...raw, criteria_json: doc });
}

/// Entries of one evidence kind inside a parsed bundle.
export function proofsOf(bundle, evidenceType) {
  return bundle.proofs.filter((p) => p.evidence_type === evidenceType);
}

/// The PR-anchored proof inside a parsed bundle (for fact display + the
/// recipient default). V3 requires exactly one evidence_type-1 entry.
export function prProofOf(bundle) {
  const found = proofsOf(bundle, EVIDENCE.Pr);
  if (found.length !== 1) return null;
  return found[0].proof;
}

/// Normalize every bundle proof to the exact on-chain shape
/// ({claimInfo, signedClaim}) and bind the bundle: exactly one PR proof,
/// at least one identity proof, all owners equal, identity == PR author
/// (login + numeric id), and — when `recipient` is given — every owner
/// equal to the recipient. Mirrors the contract's pre-evaluation gates
/// (MissingEvidence, MixedProverBundle, RecipientMismatch, identity.login,
/// identity.id) so the form fails fast with UI errors instead of on-chain.
/// Returns { ok, errors[], contractProofs? } with contractProofs ready for
/// qualify_claim: [{ evidence_type, proof: normalized }].
/**
 * @param {ParsedBundle} bundle
 * @param {string|null} [recipient]
 * @returns {{ok: true, errors: string[], contractProofs: Array<{evidence_type: number, proof: unknown}>} | {ok: false, errors: string[]}}
 */
export function toContractProofs(bundle, recipient = null) {
  const errors = [];
  const prEntries = proofsOf(bundle, EVIDENCE.Pr);
  if (prEntries.length !== 1) errors.push(`The bundle must contain exactly one PR proof (evidence_type ${EVIDENCE.Pr}).`);
  const idEntries = proofsOf(bundle, EVIDENCE.Identity);
  if (idEntries.length < 1) errors.push(`The bundle must contain an identity proof (evidence_type ${EVIDENCE.Identity}).`);
  const normalized = [];
  bundle.proofs.forEach((p, i) => {
    const shape = validateProofShape(p.proof);
    if (!shape.ok) {
      errors.push(...shape.errors.map((e) => `proofs[${i}]: ${e}`));
      return;
    }
    normalized.push({ evidence_type: p.evidence_type, proof: shape.normalized, index: i });
  });
  if (errors.length > 0) return { ok: false, errors };
  const owners = [...new Set(normalized.map((n) => String(n.proof.signedClaim.claim.owner).toLowerCase()))];
  if (owners.length > 1) {
    return { ok: false, errors: ["All bundle proofs must share one owner (mixed-prover bundles are rejected on-chain)."] };
  }
  const prNorm = normalized.find((n) => n.evidence_type === EVIDENCE.Pr).proof;
  const idNorm = normalized.find((n) => n.evidence_type === EVIDENCE.Identity).proof;
  const prEx = extractedOf(prNorm);
  const idEx = extractedOf(idNorm);
  if (!prEx || !idEx) {
    return { ok: false, errors: ["Could not read extracted parameters from the PR or identity proof."] };
  }
  const binding = checkIdentityBinding({
    prAuthor: prEx.author,
    prAuthorId: prEx.author_id,
    idLogin: idEx.id_login,
    idNum: idEx.id_num,
    proofOwners: normalized.map((n) => n.proof.signedClaim.claim.owner),
    recipient: recipient ?? normalized[0].proof.signedClaim.claim.owner,
  });
  if (binding.length > 0) return { ok: false, errors: binding };
  return {
    ok: true,
    errors: [],
    contractProofs: normalized.map(({ evidence_type, proof }) => ({ evidence_type, proof })),
  };
}

/// Full client-side analysis of a pasted bundle: parse, normalize + bind
/// (toContractProofs), extract display facts, and — M1 — refuse unmerged
/// PRs outright (a doomed qualify would burn the 1 NEAR deposit on-chain).
/// Returns { ok, errors[], bundle?, facts? }; `facts` carries the proof
/// owner for the recipient default. Pure; the form only renders the result.
/**
 * @param {string} bundleText
 * @param {string|null} [recipient]
 * @returns {{ok: true, errors: string[], bundle: ParsedBundle, facts: object} | {ok: false, errors: string[]}}
 */
export function planClaimSubmission(bundleText, recipient = null) {
  const parsed = parseClaimBundle(bundleText);
  if (!parsed.ok) return { ok: false, errors: parsed.errors ?? ["Invalid claim bundle."] };
  const contract = toContractProofs(parsed.bundle, recipient);
  if (!contract.ok) return { ok: false, errors: contract.errors ?? ["Invalid claim bundle."] };
  const prNorm = contract.contractProofs.find((p) => p.evidence_type === EVIDENCE.Pr).proof;
  const shape = validateProofShape(prNorm);
  if (!shape.ok) return { ok: false, errors: shape.errors.map((e) => `pr proof: ${e}`) };
  const f = extractProofFacts(shape.normalized);
  if (!f.ok) return { ok: false, errors: f.errors.map((e) => `pr proof: ${e}`) };
  const owner = shape.normalized.signedClaim.claim.owner;
  const facts = { ...f.facts, owner };
  if (facts.merged !== "true") {
    return { ok: false, errors: ["This proof says the PR is NOT merged (merged=false) — the contract will reject it."] };
  }
  return {
    ok: true,
    errors: [],
    bundle: { criteria_json: parsed.bundle.criteria_json, proofs: contract.contractProofs },
    facts,
  };
}

/// The exact argument object sent to BOTH dry_qualify (preflight) and
/// qualify_claim (wallet tx). One builder, one object shape — parity by
/// construction; the form passes the same reference to both calls.
/**
 * @typedef {object} QualifyArgs
 * @property {number} bounty_id
 * @property {string} criteria_json
 * @property {Array<{evidence_type: number, proof: unknown}>} proofs
 * @property {string} recipient
 * @param {number} bountyId
 * @param {ParsedBundle} bundle
 * @param {string} recipient
 * @returns {QualifyArgs}
 */
export function buildQualifyArgs(bountyId, bundle, recipient) {
  return { bounty_id: bountyId, criteria_json: bundle.criteria_json, proofs: bundle.proofs, recipient };
}

/// Interpret a dry_qualify outcome. Fail-closed: anything but
/// { ok: true, errors: [] } — including malformed responses — blocks the
/// wallet transaction, surfacing the contract's own error strings plus any
/// failing per-criterion verdicts.
/**
 * @param {unknown} outcome
 * @returns {{ok: true, errors: string[]} | {ok: false, errors: string[]}}
 */
export function interpretDryOutcome(outcome) {
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) {
    return { ok: false, errors: ["Preflight returned an unreadable response; refusing to submit."] };
  }
  if (outcome.ok !== true) {
    const errors = Array.isArray(outcome.errors) && outcome.errors.length > 0
      ? outcome.errors.map(String)
      : ["The contract would reject this claim."];
    const verdicts = Array.isArray(outcome.verdicts) ? outcome.verdicts : [];
    for (const v of verdicts) {
      if (v && typeof v === "object" && v.status !== "Pass" && typeof v.id === "string") {
        errors.push(`${v.id}: ${typeof v.detail === "string" && v.detail ? v.detail : v.status}`);
      }
    }
    return { ok: false, errors };
  }
  if (Array.isArray(outcome.errors) && outcome.errors.length > 0) {
    return { ok: false, errors: outcome.errors.map(String) };
  }
  return { ok: true, errors: [] };
}

/// Submit with mandatory preflight: run dryCall(args), submit via
/// signCall(args) ONLY when the dry outcome passes. RPC throws and
/// malformed responses fail closed (no wallet transaction). Both calls
/// receive the identical args object (parity by reference). A resolved
/// receipt carrying the wallet outcome is validated against its final
/// execution status (defense in depth behind signAndSend); failures keep
/// the transaction hash so the UI can still link the explorer.
/**
 * @param {object} o
 * @param {QualifyArgs} o.args
 * @param {(args: QualifyArgs) => Promise<unknown>} o.dryCall
 * @param {(args: QualifyArgs) => Promise<{txHash: string|null, outcome?: unknown}>} o.signCall
 * @returns {Promise<{ok: true, errors: string[], receipt: {txHash: string|null}} | {ok: false, errors: string[], txHash: string|null}>}
 */
export async function submitWithPreflight({ args, dryCall, signCall }) {
  let dry;
  try {
    dry = await dryCall(args);
  } catch (e) {
    return { ok: false, errors: [`Preflight check failed (${e instanceof Error ? e.message : String(e)}); refusing to submit.`], txHash: null };
  }
  const verdict = interpretDryOutcome(dry);
  if (!verdict.ok) return { ok: false, errors: verdict.errors, txHash: null };
  try {
    const receipt = await signCall(args);
    if (receipt && typeof receipt === "object" && receipt.outcome != null) {
      const v = interpretNearTxOutcome(receipt.outcome);
      if (!v.ok) {
        return { ok: false, errors: [v.error], txHash: v.txHash ?? receipt.txHash ?? null };
      }
    }
    return { ok: true, errors: [], receipt };
  } catch (e) {
    return { ok: false, errors: [e instanceof Error ? e.message : String(e)], txHash: thrownTxHash(e) };
  }
}

/// Pick the caller's claim out of probed slots: latest claim_seq whose
/// recipient matches (case-insensitive). Input: [{ slot, claim|null }].
export function selectOwnClaim(entries, recipient) {
  const want = String(recipient).toLowerCase();
  let best = null;
  for (const e of entries) {
    if (!e || !e.claim || typeof e.claim.recipient !== "string") continue;
    if (e.claim.recipient.toLowerCase() !== want) continue;
    if (!best || (e.claim.claim_seq ?? 0) >= (best.claim.claim_seq ?? 0)) best = e;
  }
  return best;
}

/// Summarize a returning-claimant slot scan: entries are [{ slot,
/// claim|null }] and failedSlots counts reads that errored (recorded as
/// null claims). A match wins; otherwise any failed read makes the
/// outcome uncertain (retry) rather than a false "none".
export function summarizeOwnClaimScan(entries, recipient, failedSlots = 0) {
  const own = selectOwnClaim(entries, recipient);
  if (own) return { status: "found", slot: own.slot, claim: own.claim };
  if (failedSlots > 0) return { status: "uncertain", slot: null, claim: null };
  return { status: "none", slot: null, claim: null };
}

/// Derive the tracker phase from on-chain reads. `nowSec` is injectable so
/// tests stay deterministic; callers omit it.
/// Phases: qualifying -> qualified -> finalizing -> signing -> settling -> paid.
export function derivePhase({ claim, voucher, used, nowSec = Math.floor(Date.now() / 1000) }) {
  if (voucher) {
    if (used === true) return { phase: "paid" };
    return { phase: "settling" }; // signed, escrow not yet spent (or still checking)
  }
  if (!claim) return { phase: "qualifying" }; // tx confirming, or not yet submitted
  if (claim.signed === true) return { phase: "settling" }; // voucher view lagging a block behind
  if (claim.pending_digest) return { phase: "signing" }; // dispatched: MPC round in flight
  if (typeof claim.challenge_ends_at === "number" && nowSec < claim.challenge_ends_at) {
    return { phase: "qualified", waitSec: claim.challenge_ends_at - nowSec };
  }
  return { phase: "finalizing" }; // matured: the relayer's next poll submits finalize_claim
}

/// V3 bounty title/criteria lines (the V1 derivations in display.mjs stay
/// byte-identical for V1 bounties).
export function bountyTitleV3(bounty) {
  return `Bounty #${bounty.id}`;
}

export function bountyCriteriaV3(bounty) {
  const n = Array.isArray(bounty.slots) ? bounty.slots.length : 0;
  const filled = bounty.slots_filled ?? 0;
  let total = null;
  try {
    total = formatUsdc(bounty.total_amount);
  } catch {
    total = null;
  }
  const when = bounty.challenge_window === 0
    ? "no challenge delay"
    : `challenge window ${bounty.challenge_window}s`;
  return `${n} slot${n === 1 ? "" : "s"} (${filled} claimed), verified with Reclaim zkTLS, ${when}.` +
    (total !== null ? ` Total ${total} USDC.` : "");
}
