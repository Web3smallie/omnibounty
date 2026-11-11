import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { Relayer } from "../src/index.mjs";

const tmpdir = (() => {
  const d = join(dirname(fileURLToPath(import.meta.url)), ".tmp");
  mkdirSync(d, { recursive: true });
  return d;
})();
import { StateStore } from "../src/store.mjs";
import { testSetup, makeVoucher, signVoucher, ESCROW, CHAIN_ID } from "./helper.mjs";

function harness({ vouchers = [], used = false, claimImpl = null } = {}) {
  const ctx = testSetup();
  const calls = [];
  const near = {
    async listUnrelayed() {
      return vouchers;
    },
  };
  const escrow = {
    async usedVoucher() {
      return used;
    },
    async claim(tuple, v, r, s) {
      calls.push({ tuple, v, r, s });
      if (claimImpl) return claimImpl(tuple, v, r, s);
      return { wait: async () => ({ status: 1, hash: "0xtxhash" }) };
    },
  };
  const config = {
    contractId: "v2.omnibounty.testnet",
    escrowAddress: ESCROW,
    mpcSigner: ctx.mpc.address,
    expectedChainId: CHAIN_ID,
    confirmations: 1,
    maxAttempts: 3,
  };
  const store = new StateStore(join(tmpdir, `ob-harness-${Date.now()}-${Math.random()}.json`));
  const logs = [];
  const relayer = new Relayer({ config, near, escrow, store, log: (m) => logs.push(m) });
  return { ctx, relayer, calls, store, logs };
}

describe("relayer", () => {
  it("relays a valid voucher end to end", async () => {
    const h = harness();
    const signed = signVoucher(makeVoucher({}, h.ctx), h.ctx.mpc);
    h.relayer.near.listUnrelayed = async () => [signed];
    const results = await h.relayer.pollOnce();
    assert.equal(results[0].status, "relayed");
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].tuple[1], h.ctx.recipient);
    // Second poll is a no-op (idempotent via local state).
    assert.equal((await h.relayer.pollOnce())[0].status, "already");
    assert.equal(h.calls.length, 1);
  });

  it("skips vouchers already used on-chain and records them", async () => {
    const h = harness({ used: true });
    const signed = signVoucher(makeVoucher({}, h.ctx), h.ctx.mpc);
    h.relayer.near.listUnrelayed = async () => [signed];
    const results = await h.relayer.pollOnce();
    assert.equal(results[0].status, "already");
    assert.equal(h.calls.length, 0);
    assert.ok(h.store.isRelayed(signed.voucher.digest));
  });

  it("never submits invalid vouchers", async () => {
    const h = harness();
    const signed = signVoucher(makeVoucher({ chainId: 1n }, h.ctx), h.ctx.mpc);
    h.relayer.near.listUnrelayed = async () => [signed];
    const results = await h.relayer.pollOnce();
    assert.equal(results[0].status, "skipped");
    assert.equal(h.calls.length, 0);
  });

  it("treats reverts as final and transient errors as retryable", async () => {
    const h = harness({
      claimImpl: async () => {
        throw new Error("call revert exception: VoucherUsed()");
      },
    });
    const signed = signVoucher(makeVoucher({}, h.ctx), h.ctx.mpc);
    h.relayer.near.listUnrelayed = async () => [signed];
    const results = await h.relayer.pollOnce();
    assert.equal(results[0].status, "skipped");
    assert.equal(h.calls.length, 1);

    let attempts = 0;
    const h2 = harness({
      claimImpl: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("timeout");
        return { wait: async () => ({ status: 1, hash: "0xok" }) };
      },
    });
    const signed2 = signVoucher(makeVoucher({}, h2.ctx), h2.ctx.mpc);
    h2.relayer.config.mpcSigner = h2.ctx.mpc.address;
    h2.relayer.near.listUnrelayed = async () => [signed2];
    const r2 = await h2.relayer.pollOnce();
    assert.equal(r2[0].status, "relayed");
    assert.equal(attempts, 3);
  });

  it("treats every escrow revert reason as final (S-04)", async () => {
    // Every custom error in OmniEscrow.sol must end in `skipped` after a
    // single attempt — never in repeated submissions. Messages deliberately
    // avoid the word "revert" so this exercises named-reason matching, not
    // the generic execution-reverted fallback.
    const reasons = [
      "BountyNotFound(7)",
      "TokenMismatch()",
      "AmountMismatch()",
      "NotFunded()",
      "WrongChain()",
      "WrongEscrow()",
      "ZeroAddress()",
      "ZeroAmount()",
      "TransferFailed()",
      "Reentrant()",
      "NotSponsor()",
      "BountyExists()",
      "AlreadyFunded()",
      "NotOwner()",
    ];
    for (const reason of reasons) {
      const h = harness({
        claimImpl: async () => {
          throw new Error(`execution failed: ${reason}`);
        },
      });
      const signed = signVoucher(makeVoucher({}, h.ctx), h.ctx.mpc);
      h.relayer.near.listUnrelayed = async () => [signed];
      const results = await h.relayer.pollOnce();
      assert.equal(results[0].status, "skipped", reason);
      assert.equal(h.calls.length, 1, reason);
    }
  });

  it("survives NEAR poll failures", async () => {
    const h = harness();
    h.relayer.near.listUnrelayed = async () => {
      throw new Error("boom");
    };
    const results = await h.relayer.pollOnce();
    assert.equal(results[0].status, "poll-error");
    assert.equal(h.calls.length, 0);
  });
});

