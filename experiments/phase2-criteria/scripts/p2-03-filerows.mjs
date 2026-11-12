// P2-03: occurrence-anchored multi-row extraction (files endpoint).
// PR #38132 has exactly 3 changed files. Proves row-anchored patterns for
// rows 1..3 in ONE proof, each ground-truth-compared in order. This is the
// mechanism V3 file rules (allow/forbid/required/counts/sums) rest on:
// completeness comes from row-count == PR.changed_files cross-check.
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

const URL = 'https://api.github.com/repos/react/react/pulls/38132/files?per_page=100';
const raw = await (await fetch(URL, { headers: { 'User-Agent': 'omnibounty-p2-03/1.0' } })).text();
const files = JSON.parse(raw);
console.log(`[0] rows=${files.length} bytes=${raw.length}`);
if (files.length !== 3) { console.error('ABORT: expected exactly 3 rows for this fixture PR'); process.exit(2); }

// Row pattern: ^-anchored occurrence counting. Row 1 has no prefix;
// row k skips k-1 prior "filename": occurrences.
// Row k: skip k-1 complete (key+value) rows, span to the next key, capture.
// No ^ anchor: leftmost matching starts at 0 anyway, and anchor-free
// patterns work on every regex engine (attestor engine is PCRE-compatible
// but unpinned). Quote-containing filenames fail closed (see report).
const rowPattern = (k, tag) => {
  const prefix = k === 1 ? '' : `(?:[\\s\\S]*?"filename":"[^"]*"){${k - 1}}[\\s\\S]*?`;
  return `${prefix}"filename":"(?<${tag}_file>[^"]*)","status":"(?<${tag}_status>[^"]*)","additions":(?<${tag}_add>[0-9]+),"deletions":(?<${tag}_del>[0-9]+)`;
};
// Local pre-verification (honest anchor discipline).
for (let k = 1; k <= 3; k++) {
  const m = raw.match(new RegExp(rowPattern(k, 'r' + k)));
  const ok = m && m.groups[`r${k}_file`] === files[k - 1].filename;
  console.log(`[0] local row ${k}:`, ok ? `PASS (${files[k - 1].filename.slice(0, 50)}…)` : `MISMATCH got=${m ? JSON.stringify(m.groups) : 'no-match'}`);
  if (!ok) { console.error('ABORT: local anchor mismatch (finding recorded, no proof attempted)'); process.exit(3); }
}
const client = new ReclaimClient(appId, appSecret, false, 1);
const matchers = [1, 2, 3].map((k) => ({ type: 'regex', value: rowPattern(k, 'r' + k) }));
let proof;
try {
  const t0 = Date.now();
  proof = await client.zkFetch(URL, { method: 'GET', headers: { 'User-Agent': 'omnibounty-p2-03/1.0' } }, { responseMatches: matchers });
  console.log(`[1] zkFetch OK in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} catch (e) { console.error('[1] FAILED:', String(e.message).slice(0, 400)); process.exit(1); }
const name = `p2-03-filerows-${Date.now()}.json`;
writeFileSync(join(HERE, '..', 'fixtures', name), JSON.stringify(proof, null, 2));
const ex = JSON.parse(proof.claimData.context).extractedParameters;
let ok = true;
for (let k = 1; k <= 3; k++) {
  const f = files[k - 1];
  const checks = [[`r${k}_file`, f.filename], [`r${k}_status`, f.status], [`r${k}_add`, String(f.additions)], [`r${k}_del`, String(f.deletions)]];
  for (const [key, want] of checks) {
    const pass = ex[key] === want;
    if (!pass) { console.log(`[FAIL] row${k}.${key}: got=${JSON.stringify(ex[key])} want=${JSON.stringify(want)}`); ok = false; }
  }
  if (ok) console.log(`[PASS] row ${k} all 4 fields exact`);
}
const v = await localVerify(proof, '2');
console.log('P2-03', ok && v.ok ? 'COMPLETE PASS' : 'COMPLETE WITH FAILURES');
process.exit(ok && v.ok ? 0 : 1);
