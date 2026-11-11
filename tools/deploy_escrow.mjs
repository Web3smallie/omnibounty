// OmniBounty Base Sepolia escrow deployment (real transaction).
//
// Deploys OmniEscrow with the NEAR-MPC-derived voucher signer, verifies the
// on-chain configuration plus the EIP-712 domain separator, and writes the
// public record testdata/base_sepolia.json (no secrets).
//
// Immutable deployment: no proxy, per the Phase 5 upgradeability decision.
// The constructor signer is the KDF-verified address from
// tools/mpc_derive.mjs — never a placeholder.
//
// Prerequisites:
//   - `forge build` in contracts/base (provides the artifact below).
//   - BASE_RPC_URL: Base Sepolia RPC endpoint.
//   - DEPLOY_KEY: deployer private key (0x-prefixed, 32 bytes). Funded with
//     Sepolia ETH for gas. NEVER commit this value anywhere.
//   - MPC_SIGNER_ADDRESS (optional): expected signer; when set, the script
//     aborts unless the fresh KDF derivation equals it.
//
// Usage:
//   BASE_RPC_URL=... DEPLOY_KEY=0x... node tools/deploy_escrow.mjs [--check-only] [--force]
//
//   --check-only  run every gate + gas estimate, broadcast nothing.
//   --force       overwrite an existing testdata/base_sepolia.json record.
//
// The script REFUSES to deploy to any chain other than Base Sepolia (84532).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { ethers } = require("../relayer/node_modules/ethers");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXPECT_CHAIN_ID = 84532n;
const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const NEAR_CONTRACT = process.env.NEAR_CONTRACT_ID || "v2.omnibounty.testnet";
const VOUCHER_PATH = process.env.VOUCHER_PATH || "omnibounty-voucher-v1";
const RECORD_PATH = join(ROOT, "testdata/base_sepolia.json");
const ARTIFACT_PATH = join(ROOT, "contracts/base/out/OmniEscrow.sol/OmniEscrow.json");

const CHECK_ONLY = process.argv.includes("--check-only");
const FORCE = process.argv.includes("--force");

const step = (n, msg) => console.log(`\n[step ${n}] ${msg}`);
const ok = (msg) => console.log(`  ok: ${msg}`);
function fail(msg) {
  console.error(`  FAIL: ${msg}`);
  process.exit(1);
}

function requiredEnv(name) {
  const v = process.env[name];
  if (!v || v.length === 0) fail(`missing env ${name}`);
  return v;
}

// -- Step 1: inputs (fail fast, never log secrets) ---------------------------
step(1, "reading inputs");
const rpcUrl = requiredEnv("BASE_RPC_URL");
const deployKey = requiredEnv("DEPLOY_KEY");
if (!/^0x[0-9a-fA-F]{64}$/.test(deployKey)) fail("DEPLOY_KEY must be 0x-prefixed 32 bytes");
const expectSigner = process.env.MPC_SIGNER_ADDRESS || null;
if (expectSigner && !ethers.isAddress(expectSigner)) fail(`bad MPC_SIGNER_ADDRESS: ${expectSigner}`);
if (existsSync(RECORD_PATH) && !FORCE && !CHECK_ONLY) {
  fail(`${RECORD_PATH} already exists (refusing to overwrite; re-run with --force to replace)`);
}
let artifact;
try {
  artifact = JSON.parse(readFileSync(ARTIFACT_PATH, "utf8"));
} catch {
  fail(`missing artifact ${ARTIFACT_PATH} — run \`forge build\` in contracts/base first`);
}
if (!artifact.abi || !artifact.bytecode?.object) fail("artifact has no abi/bytecode");
ok("inputs present; artifact loaded");

// -- Step 2: chain + USDC gates ------------------------------------------------
step(2, "verifying target chain and USDC");
const provider = new ethers.JsonRpcProvider(rpcUrl);
const network = await provider.getNetwork().catch((e) => fail(`RPC unreachable: ${e.message}`));
if (network.chainId !== EXPECT_CHAIN_ID) {
  fail(`refusing to deploy: chain is ${network.chainId}, expected ${EXPECT_CHAIN_ID} (Base Sepolia)`);
}
ok(`chainId=${network.chainId} (Base Sepolia)`);
const usdcCode = await provider.getCode(USDC_SEPOLIA).catch((e) => fail(`getCode failed: ${e.message}`));
if (usdcCode === "0x") fail(`no contract code at USDC ${USDC_SEPOLIA}`);
ok(`USDC present at ${USDC_SEPOLIA} (${(usdcCode.length - 2) / 2} code bytes)`);

