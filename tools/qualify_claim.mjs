// OmniBounty V3 terminal claim qualification (NEAR testnet, operator-run).
//
// Submits ONE `qualify_claim(bounty_id, criteria_json, proofs, recipient)`
// for a matured-claim bundle assembled from two Reclaim proof files. This is
// the tracked equivalent of the untracked E2E#4 qualify-runner: same proof
// selection rules (explicit directory, no defaults, no fallback), same
// local validation, plus a read-only `dry_qualify` pre-check on --dry-run.
//
// Usage:
//   node tools/qualify_claim.mjs <proofsDir> <bountyId> --criteria <file> --dry-run   # validate + dry_qualify, submit nothing
//   node tools/qualify_claim.mjs <proofsDir> <bountyId> --criteria <file> --submit    # validate, then submit
//
// Behavior:
// - <proofsDir> must contain proof-pr.json and proof-identity.json;
//   anything missing -> exit 2 before any network use.
// - Both proofs are shape-validated (frontend/lib/validation.mjs) and
//   their owners must match; recipient is always the proof owner.
// - --dry-run runs the same validation plus a live read-only dry_qualify
//   view and prints the outcome. Recorded (already-consumed) proofs report
//   ok:false here (IDENTIFIER_REPLAY / NO_OPEN_SLOT) — that is the
//   expected output for fixtures, not a script failure.
// - --submit sends exactly one transaction (300 Tgas + 1 NEAR storage
//   deposit, mirroring the frontend QUALIFY_* constants). No mode flag,
//   or any other flag -> exit 2 without submitting.
// - Signer key: JSON key file at NEAR_KEY_FILE (default
//   secrets/v3-operator.json, gitignored), {"account_id","private_key"}.
//   The key is NEVER printed. --dry-run needs no key.
// - RPC/contract: NEAR_RPC_URL / NEAR_CONTRACT_ID env with testnet
//   defaults (https://rpc.testnet.near.org, omnibounty-v3.testnet).
//
// Exit codes: 0 = dry-run validated (see printed dry_qualify outcome) or
// submitted; 1 = validation/RPC failure; 2 = usage/config error.
import { readFileSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateProofShape } from "../frontend/lib/validation.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RPC_URL = process.env.NEAR_RPC_URL || "https://rpc.testnet.near.org";
const CONTRACT_ID = process.env.NEAR_CONTRACT_ID || "omnibounty-v3.testnet";
const KEY_FILE = process.env.NEAR_KEY_FILE || join(ROOT, "secrets", "v3-operator.json");
const GAS = "300000000000000"; // 300 Tgas, mirroring frontend QUALIFY_GAS
const DEPOSIT_YOCTO = "1000000000000000000000000"; // 1 NEAR storage deposit

export function parseArgs(argv) {
  const positional = [];
  let criteriaPath = null;
  let mode = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--criteria") {
      criteriaPath = argv[++i] ?? null;
    } else if (a === "--dry-run" || a === "--submit") {
      if (mode) throw new Error("pass exactly one of --dry-run, --submit");
      mode = a;
    } else if (a.startsWith("--")) {
      throw new Error(`unknown flag: ${a}`);
    } else {
      positional.push(a);
    }
  }
  const [proofsDirArg, bountyRaw] = positional;
  if (!proofsDirArg || !bountyRaw || !criteriaPath) {
    throw new Error("usage: node tools/qualify_claim.mjs <proofsDir> <bountyId> --criteria <file> --dry-run|--submit");
  }
  if (!mode) throw new Error("refusing: pass --dry-run or --submit explicitly (no default mode)");
  const bountyId = Number(bountyRaw);
  if (!Number.isInteger(bountyId) || bountyId < 0) {
    throw new Error(`invalid bountyId: ${JSON.stringify(bountyRaw)} (want u64 id)`);
  }
  return { proofsDirArg, bountyId, criteriaPath, submit: mode === "--submit" };
}

export function loadBundle(proofsDirArg, criteriaPath) {
  const proofsDir = resolve(proofsDirArg);
  if (!existsSync(proofsDir) || !statSync(proofsDir).isDirectory()) {
    throw new Error(`proofs dir not found: ${proofsDir}`);
  }
  const prPath = join(proofsDir, "proof-pr.json");
  const idPath = join(proofsDir, "proof-identity.json");
  for (const p of [prPath, idPath]) {
    if (!existsSync(p)) throw new Error(`missing proof file: ${p}`);
  }
  const critResolved = resolve(criteriaPath);
  if (!existsSync(critResolved)) throw new Error(`criteria file not found: ${critResolved}`);
  const prRaw = JSON.parse(readFileSync(prPath, "utf8"));
  const idRaw = JSON.parse(readFileSync(idPath, "utf8"));
  const sp = validateProofShape(prRaw);
  const si = validateProofShape(idRaw);
  if (!sp.ok || !si.ok) {
    throw new Error(`invalid proofs: pr=${JSON.stringify(sp.errors)} id=${JSON.stringify(si.errors)}`);
  }
  const prOwner = sp.normalized.signedClaim.claim.owner;
  const idOwner = si.normalized.signedClaim.claim.owner;
  if (String(prOwner).toLowerCase() !== String(idOwner).toLowerCase()) {
    throw new Error("owner mismatch between PR and identity proofs");
  }
  const criteriaJson = readFileSync(critResolved, "utf8");
  JSON.parse(criteriaJson); // must be JSON; the contract enforces the schema
  return {
    proofsDir, prPath, idPath, criteriaPath: critResolved, criteriaJson,
    pr: sp.normalized, id: si.normalized, recipient: prOwner,
  };
}

