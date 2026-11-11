// OmniBounty LIVE testnet handshake (real MPC, real transactions).
//
// Runs the full claim lifecycle on NEAR testnet against the REAL
// v1.signer-prod.testnet:
//   1. Creates free helper-funded dev accounts (owner + contract).
//   2. Deploys the OmniBounty wasm.
//   3. Derives the voucher signer for THIS contract id via the verified
//      KDF tool (asserts KDF MATCH) and cross-checks it with a direct
//      `derived_public_key` RPC view.
//   4. Configures epoch/signer/freshness/bounty from testdata/e2e_claim.json.
//   5. dry_run -> claim -> asserts voucher_signed, digest equality,
//      identifier nullification, and cross-bounty replay rejection.
//   6. Exports testdata/live_voucher.json for the Foundry live-escrow test.
//
// Why Node and not the Rust workspaces suite? The Rust TLS stack is broken
// in THIS sandbox (cargo/reqwest/schannel all fail; see tools/preflight.py
// and docs), while Node/Python HTTPS works. The Rust suite
// (contracts/near/tests/cross_contract.rs) covers the same flow for
// sandbox (Linux/macOS CI) and can run testnet mode wherever Rust TLS
// works. This script is the live leg that runs HERE.
//
// Usage:
//   node tools/live_handshake.mjs
//
// Costs nothing (testnet faucet accounts). Writes only
// testdata/live_voucher.json. Exit nonzero on any assertion failure.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
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
const GAS = "300000000000000"; // 300 Tgas

const step = (n, msg) => console.log(`\n[step ${n}] ${msg}`);
const ok = (msg) => console.log(`  ok: ${msg}`);
function assert(cond, msg) {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
}

const fx = JSON.parse(
  readFileSync(join(ROOT, "testdata/e2e_claim.json"), "utf8")
);
const txHashes = {};

function randId(prefix) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const rand = Math.floor(Math.random() * 1e6).toString().padStart(6, "0");
  // MUST be a *.testnet subaccount: the helper (predecessor `testnet`)
  // cannot create bare top-level accounts (CreateAccountOnlyByRegistrar).
  return `${prefix}-${stamp}-${rand}.testnet`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function helperAccount(prefix, near, keystore) {
  const id = randId(prefix);
  const kp = nearApi.KeyPair.fromRandom("ed25519");
  // The helper rate-limits aggressively (429) with a long window;
  // back off patiently (up to ~30 min) rather than failing fast.
  let res = null;
  for (let attempt = 1; attempt <= 30; attempt++) {
    res = await fetch(`${HELPER_URL}/account`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        newAccountId: id,
        newAccountPublicKey: kp.getPublicKey().toString(),
      }),
    });
    if (res.status !== 429) break;
    console.log(`  helper 429, backing off (attempt ${attempt}/30)...`);
    await sleep(60000);
  }
  assert(res.ok, `helper account creation failed: HTTP ${res.status}`);
  // HTTP 200 is NOT success: the helper returns 200 with a failed receipt
  // when creation is rejected. Verify the receipt status.
  const body = await res.json();
  const status = body?.receipts_outcome?.[0]?.outcome?.status;
  assert(
    status && "SuccessValue" in status,
    `helper receipt failed: ${JSON.stringify(status).slice(0, 300)}`
  );
  await keystore.setKey("testnet", id, kp);
  return await near.account(id);
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

function allLogs(out) {
  const logs = [];
  for (const r of out.receipts_outcome || []) {
    for (const l of r.outcome.logs || []) logs.push(l);
  }
  return logs;
}

const keystore = new nearApi.keyStores.InMemoryKeyStore();
const near = await nearApi.connect({
  networkId: "testnet",
  keyStore: keystore,
  nodeUrl: RPC_URL,
});

step(1, "creating helper-funded dev accounts");
const owner = await helperAccount("ob-live-owner", near, keystore);
const contractAcct = await helperAccount("ob-live-ctr", near, keystore);
const contractId = contractAcct.accountId;
ok(`owner=${owner.accountId} contract=${contractId}`);

step(2, "deploying OmniBounty wasm");
const wasm = readFileSync(
  join(ROOT, "contracts/near/target/wasm32-unknown-unknown/release/omnibounty.wasm")
);
const deployOut = await contractAcct.deployContract(wasm);
txHashes.deploy = deployOut.transaction.hash;
ok(`deployed ${wasm.length} bytes, tx=${deployOut.transaction.hash}`);

