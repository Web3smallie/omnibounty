// OmniBounty PRODUCTION v2 testnet deployment (real transactions).
//
// Deploys to v2.omnibounty.testnet (fresh subaccount of omnibounty.testnet),
// configures with live-verified values, creates validation bounty #1, and
// runs the NEGATIVE dry_run gate. Supersedes omnibounty.testnet (retired;
// v1 record preserved at testdata/production_testnet.legacy.json).
// Differences from docs/archive/deploy_production_v1.mjs (v1, retired):
//   - subaccount creation signed by the v1 owner key (no helper needed);
//   - REAL Base escrow wired from the start, not the placeholder;
//   - MPC signer derived live (no hardcoded expectation: derivation is
//     predecessor-specific); KDF MATCH still asserted;
//   - --resume is PURELY read-only (v1 resumes deploy on code mismatch).
// Key custody: v2 key in secrets/v2.omnibounty.testnet.json (gitignored).
// No private key is ever printed (public keys only).
//
// Usage:
//   node tools/deploy_production_v2.mjs           # fresh deploy
//   node tools/deploy_production_v2.mjs --resume  # verify only, never deploys
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const nearApi = require("../frontend/node_modules/near-api-js");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RPC_URL = "https://rpc.testnet.near.org";
const MPC_ACCOUNT = "v1.signer-prod.testnet";
const VOUCHER_PATH = "omnibounty-voucher-v1";
const CONTRACT_ID = "v2.omnibounty.testnet";
const PARENT_ID = "omnibounty.testnet";
const GAS = "300000000000000";
const EXPECT_WITNESS = "0x244897572368eadf65bfbc5aec98d8e5443a9072";
const ESCROW_REAL = "0xee5C8F3154fed8B9B2f5D820AC687fDfa8CF2C99";
const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const SUBACCOUNT_NEAR_YOCTO = "4000000000000000000000000"; // 4 NEAR
const EXPECT_WASM_SHA = (process.env.EXPECT_WASM_SHA || "").toLowerCase();

const step = (n, msg) => console.log(`\n[step ${n}] ${msg}`);
const ok = (msg) => console.log(`  ok: ${msg}`);
function assert(cond, msg) {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
}
const txHashes = {};

async function rpc(params) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "query", params }),
  });
  return res.json();
}

async function call(account, contractId, method, args) {
  const out = await account.functionCall({
    contractId,
    methodName: method,
    args,
    gas: GAS,
    attachedDeposit: "0",
  });
  txHashes[method] = out.transaction.hash;
  return out;
}

const keystore = new nearApi.keyStores.InMemoryKeyStore();
const near = await nearApi.connect({
  networkId: "testnet",
  keyStore: keystore,
  nodeUrl: RPC_URL,
});

const RESUME = process.argv.includes("--resume");
const v2SecretPath = join(ROOT, "secrets/v2.omnibounty.testnet.json");
let owner;
if (RESUME) {
  step(1, "resuming with the saved v2 key (verify only, never deploys)");
  const saved = JSON.parse(readFileSync(v2SecretPath, "utf8"));
  assert(saved.account_id === CONTRACT_ID, "saved key is for another account");
  await keystore.setKey("testnet", CONTRACT_ID, nearApi.KeyPair.fromString(saved.private_key));
  owner = await near.account(CONTRACT_ID);
  ok(`loaded key for ${CONTRACT_ID} (public ${saved.public_key})`);
} else {
  step(1, "creating v2.omnibounty.testnet (owner-signed subaccount)");
  const acct = await rpc({ request_type: "view_account", finality: "final", account_id: CONTRACT_ID });
  assert(
    acct.error && /UNKNOWN_ACCOUNT|does not exist/i.test(JSON.stringify(acct.error)),
    `refusing: ${CONTRACT_ID} already exists (${JSON.stringify(acct).slice(0, 200)})`
  );
  ok("name is unclaimed");
  const parentSaved = JSON.parse(readFileSync(join(ROOT, "secrets/omnibounty.testnet.json"), "utf8"));
  assert(parentSaved.account_id === PARENT_ID, "parent key is for another account");
  await keystore.setKey("testnet", PARENT_ID, nearApi.KeyPair.fromString(parentSaved.private_key));
  const parent = await near.account(PARENT_ID);
  const kp = nearApi.KeyPair.fromRandom("ed25519");
  const created = await parent.createAccount(CONTRACT_ID, kp.getPublicKey(), SUBACCOUNT_NEAR_YOCTO);
  txHashes.create = created.transaction.hash;
  ok(`subaccount created, tx=${created.transaction.hash}`);
  mkdirSync(join(ROOT, "secrets"), { recursive: true });
  writeFileSync(
    v2SecretPath,
    JSON.stringify(
      {
        _warning: "TESTNET v2 deploy key. Back up offline; owns v2.omnibounty.testnet.",
        account_id: CONTRACT_ID,
        public_key: kp.getPublicKey().toString(),
        private_key: kp.toString(),
      },
      null,
      2
    ) + "\n"
  );
  console.log(`  KEY SAVED (gitignored): ${v2SecretPath}`);
  console.log(`  public: ${kp.getPublicKey().toString()} (private key never printed)`);
  const createdAcct = await rpc({ request_type: "view_account", finality: "final", account_id: CONTRACT_ID });
  assert(
    createdAcct.result && createdAcct.result.amount === SUBACCOUNT_NEAR_YOCTO,
    `funding mismatch: ${JSON.stringify(createdAcct).slice(0, 200)}`
  );
  ok("subaccount funded with exactly 4 NEAR");
  await keystore.setKey("testnet", CONTRACT_ID, kp);
  owner = await near.account(CONTRACT_ID);
}

