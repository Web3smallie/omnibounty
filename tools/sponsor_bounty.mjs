// OmniBounty V3 terminal sponsorship (NEAR testnet, operator-run).
//
// Wraps the two NEAR-side sponsor calls so agents never need wallet
// popups. The Base-side steps (createBounty / approve / fundBounty) stay
// explicit `cast` commands in the runbook — one signature per call, no
// wrapper to drift from the escrow ABI.
//
// Usage:
//   node tools/sponsor_bounty.mjs create --bounty-id <id> --token <0x> --criteria <file> --dry-run|--submit
//   node tools/sponsor_bounty.mjs mark-funded --bounty-id <id> --dry-run|--submit
//
// Behavior:
// - create --dry-run: validates the criteria file with the same gate the
//   frontend uses (parseAndValidateCriteria), prints its hash/slots/total,
//   and checks the id is unused on-chain. Submits nothing, needs no key.
// - create --submit: re-checks the id is unused (refuses BountyExists),
//   then sends create_bounty (300 Tgas + 0.05 NEAR, mirroring the
//   frontend CREATE_BOUNTY_V3_* constants) and re-reads the bounty.
// - mark-funded --dry-run: reads NEAR get_bounty plus the Base escrow
//   bounties(id) view and reports READY only when the escrow actually
//   holds the NEAR-committed total (the check the contract cannot do
//   itself). Submits nothing, needs no key.
// - mark-funded --submit: re-verifies escrow funding, requires the key
//   account to equal the recorded sponsor (the call is sponsor-only),
//   then sends mark_funded (no deposit).
// - No mode flag, or any other flag -> exit 2 without submitting.
// - Signer key: JSON key file at NEAR_KEY_FILE (default
//   secrets/v3-operator.json, gitignored). NEVER printed.
// - Endpoints: NEAR_RPC_URL / NEAR_CONTRACT_ID / BASE_RPC_URL /
//   ESCROW_ADDRESS env with the deployed-testnet defaults.
//
// Exit codes: 0 = dry-run validated / submitted+confirmed; 1 =
// validation/RPC/not-ready failure; 2 = usage/config error.
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAndValidateCriteria, hashCriteriaDocument } from "../frontend/lib/criteria.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NEAR_RPC_URL = process.env.NEAR_RPC_URL || "https://rpc.testnet.near.org";
const CONTRACT_ID = process.env.NEAR_CONTRACT_ID || "omnibounty-v3.testnet";
const KEY_FILE = process.env.NEAR_KEY_FILE || join(ROOT, "secrets", "v3-operator.json");
const BASE_RPC_URL = process.env.BASE_RPC_URL || "https://sepolia.base.org";
const ESCROW_ADDRESS = process.env.ESCROW_ADDRESS || "0x63391c272A49c30f79eb6c3d8E10F0652Bb0F767";
const GAS = "300000000000000"; // 300 Tgas, mirroring frontend constants
const CREATE_DEPOSIT_YOCTO = "50000000000000000000000"; // 0.05 NEAR storage deposit

const ESCROW_ABI = [
  "function bounties(uint256) view returns ((address token, address sponsor, uint64 deadline, bytes32 criteriaHash, bool funded, uint256 totalFunded, uint256[] amounts, uint256 claimedBitmap, uint256 refundedBitmap))",
];

