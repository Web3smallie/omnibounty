const H = { headers: { 'User-Agent': 'omnibounty-p2-scout/1.0' } };
// Review object key order (for association anchoring).
const rr = await fetch('https://api.github.com/repos/react/react/pulls/38186/reviews?per_page=5', H);
const rt = await rr.text();
console.log('REVIEWS-HTTP:', rr.status, 'rate-remaining:', rr.headers.get('x-ratelimit-remaining'));
const rj = JSON.parse(rt);
if (!Array.isArray(rj)) { console.log('REVIEWS-BODY:', rt.slice(0, 200)); process.exit(1); }
console.log('REVIEW-KEYS:', Object.keys(rj[0]).join(','));
console.log('REVIEW-ASSOC:', rj[0].author_association, '| state:', rj[0].state);
// changed_files occurrence count in PR payload (must be exactly 1 for safe extraction).
const pr = await (await fetch('https://api.github.com/repos/react/react/pulls/38132', H)).text();
const n1 = pr.split('"changed_files"').length - 1;
const n2 = pr.split('"author_association"').length - 1;
console.log('PR changed_files occurrences:', n1, '| author_association occurrences:', n2);
// check-run object: any author_association-like keys? (for span safety)
const cr = await (await fetch('https://api.github.com/repos/react/react/check-runs/128113730680', H)).text();
console.log('CHECKRUN has completed_at:', cr.includes('"completed_at"'), '| app.slug present:', cr.includes('"slug"'));
process.exit(0);
