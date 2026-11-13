const s = '[{"filename":"a","status":"m"},{"filename":"b","status":"x"},{"filename":"c","status":"y"}]';
for (const k of [1, 2, 3]) {
  const prefix = k === 1 ? '' : `^(?:[\\s\\S]*?"filename":){${k - 1}}`;
  const re = new RegExp(prefix + `"filename":"(?<f>[^"]*)"`);
  const m = s.match(re);
  console.log(`k=${k} pattern=${re} =>`, m ? m.groups.f : 'NO-MATCH');
}
// Variant B: count-then-capture without trailing literal.
for (const k of [1, 2, 3]) {
  const re = new RegExp(`^(?:[^f]*(?:f(?!ilename":)[^f]*)*"filename":"){${k}}[^"]*"`);
  const m = s.match(re);
  console.log(`k=${k} variantB =>`, m ? m[0].slice(-30) : 'NO-MATCH');
}
process.exit(0);