export function parseArgs(argv) {
  const [action, ...rest] = argv;
  if (action !== "create" && action !== "mark-funded") {
    throw new Error("usage: node tools/sponsor_bounty.mjs <create|mark-funded> ... (see header)");
  }
  const opts = {};
  let mode = null;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--dry-run" || a === "--submit") {
      if (mode) throw new Error("pass exactly one of --dry-run, --submit");
      mode = a;
    } else if (a === "--bounty-id" || a === "--token" || a === "--criteria") {
      opts[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = rest[++i] ?? null;
    } else {
      throw new Error(`unknown flag: ${a}`);
    }
  }
  if (!mode) throw new Error("refusing: pass --dry-run or --submit explicitly (no default mode)");
  const bountyId = Number(opts.bountyId);
  if (opts.bountyId == null || !Number.isInteger(bountyId) || bountyId < 0) {
    throw new Error(`invalid --bounty-id: ${JSON.stringify(opts.bountyId)} (want u64 id)`);
  }
  if (action === "create") {
    if (!opts.token || !/^0x[0-9a-fA-F]{40}$/.test(opts.token)) {
      throw new Error(`invalid --token: ${JSON.stringify(opts.token)} (want 0x address)`);
    }
    if (!opts.criteria) throw new Error("create requires --criteria <file>");
  }
  return { action, bountyId, token: opts.token ?? null, criteriaPath: opts.criteria ?? null, submit: mode === "--submit" };
}

export function loadCriteriaDoc(criteriaPath) {
  const resolved = resolve(criteriaPath);
  if (!existsSync(resolved)) throw new Error(`criteria file not found: ${resolved}`);
  const text = readFileSync(resolved, "utf8");
  const v = parseAndValidateCriteria(text);
  if (!v.ok) throw new Error(`criteria invalid: ${v.errors.join("; ")}`);
  return { text, canonical: v.canonical, hash: hashCriteriaDocument(v.canonical) };
}