step(3, "deriving the voucher signer for this contract id");
const deriveRaw = execFileSync(
  "node",
  [join(ROOT, "tools/mpc_derive.mjs"), contractId, VOUCHER_PATH],
  { encoding: "utf8" }
);
const derived = JSON.parse(deriveRaw);
assert(derived.kdfCheck === "MATCH", `KDF mismatch: ${deriveRaw}`);
const direct = await owner.viewFunction({
  contractId: MPC_ACCOUNT,
  methodName: "derived_public_key",
  args: { path: VOUCHER_PATH, predecessor: contractId, domain_id: null },
});
assert(direct === derived.derivedKey, "tool/RPC derived-key mismatch");
const mpcSigner = derived.voucherAddress;
ok(`derivedKey=${derived.derivedKey.slice(0, 24)}... address=${mpcSigner}`);

step(4, "configuring contract (new/epoch/signer/freshness/bounty)");
const bountyId = fx.config.bountyId;
// The bounty binding (repo/pr) comes from the proof context's extracted
// parameters, exactly as the on-chain template check reads them.
const extracted = JSON.parse(fx.proof.claimInfo.context).extractedParameters;
const params = {
  repository: extracted.repo,
  pullNumber: Number(extracted.number),
};
await call(owner, contractId, "new", {
  owner: owner.accountId,
  mpc_contract: MPC_ACCOUNT,
  escrow: fx.config.escrow,
  chain_id: fx.config.chainId,
});
await call(owner, contractId, "upsert_epoch", {
  epoch_id: 1,
  witnesses: [fx.witness],
});
await call(owner, contractId, "set_mpc_signer", { signer: mpcSigner });
await call(owner, contractId, "set_freshness", {
  max_proof_age_sec: 10 * 365 * 24 * 3600,
  future_skew_sec: 24 * 3600,
  voucher_ttl_sec: 24 * 3600,
});
await call(owner, contractId, "create_bounty", {
  bounty_id: bountyId,
  repo: params.repository,
  pr_number: params.pullNumber,
  token: fx.config.token,
  amount: fx.config.amount,
  expiry: 0,
});
ok(`bounty ${bountyId} open for ${params.repository}#${params.pullNumber}`);

step(5, "dry_run then live claim (real MPC signature)");
const recipient = fx.proof.signedClaim.claim.owner;
const dry = await owner.viewFunction({
  contractId: contractId,
  methodName: "dry_run",
  args: { bounty_id: bountyId, proof: fx.proof, recipient },
});
assert(
  typeof dry === "string" && dry.startsWith("OK digest="),
  `dry_run failed: ${JSON.stringify(dry)}`
);
const dryDigest = dry
  .split(/\s/)
  .find((p) => p.startsWith("digest="))
  .replace("digest=", "");
ok(`dry_run digest=${dryDigest}`);
const claimOut = await call(owner, contractId, "claim", {
  bounty_id: bountyId,
  proof: fx.proof,
  recipient,
});
const logs = allLogs(claimOut).join("\n");
assert(logs.includes("claim_submitted"), `missing claim log:\n${logs}`);
assert(logs.includes("voucher_signed"), `missing signed log:\n${logs}`);
ok(`claim tx=${claimOut.transaction.hash}`);

