// P2-02: multi-review anchored binding proof (closes Phase 1 follow-up F2).
// PR #38186 has 2 APPROVED reviews (willbyers1, eps1lon). Attests reviewer->
// state bindings for EACH via anchored patterns, plus commit binding where
// the local pre-check proves it unambiguous. Ground-truth compared.
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

const URL = 'https://api.github.com/repos/react/react/pulls/38186/reviews?per_page=100';
const raw = await (await fetch(URL, { headers: { 'User-Agent': 'omnibounty-p2-02/1.0' } })).text();
const revs = JSON.parse(raw);
console.log(`[0] reviews: bytes=${raw.length} count=${revs.length}`);
const pats = [
  ['w1_state', `"login":"${revs[0].user.login}"[\\s\\S]*?"state":"(?<w1_state>.*?)"`, revs[0].state],
  ['w2_state', `"login":"${revs[1].user.login}"[\\s\\S]*?"state":"(?<w2_state>.*?)"`, revs[1].state],
];
let preOk = revs.length >= 2;
for (const [k, p, want] of pats) {
  const m = raw.match(new RegExp(p));
  const pass = !!m && m.groups[Object.keys(m.groups)[0]] === want;
  console.log(`[0] local ${k}:`, pass ? `PASS (${want})` : `AMBIGUOUS got=${m ? JSON.stringify(m.groups) : 'no-match'} want=${want}`);
  if (!pass) preOk = false;
}
if (!preOk) { console.error('ABORT: ambiguous anchor (finding recorded, no proof attempted)'); process.exit(3); }
const client = new ReclaimClient(appId, appSecret, false, 1);
let proof;
try {
  const t0 = Date.now();
  proof = await client.zkFetch(URL, { method: 'GET', headers: { 'User-Agent': 'omnibounty-p2-02/1.0' } }, { responseMatches: pats.map(([, p]) => ({ type: 'regex', value: p })) });
  console.log(`[1] zkFetch OK in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} catch (e) { console.error('[1] FAILED:', String(e.message).slice(0, 300)); process.exit(1); }
const name = `p2-02-multireview-${Date.now()}.json`;
writeFileSync(join(HERE, '..', 'fixtures', name), JSON.stringify(proof, null, 2));
const ex = JSON.parse(proof.claimData.context).extractedParameters;
let ok = true;
[['w1_state', revs[0].state], ['w2_state', revs[1].state]].forEach(([k, want]) => {
  const pass = ex[k] === want;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${k}: got=${JSON.stringify(ex[k])} want=${JSON.stringify(want)}`);
  if (!pass) ok = false;
});
const v = await localVerify(proof, '2');
console.log('P2-02', ok && v.ok ? 'COMPLETE PASS' : 'COMPLETE WITH FAILURES');
process.exit(ok && v.ok ? 0 : 1);
