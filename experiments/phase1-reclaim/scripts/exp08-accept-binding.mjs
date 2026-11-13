// EXP-08: are request headers (Accept) bound into the attested params?
// zkFetch pulls/38132 with Accept: application/vnd.github.diff + a matcher
// for a diff-specific marker ("diff --git"). Inspects: (1) whether the SDK
// sends custom headers, (2) whether headers appear in signed claimData.params,
// (3) whether the response arrives as diff. V3 relevance: if headers are in
// signed params, the contract CAN pin representation (closing the Accept gap).
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, ReclaimClient, loadEnvFile, applyAttestor443Shim, localVerify } from './lib/exp-common.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
loadEnvFile(join(ROOT, 'frontend', '.env.local'));
applyAttestor443Shim();
const appId = process.env.RECLAIM_APP_ID;
const appSecret = process.env.RECLAIM_APP_SECRET;
if (!appId || !appSecret) { console.error('ABORT: creds missing'); process.exit(2); }
mkdirSync(join(HERE, '..', 'fixtures'), { recursive: true });

const URL = 'https://api.github.com/repos/react/react/pulls/38132';
const client = new ReclaimClient(appId, appSecret, false, 1);
let proof;
try {
  const t0 = Date.now();
  proof = await client.zkFetch(
    URL,
    { method: 'GET', headers: { 'User-Agent': 'omnibounty-exp08/1.0', Accept: 'application/vnd.github.diff' } },
    { responseMatches: [{ type: 'regex', value: 'diff --git (?<difffile>.*?)[\\n]' }] }
  );
  console.log(`[1] zkFetch diff-accept OK in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} catch (e) {
  console.error('[1] zkFetch FAILED:', String(e.message).slice(0, 400));
  console.log('[1] (A matcher failure here would mean the response was NOT diff format.)');
  process.exit(1);
}
const name = `exp08-diffaccept-${Date.now()}.json`;
writeFileSync(join(HERE, '..', 'fixtures', name), JSON.stringify(proof, null, 2));
const params = JSON.parse(proof.claimData.parameters);
console.log('[2] signed params.headers =', JSON.stringify(params.headers));
console.log('[2] signed params.method/url =', params.method, '|', params.url);
const ex = JSON.parse(proof.claimData.context).extractedParameters;
console.log('[2] extracted:', JSON.stringify(ex));
const headersBound = params.headers && (params.headers.Accept === 'application/vnd.github.diff' || (params.headers.accept === 'application/vnd.github.diff'));
console.log(`[${headersBound ? 'PASS' : 'FAIL'}] Accept header present in SIGNED params:`, !!headersBound);
console.log(`[${ex.difffile && ex.difffile.length > 0 ? 'PASS' : 'FAIL'}] diff-format response attested (difffile extracted)`);
const v = await localVerify(proof, '3');
const ok = !!headersBound && !!ex.difffile && v.ok;
console.log('EXP-08', ok ? 'COMPLETE PASS' : 'COMPLETE WITH FAILURES');
process.exit(ok ? 0 : 1);
