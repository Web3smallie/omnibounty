import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { discoverMatured, runBatch } from "../finalize_batch.mjs";

// Mock NEAR account with scripted bounties/claims/vouchers. No network.
function mockAccount({ bounties = [], claims = {}, vouchers = {}, submit = null, failViews = null } = {}) {
  const calls = { submits: 0 };
  const voucherSeqs = {};
  for (const [k, v] of Object.entries(vouchers)) voucherSeqs[k] = Array.isArray(v) ? [...v] : [v];
  return {
    calls,
    async viewFunction({ methodName, args }) {
      if (failViews === methodName) throw new Error(`${methodName} RPC down`);
      if (methodName === "list_bounties") return bounties.slice(args.from, args.from + args.limit);
      if (methodName === "get_claim") return claims[`${args.bounty_id}:${args.slot}`] ?? null;
      if (methodName === "get_voucher") {
        const seq = voucherSeqs[`${args.bounty_id}:${args.slot}`];
        if (!seq) return null;
        return seq.length > 1 ? seq.shift() : seq[0];
      }
      throw new Error(`unexpected view ${methodName}`);
    },
    async functionCall(opts) {
      calls.submits++;
      if (submit) return submit(opts);
      return { transaction: { hash: "0xtx" } };
    },
  };
}

const CLAIM = (over = {}) => ({
  bounty_id: 7, slot: 0, recipient: "0x1111111111111111111111111111111111111111",
  pr_number: 100, challenge_ends_at: 100, status: "challengeable",
  pending_digest: null, signed: false, ...over,
});
const VOUCHER = {
  voucher: { digest: "0xabc123", bounty_id: 7, slot_index: 0, nonce: 0, recipient: CLAIM().recipient, amount: "600000" },
  v: 27, r: "0xr", s: "0xs",
};
const BOUNTY = (over = {}) => ({
  id: 7, sponsor: "s", token: "0xtoken", criteria_hash: "0xch",
  slots: ["600000"], slots_filled: 1, total_amount: "600000",
  funded: true, deadline: 0, challenge_window: 0, created_at: 1, seq: 0, status: "funded", ...over,
});
const DEP = { contractId: "omnibounty-v3.testnet", nowSec: 200 };
const noSleep = async () => {};
const noWrite = async () => {};

describe("discoverMatured", () => {
  it("finds unsigned matured claims and skips the rest", async () => {
    const account = mockAccount({
      bounties: [BOUNTY({ id: 7 }), BOUNTY({ id: 8 }), null, { id: "nan" }],
      claims: {
        "7:0": CLAIM({}), // matured, unsigned -> eligible
        "8:0": { ...CLAIM({}), challenge_ends_at: 999 }, // immature -> skip
      },
    });
    // Second bounty needs a signed claim to exercise the signed-skip path.
    account.viewFunction = ((orig) => async (q) => {
      if (q.methodName === "get_claim" && q.args.bounty_id === 8) return { ...CLAIM({}), signed: true };
      return orig(q);
    })(account.viewFunction.bind(account));
    const found = await discoverMatured(account, DEP.contractId, DEP.nowSec);
    assert.deepEqual(found.map((f) => [f.bountyId, f.slot]), [[7, 0]]);
  });

  it("pages past 100 bounties", async () => {
    const bounties = [];
    for (let i = 0; i < 101; i++) bounties.push(BOUNTY({ id: 1000 + i, slots_filled: 0 }));
    bounties[100] = BOUNTY({ id: 2000, slots_filled: 1 });
    const account = mockAccount({
      bounties,
      claims: { "2000:0": CLAIM({}) },
      vouchers: {},
    });
    const found = await discoverMatured(account, DEP.contractId, DEP.nowSec);
    assert.deepEqual(found.map((f) => [f.bountyId, f.slot]), [[2000, 0]]);
  });

  it("throws loudly on a malformed bounty page", async () => {
    const account = mockAccount({ bounties: [] });
    account.viewFunction = async () => ({ not: "an array" });
    await assert.rejects(discoverMatured(account, DEP.contractId, DEP.nowSec), /unexpected list_bounties shape/);
  });
});

