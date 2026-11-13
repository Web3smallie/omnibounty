// EXP-05: PR body, labels, and reviews evidence.
// Part A (PR endpoint): body contains-probe + first-label-name extraction.
// Part B (reviews endpoint): first-review state/reviewer/commit_id.
// Ground-truth comparison for every field; local pre-verification aborts
// attestation on ambiguity (findings recorded either way).
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

const PR_URL = 'https://api.github.com/repos/react/react/pulls/38132';
const REV_URL = 'https://api.github.com/repos/react/react/pulls/38132/reviews?per_page=100';
const H = { headers: { 'User-Agent': 'omnibounty-exp05/1.0' } };
const prRaw = await (await fetch(PR_URL, H)).text();
const pr = JSON.parse(prRaw);
console.log(`[0] PR bytes=${prRaw.length} labels=${JSON.stringify(pr.labels.map((l) => l.name))} bodyLen=${(pr.body || '').length}`);
const revRaw = await (await fetch(REV_URL, H)).text();
const revs = JSON.parse(revRaw);
console.log(`[0] reviews bytes=${revRaw.length} count=${revs.length}` + (revs.length ? ` first=${revs[0].user.login}/${revs[0].state}@${String(revs[0].commit_id).slice(0, 12)}` : ''));

// Local pre-verification before spending attestor calls.
const bodyNeedle = (pr.body || '').split('\n').map((l) => l.trim()).find((l) => l.length > 20 && l.length < 100 && !/["\\]/.test(l));
console.log('[0] body needle:', JSON.stringify(bodyNeedle));
const labelRe = /"labels":\[[\s\S]*?"name":"(?<label0>.*?)"/;
const labelLocal = prRaw.match(labelRe);
console.log('[0] local first-label:', labelLocal && labelLocal.groups.label0, '| want:', pr.labels[0] && pr.labels[0].name);
if (!bodyNeedle || pr.labels.length === 0 || !labelLocal || labelLocal.groups.label0 !== pr.labels[0].name || revs.length === 0) {
  console.error('ABORT: ground truth unsuitable (empty body/labels/reviews or ambiguous label match) — finding recorded');
  process.exit(3);
}
const rev0Re = /"user":\{"login":"(?<by>.*?)".*?"state":"(?<st>.*?)"/s;
console.log('[0] local first-review check:', rev0Re.test(revRaw) ? 'pattern applicable' : 'pattern inapplicable');

const client = new ReclaimClient(appId, appSecret, false, 1);
// Part A.
let proofA;
try {
  const t0 = Date.now();
  proofA = await client.zkFetch(PR_URL, { method: 'GET', headers: { 'User-Agent': 'omnibounty-exp05/1.0' } }, { responseMatches: [
    { type: 'contains', value: bodyNeedle },
    { type: 'regex', value: '"labels":\\[[\\s\\S]*?"name":"(?<label0>.*?)"' },
  ] });
  console.log(`[A1] zkFetch PR-meta OK in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} catch (e) { console.error('[A1] FAILED:', String(e.message).slice(0, 300)); process.exit(1); }
{
  const name = `exp05a-meta-${Date.now()}.json`;
  writeFileSync(join(HERE, '..', 'fixtures', name), JSON.stringify(proofA, null, 2));
  const ex = JSON.parse(proofA.claimData.context).extractedParameters;
  const pass = ex.label0 === pr.labels[0].name;
  console.log(`[A2] label0: got=${JSON.stringify(ex.label0)} want=${JSON.stringify(pr.labels[0].name)} => ${pass ? 'PASS' : 'FAIL'}`);
  console.log('[A2] body contains-probe accepted (presence assertion, no extracted key)');
  const v = await localVerify(proofA, 'A3');
  if (!pass || !v.ok) process.exit(1);
}
// Part B.
let proofB;
try {
  const t0 = Date.now();
  proofB = await client.zkFetch(REV_URL, { method: 'GET', headers: { 'User-Agent': 'omnibounty-exp05/1.0' } }, { responseMatches: [
    { type: 'regex', value: '"user":\\{"login":"(?<reviewer>.*?)"' },
    { type: 'regex', value: '"state":"(?<review_state>.*?)"' },
    { type: 'regex', value: '"commit_id":"(?<review_commit>[0-9a-f]{40})"' },
  ] });
  console.log(`[B1] zkFetch reviews OK in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} catch (e) { console.error('[B1] FAILED:', String(e.message).slice(0, 300)); process.exit(1); }
{
  const name = `exp05b-reviews-${Date.now()}.json`;
  writeFileSync(join(HERE, '..', 'fixtures', name), JSON.stringify(proofB, null, 2));
  const ex = JSON.parse(proofB.claimData.context).extractedParameters;
  const r0 = revs[0];
  const checks = [['reviewer', ex.reviewer, r0.user.login], ['review_state', ex.review_state, r0.state], ['review_commit', ex.review_commit, r0.commit_id]];
  let ok = true;
  for (const [k, got, want] of checks) {
    const pass = got === want;
    console.log(`[${pass ? 'PASS' : 'FAIL'}] ${k}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
    if (!pass) ok = false;
  }
  if (!ok) console.log('[B2] NOTE: first-match review binding diverged — documents array-binding limits honestly');
  const v = await localVerify(proofB, 'B3');
  console.log('EXP-05', ok && v.ok ? 'COMPLETE PASS' : 'COMPLETE WITH DIVERGENCE (see above)');
  process.exit(ok && v.ok ? 0 : 1);
}
