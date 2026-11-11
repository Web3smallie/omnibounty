// Shared test helper: build signed vouchers with an ephemeral key.
// No key material is committed; keys are random per test run.
import { ethers } from "ethers";
import { computeDigest } from "../src/validate.mjs";

export const ESCROW = "0x1111111111111111111111111111111111111111";
export const CHAIN_ID = 84532n;

export function testSetup() {
  const mpc = ethers.Wallet.createRandom();
  const recipient = ethers.Wallet.createRandom().address;
  const token = ethers.Wallet.createRandom().address;
  return { mpc, recipient, token };
}

export function makeVoucher(overrides = {}, ctx) {
  const base = {
    bountyId: 7n,
    recipient: ctx.recipient,
    token: ctx.token,
    amount: 2_500_000_000n,
    nonce: 0n,
    expiry: BigInt(Math.floor(Date.now() / 1000) + 86400),
    chainId: CHAIN_ID,
    escrow: ESCROW,
  };
  return { ...base, ...overrides };
}

export function signVoucher(voucher, signer) {
  const digest = computeDigest(
    { ...voucher },
    { name: "OmniBounty", version: "1", chainId: voucher.chainId, verifyingContract: voucher.escrow }
  );
  const sig = signer.signingKey.sign(digest);
  // Serialize like the NEAR view (bigints as strings).
  const ser = {};
  for (const [k, v] of Object.entries(voucher)) {
    ser[k] = typeof v === "bigint" ? v.toString() : v;
  }
  return {
    voucher: { ...ser, digest },
    v: sig.v,
    r: sig.r,
    s: sig.s,
  };
}
