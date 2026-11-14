// V2 relayer runtime launcher (UNTRACKED, audit-backup only).
//
// Builds the relayer process environment from existing deployment values +
// the existing deployer key read at runtime from the repo-root .env.
// Contains NO secrets itself; never prints them.
//
// Usage (operator machine with direct internet):
//   NEAR_CONTRACT_ID=<deployed V3 NEAR account> node audit-backup-20261113/run-relayer-v2.mjs --once
//   NEAR_CONTRACT_ID=<deployed V3 NEAR account> node audit-backup-20261113/run-relayer-v2.mjs
// NEAR_CONTRACT_ID is REQUIRED in the environment (never defaulted: after a
// redeploy to a new account, export the new ID — no file change needed).
//
// VOUCHER_VERSION=2 is set here (relayer has no dotenv loader).
// FINALIZE_ENABLED=false: GitHub Actions scheduler owns finalization.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BACKUP = dirname(fileURLToPath(import.meta.url));
const ROOT = join(BACKUP, "..");

function readDotEnv(path) {
  const env = {};
  for (const ln of readFileSync(path, "utf8").split("\n")) {
    const l = ln.trim();
    if (!l || l.startsWith("#") || !l.includes("=")) continue;
    const i = l.indexOf("=");
    env[l.slice(0, i)] = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

const dot = readDotEnv(join(ROOT, ".env"));
const evmKey = dot.V3_DEPLOYER_PRIVATE_KEY;
if (!/^0x[0-9a-fA-F]{64}$/.test(evmKey || "")) {
  console.error("V3_DEPLOYER_PRIVATE_KEY missing or malformed in root .env (want 0x + 64 hex)");
  process.exit(2);
}

const contractId = process.env.NEAR_CONTRACT_ID;
if (!contractId || contractId.length === 0) {
  console.error("set NEAR_CONTRACT_ID in the environment (the deployed V3 NEAR account; not defaulted: it changes on redeploy)");
  process.exit(2);
}
const childEnv = {
  ...process.env,
  NEAR_RPC_URL: "https://rpc.testnet.near.org",
  NEAR_CONTRACT_ID: contractId,
  BASE_RPC_URL: "https://sepolia.base.org",
  ESCROW_ADDRESS: "0x63391c272A49c30f79eb6c3d8E10F0652Bb0F767",
  MPC_SIGNER_ADDRESS: "0x4b204ae1890a0cd49cc594fe712fea4ac765a2f9",
  RELAYER_PRIVATE_KEY: evmKey,
  VOUCHER_VERSION: "2",
  FINALIZE_ENABLED: "false",
  EXPECTED_CHAIN_ID: "84532",
  CONFIRMATIONS: "2",
  MAX_ATTEMPTS: "5",
  POLL_INTERVAL_MS: "30000",
};

const r = spawnSync("node", [join(ROOT, "relayer", "src", "index.mjs"), ...process.argv.slice(2)], {
  cwd: join(ROOT, "relayer"),
  env: childEnv,
  stdio: "inherit",
});
process.exit(r.status ?? 1);
