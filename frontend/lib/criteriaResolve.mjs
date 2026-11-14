// Universal V3 criteria resolution: ONE shared mechanism for Browse,
// Details, and Claim. Sources in order: verified cache -> served artifact
// (/criteria/<hash>.json) -> transaction-anchored recovery (the canonical
// document is permanently embedded in the public create_bounty arguments)
// -> caller-supplied paste (UI layer only, never inside this module).
//
// Integrity rule: EVERY candidate passes verifyCriteriaText() before it is
// returned or cached. Hosts, indexers, RPC nodes, and caches are all
// untrusted for integrity (a compromised one can only cause liveness
// failures, never a substituted document). All chain access flows through
// the injected fetchImpl, so every path is unit-testable offline.
import { fetchCriteriaDocument, verifyCriteriaText } from "./criteriaSource.mjs";

const HASH_RE = /^0x[0-9a-f]{64}$/;
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export const DEFAULT_SCAN_PAGE_SIZE = 100;
export const DEFAULT_SCAN_MAX_PAGES = 20;

// -- Verified cache --------------------------------------------------------
// Content-addressed (hash -> document) plus an immutable bounty mapping
// (bounty id -> creation tx). Entries never go stale: a hash identifies
// its bytes, and a bounty id admits exactly one successful creation.
// Reads ALWAYS re-verify before use, so a poisoned or hand-edited entry
// (memory or storage) is rejected and refetched, never trusted.
export function createCriteriaCache({ storage = null, namespace = "omnibounty.criteria.v1", maxEntries = 100 } = {}) {
  const docs = new Map(); // lowercased hash -> text
  const txs = new Map(); // String(bountyId) -> { txHash, signer }

  const readStorage = (key) => {
    try {
      const v = storage?.getItem(key);
      return typeof v === "string" ? v : null;
    } catch {
      return null;
    }
  };
  const writeStorage = (key, value) => {
    try {
      storage?.setItem(key, value);
    } catch {
      // Quota/privacy failures degrade to memory-only; resolution stays correct.
    }
  };
  const evictDocs = () => {
    while (docs.size > maxEntries) {
      const oldest = docs.keys().next().value;
      docs.delete(oldest);
    }
  };

  return {
    /// Store a document under its hash. Returns false (storing nothing)
    /// for malformed inputs; never throws.
    storeDocument(hash, text) {
      if (typeof hash !== "string" || !HASH_RE.test(hash.toLowerCase())) return false;
      if (typeof text !== "string" || text.length === 0) return false;
      const key = hash.toLowerCase();
      docs.set(key, text);
      evictDocs();
      writeStorage(`${namespace}.doc.${key}`, text);
      return true;
    },

    /// Raw read (memory, then storage). Callers MUST verify before use;
    /// see verifiedDocument() for the safe form. Never throws.
    readDocument(hash) {
      if (typeof hash !== "string") return null;
      const key = hash.toLowerCase();
      if (docs.has(key)) return docs.get(key);
      const stored = readStorage(`${namespace}.doc.${key}`);
      if (stored) {
        docs.set(key, stored);
        evictDocs();
        return stored;
      }
      return null;
    },

    /// Verify-on-read: returns the verified document or null. Never throws.
    verifiedDocument(hash, expectedHash) {
      const text = this.readDocument(hash);
      if (text == null) return null;
      const v = verifyCriteriaText(text, expectedHash ?? hash);
      return v.ok ? v : null;
    },

    /// Remember where a bounty was created. Immutable once verified.
    storeCreateTx(bountyId, { txHash, signer }) {
      if (!Number.isInteger(bountyId) || bountyId < 0) return false;
      if (typeof txHash !== "string" || txHash.length === 0) return false;
      if (typeof signer !== "string" || signer.length === 0) return false;
      const entry = { txHash, signer };
      txs.set(String(bountyId), entry);
      writeStorage(`${namespace}.tx.${bountyId}`, JSON.stringify(entry));
      return true;
    },

    readCreateTx(bountyId) {
      if (!Number.isInteger(bountyId) || bountyId < 0) return null;
      const key = String(bountyId);
      if (txs.has(key)) return txs.get(key);
      const stored = readStorage(`${namespace}.tx.${key}`);
      if (stored) {
        try {
          const entry = JSON.parse(stored);
          if (entry && typeof entry.txHash === "string" && typeof entry.signer === "string") {
            txs.set(key, { txHash: entry.txHash, signer: entry.signer });
            return txs.get(key);
          }
        } catch {
          return null;
        }
      }
      return null;
    },

    clear() {
      docs.clear();
      txs.clear();
    },

    get size() {
      return docs.size;
    },
  };
}

