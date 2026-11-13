import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { Relayer } from "../src/index.mjs";
import { StateStore } from "../src/store.mjs";
import { testSetupV2, makeVoucherV2, signVoucherV2, ESCROW_V2, CHAIN_ID_V2, CRITERIA_V2 } from "./helperV2.mjs";

// Regression suite for suppression-proof V3 discovery: vouchers are found
// by enumerating bounties -> claim slots -> signed vouchers, never via
// the permissionless on-chain `relayed` hint set.

const tmpdir = (() => {
  const d = join(dirname(fileURLToPath(import.meta.url)), ".tmp");
  mkdirSync(d, { recursive: true });
  return d;
})();

function harness({ used = false, claimImpl = null, bounties = null } = {}) {
  const ctx = testSetupV2();
  const calls = [];
  const servedVouchers = new Map();
  const bountyList =
    bounties ??
    [
      {
        id: 7,
        sponsor: "sponsor.testnet",
        token: ctx.token,
        criteria_hash: CRITERIA_V2,
        slots: ["600000"],
        slots_filled: 1,
        total_amount: "600000",
        funded: true,
        deadline: 1893456000,
        challenge_window: 0,
        created_at: 1,
        seq: 0,
        status: "funded",
      },
    ];
  const near = {
    // NOTE: no listUnrelayed here on purpose — V2 discovery must never
    // call it (a call would throw TypeError and fail the poll loudly).
    async listBounties(contractId, from, limit) {
      assert.equal(contractId, "v3.omnibounty.testnet");
      assert.ok(from >= 0 && limit > 0);
      return bountyList.slice(from, from + limit);
    },
    async getClaim(contractId, bountyId, slot) {
      return servedVouchers.has(`${bountyId}:${slot}`) ? { signed: true } : null;
    },
    async getVoucher(contractId, bountyId, slot) {
      return servedVouchers.get(`${bountyId}:${slot}`) ?? null;
    },
    async getBounty(contractId, bountyId) {
      return bountyList.find((b) => b && b.id === bountyId) ?? null;
    },
  };
  const escrow = {
    async usedVoucher() {
      return used;
    },
    async bounties() {
      return {
        token: ctx.token,
        sponsor: "0x3333333333333333333333333333333333333333",
        deadline: 1893456000n,
        criteriaHash: CRITERIA_V2,
        funded: true,
        totalFunded: 600000n,
        amounts: [600000n],
        claimedBitmap: 0n,
        refundedBitmap: 0n,
      };
    },
    async claim(tuple, v, r, s) {
      calls.push({ tuple, v, r, s });
      if (claimImpl) return claimImpl(tuple, v, r, s);
      return { wait: async () => ({ status: 1, hash: "0xtxhash" }) };
    },
  };
  const config = {
    contractId: "v3.omnibounty.testnet",
    escrowAddress: ESCROW_V2,
    mpcSigner: ctx.mpc.address,
    expectedChainId: CHAIN_ID_V2,
    confirmations: 1,
    maxAttempts: 3,
    voucherVersion: "2",
  };
  function fundedBounty(id, slots) {
    return {
      id,
      sponsor: "sponsor.testnet",
      token: ctx.token,
      criteria_hash: CRITERIA_V2,
      slots,
      slots_filled: slots.length,
      total_amount: slots.reduce((a, b) => (BigInt(a) + BigInt(b)).toString(), "0"),
      funded: true,
      deadline: 1893456000,
      challenge_window: 0,
      created_at: 1,
      seq: 0,
      status: "funded",
    };
  }
  const store = new StateStore(join(tmpdir, `obv2-enum-${Date.now()}-${Math.random()}.json`));
  const logs = [];
  const relayer = new Relayer({ config, near, escrow, store, log: (m) => logs.push(m) });
  return {
    ctx,
    relayer,
    calls,
    fundedBounty,
    serve(bountyId, slot, signed) {
      servedVouchers.set(`${bountyId}:${slot}`, signed);
    },
  };
}

function validSigned(h, overrides = {}) {
  return signVoucherV2(makeVoucherV2({ bounty_id: 7n, slot_index: 0, ...overrides }, h.ctx), h.ctx.mpc);
}

