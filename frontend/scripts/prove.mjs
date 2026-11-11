// Server-side proof generation (NEVER runs in the browser: it needs the
// Reclaim application secret). Produces a template-compliant proof that the
// NEAR contract accepts: extracts merged/author/repo/number for the PR.
//
// Usage:
//   RECLAIM_APP_ID=0x... RECLAIM_APP_SECRET=0x... \
//     node scripts/prove.mjs octocat/Hello-World 7 ./proof.json
//
// The app must be registered for zkFetch in the Reclaim portal; the ID/secret
// pair lives only in this machine's environment or its gitignored
// frontend/.env.local (loaded automatically; shell variables take
// precedence). Server-side only: never prefix these with NEXT_PUBLIC_.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ReclaimClient } from "@reclaimprotocol/zk-fetch";
import { loadEnvFile } from "./load_env.mjs";

loadEnvFile(join(dirname(fileURLToPath(import.meta.url)), "..", ".env.local"));

const [, , repo, prNumber, outPath] = process.argv;
const appId = process.env.RECLAIM_APP_ID;
const appSecret = process.env.RECLAIM_APP_SECRET;

if (!repo || !prNumber || !outPath) {
  console.error("usage: node scripts/prove.mjs <owner/name> <prNumber> <outPath>");
  process.exit(2);
}
if (!appId || !appSecret) {
  console.error("missing RECLAIM_APP_ID / RECLAIM_APP_SECRET (set them in the environment or in frontend/.env.local)");
  process.exit(2);
}
if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
  console.error("invalid repo slug");
  process.exit(2);
}

const url = `https://api.github.com/repos/${repo}/pulls/${prNumber}`;
const client = new ReclaimClient(appId, appSecret, true, 1);

console.log(`zkFetch ${url} ...`);
const started = Date.now();
const proof = await client.zkFetch(
  url,
  { method: "GET", headers: { "User-Agent": "omnibounty-prove/1.0" } },
  {
    responseMatches: [
      { type: "regex", value: '"merged":(?<merged>.*?)[,}]' },
      { type: "regex", value: '"login":"(?<author>.*?)"' },
      { type: "regex", value: '"full_name":"(?<repo>.*?)"' },
      { type: "regex", value: '"number":(?<number>.*?)[,}]' },
    ],
  }
);
console.log(`proof received in ${((Date.now() - started) / 1000).toFixed(1)}s`);

// Local sanity check: fail fast if the extraction does not satisfy the
// on-chain predicate (merged=true + bindings), before the user submits.
const ctx = JSON.parse(proof.claimData.context);
const ex = ctx.extractedParameters ?? {};
const problems = [];
if (ex.merged !== "true") problems.push(`merged=${JSON.stringify(ex.merged)} (PR is not merged?)`);
if (ex.repo !== repo) problems.push(`repo=${JSON.stringify(ex.repo)}`);
if (ex.number !== String(prNumber)) problems.push(`number=${JSON.stringify(ex.number)}`);
if (!ex.author) problems.push("missing author");
if (problems.length > 0) {
  console.error("proof does NOT satisfy the claim predicate:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`extracted: merged=true author=${ex.author} repo=${ex.repo} number=${ex.number}`);

writeFileSync(outPath, JSON.stringify(proof, null, 2));
console.log(`wrote ${outPath}`);
console.log("Paste this JSON into the claim form (proof owner pays out to itself only).");
