// OmniBounty FUNDED e2e claim on v2 (real USDC terms, real MPC).
//
// Creates bounty #2, dry-runs, claims with the retrieved real proof
// (react/react#38132, witness 0x2448), polls for voucher_signed, and
// verifies voucher + nullifier. Moves NO funds itself: USDC moves only
// when the relayer later settles on Base (separate step).
// Key: v2 owner (create + claim gas). Proof: .link-temp/proof3.json
// (argv override possible). Evidence: .link-temp/funded_claim.json.
//
// Usage:
//   node tools/funded_claim_v2.mjs [proofPath]
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const nearApi = require("../frontend/node_modules/near-api-js");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RPC_URL = "https://rpc.testnet.near.org";
const CONTRACT_ID = "v2.omnibounty.testnet";
const GAS = "300000000000000";
const BID = 2;
const BINDING = { repo: "react/react", prNumber: 38132 };
const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const AMOUNT = "1000000";

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
  const out = await account.functionCall({ contractId, methodName: method, args, gas: GAS, attachedDeposit: "0" });
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
const near = await nearApi.connect({ networkId: "testnet", keyStore: keystore, nodeUrl: RPC_URL });
const saved = JSON.parse(readFileSync(join(ROOT, "secrets/v2.omnibounty.testnet.json"), "utf8"));
assert(saved.account_id === CONTRACT_ID, "saved key is for another account");
await keystore.setKey("testnet", CONTRACT_ID, nearApi.KeyPair.fromString(saved.private_key));
const owner = await near.account(CONTRACT_ID);

step(0, "pre-gates: bounty absent, identifier unused");
const preBounty = await owner.viewFunction({ contractId: CONTRACT_ID, methodName: "get_bounty", args: { bounty_id: BID } });
assert(preBounty === null, `bounty ${BID} already exists, refusing`);
const proofPath = process.argv[2] || join(ROOT, ".link-temp/proof3.json");
const raw = JSON.parse(readFileSync(proofPath, "utf8"));
const cd = raw.claimData;
const proof = {
  claimInfo: { provider: cd.provider, parameters: cd.parameters, context: cd.context },
  signedClaim: {
    claim: { identifier: cd.identifier, owner: cd.owner, epoch: cd.epoch, timestampS: cd.timestampS },
    signatures: raw.signatures,
  },
};
const recipient = cd.owner;
const ex = JSON.parse(cd.context).extractedParameters;
assert(ex.merged === "true", `merged=${JSON.stringify(ex.merged)}`);
assert(ex.repo === BINDING.repo && ex.number === String(BINDING.prNumber), `binding=${ex.repo}#${ex.number}`);
assert(ex.author, "missing author");
ok(`proof binds ${ex.repo}#${ex.number} by ${ex.author}, owner=${recipient}`);
const preUsed = await owner.viewFunction({
  contractId: CONTRACT_ID,
  methodName: "is_identifier_used",
  args: { identifier_hex: cd.identifier },
});
assert(preUsed === false, "identifier already nullified, refusing");
ok("pre-gates pass");

step(1, "creating funded bounty #2 on v2");
await call(owner, CONTRACT_ID, "create_bounty", {
  bounty_id: BID,
  repo: BINDING.repo,
  pr_number: BINDING.prNumber,
  token: USDC_SEPOLIA,
  amount: AMOUNT,
  expiry: 0,
});
ok(`create_bounty tx=${txHashes.create_bounty}`);

step(2, "dry_run must succeed (free safety check)");
const dry = await owner.viewFunction({
  contractId: CONTRACT_ID,
  methodName: "dry_run",
  args: { bounty_id: BID, proof, recipient },
});
assert(typeof dry === "string" && dry.startsWith("OK digest="), `dry_run failed: ${JSON.stringify(dry)}`);
const dryDigest = dry.split(/\s/).find((p) => p.startsWith("digest=")).replace("digest=", "");
ok(`dry_run digest=${dryDigest}`);

step(3, "claiming (real MPC signature)");
const claimOut = await call(owner, CONTRACT_ID, "claim", { bounty_id: BID, proof, recipient });
const logs = allLogs(claimOut).join("\n");
assert(logs.includes("claim_submitted"), `missing claim log:\n${logs}`);
ok(`claim tx=${claimOut.transaction.hash}`);

step(4, "polling for voucher_signed (up to 10 min)");
let voucher = null;
let bounty = null;
let attempts = 0;
for (; attempts < 40; attempts++) {
  await sleep(15000);
  bounty = await owner.viewFunction({ contractId: CONTRACT_ID, methodName: "get_bounty", args: { bounty_id: BID } });
  voucher = await owner.viewFunction({ contractId: CONTRACT_ID, methodName: "get_voucher", args: { bounty_id: BID } });
  if (bounty && bounty.status === "claimed" && voucher && voucher.voucher) break;
  if (attempts % 4 === 0) console.log(`  waiting... (${attempts * 15}s, status=${bounty && bounty.status})`);
}
assert(
  bounty && bounty.status === "claimed" && voucher && voucher.voucher,
  `MPC result not observed: status=${bounty && bounty.status} voucher=${!!voucher} after ${attempts * 15}s (re-check views; MPC may still complete async)`
);
ok(`voucher signed: v=${voucher.v} digest=${voucher.voucher.digest}`);

step(5, "verifying nullifier + writing evidence");
const used = await owner.viewFunction({
  contractId: CONTRACT_ID,
  methodName: "is_identifier_used",
  args: { identifier_hex: cd.identifier },
});
assert(used === true, "identifier must be nullified");
const evidence = {
  contract: CONTRACT_ID,
  bountyId: BID,
  proofIdentifier: cd.identifier,
  recipient,
  dryDigest,
  txHashes,
  voucher: voucher.voucher,
  v: voucher.v,
  r: voucher.r,
  s: voucher.s,
};
writeFileSync(join(ROOT, ".link-temp/funded_claim.json"), JSON.stringify(evidence, null, 2) + "\n");
ok("wrote .link-temp/funded_claim.json");

console.log("\nFUNDED CLAIM COMPLETE");
console.log(`claimTx=${txHashes.claim}`);
console.log(`digest=${voucher.voucher.digest}`);
