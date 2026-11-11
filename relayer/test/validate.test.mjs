import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { validateSignedVoucher, computeDigest, VOUCHER_TYPEHASH } from "../src/validate.mjs";
import { testSetup, makeVoucher, signVoucher, ESCROW, CHAIN_ID } from "./helper.mjs";

describe("validate", () => {
  it("accepts a correctly signed voucher", () => {
    const ctx = testSetup();
    const signed = signVoucher(makeVoucher({}, ctx), ctx.mpc);
    const r = validateSignedVoucher(signed, {
      expectedChainId: CHAIN_ID,
      escrowAddress: ESCROW,
      mpcSigner: ctx.mpc.address,
    });
    assert.equal(r.ok, true);
    assert.equal(r.digest, signed.voucher.digest);
  });

  it("typehash matches the committed oracle fixture", async () => {
    const { readFileSync } = await import("node:fs");
    const fx = JSON.parse(readFileSync(new URL("../../testdata/eip712.json", import.meta.url)));
    assert.equal(VOUCHER_TYPEHASH.toLowerCase(), fx.voucherTypehash.toLowerCase());
    // And our digest function reproduces the oracle digests.
    for (const entry of fx.vouchers) {
      const v = entry.value;
      const d = computeDigest(
        {
          bountyId: BigInt(v.bountyId),
          recipient: v.recipient,
          token: v.token,
          amount: BigInt(v.amount),
          nonce: BigInt(v.nonce),
          expiry: BigInt(v.expiry),
          chainId: BigInt(v.chainId),
          escrow: v.escrow,
        },
        { name: fx.domain.name, version: fx.domain.version, chainId: BigInt(fx.domain.chainId), verifyingContract: fx.domain.verifyingContract }
      );
      assert.equal(d.toLowerCase(), entry.digest.toLowerCase());
    }
  });

  const tampers = {
    chainId: (v) => ({ ...v, chainId: 1n }),
    escrow: (v) => ({ ...v, escrow: ethers.Wallet.createRandom().address }),
    zeroRecipient: (v) => ({ ...v, recipient: ethers.ZeroAddress }),
    zeroAmount: (v) => ({ ...v, amount: 0n }),
    expired: (v) => ({ ...v, expiry: 1n }),
    badAddress: (v) => ({ ...v, token: "not-an-address" }),
  };
  for (const [name, fn] of Object.entries(tampers)) {
    it(`rejects tampered ${name} (original signature)`, () => {
      const ctx = testSetup();
      const good = makeVoucher({}, ctx);
      const signed = signVoucher(good, ctx.mpc);
      const bad = { ...signed, voucher: { ...signed.voucher } };
      const mutated = fn(good);
      for (const [k, val] of Object.entries(mutated)) {
        bad.voucher[k] = typeof val === "bigint" ? val.toString() : val;
      }
      const r = validateSignedVoucher(bad, {
        expectedChainId: CHAIN_ID,
        escrowAddress: ESCROW,
        mpcSigner: ctx.mpc.address,
      });
      assert.equal(r.ok, false, name);
    });
  }

  it("rejects wrong signer", () => {
    const ctx = testSetup();
    const other = ethers.Wallet.createRandom();
    const signed = signVoucher(makeVoucher({}, ctx), other);
    const r = validateSignedVoucher(signed, {
      expectedChainId: CHAIN_ID,
      escrowAddress: ESCROW,
      mpcSigner: ctx.mpc.address,
    });
    assert.equal(r.ok, false);
  });

  it("rejects bad v and missing fields", () => {
    const ctx = testSetup();
    const signed = signVoucher(makeVoucher({}, ctx), ctx.mpc);
    assert.equal(
      validateSignedVoucher({ ...signed, v: 30 }, { expectedChainId: CHAIN_ID, escrowAddress: ESCROW, mpcSigner: ctx.mpc.address }).ok,
      false
    );
    const missing = { voucher: { ...signed.voucher }, v: signed.v, r: signed.r, s: signed.s };
    delete missing.voucher.nonce;
    assert.equal(
      validateSignedVoucher(missing, { expectedChainId: CHAIN_ID, escrowAddress: ESCROW, mpcSigner: ctx.mpc.address }).ok,
      false
    );
    assert.equal(
      validateSignedVoucher(null, { expectedChainId: CHAIN_ID, escrowAddress: ESCROW, mpcSigner: ctx.mpc.address }).ok,
      false
    );
  });
});
