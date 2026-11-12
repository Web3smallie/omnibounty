import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  validateSignedVoucherV2,
  computeDigestV2,
  isVoucherV2Shape,
  validateScheduleConsistency,
  VOUCHER_V2_TYPEHASH,
  VOUCHER_V2_TYPE_STRING,
} from "../src/validate.mjs";
import { testSetupV2, makeVoucherV2, signVoucherV2, ESCROW_V2, CHAIN_ID_V2, CRITERIA_V2 } from "./helperV2.mjs";

const OPTS = (ctx) => ({
  expectedChainId: CHAIN_ID_V2,
  escrowAddress: ESCROW_V2,
  mpcSigner: ctx.mpc.address,
});

describe("validateV2", () => {
  it("accepts a correctly signed voucher (snake_case NEAR shape)", () => {
    const ctx = testSetupV2();
    const signed = signVoucherV2(makeVoucherV2({}, ctx), ctx.mpc);
    const r = validateSignedVoucherV2(signed, OPTS(ctx));
    assert.equal(r.ok, true);
    assert.equal(r.digest, signed.voucher.digest);
  });

  it("accepts the camelCase mock shape", () => {
    const ctx = testSetupV2();
    const snake = makeVoucherV2({}, ctx);
    const camel = {
      bountyId: snake.bounty_id,
      slotIndex: snake.slot_index,
      recipient: snake.recipient,
      token: snake.token,
      amount: snake.amount,
      nonce: snake.nonce,
      expiry: snake.expiry,
      chainId: snake.chain_id,
      escrow: snake.escrow,
      criteriaHash: snake.criteria_hash,
    };
    const signed = signVoucherV2(camel, ctx.mpc);
    assert.equal(validateSignedVoucherV2(signed, OPTS(ctx)).ok, true);
  });

  it("detects V2 vs V1 shapes", async () => {
    const ctx = testSetupV2();
    assert.equal(isVoucherV2Shape(signVoucherV2(makeVoucherV2({}, ctx), ctx.mpc)), true);
    assert.equal(isVoucherV2Shape({ voucher: { bountyId: 7 } }), false);
    assert.equal(isVoucherV2Shape({ voucher: { slotIndex: 0 } }), false);
    assert.equal(isVoucherV2Shape(null), false);
    assert.equal(isVoucherV2Shape({}), false);
  });

  it("typehash matches the frozen §9 string and oracle fixture", async () => {
    const { readFileSync } = await import("node:fs");
    assert.equal(
      VOUCHER_V2_TYPE_STRING,
      "VoucherV2(uint256 bountyId,uint8 slotIndex,address recipient,address token,uint256 amount,uint256 nonce,uint256 expiry,uint256 chainId,address escrow,bytes32 criteriaHash)"
    );
    const fx = JSON.parse(
      readFileSync(new URL("../../testdata/v3/eip712-voucher2.json", import.meta.url))
    );
    assert.equal(fx.typeString, VOUCHER_V2_TYPE_STRING);
    assert.equal(VOUCHER_V2_TYPEHASH.toLowerCase(), fx.typeHash.toLowerCase());
    // And our digest function reproduces the oracle digests.
    for (const vec of fx.vectors) {
      const d = computeDigestV2(
        {
          bountyId: BigInt(vec.bountyId),
          slotIndex: vec.slotIndex,
          recipient: vec.recipient,
          token: vec.token,
          amount: BigInt(vec.amount),
          nonce: BigInt(vec.nonce),
          expiry: BigInt(vec.expiry),
          chainId: BigInt(vec.chainId),
          escrow: vec.escrow,
          criteriaHash: vec.criteriaHash,
        },
        {
          name: "OmniBounty",
          version: "1",
          chainId: BigInt(vec.chainId),
          verifyingContract: vec.escrow,
        }
      );
      assert.equal(d.toLowerCase(), vec.digest.toLowerCase(), vec.tag);
    }
  });

  const tampers = {
    slotIndex: (v) => ({ ...v, slot_index: 3 }),
    slotIndexRange: (v) => ({ ...v, slot_index: 300 }),
    criteriaHash: (v) => ({ ...v, criteria_hash: "0x" + "11".repeat(32) }),
    criteriaHashMalformed: (v) => ({ ...v, criteria_hash: "0x1234" }),
    chainId: (v) => ({ ...v, chain_id: 1n }),
    escrow: (v) => ({ ...v, escrow: ethers.Wallet.createRandom().address }),
    zeroRecipient: (v) => ({ ...v, recipient: ethers.ZeroAddress }),
    zeroAmount: (v) => ({ ...v, amount: 0n }),
    expired: (v) => ({ ...v, expiry: 1n }),
    badAddress: (v) => ({ ...v, token: "not-an-address" }),
  };
  for (const [name, fn] of Object.entries(tampers)) {
    it(`rejects tampered ${name} (original signature)`, () => {
      const ctx = testSetupV2();
      const good = makeVoucherV2({}, ctx);
      const signed = signVoucherV2(good, ctx.mpc);
      const bad = { ...signed, voucher: { ...signed.voucher } };
      const mutated = fn(good);
      for (const [k, val] of Object.entries(mutated)) {
        bad.voucher[k] = typeof val === "bigint" ? val.toString() : val;
      }
      const r = validateSignedVoucherV2(bad, OPTS(ctx));
      assert.equal(r.ok, false, name);
    });
  }

  it("rejects wrong signer", () => {
    const ctx = testSetupV2();
    const other = ethers.Wallet.createRandom();
    const signed = signVoucherV2(makeVoucherV2({}, ctx), other);
    assert.equal(validateSignedVoucherV2(signed, OPTS(ctx)).ok, false);
  });

  it("rejects bad v and missing fields", () => {
    const ctx = testSetupV2();
    const signed = signVoucherV2(makeVoucherV2({}, ctx), ctx.mpc);
    assert.equal(validateSignedVoucherV2({ ...signed, v: 30 }, OPTS(ctx)).ok, false);
    for (const field of ["slot_index", "criteria_hash", "nonce"]) {
      const missing = { voucher: { ...signed.voucher }, v: signed.v, r: signed.r, s: signed.s };
      delete missing.voucher[field];
      assert.equal(validateSignedVoucherV2(missing, OPTS(ctx)).ok, false, field);
    }
    assert.equal(validateSignedVoucherV2(null, OPTS(ctx)).ok, false);
  });
});

