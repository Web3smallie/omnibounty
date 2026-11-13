// OmniBounty V3 one-shot claim finalizer (NEAR testnet, operator-run).
//
// Sends ONE `finalize_claim(bounty_id, slot)` transaction for a matured
// claim, then polls `get_voucher` until the MPC-signed voucher lands.
// Follows the proven V2 operator pattern (tools/funded_claim_v2.mjs):
// same near-api-js signing, same 300 Tgas, same poll-then-verify flow,
// evidence to gitignored local state. Moves NO funds itself: USDC moves
// only when the relayer later settles on Base (separate step).
//
// Key: any funded testnet account, private key in a gitignored JSON file
//   {"account_id": "...", "private_key": "ed25519:..."} (0600).
//   finalize_claim is permissionless; the key needs ~0.1 NEAR + gas only.
// Evidence: .link-temp/finalize-<bountyId>-<slot>.json (gitignored).
//
// Usage:
//   node tools/finalize.mjs <bountyId> <slot>
//   NEAR_KEY_FILE=secrets/operator.json NEAR_RPC_URL=https://... node tools/finalize.mjs 7 0
//
// Exit codes: 0 = voucher observed (fresh, pre-signed, or won-by-other);
// 1 = failure/timeout; 2 = usage/config error. Success is reported ONLY
// when `get_voucher` returns the signed voucher — never on submission.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RPC_URL = process.env.NEAR_RPC_URL || "https://rpc.testnet.near.org";
const CONTRACT_ID = "omnibounty-v3.testnet";
const GAS = "300000000000000"; // 300 Tgas (protocol tx limit, as xsuite uses)
const DEPOSIT_YOCTO = "100000000000000000000000"; // 0.1 NEAR storage deposit
const KEY_FILE = process.env.NEAR_KEY_FILE || join(ROOT, "secrets", "v3-operator.json");
const POLL_MS = 15000;
const POLL_ROUNDS = 40; // up to 10 min, mirroring funded_claim_v2.mjs

export function parseArgs(argv) {
  const [bountyRaw, slotRaw] = argv;
  const bountyId = Number(bountyRaw);
  const slot = Number(slotRaw);
  if (!Number.isInteger(bountyId) || bountyId < 0) {
    throw new Error(`invalid bountyId: ${JSON.stringify(bountyRaw)} (want u64 id)`);
  }
  if (!Number.isInteger(slot) || slot < 0 || slot > 255) {
    throw new Error(`invalid slot: ${JSON.stringify(slotRaw)} (want u8 0..255)`);
  }
  return { bountyId, slot };
}

export function isMatured(claimView, nowSec) {
  // challenge_ends_at is authoritative (qualified_at + window, saturating).
  return nowSec >= claimView.challenge_ends_at;
}

