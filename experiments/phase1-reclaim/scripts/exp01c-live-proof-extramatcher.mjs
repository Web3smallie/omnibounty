// EXP-01c: EXP-01b plus ONE extra matcher ("state").
// Purpose: EXP-01b proved the nullifier (same PR+matchers => same identifier
// as bounty's #2 spent claim => IDENTIFIER_REPLAY). The contract ignores
// unknown extracted keys, so a 5-matcher proof must yield a FRESH identifier
// and a dry_run OK on bounty #4. Also probes matcher extensibility for V3.
// SANDBOX WORKAROUND (documented, experiment-only): this sandbox's egress
// proxy passes port 443 but hangs port 444 (see EXP-00/EXP-00b evidence), while
// Reclaim's live feature flag steers zkFetch to wss://...:444/ws. This script
// rewrites ONLY that flag response to the SDK's own canonical default
// (wss://attestor.reclaimprotocol.org/ws); all SDK logic, credentials,
// matchers, and verification stages run 100% stock. Findings about :444 vs
// :443 health are reported separately; nothing here changes product code.
// Target: react/react#38132 (merged; bounty #4 on v2.omnibounty.testnet is the
// same repo/number and OPEN, so dry_run is meaningful).
// Stages: (1) zkFetch with the EXACT 4 matchers from frontend/scripts/prove.mjs
// (2) save fixture + report sizes/timings (3) local verify replicating
// contracts/near/src/reclaim.rs (identifier, ecrecover, witness-set equality
// vs live get_epoch, freshness) (4) NEAR dry_run VIEW on bounty #4.
// Read-only on chain (view calls only). No secrets printed. No txs sent.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const require = createRequire(import.meta.url);
const { ethers } = require(join(ROOT, 'frontend', 'node_modules', 'ethers'));
const canonicalize = require(join(ROOT, 'tools', 'node_modules', 'canonicalize'));
const { ReclaimClient } = require(join(ROOT, 'frontend', 'node_modules', '@reclaimprotocol', 'zk-fetch'));
const { validateProofShape } = await import(pathToFileURL(join(ROOT, 'frontend', 'lib', 'validation.mjs')).href);

