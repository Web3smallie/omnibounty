import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, isMatured, buildEvidence, runOnce } from "../finalize.mjs";

// Mock NEAR account: scripted views + optional submit behavior. No network.
function mockAccount({ claim = null, vouchers = [], submit = null } = {}) {
  const calls = { views: [], submits: 0 };
  let polls = 0;
  return {
    calls,
    async viewFunction({ methodName, args }) {
      calls.views.push([methodName, args]);
      if (methodName === "get_claim") return claim;
      if (methodName === "get_voucher") {
        const seq = Array.isArray(vouchers) ? vouchers : [vouchers];
        return seq[Math.min(polls++, seq.length - 1)] ?? null;
      }
      throw new Error(`unexpected view ${methodName}`);
    },
    async functionCall(opts) {
      calls.submits++;
      if (submit) return submit(opts);
      return { transaction: { hash: "0xtxhash" } };
    },
  };
}

const CLAIM = {
  bounty_id: 7, slot: 0, recipient: "0x1111111111111111111111111111111111111111",
  pr_number: 100, challenge_ends_at: 100, status: "challengeable",
};
const VOUCHER = {
  voucher: {
    digest: "0xabc123", bounty_id: 7, slot_index: 0, nonce: 0,
    recipient: CLAIM.recipient, amount: "600000",
  },
  v: 27, r: "0xr", s: "0xs",
};
const DEP = { contractId: "omnibounty-v3.testnet", nowSec: 200 };
const noSleep = async () => {};

describe("finalize args", () => {
  it("parses bounty and slot", () => {
    assert.deepEqual(parseArgs(["7", "0"]), { bountyId: 7, slot: 0 });
  });
  it("rejects missing, non-numeric, and out-of-range args", () => {
    for (const argv of [[], ["7"], ["x", "0"], ["7", "x"], ["-1", "0"], ["7", "256"], ["7.5", "0"]]) {
      assert.throws(() => parseArgs(argv), /invalid (bountyId|slot)/);
    }
  });
});

describe("finalize runOnce", () => {
  it("fails when the claim does not exist (no transaction)", async () => {
    const account = mockAccount({ claim: null });
    await assert.rejects(runOnce({ account, ...DEP, sleepFn: noSleep }, { bountyId: 7, slot: 0 }), /CLAIM_NOT_FOUND/);
    assert.equal(account.calls.submits, 0);
  });

  it("fails while the challenge window is open (no transaction)", async () => {
    const account = mockAccount({ claim: { ...CLAIM, challenge_ends_at: 999 }, vouchers: [null] });
    await assert.rejects(runOnce({ account, ...DEP, sleepFn: noSleep }, { bountyId: 7, slot: 0 }), /CHALLENGE_NOT_EXPIRED/);
    assert.equal(account.calls.submits, 0);
  });

  it("reports success without submitting when a voucher already exists", async () => {
    const account = mockAccount({ claim: CLAIM, vouchers: [VOUCHER] });
    const r = await runOnce({ account, ...DEP, sleepFn: noSleep }, { bountyId: 7, slot: 0 });
    assert.equal(r.submitted, false);
    assert.equal(r.txHash, null);
    assert.equal(r.voucher, VOUCHER);
    assert.equal(account.calls.submits, 0);
  });

  it("submits once and polls until the voucher lands", async () => {
    const account = mockAccount({ claim: CLAIM, vouchers: [null, null, VOUCHER] });
    let submitted = null;
    const origCall = account.functionCall.bind(account);
    account.functionCall = async (opts) => {
      submitted = opts;
      return origCall(opts);
    };
    const r = await runOnce({ account, ...DEP, sleepFn: noSleep }, { bountyId: 7, slot: 0 });
    assert.equal(r.submitted, true);
    assert.equal(r.txHash, "0xtxhash");
    assert.equal(r.voucher, VOUCHER);
    assert.equal(submitted.methodName, "finalize_claim");
    assert.deepEqual(submitted.args, { bounty_id: 7, slot: 0 });
    assert.equal(submitted.gas, "300000000000000");
    assert.equal(submitted.attachedDeposit, "100000000000000000000000");
    assert.equal(account.calls.submits, 1);
  });

  it("waits instead of resubmitting when another finalizer wins the race", async () => {
    const account = mockAccount({
      claim: CLAIM,
      vouchers: [null, VOUCHER],
      submit: async () => { throw new Error("SlotPending { bounty_id: 7, slot: 0 }"); },
    });
    const r = await runOnce({ account, ...DEP, sleepFn: noSleep }, { bountyId: 7, slot: 0 });
    assert.equal(r.submitted, false);
    assert.equal(r.txHash, null);
    assert.equal(r.voucher, VOUCHER);
    assert.equal(account.calls.submits, 1);
  });

  it("fails loudly when the voucher never lands", async () => {
    const account = mockAccount({ claim: CLAIM, vouchers: [null] });
    await assert.rejects(
      runOnce({ account, ...DEP, sleepFn: noSleep, rounds: 3 }, { bountyId: 7, slot: 0 }),
      /MPC_TIMEOUT/
    );
    assert.equal(account.calls.submits, 1);
  });

  it("propagates genuine transaction failures without polling forever", async () => {
    const account = mockAccount({
      claim: CLAIM,
      vouchers: [null],
      submit: async () => { throw new Error("insufficient gas"); },
    });
    await assert.rejects(
      runOnce({ account, ...DEP, sleepFn: noSleep, rounds: 3 }, { bountyId: 7, slot: 0 }),
      /insufficient gas/
    );
    assert.equal(account.calls.submits, 1);
  });
});

describe("finalize evidence", () => {
  it("records tx, digest, and bounty context", () => {
    const ev = buildEvidence({
      contractId: "omnibounty-v3.testnet", bountyId: 7, slot: 0,
      claim: CLAIM, txHash: "0xtxhash", voucher: VOUCHER, submitted: true,
    });
    assert.equal(ev.contract, "omnibounty-v3.testnet");
    assert.equal(ev.bountyId, 7);
    assert.equal(ev.slot, 0);
    assert.equal(ev.txHash, "0xtxhash");
    assert.equal(ev.voucher.digest, "0xabc123");
    assert.equal(ev.recipient, CLAIM.recipient);
    assert.equal(ev.prNumber, CLAIM.pr_number);
    assert.equal(ev.submitted, true);
    assert.ok(Date.parse(ev.generatedAt) > 0);
  });

  it("marks pre-signed runs as not submitted", () => {
    const ev = buildEvidence({
      contractId: "c", bountyId: 7, slot: 0, claim: CLAIM,
      txHash: null, voucher: VOUCHER, submitted: false,
    });
    assert.equal(ev.submitted, false);
    assert.equal(ev.txHash, null);
  });
});

describe("finalize maturity", () => {
  it("uses challenge_ends_at against chain time", () => {
    assert.equal(isMatured({ challenge_ends_at: 100 }, 99), false);
    assert.equal(isMatured({ challenge_ends_at: 100 }, 100), true);
    assert.equal(isMatured({ challenge_ends_at: 100 }, 200), true);
  });
});
