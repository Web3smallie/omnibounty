// EXP-02: identity evidence — head SHA, author association, base SHA.
// Target: react/react#38132 (merged). 7 matchers: current 4 + head_sha +
// author_association + base_sha. Compares every extraction against plain-fetch
// ground truth (tests first-match correctness explicitly).
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, ReclaimClient, loadEnvFile, applyAttestor443Shim, localVerify, nearView } from './lib/exp-common.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
loadEnvFile(join(ROOT, 'frontend', '.env.local'));
applyAttestor443Shim();
const appId = process.env.RECLAIM_APP_ID;
const appSecret = process.env.RECLAIM_APP_SECRET;
if (!appId || !appSecret) { console.error('ABORT: creds missing'); process.exit(2); }

const REPO = 'react/react';
const PR = 38132;
const url = `https://api.github.com/repos/${REPO}/pulls/${PR}`;

// Ground truth (plain read-only fetch).
const gt = await (await fetch(url, { headers: { 'User-Agent': 'omnibounty-exp02/1.0' } })).json();
const truth = {
  merged: String(gt.merged),
  author: gt.user.login,
  repo: gt.base.repo.full_name,
  number: String(gt.number),
  head_sha: gt.head.sha,
  author_association: gt.author_association,
  base_sha: gt.base.sha,
};
console.log('[0] ground truth:', JSON.stringify(truth));

// NOTE: anchored variants where first-match is ambiguous across head/base.
const matchers = [
  { type: 'regex', value: '"merged":(?<merged>.*?)[,}]' },
  { type: 'regex', value: '"login":"(?<author>.*?)"' },
  { type: 'regex', value: '"full_name":"(?<repo>.*?)"' },
  { type: 'regex', value: '"number":(?<number>.*?)[,}]' },
  { type: 'regex', value: '"sha":"(?<head_sha>[0-9a-f]{40})"' },
  { type: 'regex', value: '"author_association":"(?<author_association>.*?)"' },
  // NOTE: base object order is label,ref,repo{...},...,sha — sha comes AFTER
  // the nested repo object, so the pattern must tolerate nesting. Verified
  // locally against the real payload before attesting (see LOG.md).
  { type: 'regex', value: '"base":\\{[\\s\\S]*?"sha":"(?<base_sha>[0-9a-f]{40})"' },
];
const client = new ReclaimClient(appId, appSecret, false, 1);
const t0 = Date.now();
let proof;
try {
  proof = await client.zkFetch(url, { method: 'GET', headers: { 'User-Agent': 'omnibounty-exp02/1.0' } }, { responseMatches: matchers });
} catch (e) {
  console.error('[1] zkFetch FAILED:', e.message);
  process.exit(1);
}
console.log(`[1] zkFetch OK in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
mkdirSync(join(HERE, '..', 'fixtures'), { recursive: true });
const name = `exp02-pr${PR}-${Date.now()}.json`;
writeFileSync(join(HERE, '..', 'fixtures', name), JSON.stringify(proof, null, 2));
console.log(`[2] fixture: ${name} (${JSON.stringify(proof).length} bytes)`);
const ex = JSON.parse(proof.claimData.context).extractedParameters;
console.log('[2] extracted:', JSON.stringify(ex));
let allOk = true;
for (const k of Object.keys(truth)) {
  const ok = ex[k] === truth[k];
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${k}: got=${JSON.stringify(ex[k])} want=${JSON.stringify(truth[k])}`);
  if (!ok) allOk = false;
}
const v = await localVerify(proof, '3');
console.log('EXP-02', allOk && v.ok ? 'COMPLETE PASS' : 'COMPLETE WITH FAILURES');
process.exit(allOk && v.ok ? 0 : 1);