describe("scheduleConsistency", () => {
  function pair() {
    const ctx = testSetupV2();
    const near = {
      id: 7,
      sponsor: "sponsor.testnet",
      token: ctx.token,
      criteria_hash: CRITERIA_V2,
      slots: ["600000", "400000"],
      slots_filled: 0,
      total_amount: "1000000",
      funded: true,
      deadline: 1893456000,
      challenge_window: 0,
      created_at: 1,
      seq: 0,
      status: "funded",
    };
    const esc = {
      token: ctx.token,
      sponsor: "0x3333333333333333333333333333333333333333",
      deadline: 1893456000n,
      criteriaHash: CRITERIA_V2,
      funded: true,
      totalFunded: 1000000n,
      amounts: [600000n, 400000n],
      claimedBitmap: 0n,
      refundedBitmap: 0n,
    };
    return { ctx, near, esc };
  }

  it("accepts a matching schedule", () => {
    const { near, esc } = pair();
    assert.deepEqual(validateScheduleConsistency(near, esc), { ok: true, reasons: [] });
  });

  it("rejects every mismatch axis", () => {
    const cases = {
      token: (n, e) => ({ ...e, token: "0x4444444444444444444444444444444444444444" }),
      slotCount: (n, e) => ({ ...e, amounts: [600000n] }),
      slotAmount: (n, e) => ({ ...e, amounts: [600001n, 400000n], totalFunded: 1000001n }),
      total: (n, e) => ({ ...e, totalFunded: 999n }),
      deadline: (n, e) => ({ ...e, deadline: 1n }),
      criteria: (n, e) => ({ ...e, criteriaHash: "0x" + "11".repeat(32) }),
      unfunded: (n, e) => ({ ...e, funded: false }),
      unknownEscrow: (n, e) => ({ ...e, sponsor: "0x0000000000000000000000000000000000000000" }),
    };
    for (const [name, fn] of Object.entries(cases)) {
      const { near, esc } = pair();
      const r = validateScheduleConsistency(near, fn(near, esc));
      assert.equal(r.ok, false, name);
      assert.ok(r.reasons.length > 0, name);
    }
    const { near, esc } = pair();
    assert.equal(validateScheduleConsistency(null, esc).ok, false);
    assert.equal(validateScheduleConsistency(near, null).ok, false);
  });
});
