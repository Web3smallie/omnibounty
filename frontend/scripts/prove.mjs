// Server-side V3 PR proof generation (NEVER runs in the browser: it needs
// the Reclaim application secret). Produces a proof satisfying the V3
// contract's 7 unconditional PR matchers (rules.rs `mandated_matchers`):
// merged, author, repo, number, head_sha, author_id, pr_created.
//
// Usage:
//   RECLAIM_APP_ID=0x... RECLAIM_APP_SECRET=0x... \
//     node scripts/prove.mjs octocat/Hello-World 7 ./proof-pr.json
//
// The app must be registered for zkFetch in the Reclaim portal; the ID/secret
// pair lives only in this machine's environment or its gitignored
// frontend/.env.local (loaded automatically; shell variables take
// precedence). Server-side only: never prefix these with NEXT_PUBLIC_.
//
// IMPORTANT: use the SAME app ID/secret for this proof and the identity
// proof (scripts/prove_identity.mjs). The proof owner derives from the app
// secret, and the contract requires every proof owner to equal the payout
// recipient — mixed owners fail with MixedProverBundle/RecipientMismatch.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ReclaimClient } from "@reclaimprotocol/zk-fetch";
import { loadEnvFile } from "./load_env.mjs";
import { buildPrProofRequest, checkPrExtractions } from "../lib/reclaim.mjs";

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

const { url, publicOptions, privateOptions } = buildPrProofRequest(repo, prNumber);
const client = new ReclaimClient(appId, appSecret, true, 1);

console.log(`zkFetch ${url} ...`);
const started = Date.now();
const proof = await client.zkFetch(url, publicOptions, privateOptions);
console.log(`proof received in ${((Date.now() - started) / 1000).toFixed(1)}s`);

// Local sanity check: fail fast unless all 7 mandated extractions are
// present and bound to this repo/PR, before the user submits.
const ctx = JSON.parse(proof.claimData.context);
const problems = checkPrExtractions(ctx.extractedParameters ?? {}, repo, prNumber);
if (problems.length > 0) {
  console.error("proof does NOT satisfy the V3 PR template:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
const ex = ctx.extractedParameters;
console.log(`extracted: merged=true author=${ex.author} id=${ex.author_id} repo=${ex.repo} number=${ex.number} head=${ex.head_sha}`);

writeFileSync(outPath, JSON.stringify(proof, null, 2));
console.log(`wrote ${outPath}`);
console.log("Next: generate the identity proof with scripts/prove_identity.mjs (same app secret),");
console.log("then paste both as { evidence_type, proof } entries in the V3 claim bundle.");
