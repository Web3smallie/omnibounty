// Shared harness for Phase 1 Reclaim experiments (no secrets printed, ever).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..', '..', '..');
const require = createRequire(import.meta.url);
export const ethers = require(join(ROOT, 'frontend', 'node_modules', 'ethers')).ethers;
export const canonicalize = require(join(ROOT, 'tools', 'node_modules', 'canonicalize'));
export const { ReclaimClient } = require(join(ROOT, 'frontend', 'node_modules', '@reclaimprotocol', 'zk-fetch'));
const { validateProofShape } = await import(pathToFileURL(join(ROOT, 'frontend', 'lib', 'validation.mjs')).href);

export const NEAR_RPC = 'https://rpc.testnet.near.org';
export const CONTRACT = 'v2.omnibounty.testnet';

export function loadEnvFile(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return; }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const key = line.slice(0, line.indexOf('=')).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined && process.env[key] !== '') continue;
    process.env[key] = line.slice(line.indexOf('=') + 1).trim();
  }
}

/// Documented sandbox workaround (see LOG.md EXP-00b): rewrite ONLY the
/// attestor-URL feature-flag response to the SDK's canonical :443 endpoint.
/// All SDK logic, credentials, matchers run stock.
export function applyAttestor443Shim() {
  const realFetch = globalThis.fetch;
  const FLAG_URL = 'feature-flags/get?featureFlagNames=zkFetchAttestorURL';
  const ATT_443 = 'wss://attestor.reclaimprotocol.org/ws';
  globalThis.fetch = async (url, init) => {
    if (typeof url === 'string' && url.includes(FLAG_URL)) {
      console.log('[shim] feature flag rewritten to :443 attestor');
      return new Response(JSON.stringify([{ name: 'zkFetchAttestorURL', value: ATT_443, type: 'string' }]), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    return realFetch(url, init);
  };
}

export async function nearView(method, args) {
  const body = { jsonrpc: '2.0', id: 'exp', method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: CONTRACT, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') } };
  const r = await fetch(NEAR_RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (j.error || !j.result || j.result.error) throw new Error(`view ${method} failed: ${JSON.stringify(j.error || j.result).slice(0, 300)}`);
  return JSON.parse(Buffer.from(j.result.result).toString('utf8'));
}

/// Local verification replicating contracts/near/src/reclaim.rs + freshness.
/// Returns {ok, detail} and prints staged results. Never touches chain state
/// except the read-only get_epoch view for the pinned-set comparison.
export async function localVerify(proof, label) {
  const out = {};
  const shape = validateProofShape(proof);
  out.shapeOk = shape.ok;
  console.log(`[${label}] validateProofShape:`, shape.ok ? 'OK' : `FAIL ${shape.errors.join('; ')}`);
  if (!shape.ok) return { ok: false, detail: out };
  const n = shape.normalized;
  out.normalized = n;
  const canonCtx = canonicalize(JSON.parse(n.claimInfo.context));
  const idRecomp = ethers.keccak256(ethers.toUtf8Bytes(`${n.claimInfo.provider}\n${n.claimInfo.parameters}\n${canonCtx}`));
  out.idMatch = idRecomp.toLowerCase() === String(n.signedClaim.claim.identifier).toLowerCase();
  console.log(`[${label}] identifier recompute:`, out.idMatch ? 'MATCH' : `MISMATCH got=${idRecomp}`);
  const c = n.signedClaim.claim;
  const signData = `0x${String(c.identifier).replace(/^0x/i, '').toLowerCase()}\n0x${String(c.owner).replace(/^0x/i, '').toLowerCase()}\n${c.timestampS}\n${c.epoch}`;
  const digest = ethers.hashMessage(signData);
  const signers = proof.signatures.map((s) => ethers.recoverAddress(digest, s).toLowerCase());
  out.signers = signers;
  console.log(`[${label}] recovered signers:`, JSON.stringify(signers));
  const epochView = await nearView('get_epoch', { epoch_id: c.epoch });
  const pinned = new Set(((epochView && epochView.witnesses) || []).map((w) => String(w).toLowerCase()));
  out.setMatch = signers.length === pinned.size && signers.every((s) => pinned.has(s)) && new Set(signers).size === signers.length;
  console.log(`[${label}] pinned epoch-${c.epoch}:`, JSON.stringify([...pinned]), '→ set equality:', out.setMatch ? 'MATCH' : 'MISMATCH');
  const nowS = Math.floor(Date.now() / 1000);
  out.fresh = c.timestampS > nowS - 7 * 24 * 3600 && c.timestampS <= nowS + 300;
  console.log(`[${label}] freshness [now-7d, now+300s]:`, out.fresh ? 'INSIDE' : 'OUTSIDE');
  out.ok = out.shapeOk && out.idMatch && out.setMatch && out.fresh;
  return out;
}