describe("runBatch", () => {
  function setup(claims, vouchers, submit) {
    return mockAccount({
      bounties: [BOUNTY({}), BOUNTY({ id: 8 })],
      claims, vouchers, submit,
    });
  }

  it("finalizes multiple eligible claims and reports each", async () => {
    const account = setup(
      { "7:0": CLAIM({}), "8:0": CLAIM({}) },
      { "7:0": [null, VOUCHER], "8:0": [null, { ...VOUCHER, voucher: { ...VOUCHER.voucher, digest: "0xdef" } }] }
    );
    const written = [];
    const report = await runBatch(
      { account, ...DEP, sleepFn: noSleep, rounds: 3 },
      { writeEvidence: async (item, ev) => written.push([item, ev]) }
    );
    assert.equal(report.code, 0);
    assert.equal(report.results.length, 2);
    assert.deepEqual(report.results.map((r) => r.status), ["finalized", "finalized"]);
    assert.equal(account.calls.submits, 2);
    assert.equal(written.length, 2);
    assert.equal(written[0][1].voucher.digest, "0xabc123");
  });

  it("isolates one claim failure without blocking the others", async () => {
    const account = setup(
      { "7:0": CLAIM({}), "8:0": CLAIM({}) },
      { "7:0": [null], "8:0": [null, VOUCHER] },
      async () => ({ transaction: { hash: "0xtx" } })
    );
    const report = await runBatch(
      { account, ...DEP, sleepFn: noSleep, rounds: 2 },
      { writeEvidence: noWrite }
    );
    assert.equal(report.code, 1);
    assert.deepEqual(report.results.map((r) => [r.bountyId, r.status]), [[7, "failed"], [8, "finalized"]]);
    assert.match(report.results[0].detail, /MPC_TIMEOUT/);
  });

  it("skips already-signed claims without submitting", async () => {
    const account = setup({ "7:0": { ...CLAIM({}), signed: true } }, { "7:0": [VOUCHER] });
    const report = await runBatch({ account, ...DEP, sleepFn: noSleep }, { writeEvidence: noWrite });
    assert.equal(report.code, 0);
    assert.deepEqual(report.results, []);
    assert.equal(account.calls.submits, 0);
  });

  it("repeat runs recover and converge without duplicates", async () => {
    const mk = (vouchers) => setup({ "7:0": CLAIM({}) }, vouchers);
    // First run: pre-check + 2 polls all empty -> timeout (voucher lands later).
    const r1 = await runBatch({ account: mk({ "7:0": [null, null, null] }), ...DEP, sleepFn: noSleep, rounds: 2 }, { writeEvidence: noWrite });
    assert.equal(r1.code, 1);
    // Second run: voucher now present at pre-check -> success, no resubmit.
    const account2 = setup({ "7:0": CLAIM({}) }, { "7:0": [VOUCHER] });
    const r2 = await runBatch({ account: account2, ...DEP, sleepFn: noSleep }, { writeEvidence: noWrite });
    assert.equal(r2.code, 0);
    assert.equal(r2.results[0].status, "finalized");
    assert.equal(r2.results[0].submitted, false);
    assert.equal(account2.calls.submits, 0);
  });

  it("reports discovery failures without partial work", async () => {
    const account = mockAccount({ bounties: [] });
    account.viewFunction = async () => { throw new Error("list_bounties RPC down"); };
    const report = await runBatch({ account, ...DEP, sleepFn: noSleep }, { writeEvidence: noWrite });
    assert.equal(report.code, 1);
    assert.equal(report.results[0].status, "discovery-error");
  });

  it("exits cleanly when nothing is eligible", async () => {
    const account = setup({}, {});
    const report = await runBatch({ account, ...DEP, sleepFn: noSleep }, { writeEvidence: noWrite });
    assert.equal(report.code, 0);
    assert.deepEqual(report.results, []);
  });
});

describe("in-flight pending_digest skip (P2-7)", () => {
  const INFLIGHT = "0x" + "cd".repeat(32);
  const ZERO = "0x" + "00".repeat(32);

  it("skips non-zero pending_digest in discovery", async () => {
    const account = mockAccount({
      bounties: [BOUNTY({ id: 7 }), BOUNTY({ id: 8 })],
      claims: {
        "7:0": CLAIM({}), // matured, unsigned, no dispatch -> eligible
        "8:0": CLAIM({ pending_digest: INFLIGHT, status: "finalized" }), // in flight -> skip
      },
    });
    const found = await discoverMatured(account, DEP.contractId, DEP.nowSec);
    assert.deepEqual(found.map((f) => [f.bountyId, f.slot]), [[7, 0]]);
  });

  it("treats zero and missing pending_digest as no dispatch (relayer parity)", async () => {
    const noField = CLAIM({});
    delete noField.pending_digest;
    const account = mockAccount({
      bounties: [BOUNTY({ id: 7 }), BOUNTY({ id: 8 }), BOUNTY({ id: 9 }), BOUNTY({ id: 10 })],
      claims: {
        "7:0": CLAIM({ pending_digest: null }), // zero (null) -> continues
        "8:0": noField, // missing field -> continues (forward-compat, like the relayer)
        "9:0": CLAIM({ pending_digest: ZERO }), // zero digest literal -> continues
        "10:0": CLAIM({ pending_digest: ZERO, challenge_ends_at: 999 }), // continues INTO later checks -> immature skip
      },
    });
    const found = await discoverMatured(account, DEP.contractId, DEP.nowSec);
    assert.deepEqual(found.map((f) => [f.bountyId, f.slot]), [[7, 0], [8, 0], [9, 0]]);
  });

  it("skips in-flight claims without submitting while eligible claims finalize", async () => {
    const account = mockAccount({
      bounties: [BOUNTY({ id: 7 }), BOUNTY({ id: 8 })],
      claims: {
        "7:0": CLAIM({}),
        "8:0": CLAIM({ pending_digest: INFLIGHT, status: "finalized" }),
      },
      vouchers: { "7:0": [null, VOUCHER] },
    });
    const report = await runBatch(
      { account, ...DEP, sleepFn: noSleep, rounds: 3 },
      { writeEvidence: noWrite }
    );
    assert.equal(report.code, 0);
    assert.equal(account.calls.submits, 1); // no submission for the in-flight claim
    assert.deepEqual(report.results.map((r) => [r.bountyId, r.status]), [[7, "finalized"]]);
  });

  it("fails safely on missing claims and failed reads", async () => {
    // Missing claim view: skipped silently, nothing submitted.
    const missing = mockAccount({ bounties: [BOUNTY({})], claims: {} });
    const r1 = await runBatch({ account: missing, ...DEP, sleepFn: noSleep }, { writeEvidence: noWrite });
    assert.equal(r1.code, 0);
    assert.deepEqual(r1.results, []);
    assert.equal(missing.calls.submits, 0);
    // Failed get_claim read: loud discovery error, zero submissions.
    const failing = mockAccount({ bounties: [BOUNTY({})], claims: { "7:0": CLAIM({}) }, failViews: "get_claim" });
    const r2 = await runBatch({ account: failing, ...DEP, sleepFn: noSleep }, { writeEvidence: noWrite });
    assert.equal(r2.code, 1);
    assert.equal(r2.results[0].status, "discovery-error");
    assert.equal(failing.calls.submits, 0);
  });
});