function loadEnvFile(path) {
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
loadEnvFile(join(ROOT, 'frontend', '.env.local'));

// Documented sandbox workaround: steer ONLY the attestor-URL feature flag to
// the :443 endpoint (see header). Every other request passes through untouched.
const realFetch = globalThis.fetch;
const FLAG_URL = 'feature-flags/get?featureFlagNames=zkFetchAttestorURL';
const ATT_443 = 'wss://attestor.reclaimprotocol.org/ws';
globalThis.fetch = async (url, init) => {
  if (typeof url === 'string' && url.includes(FLAG_URL)) {
    console.log('[shim] feature flag rewritten to :443 attestor');
    return new Response(JSON.stringify([{ name: 'zkFetchAttestorURL', value: ATT_443, type: 'string' }]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return realFetch(url, init);
};

const appId = process.env.RECLAIM_APP_ID;
const appSecret = process.env.RECLAIM_APP_SECRET;
if (!appId || !appSecret) { console.error('ABORT: RECLAIM_APP_ID/SECRET missing'); process.exit(2); }
console.log('creds present: appId+secret YES (values never printed)');

const REPO = 'react/react';
const PR = 38132;
const BOUNTY_ID = 4;
const NEAR_RPC = 'https://rpc.testnet.near.org';
const CONTRACT = 'v2.omnibounty.testnet';
const url = `https://api.github.com/repos/${REPO}/pulls/${PR}`;

// Raw response size baseline (plain read-only fetch).
const rawRes = await fetch(url, { headers: { 'User-Agent': 'omnibounty-exp1/1.0' } });
const rawText = await rawRes.text();
console.log(`[1] plain GET: HTTP ${rawRes.status}, raw bytes = ${rawText.length}`);

// ---- Stage 1: zkFetch with EXACT current matchers (prove.mjs:47-53). ----
const matchers = [
  { type: 'regex', value: '"merged":(?<merged>.*?)[,}]' },
  { type: 'regex', value: '"login":"(?<author>.*?)"' },
  { type: 'regex', value: '"full_name":"(?<repo>.*?)"' },
  { type: 'regex', value: '"number":(?<number>.*?)[,}]' },
  { type: 'regex', value: '"state":"(?<state>.*?)"' },
];
const client = new ReclaimClient(appId, appSecret, true, 1);
console.log('[1] zkFetch starting...');
const t0 = Date.now();
let proof;
try {
  proof = await client.zkFetch(
    url,
    { method: 'GET', headers: { 'User-Agent': 'omnibounty-prove/1.0' } },
    { responseMatches: matchers }
  );
} catch (e) {
  console.error('[1] zkFetch FAILED:', e.message);
  if (e.cause) console.error('[1] cause:', String(e.cause).slice(0, 500));
  process.exit(1);
}
console.log(`[1] zkFetch OK in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
mkdirSync(join(HERE, '..', 'fixtures'), { recursive: true });
const fixPath = join(HERE, '..', 'fixtures', `exp01c-pr${PR}-${Date.now()}.json`);
writeFileSync(fixPath, JSON.stringify(proof, null, 2));
const proofBytes = JSON.stringify(proof).length;
const cd = proof.claimData;
console.log(`[2] fixture saved: experiments/phase1-reclaim/fixtures/${fixPath.split(/[\\/]/).pop()} (${proofBytes} bytes)`);
console.log(`[2] epoch=${cd.epoch} timestampS=${cd.timestampS} (age ${(Date.now() / 1000 - cd.timestampS).toFixed(0)}s) owner=${cd.owner} sigs=${proof.signatures.length}`);
console.log(`[2] extracted: ${cd.context.slice(0, 300)}`);

// ---- Stage 3: local verification replicating reclaim.rs ----
const shape = validateProofShape(proof);
console.log('[3a] validateProofShape (UI gate):', shape.ok ? 'OK' : `FAIL ${shape.errors.join('; ')}`);
if (!shape.ok) process.exit(1);
const n = shape.normalized;
const canonCtx = canonicalize(JSON.parse(n.claimInfo.context));
const idRecomp = ethers.keccak256(ethers.toUtf8Bytes(`${n.claimInfo.provider}\n${n.claimInfo.parameters}\n${canonCtx}`));
const idOk = idRecomp.toLowerCase() === String(n.signedClaim.claim.identifier).toLowerCase();
console.log('[3b] identifier recompute:', idOk ? 'MATCH' : `MISMATCH got=${idRecomp}`);
const signData = `0x${String(n.signedClaim.claim.identifier).replace(/^0x/i, '').toLowerCase()}\n0x${String(n.signedClaim.claim.owner).replace(/^0x/i, '').toLowerCase()}\n${n.signedClaim.claim.timestampS}\n${n.signedClaim.claim.epoch}`;
const digest = ethers.hashMessage(signData);
const signers = proof.signatures.map((s) => ethers.recoverAddress(digest, s).toLowerCase());
console.log('[3c] recovered signers:', JSON.stringify(signers));

async function nearView(method, args) {
  const body = { jsonrpc: '2.0', id: 'exp1', method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: CONTRACT, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') } };
  const r = await fetch(NEAR_RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (j.error || !j.result || j.result.error) throw new Error(`view ${method} failed: ${JSON.stringify(j.error || j.result).slice(0, 300)}`);
  return JSON.parse(Buffer.from(j.result.result).toString('utf8'));
}
const epochView = await nearView('get_epoch', { epoch_id: cd.epoch });
const pinned = new Set((epochView?.witnesses || []).map((w) => String(w).toLowerCase()));
const exact = signers.length === pinned.size && signers.every((s) => pinned.has(s)) && new Set(signers).size === signers.length;
console.log(`[3d] pinned epoch-${cd.epoch} witnesses: ${JSON.stringify([...pinned])} → set equality:`, exact ? 'MATCH' : 'MISMATCH');
const nowS = Math.floor(Date.now() / 1000);
const fresh = cd.timestampS > nowS - 7 * 24 * 3600 && cd.timestampS <= nowS + 300;
console.log('[3e] freshness window [now-7d, now+300s]:', fresh ? 'INSIDE' : 'OUTSIDE');

// ---- Stage 4: real dry_run view on bounty #4 (read-only). ----
try {
  const dry = await nearView('dry_run', { bounty_id: BOUNTY_ID, proof: n, recipient: cd.owner });
  console.log('[4] dry_run bounty #4:', dry);
} catch (e) {
  console.log('[4] dry_run FAILED:', String(e.message).slice(0, 400));
  process.exit(1);
}
console.log('EXP-01 COMPLETE');
process.exit(0);
