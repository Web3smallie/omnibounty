// EXP-03: CI check-run evidence (list binding + single-run precision).
// Part A: GET commits/{head}/check-runs?per_page=100 — anchored name→conclusion
//   binding for run "cleanup"; tests array first-match behavior explicitly
//   (local anchor-uniqueness pre-check before attesting).
// Part B: GET check-runs/{id} — full single-object field extraction.
// Compares everything to plain-fetch ground truth. Records sizes/timings.
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

const SHA = '5621284babc44ced80598504e7aae22f75fb32c1'; // react#38132 head
const LIST_URL = `https://api.github.com/repos/react/react/commits/${SHA}/check-runs?per_page=100`;

// Ground truth for part A.
const listRaw = await (await fetch(LIST_URL, { headers: { 'User-Agent': 'omnibounty-exp03/1.0' } })).text();
const listJson = JSON.parse(listRaw);
console.log(`[0] list: HTTP 200, bytes=${listRaw.length}, total=${listJson.total_count}, page=${listJson.check_runs.length}`);
const target = listJson.check_runs.find((c) => c.name === 'cleanup');
if (!target) { console.error('ABORT: anchor run not on page 1'); process.exit(2); }
console.log(`[0] anchor: id=${target.id} conclusion=${target.conclusion} head=${target.head_sha.slice(0, 12)}`);
// Local pre-verification: anchor string must occur EXACTLY once on the page,
// and the anchored extraction must equal ground truth — else attesting would
// prove an ambiguous binding.
const anchor = '"name":"cleanup"';
const occ = listRaw.split(anchor).length - 1;
console.log(`[0] anchor occurrences on page: ${occ}`);
const localA = listRaw.match(/"name":"cleanup"[\s\S]*?"conclusion":"(?<c>.*?)"/);
const localB = listRaw.match(/"name":"cleanup"[\s\S]*?"head_sha":"(?<h>[0-9a-f]{40})"/);
console.log('[0] local anchored conclusion:', localA && localA.groups.c, '| head:', localB && localB.groups.h.slice(0, 12));
if (occ !== 1 || !localA || localA.groups.c !== target.conclusion) {
  console.error('ABORT: list binding is ambiguous on this page (finding recorded, no proof attempted)');
  process.exit(3);
}

const client = new ReclaimClient(appId, appSecret, false, 1);

// ---- Part A: list binding proof. ----
const matchersA = [
  { type: 'regex', value: '"name":"cleanup"[\\s\\S]*?"conclusion":"(?<conclusion>.*?)"' },
  { type: 'regex', value: '"name":"cleanup"[\\s\\S]*?"head_sha":"(?<head_sha>[0-9a-f]{40})"' },
  { type: 'regex', value: '"total_count":(?<total_count>.*?)[,}]' },
];
let proofA;
try {
  const t0 = Date.now();
  proofA = await client.zkFetch(LIST_URL, { method: 'GET', headers: { 'User-Agent': 'omnibounty-exp03/1.0' } }, { responseMatches: matchersA });
  console.log(`[A1] zkFetch list OK in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} catch (e) {
  console.error('[A1] zkFetch list FAILED:', e.message.slice(0, 300));
  process.exit(1);
}
{
  const name = `exp03a-checklist-${Date.now()}.json`;
  writeFileSync(join(HERE, '..', 'fixtures', name), JSON.stringify(proofA, null, 2));
  const ex = JSON.parse(proofA.claimData.context).extractedParameters;
  console.log(`[A2] fixture: ${name} (${JSON.stringify(proofA).length} bytes); extracted:`, JSON.stringify(ex));
  console.log(`[${ex.conclusion === target.conclusion ? 'PASS' : 'FAIL'}] conclusion bound to anchor run`);
  console.log(`[${ex.head_sha === SHA ? 'PASS' : 'FAIL'}] head_sha bound to anchor run`);
  const v = await localVerify(proofA, 'A3');
  if (!v.ok) process.exit(1);
}

// ---- Part B: single check-run proof. ----
const RUN_URL = `https://api.github.com/repos/react/react/check-runs/${target.id}`;
const runRaw = await (await fetch(RUN_URL, { headers: { 'User-Agent': 'omnibounty-exp03/1.0' } })).text();
const runJson = JSON.parse(runRaw);
console.log(`[0] single: bytes=${runRaw.length}`);
const matchersB = [
  { type: 'regex', value: '"id":(?<run_id>.*?)[,}]' },
  { type: 'regex', value: '"name":"(?<run_name>.*?)"' },
  { type: 'regex', value: '"head_sha":"(?<head_sha>[0-9a-f]{40})"' },
  { type: 'regex', value: '"status":"(?<status>.*?)"' },
  { type: 'regex', value: '"conclusion":"(?<conclusion>.*?)"' },
  { type: 'regex', value: '"completed_at":"(?<completed_at>.*?)"' },
  { type: 'regex', value: '"app":\\{[^}]*?"slug":"(?<app>.*?)"' },
];
let proofB;
try {
  const t0 = Date.now();
  proofB = await client.zkFetch(RUN_URL, { method: 'GET', headers: { 'User-Agent': 'omnibounty-exp03/1.0' } }, { responseMatches: matchersB });
  console.log(`[B1] zkFetch single OK in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} catch (e) {
  console.error('[B1] zkFetch single FAILED:', e.message.slice(0, 300));
  process.exit(1);
}
{
  const name = `exp03b-checkrun-${Date.now()}.json`;
  writeFileSync(join(HERE, '..', 'fixtures', name), JSON.stringify(proofB, null, 2));
  const ex = JSON.parse(proofB.claimData.context).extractedParameters;
  console.log(`[B2] fixture: ${name} (${JSON.stringify(proofB).length} bytes); extracted:`, JSON.stringify(ex));
  const want = { run_id: String(runJson.id), run_name: runJson.name, head_sha: runJson.head_sha, status: runJson.status, conclusion: runJson.conclusion, completed_at: runJson.completed_at, app: runJson.app.slug };
  let ok = true;
  for (const k of Object.keys(want)) {
    const pass = ex[k] === want[k];
    console.log(`[${pass ? 'PASS' : 'FAIL'}] ${k}: got=${JSON.stringify(ex[k])} want=${JSON.stringify(want[k])}`);
    if (!pass) ok = false;
  }
  const v = await localVerify(proofB, 'B3');
  console.log('EXP-03', ok && v.ok ? 'COMPLETE PASS' : 'COMPLETE WITH FAILURES');
  process.exit(ok && v.ok ? 0 : 1);
}
