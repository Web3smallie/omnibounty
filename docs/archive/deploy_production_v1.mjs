// ARCHIVED — RETIRED V1 DEPLOY SCRIPT. DO NOT RUN.
// Deploys/configures the retired omnibounty.testnet (v1) and would
// OVERWRITE testdata/production_testnet.json (now the V2 record).
// Active path: node tools/deploy_production_v2.mjs [--resume]
// Preserved for historical reference only (moved from tools/ 2026-11-11).
//
// OmniBounty PRODUCTION testnet deployment (real transactions).
//
// Claims `omnibounty.testnet`, deploys the cargo-near artifact, and
// configures it with independently verified values:
//   - MPC signer from tools/mpc_derive.mjs (asserts KDF MATCH), expected
//     0xc83b76aef4db9a14fcd4abcceb99b0fc27ebb3cc for this account.
//   - Epoch-1 witness from the DEPLOYED reclaim-protocol.testnet
//     (tools/confirm_witnesses.py), expected
//     0x244897572368eadf65bfbc5aec98d8e5443a9072.
//   - Production freshness (7d / 5m / 24h TTL).
//   - Escrow placeholder 0x1111... (updated after the Base deployment).
//
// Then creates validation bounty #1 (react/react#1, $1 USDC terms) and
// runs a NEGATIVE dry_run with the real spike proof: it must fail closed
// (unmerged template or stale timestamp), proving the guards execute on
// the production bytes. No test claims are made against production.
//
// Key custody: the deploy key is written to secrets/omnibounty.testnet.json
// (gitignored) AND printed once. Back it up: it owns the contract.
// Public record (no secrets): testdata/production_testnet.json.
//
// Usage:
//   node tools/deploy_production.mjs           # fresh claim + deploy
//   node tools/deploy_production.mjs --resume  # reuse saved key, verify
//     config, rerun validation (safe: no re-deploy, no duplicate bounty)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const nearApi = require("../frontend/node_modules/near-api-js");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RPC_URL = "https://rpc.testnet.near.org";
const HELPER_URL = "https://helper.testnet.near.org";
const MPC_ACCOUNT = "v1.signer-prod.testnet";
const VOUCHER_PATH = "omnibounty-voucher-v1";
const CONTRACT_ID = "omnibounty.testnet";
const GAS = "300000000000000";
const EXPECT_MPC_SIGNER = "0xc83b76aef4db9a14fcd4abcceb99b0fc27ebb3cc";
const EXPECT_WITNESS = "0x244897572368eadf65bfbc5aec98d8e5443a9072";
const ESCROW_PLACEHOLDER = "0x1111111111111111111111111111111111111111";
const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

const step = (n, msg) => console.log(`\n[step ${n}] ${msg}`);
const ok = (msg) => console.log(`  ok: ${msg}`);
function assert(cond, msg) {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const txHashes = {};

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
const secretPath = join(ROOT, "secrets/omnibounty.testnet.json");
let owner;
if (RESUME) {
  step(1, "resuming with the saved deploy key (no re-claim, no re-deploy)");
  const saved = JSON.parse(readFileSync(secretPath, "utf8"));
  assert(saved.account_id === CONTRACT_ID, "saved key is for another account");
  const kp = nearApi.KeyPair.fromString(saved.private_key);
  await keystore.setKey("testnet", CONTRACT_ID, kp);
  owner = await near.account(CONTRACT_ID);
  ok(`loaded key for ${CONTRACT_ID} (public ${saved.public_key})`);
} else {
  step(1, "claiming omnibounty.testnet via the helper");
  const kp = nearApi.KeyPair.fromRandom("ed25519");
  let res = null;
  for (let attempt = 1; attempt <= 30; attempt++) {
    res = await fetch(`${HELPER_URL}/account`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        newAccountId: CONTRACT_ID,
        newAccountPublicKey: kp.getPublicKey().toString(),
      }),
    });
    if (res.status !== 429) break;
    console.log(`  helper 429, backing off (attempt ${attempt}/30)...`);
    await sleep(60000);
  }
  assert(res.ok, `helper failed: HTTP ${res.status}`);
  const body = await res.json();
  const status = body?.receipts_outcome?.[0]?.outcome?.status;
  assert(
    status && "SuccessValue" in status,
    `helper receipt failed (name may be taken): ${JSON.stringify(status).slice(0, 300)}`
  );
  await keystore.setKey("testnet", CONTRACT_ID, kp);
  owner = await near.account(CONTRACT_ID);
  ok(`claimed ${CONTRACT_ID}`);

  // Key custody: gitignored file + one console print. Back it up.
  mkdirSync(join(ROOT, "secrets"), { recursive: true });
  writeFileSync(
    secretPath,
    JSON.stringify(
      {
        _warning: "TESTNET deploy key. Back up offline; owns omnibounty.testnet.",
        account_id: CONTRACT_ID,
        public_key: kp.getPublicKey().toString(),
        private_key: kp.toString(),
      },
      null,
      2
    ) + "\n"
  );
  console.log(`  KEY SAVED (gitignored): ${secretPath}`);
  console.log(`  public: ${kp.getPublicKey().toString()}`);
  console.log(`  BACK UP THE PRIVATE KEY NOW; it is printed only here and in that file.`);
  console.log(`  private: ${kp.toString()}`);
}

