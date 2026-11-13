const H = { headers: { 'User-Agent': 'omnibounty-phase2-scout/1.0' } };
const HEAD = '5621284babc44ced80598504e7aae22f75fb32c1';
// List the workflows directory at the PR head, then fetch one real file.
const d = await fetch(`https://api.github.com/repos/react/react/contents/.github/workflows?ref=${HEAD}`, H);
const dt = await d.text();
console.log('DIR: HTTP', d.status, 'bytes=', dt.length);
if (!d.ok) { console.log(dt.slice(0, 200)); process.exit(1); }
const entries = JSON.parse(dt);
console.log('DIR entries:', entries.map((e) => `${e.name} (${e.size}B sha=${String(e.sha).slice(0, 12)})`).slice(0, 8).join(' | '));
const target = entries.find((e) => e.type === 'file' && e.size < 20000) || entries[0];
const f = await fetch(`https://api.github.com/repos/react/react/contents/${target.path}?ref=${HEAD}`, H);
const ft = await f.text();
console.log('FILE: HTTP', f.status, 'bytes=', ft.length);
const fj = JSON.parse(ft);
console.log('FILE keys:', Object.keys(fj).join(','));
console.log('FILE:', 'path=' + fj.path, 'sha=' + fj.sha, 'size=' + fj.size);
process.exit(0);
