// EXP-04: diff/file evidence + protected-file absence semantics.
// Part A: GET pulls/{n}/files — first-row filename/status/additions/deletions
//   + a `contains` probe for a string known present in a patch.
// Part B (NEGATIVE): same endpoint with a matcher for a filename KNOWN ABSENT
//   — records exactly how the attestor handles non-matching matchers.
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

const URL = 'https://api.github.com/repos/react/react/pulls/38132/files?per_page=100';
const raw = await (await fetch(URL, { headers: { 'User-Agent': 'omnibounty-exp04/1.0' } })).text();
const files = JSON.parse(raw);
console.log(`[0] files: HTTP 200, bytes=${raw.length}, entries=${files.length}`);
const f0 = files[0];
console.log(`[0] first: ${f0.filename} status=${f0.status} +${f0.additions}/-${f0.deletions} patchBytes=${(f0.patch || '').length}`);
// Local pre-check of the anchored first-row extraction.
const rowRe = /"filename":"(?<fn>.*?)","status":"(?<st>.*?)","additions":(?<add>.*?),"deletions":(?<del>.*?)[,}]/;
const lm = raw.match(rowRe);
console.log('[0] local first-row match:', lm ? `${lm.groups.fn} ${lm.groups.st} +${lm.groups.add}/-${lm.groups.del}` : 'NO-MATCH');
// A string known present in f0's patch for the contains probe.
const rawNeedle = (f0.patch || '').split('\n').find((l) => l.startsWith('+') && l.length > 8 && l.length < 80);
// Strip leading diff marker/punctuation so the probe is valid whether
// `contains` is implemented as substring or regex match.
const needle = rawNeedle.replace(/^[^A-Za-z0-9]+/, '').slice(0, 60);
console.log('[0] contains needle:', JSON.stringify(needle));
if (!lm || lm.groups.fn !== f0.filename || !needle) { console.error('ABORT: local pre-check failed'); process.exit(2); }

const client = new ReclaimClient(appId, appSecret, false, 1);
// ---- Part A ----
const matchersA = [
  { type: 'regex', value: '"filename":"(?<file0>.*?)","status":"(?<status0>.*?)","additions":(?<add0>.*?),"deletions":(?<del0>.*?)[,}]' },
  { type: 'contains', value: needle },
];
let proofA;
try {
  const t0 = Date.now();
  proofA = await client.zkFetch(URL, { method: 'GET', headers: { 'User-Agent': 'omnibounty-exp04/1.0' } }, { responseMatches: matchersA });
  console.log(`[A1] zkFetch files OK in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} catch (e) {
  console.error('[A1] zkFetch files FAILED:', String(e.message).slice(0, 300));
  process.exit(1);
}
{
  const name = `exp04a-files-${Date.now()}.json`;
  writeFileSync(join(HERE, '..', 'fixtures', name), JSON.stringify(proofA, null, 2));
  const ex = JSON.parse(proofA.claimData.context).extractedParameters;
  console.log(`[A2] fixture: ${name} (${JSON.stringify(proofA).length} bytes); extracted:`, JSON.stringify(ex));
  const checks = [['file0', ex.file0, f0.filename], ['status0', ex.status0, f0.status], ['add0', ex.add0, String(f0.additions)], ['del0', ex.del0, String(f0.deletions)]];
  let ok = true;
  for (const [k, got, want] of checks) {
    const pass = got === want;
    console.log(`[${pass ? 'PASS' : 'FAIL'}] ${k}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
    if (!pass) ok = false;
  }
  const v = await localVerify(proofA, 'A3');
  if (!ok || !v.ok) process.exit(1);
}
// ---- Part B: absent-file negative ----
const matchersB = [{ type: 'regex', value: '"filename":"tests/no-such-file-xyz\\.spec\\.js"' }];
try {
  const t0 = Date.now();
  await client.zkFetch(URL, { method: 'GET', headers: { 'User-Agent': 'omnibounty-exp04/1.0' } }, { responseMatches: matchersB });
  console.log(`[B1] UNEXPECTED: absent-file proof SUCCEEDED in ${((Date.now() - t0) / 1000).toFixed(1)}s (inspect fixture!)`);
  process.exit(1);
} catch (e) {
  console.log('[B1] absent-file proof FAILED AS PREDICTED:', String(e.message).slice(0, 300));
}
console.log('EXP-04 COMPLETE PASS (A attested, B fail-closed as predicted)');
process.exit(0);
