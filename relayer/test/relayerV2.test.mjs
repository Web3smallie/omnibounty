import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { Relayer } from "../src/index.mjs";
import { StateStore } from "../src/store.mjs";
import { testSetupV2, makeVoucherV2, signVoucherV2, ESCROW_V2, CHAIN_ID_V2, CRITERIA_V2 } from "./helperV2.mjs";
import { testSetup, makeVoucher, signVoucher } from "./helper.mjs";

const tmpdir = (() => {
  const d = join(dirname(fileURLToPath(import.meta.url)), ".tmp");
  mkdirSync(d, { recursive: true });
  return d;
})();

function harness(
  { vouchers = [], used = false, claimImpl = null, version = "2", nearBounty, escrowBounty } = {}
) {
  const ctx = testSetupV2();
  const calls = [];
  const defaultNear = {
    id: 7,
    sponsor: "sponsor.testnet",
    token: ctx.token,
    criteria_hash: CRITERIA_V2,
    slots: ["600000"],
    slots_filled: 0,
    total_amount: "600000",
    funded: true,
    deadline: 1893456000,
    challenge_window: 0,
    created_at: 1,
    seq: 0,
    status: "funded",
  };
  const defaultEscrow = {
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
  const near = {
    async listUnrelayed() {
      return vouchers;
    },
    async getBounty() {
      return nearBounty === undefined ? defaultNear : nearBounty;
    },
  };
  const escrow = {
    async usedVoucher() {
      return used;
    },
    async bounties() {
      return escrowBounty === undefined ? defaultEscrow : escrowBounty;
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
    voucherVersion: version,
  };
  const store = new StateStore(join(tmpdir, `obv2-harness-${Date.now()}-${Math.random()}.json`));
  const logs = [];
  const relayer = new Relayer({ config, near, escrow, store, log: (m) => logs.push(m) });
  return { ctx, relayer, calls, store, logs };
}

describe("relayerV2", () => {
  it("relays a valid V2 voucher end to end", async () => {
    const h = harness();
    const signed = signVoucherV2(makeVoucherV2({ slot_index: 2 }, h.ctx), h.ctx.mpc);
    h.relayer.near.listUnrelayed = async () => [signed];
    const results = await h.relayer.pollOnce();
    assert.equal(results[0].status, "relayed");
    assert.equal(h.calls.length, 1);
    // V2 tuple: 10 fields in §9 order (slotIndex second, criteriaHash last).
    assert.equal(h.calls[0].tuple.length, 10);
    assert.equal(h.calls[0].tuple[1], 2);
    assert.equal(typeof h.calls[0].tuple[9], "string");
    // Second poll is a no-op (idempotent via local state).
    assert.equal((await h.relayer.pollOnce())[0].status, "already");
    assert.equal(h.calls.length, 1);
  });

  it("skips V1-shaped vouchers with a version-mismatch reason", async () => {
    const h = harness();
    const v1ctx = testSetup();
    const v1signed = signVoucher(makeVoucher({}, v1ctx), v1ctx.mpc);
    h.relayer.near.listUnrelayed = async () => [v1signed];
    const results = await h.relayer.pollOnce();
    assert.equal(results[0].status, "skipped");
    assert.match(results[0].reason, /version mismatch/);
    assert.equal(h.calls.length, 0);
  });

  it("skips used-on-chain and invalid V2 vouchers without submitting", async () => {
    const h = harness({ used: true });
    const signed = signVoucherV2(makeVoucherV2({}, h.ctx), h.ctx.mpc);
    h.relayer.near.listUnrelayed = async () => [signed];
    assert.equal((await h.relayer.pollOnce())[0].status, "already");
    assert.equal(h.calls.length, 0);

    const h2 = harness();
    const bad = signVoucherV2(makeVoucherV2({ chain_id: 1n }, h2.ctx), h2.ctx.mpc);
    h2.relayer.near.listUnrelayed = async () => [bad];
    assert.equal((await h2.relayer.pollOnce())[0].status, "skipped");
    assert.equal(h2.calls.length, 0);
  });

  it("treats every V2 escrow revert reason as final", async () => {
    const reasons = [
      "SlotClaimed()",
      "AlreadyRefunded()",
      "CriteriaMismatch()",
      "InvalidSlot()",
      "InvalidSchedule()",
      "RefundUnavailable()",
      "DeadlineNotPassed()",
      "NotProposedOwner()",
    ];
    for (const reason of reasons) {
      const h = harness({
        claimImpl: async () => {
          throw new Error(`execution failed: ${reason}`);
        },
      });
      const signed = signVoucherV2(makeVoucherV2({}, h.ctx), h.ctx.mpc);
      h.relayer.near.listUnrelayed = async () => [signed];
      const results = await h.relayer.pollOnce();
      assert.equal(results[0].status, "skipped", reason);
      assert.equal(h.calls.length, 1, reason);
    }
  });

  it("skips on schedule mismatch without submitting", async () => {
    const h = harness({
      escrowBounty: {
        token: "0x4444444444444444444444444444444444444444",
        sponsor: "0x3333333333333333333333333333333333333333",
        deadline: 1893456000n,
        criteriaHash: CRITERIA_V2,
        funded: true,
        totalFunded: 999n,
        amounts: [999n],
        claimedBitmap: 0n,
        refundedBitmap: 0n,
      },
    });
    const signed = signVoucherV2(makeVoucherV2({}, h.ctx), h.ctx.mpc);
    h.relayer.near.listUnrelayed = async () => [signed];
    const results = await h.relayer.pollOnce();
    assert.equal(results[0].status, "skipped");
    assert.match(results[0].reason, /schedule mismatch/);
    assert.equal(h.calls.length, 0);
  });

  it("skips unknown or unfunded bounties, errors on fetch failure", async () => {
    const h = harness({ nearBounty: null });
    const signed = signVoucherV2(makeVoucherV2({}, h.ctx), h.ctx.mpc);
    h.relayer.near.listUnrelayed = async () => [signed];
    assert.match((await h.relayer.pollOnce())[0].reason, /unknown NEAR bounty/);

    const h2 = harness();
    h2.relayer.near.getBounty = async () => {
      throw new Error("RPC down");
    };
    const signed2 = signVoucherV2(makeVoucherV2({}, h2.ctx), h2.ctx.mpc);
    h2.relayer.near.listUnrelayed = async () => [signed2];
    const r2 = await h2.relayer.pollOnce();
    assert.equal(r2[0].status, "error");
  });
});
