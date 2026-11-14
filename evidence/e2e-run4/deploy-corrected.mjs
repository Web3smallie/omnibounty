// PREPARED redeploy: corrected V3 WASM -> EXISTING omnibounty-v3.testnet.
// NOT YET EXECUTED. Run only on explicit approval:
//   node audit-backup-20261113/deploy-corrected.mjs
//
// What it does:
//  1. Loads the operator key from root .env (NEAR_ACCOUNT_ID must be
//     omnibounty-v3.testnet; FullAccess required). Never prints secrets.
//  2. Asserts the artifact is exactly 766c6b14... (707605 bytes).
//  3. Submits ONE DeployContract transaction (code only; all trie state
//     preserved by protocol: bounties, claims, vouchers, nullifiers,
//     epochs, config, next_nonce).
//  4. Prints the tx hash; verification steps are in DEPLOY-READINESS.md.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire("/workspaces/omnibounty/tools/finalize.mjs");
const nearApi = require("../frontend/node_modules/near-api-js");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXPECT_SHA = "766c6b14accb4730b634a5d659a10ae804e3e1eb86c77fe1ba9a1fefc02a94d4";
const EXPECT_BYTES = 707605;
const CONTRACT = "omnibounty-v3.testnet";
const env = {};
for (const ln of readFileSync(join(ROOT, ".env"), "utf8").split("\n")) {
  const l = ln.trim();
  if (!l || l.startsWith("#") || !l.includes("=")) continue;
  const i = l.indexOf("=");
  env[l.slice(0, i)] = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}
if (env.NEAR_ACCOUNT_ID !== CONTRACT) throw new Error("operator key is not for " + CONTRACT);
const wasmPath = join(ROOT, "audit-backup-20261113/corrected/omnibounty_v3.fixed-f5b2539.wasm");
const wasm = readFileSync(wasmPath);
const sha = createHash("sha256").update(wasm).digest("hex");
if (sha !== EXPECT_SHA || wasm.length !== EXPECT_BYTES) {
  throw new Error(`artifact mismatch: ${sha} (${wasm.length} B)`);
}
console.log(`artifact OK: sha256=${sha} bytes=${wasm.length}`);
const keystore = new nearApi.keyStores.InMemoryKeyStore();
await keystore.setKey("testnet", CONTRACT, nearApi.KeyPair.fromString(env.NEAR_PRIVATE_KEY));
const near = await nearApi.connect({ networkId: "testnet", keyStore: keystore, nodeUrl: "https://rpc.testnet.near.org" });
const out = await (await near.account(CONTRACT)).deployContract(wasm);
console.log("deployed, tx=" + out.transaction.hash);
