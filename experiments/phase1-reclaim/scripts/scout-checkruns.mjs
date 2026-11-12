const sha = '5621284babc44ced80598504e7aae22f75fb32c1';
const r = await fetch(`https://api.github.com/repos/react/react/commits/${sha}/check-runs?per_page=100`, { headers: { 'User-Agent': 'exp03-scout', Accept: 'application/vnd.github+json' } });
console.log('HTTP', r.status);
const t = await r.text();
console.log('bytes:', t.length);
if (!r.ok) { console.log(t.slice(0, 300)); process.exit(1); }
const j = JSON.parse(t);
console.log('total_count:', j.total_count, 'returned:', (j.check_runs || []).length);
for (const c of (j.check_runs || []).slice(0, 12)) {
  console.log(`- id=${c.id} name=${JSON.stringify(c.name)} status=${c.status} conclusion=${c.conclusion} head=${(c.head_sha || '').slice(0, 12)} app=${c.app && c.app.slug} completed=${c.completed_at}`);
}
process.exit(0);
