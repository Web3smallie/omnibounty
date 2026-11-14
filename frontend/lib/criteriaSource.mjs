// V3 criteria retrieval + verification. The NEAR V3 contract stores only
// the criteria_hash (BountyV3 has no document field by design); claimants
// re-supply the document on every claim and the contract re-validates and
// re-hashes it. This module fetches a candidate document for a bounty and
// accepts it ONLY when it strictly parses, validates, and hashes to the
// on-chain commitment. Chain access happens solely through the injected
// `fetchImpl`, so every path is unit-testable without network.
import {
  hashCriteriaDocument,
  strictParseJson,
  validateCriteria,
} from "./criteria.mjs";

const HASH_RE = /^0x[0-9a-f]{64}$/;

/// Verify candidate criteria text against an on-chain criteria hash.
/// Returns { ok: true, text, hash, doc } on success, else
/// { ok: false, reason, detail } with reason one of
/// "malformed" (not strict JSON), "invalid" (fails criteria validation),
/// or "mismatch" (valid document for a different commitment). Pure.
export function verifyCriteriaText(text, expectedHash) {
  const want = String(expectedHash ?? "").toLowerCase();
  if (!HASH_RE.test(want)) {
    return { ok: false, reason: "invalid", detail: "expected criteria hash is not 0x-prefixed 32-byte hex" };
  }
  if (typeof text !== "string" || text.length === 0) {
    return { ok: false, reason: "malformed", detail: "criteria text is empty" };
  }
  let doc;
  try {
    doc = strictParseJson(text);
  } catch (e) {
    return { ok: false, reason: "malformed", detail: e instanceof Error ? e.message : String(e) };
  }
  const v = validateCriteria(doc);
  if (!v.ok) {
    return { ok: false, reason: "invalid", detail: v.errors.join("; ") };
  }
  let hash;
  try {
    hash = hashCriteriaDocument(text);
  } catch (e) {
    return { ok: false, reason: "malformed", detail: e instanceof Error ? e.message : String(e) };
  }
  if (hash.toLowerCase() !== want) {
    return { ok: false, reason: "mismatch", detail: `document hashes to ${hash}, bounty commits to ${want}` };
  }
  return { ok: true, text, hash: want, doc };
}

/// Retrieve the criteria document committed to by `criteriaHash` from the
/// app's served criteria artifacts (`/criteria/<hash>.json`) and verify
/// it before accepting. Returns verifyCriteriaText's success shape, or
/// { ok: false, reason, detail } with reason "missing" (no artifact for
/// this hash — the claimant must paste the sponsor's document instead),
/// "unavailable" (transport failure), or a verifyCriteriaText reason.
/// Never throws on expected failures; only unexpected fetchImpl misuse
/// (non-Response returns) propagates as an exception.
export async function fetchCriteriaDocument(criteriaHash, fetchImpl = fetch) {
  const want = String(criteriaHash ?? "").toLowerCase();
  if (!HASH_RE.test(want)) {
    return { ok: false, reason: "invalid", detail: "criteria hash is not 0x-prefixed 32-byte hex" };
  }
  let res;
  try {
    res = await fetchImpl(`/criteria/${want}.json`);
  } catch (e) {
    return { ok: false, reason: "unavailable", detail: e instanceof Error ? e.message : String(e) };
  }
  if (!res || typeof res !== "object") {
    throw new Error("fetchCriteriaDocument: fetchImpl must resolve to a Response-like object");
  }
  if (res.status === 404 || res.ok === false) {
    if (res.status === 404) {
      return { ok: false, reason: "missing", detail: `no served criteria artifact for ${want}` };
    }
    return { ok: false, reason: "unavailable", detail: `criteria artifact request failed (status ${res.status})` };
  }
  let text;
  try {
    text = await res.text();
  } catch (e) {
    return { ok: false, reason: "unavailable", detail: e instanceof Error ? e.message : String(e) };
  }
  return verifyCriteriaText(text, want);
}