step(2, RESUME ? "verifying the deployed bytes" : "deploying the cargo-near artifact");
const wasmPath = join(ROOT, "contracts/near/target/near/omnibounty.wasm");
const wasm = readFileSync(wasmPath);
const wasmHash = createHash("sha256").update(wasm).digest("hex");
console.log(`  bytes=${wasm.length} sha256=${wasmHash}`);
if (RESUME) {
  // Confirm the on-chain code is exactly these bytes (no re-deploy).
  const codeRes = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "1",
      method: "query",
      params: {
        request_type: "view_code",
        finality: "final",
        account_id: CONTRACT_ID,
      },
    }),
  });
  const codeBody = await codeRes.json();
  const onChain = Buffer.from(codeBody.result.code_base64, "base64");
  const onChainHash = createHash("sha256").update(onChain).digest("hex");
  assert(
    onChainHash === wasmHash,
    `on-chain code ${onChainHash} != local ${wasmHash}`
  );
  ok(`on-chain code matches (${onChain.length} bytes)`);
} else {
  const deployOut = await owner.deployContract(wasm);
  txHashes.deploy = deployOut.transaction.hash;
  ok(`deployed, tx=${deployOut.transaction.hash}`);
}

step(3, "deriving + asserting the voucher signer");
const deriveRaw = execFileSync(
  "node",
  [join(ROOT, "tools/mpc_derive.mjs"), CONTRACT_ID, VOUCHER_PATH],
  { encoding: "utf8" }
);
const derived = JSON.parse(deriveRaw);
assert(derived.kdfCheck === "MATCH", `KDF mismatch: ${deriveRaw}`);
assert(
  derived.voucherAddress.toLowerCase() === EXPECT_MPC_SIGNER,
  `signer drift: ${derived.voucherAddress} != ${EXPECT_MPC_SIGNER}`
);
ok(`mpcSigner=${derived.voucherAddress} (as expected)`);

step(4, RESUME ? "verifying config (no re-configure)" : "configuring (new/signer/epoch/freshness)");
if (!RESUME) {
  await call(owner, CONTRACT_ID, "new", {
    owner: CONTRACT_ID,
    mpc_contract: MPC_ACCOUNT,
    escrow: ESCROW_PLACEHOLDER,
    chain_id: 84532,
  });
  // Witness expected from tools/confirm_witnesses.py (live contract state).
  await call(owner, CONTRACT_ID, "upsert_epoch", {
    epoch_id: 1,
    witnesses: [EXPECT_WITNESS],
  });
  await call(owner, CONTRACT_ID, "set_mpc_signer", {
    signer: derived.voucherAddress,
  });
  await call(owner, CONTRACT_ID, "set_freshness", {
    max_proof_age_sec: 7 * 24 * 3600,
    future_skew_sec: 5 * 60,
    voucher_ttl_sec: 24 * 3600,
  });
}
const cfg = await owner.viewFunction({
  contractId: CONTRACT_ID,
  methodName: "get_config",
  args: {},
});
assert(cfg.owner === CONTRACT_ID, `owner=${cfg.owner}`);
assert(
  String(cfg.mpc_signer).toLowerCase() === derived.voucherAddress.toLowerCase(),
  "signer mismatch"
);
assert(String(cfg.escrow).toLowerCase() === ESCROW_PLACEHOLDER, "escrow");
assert(cfg.domain_id === 0, "domain");
assert(cfg.max_proof_age_sec === 7 * 24 * 3600, "freshness");
const epoch = await owner.viewFunction({
  contractId: CONTRACT_ID,
  methodName: "get_epoch",
  args: { epoch_id: 1 },
});
assert(
  epoch &&
    epoch.witnesses &&
    epoch.witnesses.map((w) => String(w).toLowerCase()).includes(EXPECT_WITNESS),
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
const bounty = await owner.viewFunction({
  contractId: CONTRACT_ID,
  methodName: "get_bounty",
  args: { bounty_id: 1 },
});
assert(bounty.status === "open", `status=${bounty.status}`);
assert(bounty.sponsor === CONTRACT_ID, `sponsor=${bounty.sponsor}`);
assert(bounty.repo === "react/react" && bounty.pr_number === 1, "binding");
ok("bounty #1 open (react/react#1, $1 USDC terms)");
// Real spike proof (epoch 1, real witness signature, unmerged template).
const reclaim = JSON.parse(
  readFileSync(join(ROOT, "testdata/reclaim.json"), "utf8")
);
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
// dry_run PANICS on failure by design (like claim would); a closed
// failure surfaces as a view error carrying the stable error code.
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
assert(
  CLOSED.some((c) => dryErr.includes(c)),
  `negative dry_run must fail closed, got: ${dryErr.slice(0, 300)}`
);
const dry = CLOSED.find((c) => dryErr.includes(c));
ok(`dry_run failed closed as required: ${dry}`);

step(6, "writing the public deployment record");
const record = {
  _comment:
    "OmniBounty testnet deployment record (no secrets). Key in secrets/omnibounty.testnet.json (gitignored).",
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
  escrow: ESCROW_PLACEHOLDER,
  escrowNote: "Placeholder until the Base Sepolia escrow deploys; owner-updatable via set_escrow.",
  chainId: 84532,
  epoch1Witnesses: [EXPECT_WITNESS],
  witnessNote:
    "Confirmed from deployed reclaim-protocol.testnet get_epoch_by_id(1) via tools/confirm_witnesses.py.",
  txHashes,
  resumed: RESUME === true,
  resumeNote: RESUME
    ? "Re-verification run: no new transactions; setup txs from the initial run."
    : null,
  validationBounty: 1,
  negativeDryRun: dry,
};
const recordPath = join(ROOT, "testdata/production_testnet.json");
writeFileSync(recordPath, JSON.stringify(record, null, 2) + "\n");
ok(`wrote ${recordPath}`);

console.log("\nPRODUCTION TESTNET DEPLOYMENT COMPLETE");
console.log(`contract=${CONTRACT_ID}`);
console.log(`wasm sha256=${wasmHash}`);
if (txHashes.deploy) console.log(`deploy tx=${txHashes.deploy}`);