export function buildEvidence({ contractId, bountyId, slot, claim, txHash, voucher, submitted }) {
  return {
    contract: contractId,
    bountyId,
    slot,
    recipient: claim.recipient,
    prNumber: claim.pr_number,
    submitted,
    txHash,
    voucher: voucher.voucher,
    v: voucher.v,
    r: voucher.r,
    s: voucher.s,
    generatedAt: new Date().toISOString(),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isRaceLost(msg) {
  // Another finalizer won (or already won): do NOT resubmit; the outcome
  // is determined by polling for the voucher instead.
  return /SlotPending|AlreadyFinalized/.test(msg);
}

// Injectable core: `account` exposes viewFunction/callFunction like a
// near-api-js Account; `nowSec`/`sleepFn`/rounds make polling testable.
export async function runOnce(deps, { bountyId, slot }) {
  const { account, contractId, nowSec, sleepFn = sleep, rounds = POLL_ROUNDS } = deps;
  const claim = await account.viewFunction({ contractId, methodName: "get_claim", args: { bounty_id: bountyId, slot } });
  if (!claim) throw new Error(`CLAIM_NOT_FOUND bounty=${bountyId} slot=${slot}`);
  const existing = await account.viewFunction({ contractId, methodName: "get_voucher", args: { bounty_id: bountyId, slot } });
  if (existing && existing.voucher) {
    return { submitted: false, txHash: null, voucher: existing };
  }
  if (!isMatured(claim, nowSec)) {
    throw new Error(
      `CHALLENGE_NOT_EXPIRED ends_at=${claim.challenge_ends_at} now=${nowSec} (retry after the window)`
    );
  }
  let txHash = null;
  try {
    const out = await account.functionCall({
      contractId,
      methodName: "finalize_claim",
      args: { bounty_id: bountyId, slot },
      gas: GAS,
      attachedDeposit: DEPOSIT_YOCTO,
    });
    txHash = out.transaction.hash;
  } catch (e) {
    const msg = e.message ?? String(e);
    if (!isRaceLost(msg)) throw e;
    // Lost the race (or a previous run's dispatch is live): fall through
    // to polling. Never resubmit blindly.
  }
  for (let i = 0; i < rounds; i++) {
    await sleepFn(POLL_MS);
    const found = await account.viewFunction({
      contractId, methodName: "get_voucher", args: { bounty_id: bountyId, slot },
    });
    if (found && found.voucher) return { submitted: txHash !== null, txHash, voucher: found };
  }
  throw new Error(`MPC_TIMEOUT no voucher for bounty=${bountyId} slot=${slot} (re-run to retry; check MPC status)`);
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    console.error(`usage: node tools/finalize.mjs <bountyId> <slot>\n${e.message}`);
    process.exitCode = 2;
    return;
  }
  let saved;
  try {
    saved = JSON.parse(readFileSync(KEY_FILE, "utf8"));
  } catch (e) {
    console.error(`cannot read operator key file ${KEY_FILE}: ${e.message}`);
    console.error(`create {"account_id": "...", "private_key": "ed25519:..."} with mode 0600 (gitignored secrets/).`);
    process.exitCode = 2;
    return;
  }
  // Lazy-load near-api-js only on the live path (unit tests must not need it).
  const { createRequire } = await import("node:module");
  const nearApi = createRequire(import.meta.url)("../frontend/node_modules/near-api-js");
  const keystore = new nearApi.keyStores.InMemoryKeyStore();
  const keyPair = nearApi.KeyPair.fromString(saved.private_key);
  await keystore.setKey("testnet", saved.account_id, keyPair);
  const near = await nearApi.connect({ networkId: "testnet", keyStore: keystore, nodeUrl: RPC_URL });
  const account = await near.account(saved.account_id);
  console.log(`finalize bounty=${parsed.bountyId} slot=${parsed.slot} as ${saved.account_id} on ${CONTRACT_ID}`);
  const nowSec = Math.floor(Date.now() / 1000);
  let result;
  try {
    result = await runOnce({ account, contractId: CONTRACT_ID, nowSec }, parsed);
  } catch (e) {
    console.error(`FAILED: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  const claim = await account.viewFunction({
    contractId: CONTRACT_ID, methodName: "get_claim",
    args: { bounty_id: parsed.bountyId, slot: parsed.slot },
  });
  const evidence = buildEvidence({
    contractId: CONTRACT_ID,
    bountyId: parsed.bountyId,
    slot: parsed.slot,
    claim,
    txHash: result.txHash,
    voucher: result.voucher,
    submitted: result.submitted,
  });
  const dir = join(ROOT, ".link-temp");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `finalize-${parsed.bountyId}-${parsed.slot}.json`);
  writeFileSync(path, JSON.stringify(evidence, null, 2) + "\n");
  console.log(result.submitted ? "FINALIZED (tx submitted)" : "FINALIZED (voucher already present)");
  console.log(`tx=${result.txHash ?? "(none)"}`);
  console.log(`digest=${result.voucher.voucher.digest}`);
  console.log(`evidence: ${path}`);
}

// Side-effect-free on import (tests import the pure core above).
if (process.argv[1]?.endsWith("finalize.mjs")) {
  await main(process.argv.slice(2));
}
