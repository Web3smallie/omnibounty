import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { loadConfig, summarize } from "../src/config.mjs";

function baseEnv() {
  return {
    NEAR_RPC_URL: "https://rpc.testnet.near.org",
    NEAR_CONTRACT_ID: "v2.omnibounty.testnet",
    BASE_RPC_URL: "https://sepolia.base.org",
    ESCROW_ADDRESS: "0x1111111111111111111111111111111111111111",
    MPC_SIGNER_ADDRESS: ethers.Wallet.createRandom().address,
    RELAYER_PRIVATE_KEY: ethers.Wallet.createRandom().privateKey,
  };
}

describe("config", () => {
  it("loads valid config with defaults", () => {
    const cfg = loadConfig(baseEnv());
    assert.equal(cfg.expectedChainId, 84532n);
    assert.equal(cfg.pollIntervalMs, 30000);
    assert.equal(cfg.confirmations, 2);
    assert.ok(ethers.isAddress(cfg.relayerAddress));
  });

  it("rejects missing and invalid values", () => {
    assert.throws(() => loadConfig({}), /missing env/);
    assert.throws(() => loadConfig({ ...baseEnv(), ESCROW_ADDRESS: "zzz" }), /invalid ESCROW_ADDRESS/);
    assert.throws(() => loadConfig({ ...baseEnv(), MPC_SIGNER_ADDRESS: "0x1234" }), /invalid MPC_SIGNER_ADDRESS/);
    assert.throws(() => loadConfig({ ...baseEnv(), RELAYER_PRIVATE_KEY: "0x1234" }), /invalid RELAYER_PRIVATE_KEY/);
    assert.throws(() => loadConfig({ ...baseEnv(), POLL_INTERVAL_MS: "5" }), /invalid POLL_INTERVAL_MS/);
    assert.throws(() => loadConfig({ ...baseEnv(), CONFIRMATIONS: "0" }), /invalid CONFIRMATIONS/);
  });

  it("voucher version defaults to 1 and accepts 2", () => {
    assert.equal(loadConfig(baseEnv()).voucherVersion, "1");
    assert.equal(loadConfig({ ...baseEnv(), VOUCHER_VERSION: "2" }).voucherVersion, "2");
    assert.throws(() => loadConfig({ ...baseEnv(), VOUCHER_VERSION: "3" }), /invalid VOUCHER_VERSION/);
  });

  it("summary never contains the private key", () => {
    const env = baseEnv();
    const s = JSON.stringify(summarize(loadConfig(env)));
    assert.ok(!s.includes(env.RELAYER_PRIVATE_KEY));
    assert.ok(!s.includes("privateKey"));
  });
});
