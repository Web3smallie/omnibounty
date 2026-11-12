// Phase 2 scout (read-only): contents API shape, compare API shape,
// and a multi-review PR candidate for binding tests.
const H = { headers: { 'User-Agent': 'omnibounty-phase2-scout/1.0' } };
const HEAD = '5621284babc44ced80598504e7aae22f75fb32c1';
const BASE = '5b6109643a00e2681499234fd328d16c966deae4';

// 1. contents API for a protected-file-style target (workflow file).
const cUrl = `https://api.github.com/repos/react/react/contents/.github/workflows/runtime-tests.yml?ref=${HEAD}`;
const cRes = await fetch(cUrl, H);
const cText = await cRes.text();
console.log('CONTENTS: HTTP', cRes.status, 'bytes=', cText.length);
if (cRes.ok) {
  const c = JSON.parse(cText);
  console.log('CONTENTS keys:', Object.keys(c).join(','));
  console.log('CONTENTS:', 'name=' + c.name, 'path=' + c.path, 'sha=' + c.sha, 'size=' + c.size);
}

// 2. compare API base...head.
const cmpUrl = `https://api.github.com/repos/react/react/compare/${BASE}...${HEAD}`;
const cmpRes = await fetch(cmpUrl, H);
const cmpText = await cmpRes.text();
console.log('COMPARE: HTTP', cmpRes.status, 'bytes=', cmpText.length);
if (cmpRes.ok) {
  const c = JSON.parse(cmpText);
  console.log('COMPARE: ahead_by=' + c.ahead_by + ' behind_by=' + c.behind_by + ' total_commits=' + c.total_commits + ' files=' + (c.files || []).length);
  for (const f of (c.files || []).slice(0, 6)) {
    console.log(`  file: ${f.filename} status=${f.status} +${f.additions}/-${f.deletions} sha=${f.sha} patch=${(f.patch || '').length}B`);
  }
}

// 3. multi-review PR hunt: scan recent merged PRs for one with >= 2 reviews.
const listRes = await fetch('https://api.github.com/repos/react/react/pulls?state=closed&per_page=30&sort=updated&direction=desc', H);
const list = await listRes.json();
let found = null;
for (const p of list) {
  if (!p.merged_at) continue;
  const rr = await fetch(`https://api.github.com/repos/react/react/pulls/${p.number}/reviews?per_page=100`, H);
  if (!rr.ok) continue;
  const revs = await rr.json();
  if (Array.isArray(revs) && revs.length >= 2) { found = { p, revs }; break; }
}
if (found) {
  console.log(`MULTI-REVIEW: PR #${found.p.number} "${found.p.title.slice(0, 70)}" head=${found.p.head.sha} reviews=${found.revs.length}`);
  for (const r of found.revs.slice(0, 6)) {
    console.log(`  review: ${r.user.login} state=${r.state} commit=${String(r.commit_id).slice(0, 12)}`);
  }
} else {
  console.log('MULTI-REVIEW: none found in first 30 closed PRs');
}
process.exit(0);
