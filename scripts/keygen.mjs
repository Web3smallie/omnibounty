// Disposable testnet identity generator (no network, no funds moved).
//
// Creates TWO throwaway identities for terminal E2E runs and stores them
// in gitignored secrets/ (0600), refusing to overwrite existing files:
//   secrets/agent-near.json  {"account_id","public_key","private_key"} (ed25519)
//   secrets/agent-evm.json   {"address","private_key"} (secp256k1)
//
// The NEAR key is printed with its IMPLICIT account id (64 hex chars from
// the public key): usable as a recipient immediately, but it must be FUNDED
// (or its key added to a funded named account) before it can sign.
// The EVM address needs Base Sepolia ETH (gas) and, for sponsoring, testnet
// USDC. Funding is a MANUAL operator step; this script only prints what
// each identity needs. Nothing here touches existing funded identities.
//
// Usage: node scripts/keygen.mjs [--force]   (--force regenerates; default refuses)
import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SECRETS = join(ROOT, "secrets");
const NEAR_PATH = join(SECRETS, "agent-near.json");
const EVM_PATH = join(SECRETS, "agent-evm.json");
const force = process.argv.includes("--force");

let nearApi;
let ethersLib;
try {
  const require = createRequire(import.meta.url);
  nearApi = require("../frontend/node_modules/near-api-js");
  ethersLib = require("../frontend/node_modules/ethers");
} catch {
  console.error("missing frontend dependencies: run `npm ci` in frontend/ first (scripts/setup.sh does this).");
  process.exit(2);
}

mkdirSync(SECRETS, { recursive: true });
for (const p of [NEAR_PATH, EVM_PATH]) {
  if (existsSync(p) && !force) {
    console.error(`refusing to overwrite ${p} (pass --force to regenerate both files)`);
    process.exit(2);
  }
}

// NEAR ed25519 keypair; implicit account id = hex of the 32 public-key bytes.
const kp = nearApi.KeyPair.fromRandom("ed25519");
const pubBytes = Buffer.from(kp.getPublicKey().data);
const implicitAccountId = pubBytes.toString("hex");
const nearDoc = {
  _comment: "DISPOSABLE testnet identity - never fund with real assets, never reuse elsewhere.",
  account_id: implicitAccountId,
  public_key: kp.getPublicKey().toString(),
  private_key: kp.toString(),
};
// EVM secp256k1 wallet.
const wallet = ethersLib.ethers.Wallet.createRandom();
const evmDoc = {
  _comment: "DISPOSABLE testnet identity - never fund with real assets, never reuse elsewhere.",
  address: wallet.address,
  private_key: wallet.privateKey,
};
writeFileSync(NEAR_PATH, JSON.stringify(nearDoc, null, 2) + "\n", { mode: 0o600 });
chmodSync(NEAR_PATH, 0o600);
writeFileSync(EVM_PATH, JSON.stringify(evmDoc, null, 2) + "\n", { mode: 0o600 });
chmodSync(EVM_PATH, 0o600);

console.log(`wrote ${NEAR_PATH} (0600)`);
console.log(`wrote ${EVM_PATH} (0600)`);
console.log("");
console.log(`NEAR implicit account: ${implicitAccountId}`);
console.log(`EVM address:           ${wallet.address}`);
console.log("");
console.log("FUNDING (manual - nothing is automatic):");
console.log("- NEAR: fund the implicit account above from any funded testnet account");
console.log("  (or add this public key to a named testnet account you control).");
console.log("  Needed for: create_bounty (0.05 NEAR + gas), qualify_claim (1 NEAR +");
console.log("  gas), finalize_claim (0.1 NEAR + gas), mark_funded (gas only).");
console.log("- EVM: fund the address with Base Sepolia ETH for gas; sponsoring also");
console.log("  needs testnet USDC (Circle testnet faucet or a funded peer).");
console.log("Point scripts at these files with NEAR_KEY_FILE=secrets/agent-near.json");
console.log("and RELAYER_PRIVATE_KEY=<the printed EVM key via env, never a file arg>.");