describe("enumerateV2", () => {
  it("discovers and relays a valid voucher without list_unrelayed", async () => {
    const h = harness();
    const signed = validSigned(h);
    h.serve(7, 0, signed);
    const results = await h.relayer.pollOnce();
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "relayed");
    assert.equal(h.calls.length, 1);
  });

  it("still discovers a voucher hidden from list_unrelayed (suppression fix)", async () => {
    const h = harness();
    // Simulate the attack at the source boundary: even if list_unrelayed
    // omits the digest (planted in the on-chain relayed set), enumeration
    // finds the signed voucher and relays it.
    h.relayer.near.listUnrelayed = async () => [];
    const signed = validSigned(h);
    h.serve(7, 0, signed);
    const results = await h.relayer.pollOnce();
    assert.equal(results[0].status, "relayed");
    assert.equal(h.calls.length, 1);
  });

  it("skips genuinely settled vouchers via escrow usedVoucher", async () => {
    const h = harness({ used: true });
    h.serve(7, 0, validSigned(h));
    const results = await h.relayer.pollOnce();
    assert.equal(results[0].status, "already");
    assert.equal(h.calls.length, 0);
  });

  it("never double-submits across repeated polls", async () => {
    const h = harness();
    h.serve(7, 0, validSigned(h));
    assert.equal((await h.relayer.pollOnce())[0].status, "relayed");
    assert.equal((await h.relayer.pollOnce())[0].status, "already");
    assert.equal(h.calls.length, 1);
  });

  it("keeps existing handling for invalid and expired vouchers", async () => {
    const h = harness();
    const bad = signVoucherV2(makeVoucherV2({ chain_id: 1n }, h.ctx), h.ctx.mpc);
    h.serve(7, 0, bad);
    assert.equal((await h.relayer.pollOnce())[0].status, "skipped");
    assert.equal(h.calls.length, 0);

    const h2 = harness();
    const stale = signVoucherV2(
      makeVoucherV2({ expiry: BigInt(Math.floor(Date.now() / 1000) - 10) }, h2.ctx),
      h2.ctx.mpc
    );
    h2.serve(7, 0, stale);
    assert.equal((await h2.relayer.pollOnce())[0].status, "skipped");
    assert.equal(h2.calls.length, 0);
  });

  it("skips unsigned claims and empty slots without fetching vouchers", async () => {
    const h = harness();
    // Multi-slot bounty where only slot 0 is signed, plus an empty bounty.
    // Both views serve the same array (as a real contract would).
    const listed = [
      { ...h.fundedBounty(7, ["600000"]), slots: ["600000", "0"], slots_filled: 1 },
      { id: 8, slots: ["100"], slots_filled: 0 },
    ];
    h.relayer.near.listBounties = async () => listed;
    h.relayer.near.getBounty = async (contractId, bountyId) =>
      listed.find((b) => b && b.id === bountyId) ?? null;
    h.relayer.escrow.bounties = async () => ({
      token: h.ctx.token,
      sponsor: "0x3333333333333333333333333333333333333333",
      deadline: 1893456000n,
      criteriaHash: CRITERIA_V2,
      funded: true,
      totalFunded: 600000n,
      amounts: [600000n, 0n],
      claimedBitmap: 0n,
      refundedBitmap: 0n,
    });
    // Only bounty 7 slot 0 is signed; slot 1 and bounty 8 yield nothing.
    h.serve(7, 0, validSigned(h));
    const results = await h.relayer.pollOnce();
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "relayed");
  });

  it("pages past 100 bounties and tolerates malformed entries", async () => {
    const bounties = [];
    for (let i = 0; i < 101; i++) {
      bounties.push({
        id: 1000 + i, sponsor: "s", token: "0x0000000000000000000000000000000000000000",
        criteria_hash: CRITERIA_V2, slots: ["1"], slots_filled: 0,
        total_amount: "1", funded: false, deadline: 0, challenge_window: 0,
        created_at: 1, seq: 0, status: "open",
      });
    }
    // Voucher on the last page + malformed entries that must be skipped.
    bounties.push(null, { id: "nan" }, { id: 2000 });
    const h = harness({ bounties });
    const signed = signVoucherV2(
      makeVoucherV2({ bounty_id: 1099n, slot_index: 0 }, h.ctx),
      h.ctx.mpc
    );
    // Mark the last bounty as filled so the slot is probed.
    bounties[99] = h.fundedBounty(1099, ["600000"]);
    h.serve(1099, 0, signed);
    const results = await h.relayer.pollOnce();
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "relayed");
  });

  it("fails the poll loudly on a malformed bounty page", async () => {
    const h = harness();
    h.relayer.near.listBounties = async () => ({ not: "an array" });
    const results = await h.relayer.pollOnce();
    assert.equal(results[0].status, "poll-error");
    assert.match(results[0].error, /unexpected list_bounties shape/);
  });

  it("fails the poll loudly when bounty listing throws", async () => {
    const h = harness();
    h.relayer.near.listBounties = async () => {
      throw new Error("RPC down");
    };
    const results = await h.relayer.pollOnce();
    assert.equal(results[0].status, "poll-error");
  });
});
