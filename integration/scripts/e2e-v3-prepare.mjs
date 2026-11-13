// e2e prepare: deploy MockUSDC + OmniEscrowV2 on a fresh in-process chain
// and print the E2E_* env exports for fixture regen. Run from integration/:
//   npm run e2e:prepare
import hre from "hardhat";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deploySuite, DUMMY_SIGNER } from "./e2e-v3-lib.mjs";

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const { token, escrow } = await deploySuite(deployer, DUMMY_SIGNER);
  const { chainId } = await hre.ethers.provider.getNetwork();
  // Machine-readable copy for CI (humans use the printed exports below).
  const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "out");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "e2e-env.json"),
    JSON.stringify({ token, escrow, chainId: chainId.toString() }, null, 2)
  );
  console.log(`# mock USDC deployed at ${token}`);
  console.log(`# escrow deployed at ${escrow} (dummy signer; real signer comes from regen)`);
  console.log("");
  console.log("# PowerShell (run from contracts/near-v3):");
  console.log(
    `$env:E2E_ESCROW_ADDRESS='${escrow}'; $env:E2E_TOKEN_ADDRESS='${token}'; $env:E2E_CHAIN_ID='${chainId}'; cargo test regen_e2e_fixture -- --ignored --nocapture`
  );
  console.log("");
  console.log("# bash (run from contracts/near-v3):");
  console.log(
    `E2E_ESCROW_ADDRESS=${escrow} E2E_TOKEN_ADDRESS=${token} E2E_CHAIN_ID=${chainId} cargo test regen_e2e_fixture -- --ignored --nocapture`
  );
}

try {
  await main();
  // Windows libuv teardown assertion workaround: flush, then exit
  // explicitly instead of letting the event loop drain Hardhat handles.
  await new Promise((r) => setTimeout(r, 100));
  process.exit(0);
} catch (e) {
  console.error(e);
  process.exit(1);
}