function browserStorage() {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

let sharedCacheInstance = null;

/// Process-wide verified cache (browser: localStorage-backed; node: memory).
/// Components share it; tests construct their own via createCriteriaCache().
export function getSharedCache() {
  if (!sharedCacheInstance) sharedCacheInstance = createCriteriaCache({ storage: browserStorage() });
  return sharedCacheInstance;
}

// -- Pure parsers ------------------------------------------------------------

/// Extract candidate creation transactions from one indexer receipts page
/// (NearBlocks v1 account-transactions shape). Keeps only FUNCTION_CALL
/// create_bounty receipts addressed to this contract from a non-system
/// signer, deduplicated by tx hash. Never throws on data shapes.
export function extractCreateCandidates(indexerJson, { contractId }) {
  if (!indexerJson || typeof indexerJson !== "object" || Array.isArray(indexerJson)) {
    return { ok: false, reason: "invalid", detail: "indexer payload is not an object" };
  }
  const txns = Array.isArray(indexerJson.txns) ? indexerJson.txns : [];
  const seen = new Map(); // txHash -> signer (first wins)
  for (const r of txns) {
    if (!r || typeof r !== "object") continue;
    const txHash = r.transaction_hash;
    if (typeof txHash !== "string" || txHash.length === 0) continue;
    if (r.receiver_account_id !== contractId) continue;
    const signer = r.predecessor_account_id;
    if (typeof signer !== "string" || signer.length === 0 || signer === "system") continue;
    const actions = Array.isArray(r.actions) ? r.actions : [];
    const creates = actions.some((a) => a && a.action === "FUNCTION_CALL" && a.method === "create_bounty");
    if (!creates) continue;
    if (!seen.has(txHash)) seen.set(txHash, signer);
  }
  return { ok: true, candidates: [...seen.entries()].map(([txHash, signer]) => ({ txHash, signer })) };
}

/// True only for a successful NEAR execution outcome. Failed attempts
/// (BountyExists retries, validation failures) are skipped, never trusted.
export function isTxSuccess(txJson) {
  const status = txJson?.result?.status;
  if (!status || typeof status !== "object") return false;
  return "SuccessValue" in status || "SuccessReceiptId" in status;
}

function base64ToUtf8(b64) {
  // Browser-safe (no Buffer): atob exists in browsers and Node 16+.
  if (typeof b64 !== "string" || b64.length === 0 || b64.length % 4 !== 0 || !B64_RE.test(b64)) {
    throw new Error("not base64");
  }
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/// Extract the criteria document from one NEAR RPC `tx` response for the
/// wanted bounty. Reasons: "not-success" (failed attempt — skip),
/// "other-bounty" (different bounty — skip), "no-create-args" (no
/// create_bounty call — skip), "malformed" (unreadable — skip). The
/// returned text is still UNVERIFIED: callers must run
/// verifyCriteriaText() before trusting it. Never throws.
export function extractCriteriaFromTx(txJson, { bountyId }) {
  if (!txJson || typeof txJson !== "object") {
    return { ok: false, reason: "malformed", detail: "transaction response is not an object" };
  }
  if (!isTxSuccess(txJson)) {
    return { ok: false, reason: "not-success", detail: "transaction did not succeed" };
  }
  const actions = txJson.result?.transaction?.actions;
  if (!Array.isArray(actions)) {
    return { ok: false, reason: "malformed", detail: "transaction has no actions list" };
  }
  const call = actions.find((a) => a?.FunctionCall?.method_name === "create_bounty")?.FunctionCall ?? null;
  if (!call) {
    return { ok: false, reason: "no-create-args", detail: "no create_bounty call in transaction" };
  }
  let args;
  try {
    args = JSON.parse(base64ToUtf8(call.args));
  } catch {
    return { ok: false, reason: "malformed", detail: "create_bounty args are not base64 JSON" };
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { ok: false, reason: "malformed", detail: "create_bounty args are not an object" };
  }
  if (args.bounty_id !== bountyId) {
    return { ok: false, reason: "other-bounty", detail: `transaction creates bounty ${String(args.bounty_id)}` };
  }
  if (typeof args.criteria_json !== "string" || args.criteria_json.length === 0) {
    return { ok: false, reason: "malformed", detail: "create_bounty args carry no criteria_json string" };
  }
  return { ok: true, criteriaText: args.criteria_json };
}

// -- Network fetchers (all through fetchImpl) --------------------------------

async function readJsonBody(res) {
  // res.json() when available; some doubles only implement text().
  if (res && typeof res.json === "function") return res.json();
  return JSON.parse(await res.text());
}

async function fetchReceiptsPage({ indexerBaseUrl, contractId, page, perPage }, fetchImpl) {
  const url = `${indexerBaseUrl}/v1/account/${contractId}/txns?order=desc&page=${page}&per_page=${perPage}`;
  let res;
  try {
    res = await fetchImpl(url);
  } catch (e) {
    return { ok: false, reason: "unavailable", detail: e instanceof Error ? e.message : String(e) };
  }
  if (!res || typeof res !== "object" || res.ok === false) {
    return { ok: false, reason: "unavailable", detail: `indexer request failed (status ${res?.status})` };
  }
  try {
    return { ok: true, json: await readJsonBody(res) };
  } catch (e) {
    return { ok: false, reason: "unavailable", detail: `indexer response unreadable (${e instanceof Error ? e.message : String(e)})` };
  }
}

async function fetchTransaction({ nearRpcUrl, txHash, signer }, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(nearRpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "omnibounty-criteria", method: "tx", params: [txHash, signer] }),
    });
  } catch (e) {
    return { ok: false, reason: "unavailable", detail: e instanceof Error ? e.message : String(e) };
  }
  if (!res || typeof res !== "object" || res.ok === false) {
    return { ok: false, reason: "unavailable", detail: `transaction request failed (status ${res?.status})` };
  }
  let body;
  try {
    body = await readJsonBody(res);
  } catch (e) {
    return { ok: false, reason: "unavailable", detail: `transaction response unreadable (${e instanceof Error ? e.message : String(e)})` };
  }
  if (!body || typeof body !== "object" || body.error) {
    return { ok: false, reason: "not-found", detail: "transaction unknown to this RPC node" };
  }
  return { ok: true, json: body };
}

