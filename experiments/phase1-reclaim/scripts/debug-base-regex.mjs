const r = await fetch('https://api.github.com/repos/react/react/pulls/38132', { headers: { 'User-Agent': 'exp02-debug' } });
const raw = await r.text();
const baseIdx = raw.indexOf('"base":{');
console.log('BASE-SUBSTR:', JSON.stringify(raw.slice(baseIdx, baseIdx + 160)));
const m = raw.match(/"base":\{[^}]*?"ref":"[^"]*","sha":"(?<base_sha>[0-9a-f]{40})"/);
console.log('LOCAL-MATCH:', m ? m.groups.base_sha : 'NO-MATCH');
const m2 = raw.match(/"sha":"(?<s>[0-9a-f]{40})"/);
console.log('FIRST-SHA:', m2 ? m2.groups.s : 'none');
process.exit(0);