step(2, RESUME ? "verifying the deployed bytes" : "deploying the cargo-near artifact");
const wasmPath = join(ROOT, "contracts/near/target/near/omnibounty.wasm");
const wasm = readFileSync(wasmPath);
const wasmHash = createHash("sha256").update(wasm).digest("hex");
console.log(`  bytes=${wasm.length} sha256=${wasmHash}`);
if (EXPECT_WASM_SHA) {
  assert(wasmHash === EXPECT_WASM_SHA, `stale bytes: ${wasmHash} != expected ${EXPECT_WASM_SHA}`);
  ok("artifact matches the expected build hash");
}
if (RESUME) {
  const codeBody = await rpc({ request_type: "view_code", finality: "final", account_id: CONTRACT_ID });
  const onChain = Buffer.from(codeBody.result.code_base64, "base64");
  const onChainHash = createHash("sha256").update(onChain).digest("hex");
  assert(onChainHash === wasmHash, `on-chain code ${onChainHash} != local ${wasmHash} (refusing to deploy; investigate)`);
  ok(`on-chain code matches (${onChain.length} bytes)`);
} else {
  const deployOut = await owner.deployContract(wasm);
  txHashes.deploy = deployOut.transaction.hash;
  ok(`deployed, tx=${deployOut.transaction.hash}`);
}

step(3, "deriving + asserting the voucher signer");
const deriveRaw = execFileSync("node", [join(ROOT, "tools/mpc_derive.mjs"), CONTRACT_ID, VOUCHER_PATH], {
  encoding: "utf8",
});
const derived = JSON.parse(deriveRaw);
assert(derived.kdfCheck === "MATCH", `KDF mismatch: ${deriveRaw}`);
ok(`mpcSigner=${derived.voucherAddress} (fresh derivation for ${CONTRACT_ID})`);

step(4, RESUME ? "verifying config (no re-configure)" : "configuring (new/signer/epoch/freshness)");
if (!RESUME) {
  await call(owner, CONTRACT_ID, "new", {
    owner: CONTRACT_ID,
    mpc_contract: MPC_ACCOUNT,
    escrow: ESCROW_REAL,
    chain_id: 84532,
  });
  await call(owner, CONTRACT_ID, "upsert_epoch", { epoch_id: 1, witnesses: [EXPECT_WITNESS] });
  await call(owner, CONTRACT_ID, "set_mpc_signer", { signer: derived.voucherAddress });
  await call(owner, CONTRACT_ID, "set_freshness", {
    max_proof_age_sec: 7 * 24 * 3600,
    future_skew_sec: 5 * 60,
    voucher_ttl_sec: 24 * 3600,
  });
}
const cfg = await owner.viewFunction({ contractId: CONTRACT_ID, methodName: "get_config", args: {} });
assert(cfg.owner === CONTRACT_ID, `owner=${cfg.owner}`);
assert(String(cfg.mpc_signer).toLowerCase() === derived.voucherAddress.toLowerCase(), "signer mismatch");
assert(String(cfg.escrow).toLowerCase() === ESCROW_REAL.toLowerCase(), `escrow=${cfg.escrow}`);
assert(cfg.domain_id === 0, "domain");
assert(cfg.max_proof_age_sec === 7 * 24 * 3600, "freshness");
const epoch = await owner.viewFunction({ contractId: CONTRACT_ID, methodName: "get_epoch", args: { epoch_id: 1 } });
assert(
  epoch && epoch.witnesses && epoch.witnesses.map((w) => String(w).toLowerCase()).includes(EXPECT_WITNESS),
  `epoch witnesses: ${JSON.stringify(epoch)}`
);
ok("config verified on-chain");

