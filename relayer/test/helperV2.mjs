// Shared V2 test helper: build signed VoucherV2 bundles in the NEAR V3
// snake_case view shape. No key material is committed; keys random per run.
import { ethers } from "ethers";
import { computeDigestV2 } from "../src/validate.mjs";

export const ESCROW_V2 = "0x2222222222222222222222222222222222222222";
export const CHAIN_ID_V2 = 84532n;
export const CRITERIA_V2 = "0x499dcdccb8acfafe8d71e42ac91ab86cacbac30bf2b33c521b1bd47a31641d10";

export function testSetupV2() {
  const mpc = ethers.Wallet.createRandom();
  const recipient = ethers.Wallet.createRandom().address;
  const token = ethers.Wallet.createRandom().address;
  return { mpc, recipient, token };
}

export function makeVoucherV2(overrides = {}, ctx) {
  const base = {
    bounty_id: 7n,
    slot_index: 0,
    recipient: ctx.recipient,
    token: ctx.token,
    amount: 600_000n,
    nonce: 0n,
    expiry: BigInt(Math.floor(Date.now() / 1000) + 86400),
    chain_id: CHAIN_ID_V2,
    escrow: ESCROW_V2,
    criteria_hash: CRITERIA_V2,
  };
  return { ...base, ...overrides };
}

export function signVoucherV2(voucher, signer) {
  const digest = computeDigestV2(
    {
      bountyId: BigInt(voucher.bounty_id ?? voucher.bountyId),
      slotIndex: Number(BigInt(voucher.slot_index ?? voucher.slotIndex)),
      recipient: voucher.recipient,
      token: voucher.token,
      amount: BigInt(voucher.amount),
      nonce: BigInt(voucher.nonce),
      expiry: BigInt(voucher.expiry),
      chainId: BigInt(voucher.chain_id ?? voucher.chainId),
      escrow: voucher.escrow,
      criteriaHash: voucher.criteria_hash ?? voucher.criteriaHash,
    },
    {
      name: "OmniBounty",
      version: "1",
      chainId: BigInt(voucher.chain_id ?? voucher.chainId),
      verifyingContract: voucher.escrow,
    }
  );
  const sig = signer.signingKey.sign(digest);
  // Serialize like the NEAR view (bigints as strings, snake_case keys kept).
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