step(6, "verifying the signed voucher on-chain");
const voucher = await owner.viewFunction({
  contractId: contractId,
  methodName: "get_voucher",
  args: { bounty_id: bountyId },
});
const vv = voucher.voucher;
// NOTE: dry_run and claim run in different blocks, so the TTL-based expiry
// (and hence the digest) legitimately differs. What must match exactly:
// every other field. The digest itself is recomputed independently below.
const dryParts = Object.fromEntries(
  dry.split(/\s/).slice(1).map((p) => p.split("="))
);
assert(vv.bounty_id ?? vv.bountyId, "voucher has bounty id");
const vBid = vv.bounty_id !== undefined ? vv.bounty_id : vv.bountyId;
assert(vBid === bountyId, `bounty id ${vBid} != ${bountyId}`);
assert(
  String(vv.recipient).toLowerCase() === recipient.toLowerCase(),
  "recipient mismatch"
);
assert(
  String(vv.token).toLowerCase() === String(fx.config.token).toLowerCase(),
  "token mismatch"
);
assert(String(vv.amount) === String(fx.config.amount), "amount mismatch");
assert(String(vv.nonce) === String(dryParts.nonce), "nonce mismatch");
assert(
  String(vv.chain_id ?? vv.chainId) === String(fx.config.chainId),
  "chain id mismatch"
);
assert(
  String(vv.escrow).toLowerCase() === String(fx.config.escrow).toLowerCase(),
  "escrow mismatch"
);
assert(
  Math.abs(Number(vv.expiry) - Number(dryParts.expiry)) <= 900,
  `expiry drift too large: ${vv.expiry} vs dry ${dryParts.expiry}`
);
assert(voucher.v === 27 || voucher.v === 28, `bad v: ${voucher.v}`);
// Independent EIP-712 recomputation (ethers oracle) + ecrecover check.
const ethers = require("../frontend/node_modules/ethers");
const coder = ethers.AbiCoder.defaultAbiCoder();
const vth = ethers.keccak256(
  ethers.toUtf8Bytes(
    "Voucher(uint256 bountyId,address recipient,address token,uint256 amount,uint256 nonce,uint256 expiry,uint256 chainId,address escrow)"
  )
);
const dth = ethers.keccak256(
  ethers.toUtf8Bytes(
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
  )
);
const ds = ethers.keccak256(
  coder.encode(
    ["bytes32", "bytes32", "bytes32", "uint256", "address"],
    [
      dth,
      ethers.keccak256(ethers.toUtf8Bytes("OmniBounty")),
      ethers.keccak256(ethers.toUtf8Bytes("1")),
      vv.chain_id ?? vv.chainId,
      vv.escrow,
    ]
  )
);
const sh = ethers.keccak256(
  coder.encode(
    ["bytes32", "uint256", "address", "address", "uint256", "uint256", "uint256", "uint256", "address"],
    [vth, vBid, vv.recipient, vv.token, vv.amount, vv.nonce, vv.expiry, vv.chain_id ?? vv.chainId, vv.escrow]
  )
);
const recomputed = ethers.keccak256(ethers.concat(["0x1901", ds, sh]));
assert(
  recomputed.toLowerCase() === String(vv.digest).toLowerCase(),
  `digest mismatch: chain=${vv.digest} recomputed=${recomputed}`
);
const recovered = ethers.recoverAddress(vv.digest, {
  r: voucher.r,
  s: voucher.s,
  v: voucher.v,
});
assert(
  recovered.toLowerCase() === mpcSigner.toLowerCase(),
  `ecrecover ${recovered} != derived MPC signer ${mpcSigner}`
);
ok(`digest recomputed + ecrecover == ${mpcSigner}`);
ok(`voucher signed: v=${voucher.v} digest=${vv.digest}`);
const bounty = await owner.viewFunction({
  contractId: contractId,
  methodName: "get_bounty",
  args: { bounty_id: bountyId },
});
assert(bounty.status === "claimed", `status=${bounty.status}`);
const used = await owner.viewFunction({
  contractId: contractId,
  methodName: "is_identifier_used",
  args: { identifier_hex: fx.proof.signedClaim.claim.identifier },
});
assert(used === true, "identifier must be nullified");
ok(`bounty claimed + identifier nullified`);

step(7, "cross-bounty replay must fail with IDENTIFIER_REPLAY");
await call(owner, contractId, "create_bounty", {
  bounty_id: bountyId + 1000,
  repo: params.repository,
  pr_number: params.pullNumber,
  token: fx.config.token,
  amount: fx.config.amount,
  expiry: 0,
});
let replayErr = "";
try {
  await call(owner, contractId, "claim", {
    bounty_id: bountyId + 1000,
    proof: fx.proof,
    recipient,
  });
} catch (e) {
  replayErr = String((e && e.message) || e);
}
assert(
  replayErr.includes("IDENTIFIER_REPLAY"),
  `expected IDENTIFIER_REPLAY, got: ${replayErr.slice(0, 400)}`
);
ok("replay rejected");

step(8, "exporting the live vector for the Foundry escrow test");
const live = {
  _comment:
    "LIVE testnet vector: real MPC signature over a real voucher digest. Generated by tools/live_handshake.mjs; verified by contracts/base/test/LiveVoucher.t.sol.",
  network: "testnet",
  contract: contractId,
  owner: owner.accountId,
  mpcContract: MPC_ACCOUNT,
  mpcVersion: "3.18.0",
  mpcSigner,
  derivedKey: derived.derivedKey,
  txHashes,
  voucher: voucher.voucher,
  v: voucher.v,
  r: voucher.r,
  s: voucher.s,
};
const livePath = join(ROOT, "testdata/live_voucher.json");
writeFileSync(livePath, JSON.stringify(live, null, 2) + "\n");
ok(`wrote ${livePath}`);

console.log("\nLIVE HANDSHAKE COMPLETE");
console.log(`contract=${contractId}`);
console.log(`mpcSigner=${mpcSigner}`);
console.log(`digest=${vv.digest}`);
console.log(`claimTx=${txHashes.claim}`);
