// Relayer configuration. All values from the environment; secrets are never
// logged. Fails fast on missing/invalid config.
import { ethers } from "ethers";

function required(name) {
  const v = process.env[name];
  if (!v || v.length === 0) throw new Error(`missing env ${name}`);
  return v;
}

function optional(name, fallback) {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

export function loadConfig(env = process.env) {
  const get = (n) => {
    const v = env[n];
    if (!v || v.length === 0) throw new Error(`missing env ${n}`);
    return v;
  };
  const opt = (n, f) => (env[n] && env[n].length > 0 ? env[n] : f);

  const nearRpcUrl = get("NEAR_RPC_URL");
  const contractId = get("NEAR_CONTRACT_ID");
  const baseRpcUrl = get("BASE_RPC_URL");
  const escrowAddress = get("ESCROW_ADDRESS");
  const mpcSigner = get("MPC_SIGNER_ADDRESS");
  const privateKey = get("RELAYER_PRIVATE_KEY");
  const expectedChainId = BigInt(opt("EXPECTED_CHAIN_ID", "84532"));

  for (const [label, addr] of [
    ["ESCROW_ADDRESS", escrowAddress],
    ["MPC_SIGNER_ADDRESS", mpcSigner],
  ]) {
    if (!ethers.isAddress(addr)) throw new Error(`invalid ${label}: ${addr}`);
  }
  let wallet;
  try {
    wallet = new ethers.Wallet(privateKey);
  } catch {
    throw new Error("invalid RELAYER_PRIVATE_KEY");
  }
  const pollIntervalMs = Number(opt("POLL_INTERVAL_MS", "30000"));
  const confirmations = Number(opt("CONFIRMATIONS", "2"));
  const maxAttempts = Number(opt("MAX_ATTEMPTS", "5"));
  const statePath = opt("STATE_PATH", "./relayer-state.json");
  // Voucher protocol version: "1" (V2 escrow, default — preserves existing
  // deployments with zero config change) or "2" (V3 escrow / VoucherV2).
  const voucherVersion = opt("VOUCHER_VERSION", "1");
  if (voucherVersion !== "1" && voucherVersion !== "2") {
    throw new Error("invalid VOUCHER_VERSION: want 1 or 2");
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 1000) {
    throw new Error("invalid POLL_INTERVAL_MS");
  }
  if (!Number.isFinite(confirmations) || confirmations < 1) {
    throw new Error("invalid CONFIRMATIONS");
  }

  return {
    nearRpcUrl,
    contractId,
    baseRpcUrl,
    escrowAddress: ethers.getAddress(escrowAddress),
    mpcSigner: ethers.getAddress(mpcSigner),
    relayerAddress: wallet.address,
    // Signer construction is deferred to the caller so tests can inject fakes.
    privateKey,
    expectedChainId,
    pollIntervalMs,
    confirmations,
    maxAttempts,
    statePath,
    voucherVersion,
  };
}

// Redacted summary for startup logs (NEVER includes the private key).
export function summarize(cfg) {
  return {
    nearRpcUrl: cfg.nearRpcUrl,
    contractId: cfg.contractId,
    baseRpcUrl: cfg.baseRpcUrl,
    escrowAddress: cfg.escrowAddress,
    mpcSigner: cfg.mpcSigner,
    relayerAddress: cfg.relayerAddress,
    expectedChainId: cfg.expectedChainId.toString(),
    pollIntervalMs: cfg.pollIntervalMs,
    confirmations: cfg.confirmations,
    voucherVersion: cfg.voucherVersion,
  };
}