step(5, "validation bounty + NEGATIVE dry_run (guards must fail closed)");
if (!RESUME) {
  await call(owner, CONTRACT_ID, "create_bounty", {
    bounty_id: 1,
    repo: "react/react",
    pr_number: 1,
    token: USDC_SEPOLIA,
    amount: "1000000",
    expiry: 0,
  });
}
const bounty = await owner.viewFunction({ contractId: CONTRACT_ID, methodName: "get_bounty", args: { bounty_id: 1 } });
assert(bounty.status === "open", `status=${bounty.status}`);
assert(bounty.sponsor === CONTRACT_ID, `sponsor=${bounty.sponsor}`);
assert(bounty.repo === "react/react" && bounty.pr_number === 1, "binding");
ok("bounty #1 open (react/react#1, $1 USDC terms)");
const reclaim = JSON.parse(readFileSync(join(ROOT, "testdata/reclaim.json"), "utf8"));
const spike = reclaim.spike;
const proof = {
  claimInfo: spike.claimInfo,
  signedClaim: {
    claim: {
      identifier: spike.claim.identifier,
      owner: spike.claim.owner,
      epoch: spike.claim.epoch,
      timestampS: spike.claim.timestampS,
    },
    signatures: spike.signatures,
  },
};
let dryErr = "";
try {
  const dry = await owner.viewFunction({
    contractId: CONTRACT_ID,
    methodName: "dry_run",
    args: { bounty_id: 1, proof, recipient: spike.claim.owner },
  });
  dryErr = `UNEXPECTED SUCCESS: ${JSON.stringify(dry).slice(0, 200)}`;
} catch (e) {
  dryErr = String((e && e.message) || e);
}
const CLOSED = ["PREDICATE_FAILED", "TEMPLATE_MISMATCH", "PROOF_TOO_OLD"];
assert(CLOSED.some((c) => dryErr.includes(c)), `negative dry_run must fail closed, got: ${dryErr.slice(0, 300)}`);
const dry = CLOSED.find((c) => dryErr.includes(c));
ok(`dry_run failed closed as required: ${dry}`);

step(6, "writing the public deployment record");
const recordPath = join(ROOT, "testdata/production_testnet.json");
let priorHashes = {};
if (RESUME && existsSync(recordPath)) {
  try {
    priorHashes = JSON.parse(readFileSync(recordPath, "utf8")).txHashes || {};
  } catch {
    priorHashes = {};
  }
}
const record = {
  _comment: "OmniBounty testnet deployment record (no secrets). Key in secrets/v2.omnibounty.testnet.json (gitignored).",
  network: "testnet",
  contract: CONTRACT_ID,
  wasm: {
    path: "contracts/near/target/near/omnibounty.wasm",
    bytes: wasm.length,
    sha256: "0x" + wasmHash,
    abi: "contracts/near/target/near/omnibounty_abi.json",
  },
  mpcContract: MPC_ACCOUNT,
  mpcVersion: "3.18.0",
  mpcSigner: derived.voucherAddress,
  derivedKey: derived.derivedKey,
  escrow: ESCROW_REAL,
  escrowNote: "Real Base Sepolia escrow, wired at deploy time.",
  chainId: 84532,
  epoch1Witnesses: [EXPECT_WITNESS],
  witnessNote: "Confirmed from deployed reclaim-protocol.testnet get_epoch_by_id(1) via tools/confirm_witnesses.py.",
  txHashes: RESUME ? priorHashes : txHashes,
  resumed: RESUME === true,
  resumeNote: RESUME ? "Re-verification run: no new transactions." : null,
  validationBounty: 1,
  negativeDryRun: dry,
  supersedes: {
    contract: PARENT_ID,
    record: "testdata/production_testnet.legacy.json",
    reason: "v1 retired (bounty #3 wedged pre-fix); v1 state preserved untouched for recovery.",
  },
};
writeFileSync(recordPath, JSON.stringify(record, null, 2) + "\n");
ok(`wrote ${recordPath}`);

console.log("\nPRODUCTION V2 TESTNET DEPLOYMENT COMPLETE");
console.log(`contract=${CONTRACT_ID}`);
console.log(`wasm sha256=${wasmHash}`);
if (txHashes.create) console.log(`create tx=${txHashes.create}`);
if (txHashes.deploy) console.log(`deploy tx=${txHashes.deploy}`);
