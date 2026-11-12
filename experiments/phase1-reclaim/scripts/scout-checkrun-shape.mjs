const sha = '5621284babc44ced80598504e7aae22f75fb32c1';
const r = await fetch(`https://api.github.com/repos/react/react/commits/${sha}/check-runs?per_page=5`, { headers: { 'User-Agent': 'exp03-scout2' } });
const t = await r.text();
const j = JSON.parse(t);
const first = JSON.stringify(j.check_runs[0]);
console.log('FIRST-RUN-KEYS:', Object.keys(j.check_runs[0]).join(','));
console.log('FIRST-RUN-HEAD:', first.slice(0, 420));
// Where does "conclusion" sit relative to "name"?
console.log('idx(name)=', first.indexOf('"name"'), 'idx(conclusion)=', first.indexOf('"conclusion"'), 'idx(head_sha)=', first.indexOf('"head_sha"'), 'idx(app)=', first.indexOf('"app"'));
process.exit(0);