// -- Step 3: derive + assert the MPC signer ------------------------------------
step(3, "deriving + asserting the voucher signer");
const deriveRaw = execFileSync(
  "node",
  [join(ROOT, "tools/mpc_derive.mjs"), NEAR_CONTRACT, VOUCHER_PATH],
  { encoding: "utf8" }
);
let derived;
try {
  derived = JSON.parse(deriveRaw);
} catch {
  fail(`mpc_derive output unparseable: ${deriveRaw.slice(0, 200)}`);
}
if (derived.kdfCheck !== "MATCH") fail(`KDF mismatch: ${deriveRaw.slice(0, 200)}`);
if (expectSigner && derived.voucherAddress.toLowerCase() !== expectSigner.toLowerCase()) {
  fail(`signer drift: derived ${derived.voucherAddress} != expected ${expectSigner}`);
}
const signer = ethers.getAddress(derived.voucherAddress);
ok(`mpcSigner=${signer} (KDF MATCH)`);

// -- Step 4: deployer + gas estimate -------------------------------------------
step(4, "checking deployer and estimating gas");
const wallet = new ethers.Wallet(deployKey, provider);
const deployer = await wallet.getAddress();
const balance = await provider.getBalance(deployer);
console.log(`  deployer=${deployer} balance=${ethers.formatEther(balance)} ETH`);
const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode.object, wallet);
const deployTx = await factory.getDeployTransaction(signer);
let gasEstimate;
try {
  gasEstimate = await provider.estimateGas({ ...deployTx, from: deployer });
} catch (e) {
  fail(`gas estimation failed: ${e.message.slice(0, 300)}`);
}
ok(`deploy gas estimate=${gasEstimate}`);
if (CHECK_ONLY) {
  console.log("\nCHECK-ONLY COMPLETE: all gates passed, nothing broadcast.");
  process.exit(0);
}
if (balance === 0n) fail("deployer has no ETH for gas");

// -- Step 5: broadcast ----------------------------------------------------------
step(5, "broadcasting deployment");
const contract = await factory.deploy(signer).catch((e) => fail(`deploy broadcast failed: ${e.message.slice(0, 300)}`));
const deployTxHash = contract.deploymentTransaction().hash;
console.log(`  tx=${deployTxHash} (waiting for 2 confirmations...)`);
const receipt = await contract.deploymentTransaction().wait(2);
if (receipt.status !== 1) fail(`deploy tx reverted: ${deployTxHash}`);
const escrow = await contract.getAddress();
ok(`escrow=${escrow} block=${receipt.blockNumber}`);

// -- Step 6: on-chain verification ----------------------------------------------
step(6, "verifying deployed configuration + EIP-712 domain");
const escrowView = new ethers.Contract(escrow, artifact.abi, provider);
const onchainSigner = await escrowView.mpcSigner();
if (onchainSigner.toLowerCase() !== signer.toLowerCase()) fail(`mpcSigner drift: ${onchainSigner}`);
ok(`mpcSigner=${onchainSigner}`);
const owner = await escrowView.owner();
if (owner.toLowerCase() !== deployer.toLowerCase()) fail(`owner drift: ${owner}`);
ok(`owner=${owner} (deployer)`);
// Independently recompute the domain separator and compare.
const expectedDs = ethers.keccak256(
  ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "bytes32", "bytes32", "uint256", "address"],
    [
      ethers.keccak256(ethers.toUtf8Bytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
      ethers.keccak256(ethers.toUtf8Bytes("OmniBounty")),
      ethers.keccak256(ethers.toUtf8Bytes("1")),
      EXPECT_CHAIN_ID,
      escrow,
    ]
  )
);
const onchainDs = await escrowView.DOMAIN_SEPARATOR();
if (onchainDs.toLowerCase() !== expectedDs.toLowerCase()) fail("DOMAIN_SEPARATOR mismatch");
ok(`DOMAIN_SEPARATOR=${onchainDs} (matches recomputation)`);
const code = await provider.getCode(escrow);
if (code === "0x") fail("no code at deployed address");
ok(`runtime code present (${(code.length - 2) / 2} bytes)`);

// -- Step 7: public record (no secrets) ------------------------------------------
step(7, "writing the public deployment record");
const record = {
  _comment: "OmniBounty Base Sepolia escrow record (no secrets). Immutable deployment, no proxy.",
  network: "base-sepolia",
  chainId: 84532,
  escrow,
  deployTx: deployTxHash,
  blockNumber: receipt.blockNumber,
  deployer,
  mpcSigner: signer,
  kdfCheck: "MATCH",
  nearContract: NEAR_CONTRACT,
  voucherPath: VOUCHER_PATH,
  usdc: USDC_SEPOLIA,
  domainSeparator: onchainDs,
  bytecodeSha256: "0x" + createHash("sha256").update(Buffer.from(artifact.bytecode.object.slice(2), "hex")).digest("hex"),
  deployedAt: new Date().toISOString(),
};
writeFileSync(RECORD_PATH, JSON.stringify(record, null, 2) + "\n");
ok(`wrote ${RECORD_PATH}`);

console.log("\nESCROW DEPLOYMENT COMPLETE");
console.log(`escrow=${escrow}`);
console.log(`deploy tx=${deployTxHash}`);
console.log(`next: node tools/set_escrow.mjs ${escrow}`);