// -- Universal resolver ------------------------------------------------------

function validBountyId(v) {
  return Number.isInteger(v) && v >= 0;
}

/// Resolve the criteria document for ANY bounty through every known
/// source, in order: verified cache -> served artifact ->
/// transaction-anchored recovery. Returns verifyCriteriaText's success
/// shape plus `source` ("cache" | "artifact" | "transaction"), the
/// creation `txHash` when transaction-anchored, and `tried` (sources
/// attempted). Failures carry reason "missing" | "unavailable" |
/// "malformed" | "invalid" | "mismatch" with the same fail-closed
/// semantics as criteriaSource: a found-but-wrong document for THIS
/// bounty aborts with mismatch/invalid instead of trying further
/// candidates, because a bounty admits exactly one successful creation.
export async function resolveCriteriaDocument(
  { bountyId, criteriaHash, createTxHash = null, signer = null },
  {
    fetchImpl = globalThis.fetch,
    artifactBase = "",
    indexerBaseUrl = null,
    contractId = null,
    nearRpcUrl = null,
    cache = null,
    perPage = DEFAULT_SCAN_PAGE_SIZE,
    maxPages = DEFAULT_SCAN_MAX_PAGES,
  } = {}
) {
  const tried = [];
  const want = String(criteriaHash ?? "").toLowerCase();
  if (!validBountyId(bountyId)) {
    return { ok: false, reason: "invalid", detail: "bounty id must be a non-negative integer", tried };
  }
  if (!HASH_RE.test(want)) {
    return { ok: false, reason: "invalid", detail: "criteria hash is not 0x-prefixed 32-byte hex", tried };
  }
  if (typeof fetchImpl !== "function") {
    return { ok: false, reason: "unavailable", detail: "no fetch implementation available", tried };
  }

  // 1. Verified cache (verify-on-read defeats poisoned entries).
  if (cache) {
    tried.push("cache");
    let hit = null;
    try {
      hit = cache.verifiedDocument(want, want);
    } catch {
      hit = null;
    }
    if (hit) return { ok: true, text: hit.text, hash: hit.hash, doc: hit.doc, source: "cache", tried };
  }

  // 2. Served artifact (fast path; still fully verified).
  tried.push("artifact");
  let artifactPoison = null;
  try {
    const fetchArtifact = artifactBase
      ? (path) => fetchImpl(`${artifactBase}${path}`)
      : fetchImpl;
    const r = await fetchCriteriaDocument(want, fetchArtifact);
    if (r.ok) {
      try {
        cache?.storeDocument(want, r.text);
      } catch {
        // Cache failures never fail resolution.
      }
      return { ok: true, text: r.text, hash: r.hash, doc: r.doc, source: "artifact", tried };
    }
    if (r.reason === "malformed" || r.reason === "invalid" || r.reason === "mismatch") {
      artifactPoison = r; // a served-but-wrong file: keep looking on-chain, report it if nothing verifies
    }
  } catch (e) {
    return { ok: false, reason: "unavailable", detail: e instanceof Error ? e.message : String(e), tried };
  }

  // 3. Transaction-anchored recovery.
  tried.push("transaction");
  if (!indexerBaseUrl || !contractId || !nearRpcUrl) {
    return {
      ok: false,
      reason: "unavailable",
      detail: "transaction recovery is not configured (indexer/contract/RPC endpoint missing)",
      tried,
    };
  }

  const verifyAndCache = (text, txHash, txSigner) => {
    const v = verifyCriteriaText(text, want);
    if (!v.ok) return v;
    try {
      cache?.storeDocument(want, v.text);
      if (txHash && txSigner) cache?.storeCreateTx(bountyId, { txHash, signer: txSigner });
    } catch {
      // Cache failures never fail resolution.
    }
    return { ok: true, text: v.text, hash: v.hash, doc: v.doc, source: "transaction", txHash, tried };
  };

  const resolveOneTx = async (txHash, txSigner) => {
    const fetched = await fetchTransaction({ nearRpcUrl, txHash, signer: txSigner }, fetchImpl);
    if (!fetched.ok) return fetched;
    return extractCriteriaFromTx(fetched.json, { bountyId });
  };

  // 3a. Known creation tx (sponsor flow) or remembered mapping: direct fetch, no scan.
  const direct = createTxHash
    ? { txHash: createTxHash, signer }
    : cache
      ? cache.readCreateTx(bountyId)
      : null;
  if (createTxHash || direct) {
    const txHash = createTxHash ?? direct.txHash;
    const txSigner = createTxHash ? signer : direct.signer;
    if (typeof txHash !== "string" || txHash.length === 0 || typeof txSigner !== "string" || txSigner.length === 0) {
      return { ok: false, reason: "invalid", detail: "direct transaction lookup needs a hash and a signer account", tried };
    }
    const r = await resolveOneTx(txHash, txSigner);
    if (!r.ok) {
      if (r.reason === "not-found") {
        return { ok: false, reason: "missing", detail: `creation transaction ${txHash} unknown to this RPC node`, tried };
      }
      if (r.reason === "unavailable") return { ...r, tried };
      return { ok: false, reason: "invalid", detail: `known creation transaction unusable (${r.reason}: ${r.detail})`, tried };
    }
    const v = verifyAndCache(r.criteriaText, txHash, txSigner);
    if (!v.ok) return { ...v, tried };
    return v;
  }

  // 3b. Discovery scan over the contract's receipts (contributor flow:
  // no sponsor input at all). Skips failures, foreign bounties, and
  // garbage; aborts fail-closed on a verified-id mismatch.
  if (typeof signer === "string" && signer.length > 0 && !createTxHash) {
    // A bare signer without a tx hash adds nothing to discovery; ignore.
  }
  const seenTx = new Set();
  let sawTransportFailure = false;
  for (let page = 1; page <= maxPages; page++) {
    const fetched = await fetchReceiptsPage({ indexerBaseUrl, contractId, page, perPage }, fetchImpl);
    if (!fetched.ok) {
      return { ...fetched, tried };
    }
    const listed = extractCreateCandidates(fetched.json, { contractId });
    if (!listed.ok) {
      return { ok: false, reason: "unavailable", detail: `indexer page ${page} unreadable (${listed.detail})`, tried };
    }
    const pageTxns = Array.isArray(fetched.json?.txns) ? fetched.json.txns : [];
    for (const c of listed.candidates) {
      if (seenTx.has(c.txHash)) continue;
      seenTx.add(c.txHash);
      const r = await resolveOneTx(c.txHash, c.signer);
      if (!r.ok) {
        if (r.reason === "unavailable") sawTransportFailure = true;
        continue; // unknown/failed/unreadable candidate: keep scanning
      }
      const v = verifyAndCache(r.criteriaText, c.txHash, c.signer);
      if (!v.ok) {
        if (v.reason === "mismatch" || v.reason === "malformed" || v.reason === "invalid") {
          return { ...v, tried }; // successful creation for THIS id that fails verification: stop, fail closed
        }
        continue;
      }
      return v;
    }
    if (pageTxns.length === 0) break; // normal end of history
  }
  if (artifactPoison) return { ...artifactPoison, tried };
  if (sawTransportFailure) {
    return { ok: false, reason: "unavailable", detail: "candidate transactions could not be read; retry later", tried };
  }
  return { ok: false, reason: "missing", detail: `no creation transaction found for bounty ${bountyId}`, tried };
}