export async function rpcView(contractId, method, args, rpcUrl = NEAR_RPC_URL) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: "sponsor-dry-run", method: "query",
      params: {
        request_type: "call_function", finality: "final",
        account_id: contractId, method_name: method,
        args_base64: Buffer.from(JSON.stringify(args), "utf8").toString("base64"),
      },
    }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status} for ${method}`);
  const body = await res.json();
  if (body.error) throw new Error(`RPC error for ${method}: ${JSON.stringify(body.error).slice(0, 200)}`);
  return JSON.parse(Buffer.from(body.result.result).toString("utf8"));
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
  const near = await nearApi.connect({ networkId: "testnet", keyStore: keystore, nodeUrl: NEAR_RPC_URL });
  return { account: await near.account(saved.account_id), accountId: saved.account_id };
}

function escrowContract() {
  const require = createRequire(import.meta.url);
  const { ethers } = require("../frontend/node_modules/ethers");
  const provider = new ethers.JsonRpcProvider(BASE_RPC_URL, 84532);
  return new ethers.Contract(ESCROW_ADDRESS, ESCROW_ABI, provider);
}

/// Submit create_bounty for pre-validated inputs. Callers must have run
/// the unused-id pre-check (same checks as main); returns { txHash }.
export async function submitCreateBounty({ account, contractId, bountyId, token, canonical }) {
  const out = await account.functionCall({
    contractId, methodName: "create_bounty",
    args: { bounty_id: bountyId, token, criteria_json: canonical },
    gas: GAS, attachedDeposit: CREATE_DEPOSIT_YOCTO,
  });
  return { txHash: out.transaction.hash };
}

/// Submit mark_funded. Callers must have run checkFundingReady plus the
/// sponsor==key check (same checks as main); returns { txHash }.
export async function submitMarkFunded({ account, contractId, bountyId }) {
  const out = await account.functionCall({
    contractId, methodName: "mark_funded",
    args: { bounty_id: bountyId }, gas: GAS, attachedDeposit: "0",
  });
  return { txHash: out.transaction.hash };
}

/// Read-only funding cross-check: the escrow must actually hold the
/// NEAR-committed total before mark-funded means anything. Returns
/// { ready, reasons[], near, escrow }.
export async function checkFundingReady(bountyId, { nearView = undefined, escrowView = undefined } = {}) {
  const reasons = [];
  // Explicitly-passed views (including null) short-circuit the live reads,
  // so tests never touch the network; omitted views hit the chain.
  const near = nearView === undefined ? await rpcView(CONTRACT_ID, "get_bounty", { bounty_id: bountyId }) : nearView;
  if (!near) {
    reasons.push(`no NEAR bounty ${bountyId} (create it first)`);
    return { ready: false, reasons, near: null, escrow: null };
  }
  const escrow = escrowView === undefined ? await escrowContract().bounties(BigInt(bountyId)) : escrowView;
  const escrowFunded = escrow.funded === true;
  const escrowTotal = escrow.totalFunded.toString();
  if (!escrowFunded) reasons.push(`Base escrow bounty ${bountyId} is not funded yet`);
  if (escrowTotal !== String(near.total_amount)) {
    reasons.push(`escrow total ${escrowTotal} != NEAR total ${near.total_amount}`);
  }
  if (near.funded === true) reasons.push(`NEAR bounty ${bountyId} is already marked funded (no-op refused)`);
  return { ready: reasons.length === 0, reasons, near, escrow: { funded: escrowFunded, totalFunded: escrowTotal } };
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
  if (parsed.action === "create") {
    let doc;
    try {
      doc = loadCriteriaDoc(parsed.criteriaPath);
    } catch (e) {
      console.error(e.message);
      process.exitCode = e.message.startsWith("criteria file not found") ? 2 : 1;
      return;
    }
    const slots = JSON.parse(doc.canonical).slots.map((s) => s.amount);
    const total = slots.reduce((sum, a) => sum + BigInt(a), 0n).toString();
    console.log(`criteria: hash=${doc.hash} slots=${slots.length} total=${total}`);
    let existing;
    try {
      existing = await rpcView(CONTRACT_ID, "get_bounty", { bounty_id: parsed.bountyId });
    } catch (e) {
      console.error(`bounty pre-check failed: ${e.message}`);
      process.exitCode = 1;
      return;
    }
    if (existing) {
      console.error(`bounty ${parsed.bountyId} already exists on NEAR (pick another id)`);
      process.exitCode = 1;
      return;
    }
    if (!parsed.submit) {
      console.log(`DRY-RUN: create bounty=${parsed.bountyId} token=${parsed.token} — id unused, nothing submitted.`);
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
    console.log(`submitting create_bounty as ${accountId} on ${CONTRACT_ID}`);
    const { txHash } = await submitCreateBounty({
      account, contractId: CONTRACT_ID, bountyId: parsed.bountyId, token: parsed.token, canonical: doc.canonical,
    });
    console.log(`tx: ${txHash}`);
    const created = await account.viewFunction({ contractId: CONTRACT_ID, methodName: "get_bounty", args: { bounty_id: parsed.bountyId } });
    console.log(`confirmed: id=${created.id} slots=${created.slots.length} funded=${created.funded}`);
    return;
  }
  // mark-funded
  let check;
  try {
    check = await checkFundingReady(parsed.bountyId);
  } catch (e) {
    console.error(`funding check failed: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  for (const r of check.reasons) console.log(`- ${r}`);
  if (!check.ready) {
    console.log("NOT READY: fix the above, then re-run.");
    process.exitCode = 1;
    return;
  }
  console.log(`READY: escrow holds ${check.escrow.totalFunded} for bounty ${parsed.bountyId}.`);
  if (!parsed.submit) {
    console.log("DRY-RUN: nothing submitted.");
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
  if (check.near.sponsor !== accountId) {
    console.error(`key account ${accountId} is not the recorded sponsor ${check.near.sponsor} (mark_funded is sponsor-only)`);
    process.exitCode = 1;
    return;
  }
  console.log(`submitting mark_funded as ${accountId} on ${CONTRACT_ID}`);
  const { txHash } = await submitMarkFunded({ account, contractId: CONTRACT_ID, bountyId: parsed.bountyId });
  console.log(`tx: ${txHash}`);
  console.log("MARKED FUNDED");
}

if (process.argv[1]?.endsWith("sponsor_bounty.mjs")) {
  await main(process.argv.slice(2));
}
