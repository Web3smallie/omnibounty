// Regenerates testdata/v3/golden-hashes.json from criteria-valid/*.json.
// Every fixture MUST validate first; the file maps name -> criteria_hash.
// Re-run + diff to detect canonicalization drift. No network.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const { parseAndValidateCriteria, hashCriteriaDocument } = await import(
  pathToFileURL(join(ROOT, 'frontend', 'lib', 'criteria.mjs')).href
);

const dir = join(ROOT, 'testdata', 'v3', 'criteria-valid');
const out = {};
for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
  const text = readFileSync(join(dir, f), 'utf8');
  const v = parseAndValidateCriteria(text);
  if (!v.ok) {
    console.error(`INVALID FIXTURE ${f}:`, v.errors.join(' | '));
    process.exit(1);
  }
  out[f.replace(/\.json$/, '')] = hashCriteriaDocument(text);
  console.log(`${f}: ${out[f.replace(/\.json$/, '')]}`);
}
writeFileSync(join(ROOT, 'testdata', 'v3', 'golden-hashes.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`wrote golden-hashes.json (${Object.keys(out).length} vectors)`);
process.exit(0);
