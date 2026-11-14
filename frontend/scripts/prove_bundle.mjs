// Server-side V3 proof-bundle generation (NEVER runs in the browser: it
// needs the Reclaim application secret AND the claimant's GitHub token).
// Runs both attestations with the SAME app secret in one command and
// writes one file the "Prepare claim" wizard accepts in a single paste.
//
// Usage (from frontend/, secrets in the environment or gitignored
// frontend/.env.local — loaded automatically, shell takes precedence):
//   RECLAIM_APP_ID=0x... RECLAIM_APP_SECRET=0x... GITHUB_TOKEN=ghp_... \
//     node scripts/prove_bundle.mjs octocat/Hello-World 7 ./claim-proofs.json
//
// Credential rules (same as the single-proof scripts):
// - One RECLAIM_APP_ID/SECRET pair for BOTH proofs: the proof owner
//   derives from the app secret, and the contract requires every proof
//   owner to equal the payout recipient — mixed owners fail on-chain.
// - GITHUB_TOKEN is the CLAIMANT's own token from the claimant's own
//   machine. It travels ONLY in zkFetch privateOptions.headers (hidden
//   from the verifier, never in the proof or on-chain) and this script
//   never prints it. Least privilege suffices; revoke after the demo.
// - Server-side only: never prefix these with NEXT_PUBLIC_.
//
// The script fails fast (exit 1) unless the PR proof carries all 7
// mandated extractions, the identity proof carries login + numeric id,
// the identity IS the PR author, and both owners match — the same gates
// the contract enforces, checked before the contributor touches the
// claim form.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ReclaimClient } from "@reclaimprotocol/zk-fetch";
import { loadEnvFile } from "./load_env.mjs";
import {
  buildIdentityProofRequest,
  buildPrProofRequest,
  checkIdentityBinding,
  checkIdentityExtractions,
  checkPrExtractions,
} from "../lib/reclaim.mjs";

loadEnvFile(join(dirname(fileURLToPath(import.meta.url)), "..", ".env.local"));

const [, , repo, prNumber, outPath] = process.argv;
const appId = process.env.RECLAIM_APP_ID;
const appSecret = process.env.RECLAIM_APP_SECRET;
const githubToken = process.env.GITHUB_TOKEN;

if (!repo || !prNumber || !outPath) {
  console.error("usage: node scripts/prove_bundle.mjs <owner/name> <prNumber> <outPath>");
  process.exit(2);
}
if (!appId || !appSecret) {
  console.error("missing RECLAIM_APP_ID / RECLAIM_APP_SECRET (set them in the environment or in frontend/.env.local)");
  process.exit(2);
}
if (!githubToken) {
  console.error("missing GITHUB_TOKEN (the claimant's own token; least privilege suffices)");
  process.exit(2);
}
if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
  console.error("invalid repo slug");
  process.exit(2);
}

const fail = (lines) => {
  for (const l of lines) console.error(l);
  process.exit(1);
};

const client = new ReclaimClient(appId, appSecret, true, 1);

// 1. Merged-PR attestation (evidence_type 1).
const prReq = buildPrProofRequest(repo, prNumber);
console.log(`[1/2] zkFetch ${prReq.url} ...`);
const startedPr = Date.now();
const prProof = await client.zkFetch(prReq.url, prReq.publicOptions, prReq.privateOptions);
console.log(`[1/2] proof received in ${((Date.now() - startedPr) / 1000).toFixed(1)}s`);
const prCtx = JSON.parse(prProof.claimData.context);
const prProblems = checkPrExtractions(prCtx.extractedParameters ?? {}, repo, prNumber);
if (prProblems.length > 0) {
  fail(["PR proof does NOT satisfy the V3 template:", ...prProblems.map((p) => `  - ${p}`)]);
}
const prEx = prCtx.extractedParameters;
console.log(`[1/2] extracted: merged=true author=${prEx.author} id=${prEx.author_id} repo=${prEx.repo} number=${prEx.number}`);

// 2. GitHub identity attestation (evidence_type 7). Only the public
// login/id are printed — never headers, never the token.
const idReq = buildIdentityProofRequest(`Bearer ${githubToken}`);
console.log(`[2/2] zkFetch ${idReq.url} ...`);
const startedId = Date.now();
const identityProof = await client.zkFetch(idReq.url, idReq.publicOptions, idReq.privateOptions);
console.log(`[2/2] proof received in ${((Date.now() - startedId) / 1000).toFixed(1)}s`);
const idCtx = JSON.parse(identityProof.claimData.context);
const idProblems = checkIdentityExtractions(idCtx.extractedParameters ?? {});
if (idProblems.length > 0) {
  fail(["Identity proof does NOT satisfy the V3 template:", ...idProblems.map((p) => `  - ${p}`)]);
}
const idEx = idCtx.extractedParameters;
console.log(`[2/2] extracted: id_login=${idEx.id_login} id_num=${idEx.id_num}`);

// 3. Authorship chain + shared owner, mirrored from the on-chain gates.
const binding = checkIdentityBinding({
  prAuthor: prEx.author,
  prAuthorId: prEx.author_id,
  idLogin: idEx.id_login,
  idNum: idEx.id_num,
  proofOwners: [prProof.claimData.owner, identityProof.claimData.owner],
  recipient: prProof.claimData.owner,
});
if (binding.length > 0) {
  fail(["Proofs do not bind to one payout owner:", ...binding.map((p) => `  - ${p}`)]);
}
console.log(`bound: identity is the PR author, shared owner ${prProof.claimData.owner}`);

// Defense in depth: refuse to write output that somehow embeds a secret
// (e.g. a future SDK echoing private headers into parameters).
const serialized = JSON.stringify({ prProof, identityProof }, null, 2);
if (serialized.includes(githubToken)) {
  fail(["refusing to write: output somehow contains the GitHub token"]);
}
if (typeof appSecret === "string" && appSecret.length > 8 && serialized.includes(appSecret)) {
  fail(["refusing to write: output somehow contains the app secret"]);
}
writeFileSync(outPath, serialized);
console.log(`wrote ${outPath}`);
console.log("Next: open the bounty, click “Prepare claim”, and paste this one file.");