// -- Shared instance (component path) ------------------------------------------

/**
 * Live resolver with in-flight dedupe: concurrent resolves for one
 * bounty share a single scan. Construct per endpoint set; tests build
 * their own, components share one via getSharedResolver().
 * @param {{ fetchImpl?: typeof fetch, indexerBaseUrl?: string, contractId?: string, nearRpcUrl?: string, cache?: object|null }} [opts]
 */
export function createSharedResolver({ fetchImpl = globalThis.fetch, indexerBaseUrl, contractId, nearRpcUrl, cache = null } = {}) {
  const store = cache ?? getSharedCache();
  const inflight = new Map();
  return {
    cache: store,
    resolve(args) {
      const key = `${args?.bountyId}:${String(args?.criteriaHash ?? "").toLowerCase()}:${args?.createTxHash ?? ""}`;
      if (inflight.has(key)) return inflight.get(key);
      const p = resolveCriteriaDocument(args, { fetchImpl, indexerBaseUrl, contractId, nearRpcUrl, cache: store }).finally(() => {
        if (inflight.get(key) === p) inflight.delete(key);
      });
      inflight.set(key, p);
      return p;
    },
  };
}

const sharedResolvers = new Map();

/**
 * Memoized shared resolver for the configured deployment. Components
 * call this; every page then resolves through the same cache, the same
 * scan dedupe, and the same verification gate.
 * @param {{ fetchImpl?: typeof fetch, indexerBaseUrl?: string, contractId?: string, nearRpcUrl?: string }} [opts]
 */
export function getSharedResolver({ fetchImpl = globalThis.fetch, indexerBaseUrl, contractId, nearRpcUrl } = {}) {
  const key = JSON.stringify([indexerBaseUrl, contractId, nearRpcUrl]);
  if (!sharedResolvers.has(key)) {
    sharedResolvers.set(key, createSharedResolver({ fetchImpl, indexerBaseUrl, contractId, nearRpcUrl }));
  }
  return sharedResolvers.get(key);
}
