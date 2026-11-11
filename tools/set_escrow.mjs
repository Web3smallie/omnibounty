// OmniBounty NEAR escrow wiring (real transaction unless --check-only).
//
// Sets the Base Sepolia escrow address on the NEAR contract via the
// owner-authorized `set_escrow`, then re-reads `get_config` to prove the
// wiring. Previously-signed placeholder-bound vouchers (e.g. the
// testdata/live_voucher.json vector) can never settle on the new escrow —
// that is expected cross-address replay protection, not a regression.
//
// Signer: the owner key in secrets/v2.omnibounty.testnet.json (gitignored).
// The key is NEVER printed. --check-only needs no key (read-only views).
//
// Usage:
//   node tools/set_escrow.mjs 0x... [--check-only]
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const nearApi = require("../frontend/node_modules/near-api-js");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RPC_URL = process.env.NEAR_RPC_URL || "https://rpc.testnet.near.org";
const CONTRACT_ID = process.env.NEAR_CONTRACT_ID || "v2.omnibounty.testnet";
const PLACEHOLDER = "0x1111111111111111111111111111111111111111";
const GAS = "300000000000000";

const CHECK_ONLY = process.argv.includes("--check-only");
const target = process.argv[2];

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}
if (!target || target.startsWith("--")) fail("usage: node tools/set_escrow.mjs 0x... [--check-only]");
if (!/^0x[0-9a-fA-F]{40}$/.test(target)) fail(`not an EVM address: ${target}`);
if (target.toLowerCase() === PLACEHOLDER) fail("refusing to wire the placeholder address");
if (/^0x0+$/.test(target)) fail("refusing to wire the zero address");

const keystore = new nearApi.keyStores.InMemoryKeyStore();
const near = await nearApi.connect({ networkId: "testnet", keyStore: keystore, nodeUrl: RPC_URL });

async function viewConfig(account) {
  return account.viewFunction({ contractId: CONTRACT_ID, methodName: "get_config", args: {} });
}

if (CHECK_ONLY) {
  // Read-only: no key required. Uses an anonymous account handle for views.
  const anon = await near.account(CONTRACT_ID);
  const cfg = await viewConfig(anon);
  console.log(`current escrow: ${cfg.escrow}`);
  console.log(`target escrow:  ${target}`);
  console.log(`mpc_signer:     ${cfg.mpc_signer}`);
  console.log("CHECK-ONLY COMPLETE: no transaction sent.");
  process.exit(0);
}

const secretPath = join(ROOT, "secrets/v2.omnibounty.testnet.json");
let saved;
try {
  saved = JSON.parse(readFileSync(secretPath, "utf8"));
} catch {
  fail(`cannot read owner key ${secretPath}`);
}
if (saved.account_id !== CONTRACT_ID) fail("saved key is for another account");
const kp = nearApi.KeyPair.fromString(saved.private_key);
await keystore.setKey("testnet", CONTRACT_ID, kp);
const owner = await near.account(CONTRACT_ID);

const before = await viewConfig(owner);
console.log(`current escrow: ${before.escrow}`);
if (String(before.escrow).toLowerCase() === target.toLowerCase()) {
  fail("already wired to this address (no-op refused)");
}
if (before.owner !== CONTRACT_ID) fail(`unexpected owner ${before.owner}`);

const out = await owner.functionCall({
  contractId: CONTRACT_ID,
  methodName: "set_escrow",
  args: { escrow: target },
  gas: GAS,
  attachedDeposit: "0",
});
console.log(`set_escrow tx=${out.transaction.hash}`);

const after = await viewConfig(owner);
if (String(after.escrow).toLowerCase() !== target.toLowerCase()) {
  fail(`wiring not reflected on-chain: ${after.escrow}`);
}
console.log(`wired escrow:   ${after.escrow}`);
console.log("\nESCROW WIRING COMPLETE");
console.log(`set_escrow tx=${out.transaction.hash}`);
