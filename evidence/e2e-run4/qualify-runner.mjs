// Corrected E2E qualify runner (UNTRACKED, audit-backup only).
//
// Fix for the E2E#3 proof-selection mistake (/tmp/e2e3-qualify.mjs hardcoded
// proofs/): the proofs directory is a REQUIRED explicit argument with no
// default and no fallback. Usage:
//   node qualify-runner.mjs <proofsDir> <bountyId> --dry-run   # validate + print, submit nothing
//   node qualify-runner.mjs <proofsDir> <bountyId> --submit    # validate, then submit qualify_claim
//
// Behavior:
// - Missing/unknown proofsDir, or missing proof-pr.json / proof-identity.json
//   inside it -> immediate exit 2, before any network use.
// - Resolves and prints absolute paths + per-proof timestamp/epoch/owner.
// - Validates both shapes via frontend/lib/validation.mjs; any failure -> exit 1.
// - --dry-run (also the behavior when the mode flag is absent or unrecognized:
//   NEVER submits unless the literal flag --submit is present).
// - No secrets printed (account IDs and public owner addresses only).
import { readFileSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateProofShape } from "/workspaces/omnibounty/frontend/lib/validation.mjs";

const BACKUP = dirname(fileURLToPath(import.meta.url));
const ROOT = join(BACKUP, "..");
const [, , proofsDirArg, bountyRaw, modeRaw] = process.argv;
if (!proofsDirArg || !bountyRaw) {
  console.error("usage: node qualify-runner.mjs <proofsDir> <bountyId> --dry-run|--submit");
  process.exit(2);
}
const submit = modeRaw === "--submit";
if (modeRaw !== "--dry-run" && !submit) {
  console.error("refusing: pass --dry-run or --submit explicitly (no default mode)");
  process.exit(2);
}
const proofsDir = resolve(proofsDirArg);
if (!existsSync(proofsDir) || !statSync(proofsDir).isDirectory()) {
  console.error(`proofs dir not found: ${proofsDir}`);
  process.exit(2);
}
const bountyId = Number(bountyRaw);
if (!Number.isInteger(bountyId) || bountyId < 0) {
  console.error(`invalid bountyId: ${bountyRaw}`);
  process.exit(2);
}
const prPath = join(proofsDir, "proof-pr.json");
const idPath = join(proofsDir, "proof-identity.json");
for (const p of [prPath, idPath]) {
  if (!existsSync(p)) {
    console.error(`missing proof file: ${p}`);
    process.exit(2);
  }
}
console.log(`proofs dir: ${proofsDir}`);
console.log(`proof files:\n  ${prPath}\n  ${idPath}`);
const prRaw = JSON.parse(readFileSync(prPath, "utf8"));
const idRaw = JSON.parse(readFileSync(idPath, "utf8"));
const sp = validateProofShape(prRaw);
const si = validateProofShape(idRaw);
if (!sp.ok || !si.ok) {
  console.error(`invalid proofs: pr=${JSON.stringify(sp.errors)} id=${JSON.stringify(si.errors)}`);
  process.exit(1);
}
const now = Math.floor(Date.now() / 1000);
for (const [t, n] of [["pr", sp.normalized], ["id", si.normalized]]) {
  const c = n.signedClaim.claim;
  console.log(`${t}: ts=${c.timestampS} age=${now - c.timestampS}s epoch=${c.epoch} owner=${c.owner} sigs=${n.signedClaim.signatures.length}`);
}
if (sp.normalized.signedClaim.claim.owner.toLowerCase() !== si.normalized.signedClaim.claim.owner.toLowerCase()) {
  console.error("owner mismatch between PR and identity proofs");
  process.exit(1);
}
const cj = readFileSync(join(BACKUP, "proofs/demo-criteria.json"), "utf8");
const recipient = sp.normalized.signedClaim.claim.owner;
console.log(`bounty=${bountyId} recipient=${recipient} criteria_bytes=${cj.length}`);
if (!submit) {
  console.log("DRY-RUN: bundle valid, nothing submitted.");
  process.exit(0);
}
const require = createRequire("/workspaces/omnibounty/tools/finalize.mjs");
const nearApi = require("../frontend/node_modules/near-api-js");
const env = {};
for (const ln of readFileSync(join(ROOT, ".env"), "utf8").split("\n")) {
  const l = ln.trim();
  if (!l || l.startsWith("#") || !l.includes("=")) continue;
  const i = l.indexOf("=");
  env[l.slice(0, i)] = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}
const keystore = new nearApi.keyStores.InMemoryKeyStore();
await keystore.setKey("testnet", env.NEAR_ACCOUNT_ID, nearApi.KeyPair.fromString(env.NEAR_PRIVATE_KEY));
const near = await nearApi.connect({ networkId: "testnet", keyStore: keystore, nodeUrl: "https://rpc.testnet.near.org" });
const out = await (await near.account(env.NEAR_ACCOUNT_ID)).functionCall({
  contractId: "omnibounty-v3.testnet", methodName: "qualify_claim",
  args: { bounty_id: bountyId, criteria_json: cj,
    proofs: [
      { evidence_type: 1, proof: sp.normalized },
      { evidence_type: 7, proof: si.normalized },
    ],
    recipient },
  gas: BigInt("300000000000000"), attachedDeposit: BigInt("1000000000000000000000000"),
});
console.log("tx:", out.transaction.hash);
console.log("status:", JSON.stringify(out.status).slice(0, 200));
