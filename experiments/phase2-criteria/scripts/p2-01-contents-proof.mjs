// P2-01: contents-API protected-file proof (NEW endpoint class for V3).
// Attests path+sha+size of a workflow file at the PR head SHA; the blob SHA
// equality against the criteria-committed value is what makes protected-file
// integrity positive (no absence reasoning anywhere).
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, ReclaimClient, loadEnvFile, applyAttestor443Shim, localVerify } from '../../phase1-reclaim/scripts/lib/exp-common.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
loadEnvFile(join(ROOT, 'frontend', '.env.local'));
applyAttestor443Shim();
const appId = process.env.RECLAIM_APP_ID;
const appSecret = process.env.RECLAIM_APP_SECRET;
if (!appId || !appSecret) { console.error('ABORT: creds missing'); process.exit(2); }
mkdirSync(join(HERE, '..', 'fixtures'), { recursive: true });

const PATH = '.github/workflows/compiler_discord_notify.yml';
const REF = '5621284babc44ced80598504e7aae22f75fb32c1';
const URL = `https://api.github.com/repos/react/react/contents/${PATH}?ref=${REF}`;
const raw = await (await fetch(URL, { headers: { 'User-Agent': 'omnibounty-p2-01/1.0' } })).text();
const gt = JSON.parse(raw);
console.log(`[0] contents: bytes=${raw.length} path=${gt.path} sha=${gt.sha} size=${gt.size}`);
// Local pre-verification of matcher shapes.
const mPath = raw.match(/"path":"(?<p>.*?)"/);
const mSha = raw.match(/"sha":"(?<s>[0-9a-f]{40})"/);
const mSize = raw.match(/"size":(?<z>[0-9]+)[,}]/);
console.log('[0] local:', mPath && mPath.groups.p === gt.path ? 'path OK' : 'PATH MISMATCH', '|', mSha && mSha.groups.s === gt.sha ? 'sha OK' : 'SHA MISMATCH', '|', mSize && mSize.groups.z === String(gt.size) ? 'size OK' : 'SIZE MISMATCH');
if (!mPath || !mSha || !mSize || mPath.groups.p !== gt.path || mSha.groups.s !== gt.sha) {
  console.error('ABORT: ambiguous matcher shapes (finding recorded, no proof attempted)');
  process.exit(3);
}
const client = new ReclaimClient(appId, appSecret, false, 1);
let proof;
try {
  const t0 = Date.now();
  proof = await client.zkFetch(URL, { method: 'GET', headers: { 'User-Agent': 'omnibounty-p2-01/1.0' } }, { responseMatches: [
    { type: 'regex', value: '"path":"(?<path>.*?)"' },
    { type: 'regex', value: '"sha":"(?<blob_sha>[0-9a-f]{40})"' },
    { type: 'regex', value: '"size":(?<size>[0-9]+)[,}]' },
  ] });
  console.log(`[1] zkFetch OK in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} catch (e) { console.error('[1] FAILED:', String(e.message).slice(0, 300)); process.exit(1); }
const name = `p2-01-contents-${Date.now()}.json`;
writeFileSync(join(HERE, '..', 'fixtures', name), JSON.stringify(proof, null, 2));
const ex = JSON.parse(proof.claimData.context).extractedParameters;
const checks = [['path', ex.path, gt.path], ['blob_sha', ex.blob_sha, gt.sha], ['size', ex.size, String(gt.size)]];
let ok = true;
for (const [k, got, want] of checks) {
  const pass = got === want;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${k}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  if (!pass) ok = false;
}
const v = await localVerify(proof, '2');
console.log('P2-01', ok && v.ok ? 'COMPLETE PASS' : 'COMPLETE WITH FAILURES');
process.exit(ok && v.ok ? 0 : 1);