export function buildQualifyArgs(bountyId, bundle) {
  return {
    bounty_id: bountyId,
    criteria_json: bundle.criteriaJson,
    proofs: [
      { evidence_type: 1, proof: bundle.pr },
      { evidence_type: 7, proof: bundle.id },
    ],
    recipient: bundle.recipient,
  };
}

function describeProof(tag, normalized, nowSec) {
  const c = normalized.signedClaim.claim;
  return `${tag}: ts=${c.timestampS} age=${nowSec - c.timestampS}s epoch=${c.epoch} owner=${c.owner} sigs=${normalized.signedClaim.signatures.length}`;
}

/// Read-only dry_qualify view over plain fetch (needs no key). Returns the
/// contract's DryOutcome verbatim.
export async function dryQualifyView(args, { rpcUrl = RPC_URL, contractId = CONTRACT_ID } = {}) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: "qualify-dry-run", method: "query",
      params: {
        request_type: "call_function", finality: "final",
        account_id: contractId, method_name: "dry_qualify",
        args_base64: Buffer.from(JSON.stringify(args), "utf8").toString("base64"),
      },
    }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status} for dry_qualify`);
  const decoded = Buffer.from((await res.json()).result.result).toString("utf8");
  return JSON.parse(decoded);
}

/// Submit qualify_claim for a validated bundle. Callers must have run
/// loadBundle plus a dry_qualify gate (same checks as main).
export async function submitQualify({ account, contractId, args }) {
  const out = await account.functionCall({
    contractId, methodName: "qualify_claim", args,
    gas: GAS, attachedDeposit: DEPOSIT_YOCTO,
  });
  return { txHash: out.transaction.hash, status: out.status };
}

export async function connectAccount(keyFile) {
  let saved;
  try {
    saved = JSON.parse(readFileSync(keyFile, "utf8"));
  } catch (e) {
    throw new Error(`cannot read key file ${keyFile}: ${e.message}`);
  }
  if (!saved.account_id || !saved.private_key) {
    throw new Error(`key file ${keyFile} must hold {"account_id","private_key"}`);
  }
  const require = createRequire(import.meta.url);
  const nearApi = require("../frontend/node_modules/near-api-js");
  const keystore = new nearApi.keyStores.InMemoryKeyStore();
  await keystore.setKey("testnet", saved.account_id, nearApi.KeyPair.fromString(saved.private_key));
  const near = await nearApi.connect({ networkId: "testnet", keyStore: keystore, nodeUrl: RPC_URL });
  return { account: await near.account(saved.account_id), accountId: saved.account_id };
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 2;
    return;
  }
  let bundle;
  try {
    bundle = loadBundle(parsed.proofsDirArg, parsed.criteriaPath);
  } catch (e) {
    console.error(e.message);
    process.exitCode = e.message.startsWith("proofs dir not found") || e.message.startsWith("missing proof file") || e.message.startsWith("criteria file not found") ? 2 : 1;
    return;
  }
  const nowSec = Math.floor(Date.now() / 1000);
  console.log(`proofs dir: ${bundle.proofsDir}`);
  console.log(`proof files:\n  ${bundle.prPath}\n  ${bundle.idPath}`);
  console.log(describeProof("pr", bundle.pr, nowSec));
  console.log(describeProof("id", bundle.id, nowSec));
  console.log(`bounty=${parsed.bountyId} recipient=${bundle.recipient} criteria_bytes=${bundle.criteriaJson.length}`);
  const args = buildQualifyArgs(parsed.bountyId, bundle);
  if (!parsed.submit) {
    // Read-only pre-check against the live contract; submits nothing.
    try {
      const outcome = await dryQualifyView(args);
      console.log(`dry_qualify: ${JSON.stringify(outcome).slice(0, 400)}`);
    } catch (e) {
      console.error(`dry_qualify failed: ${e.message ?? String(e)}`);
      process.exitCode = 1;
      return;
    }
    console.log("DRY-RUN: bundle valid, nothing submitted.");
    return;
  }
  let account;
  let accountId;
  try {
    ({ account, accountId } = await connectAccount(KEY_FILE));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 2;
    return;
  }
  console.log(`submitting qualify_claim as ${accountId} on ${CONTRACT_ID}`);
  const { txHash, status } = await submitQualify({ account, contractId: CONTRACT_ID, args });
  console.log(`tx: ${txHash}`);
  console.log(`status: ${JSON.stringify(status).slice(0, 200)}`);
}

if (process.argv[1]?.endsWith("qualify_claim.mjs")) {
  await main(process.argv.slice(2));
}
