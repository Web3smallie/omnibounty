// Server-side V3 GitHub identity proof generation (NEVER runs in the
// browser). The V3 contract requires an identity proof on EVERY claim
// (evidence_type 7, else MissingEvidence): an authenticated
// GET https://api.github.com/user binding the prover to a GitHub login +
// numeric user id, matched against the PR author on-chain.
//
// Usage:
//   RECLAIM_APP_ID=0x... RECLAIM_APP_SECRET=0x... GITHUB_TOKEN=ghp_... \
//     node scripts/prove_identity.mjs ./proof-identity.json
//
// Credential rules (all enforced by how this script is built):
// - RECLAIM_APP_ID/SECRET must be the SAME pair used for the PR proof:
//   the proof owner derives from the app secret, and the contract requires
//   every proof owner to equal the payout recipient.
// - GITHUB_TOKEN is the CLAIMANT's own token, from the claimant's own
//   machine. Never use a shared account: the proven login/id must equal
//   the PR author, so anyone else's token fails on-chain anyway.
// - The token travels ONLY in zkFetch privateOptions.headers, which the SDK
//   keeps hidden from the verifier: it is sent to GitHub inside the TLS
//   session but never appears in the signed parameters, the proof file, or
//   the chain. This script never prints it (not even its length/prefix).
// - Least privilege: any token that can read your own profile suffices
//   (no repo scopes needed); prefer a short-lived, revocable token and
//   revoke it after the demo.
//
// Secrets live only in this machine's environment or gitignored
// frontend/.env.local (loaded automatically; shell variables take
// precedence). Server-side only: never prefix these with NEXT_PUBLIC_.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ReclaimClient } from "@reclaimprotocol/zk-fetch";
import { loadEnvFile } from "./load_env.mjs";
import { buildIdentityProofRequest, checkIdentityExtractions } from "../lib/reclaim.mjs";

loadEnvFile(join(dirname(fileURLToPath(import.meta.url)), "..", ".env.local"));

const [, , outPath] = process.argv;
const appId = process.env.RECLAIM_APP_ID;
const appSecret = process.env.RECLAIM_APP_SECRET;
const githubToken = process.env.GITHUB_TOKEN;

if (!outPath) {
  console.error("usage: node scripts/prove_identity.mjs <outPath>");
  process.exit(2);
}
if (!appId || !appSecret) {
  console.error("missing RECLAIM_APP_ID / RECLAIM_APP_SECRET (set them in the environment or in frontend/.env.local)");
  process.exit(2);
}
if (!githubToken) {
  console.error("missing GITHUB_TOKEN (the claimant's own token; see the header of this script)");
  process.exit(2);
}

const { url, publicOptions, privateOptions } = buildIdentityProofRequest(`Bearer ${githubToken}`);
const client = new ReclaimClient(appId, appSecret, true, 1);

console.log(`zkFetch ${url} ...`);
const started = Date.now();
const proof = await client.zkFetch(url, publicOptions, privateOptions);
console.log(`proof received in ${((Date.now() - started) / 1000).toFixed(1)}s`);

// Sanity check: the authenticated identity must be present. Only the
// public login/id are printed — never headers, never the token.
const ctx = JSON.parse(proof.claimData.context);
const problems = checkIdentityExtractions(ctx.extractedParameters ?? {});
if (problems.length > 0) {
  console.error("proof does NOT satisfy the V3 identity template:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
const ex = ctx.extractedParameters;
console.log(`extracted: id_login=${ex.id_login} id_num=${ex.id_num}`);

// Defense in depth: refuse to write a proof file that somehow embeds the
// token (e.g. a future SDK echoing private headers into parameters).
const serialized = JSON.stringify(proof, null, 2);
if (serialized.includes(githubToken)) {
  console.error("refusing to write: proof somehow contains the GitHub token");
  process.exit(1);
}
writeFileSync(outPath, serialized);
console.log(`wrote ${outPath}`);
console.log("Paste this as an { evidence_type: 7, proof } entry beside the PR proof in the V3 claim bundle.");
