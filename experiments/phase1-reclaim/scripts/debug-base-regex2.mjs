const r = await fetch('https://api.github.com/repos/react/react/pulls/38132', { headers: { 'User-Agent': 'exp02-debug2' } });
const raw = await r.text();
const baseIdx = raw.indexOf('"base":{');
console.log('BASE-KEYS-REGION:', JSON.stringify(raw.slice(baseIdx, baseIdx + 400)));
// Candidate tolerant patterns (applied to the whole payload like the attestor does).
const cands = {
  dotstar_lazy: /"base":\{[\s\S]*?"sha":"(?<s>[0-9a-f]{40})"/,
  anchored_ref: /"ref":"main","sha":"(?<s>[0-9a-f]{40})"/,
};
for (const [name, re] of Object.entries(cands)) {
  const m = raw.match(re);
  console.log(name, '=>', m ? m.groups.s : 'NO-MATCH');
}
process.exit(0);
