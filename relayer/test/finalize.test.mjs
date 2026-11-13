import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Relayer } from "../src/index.mjs";
import { StateStore } from "../src/store.mjs";
import { loadConfig } from "../src/config.mjs";

// Mock NEAR views with scripted bounties/claims. No network.
function mockNear({ bounties = [], claims = {}, fail = null } = {}) {
  return {
    calls: { submits: 0 },
    async listBounties(_c, from, limit) {
      if (fail === "listBounties") throw new Error("listBounties RPC down");
      return bounties.slice(from, from + limit);
    },
    async getClaim(_c, bountyId, slot) {
      if (fail === "getClaim") throw new Error("getClaim RPC down");
      return claims[`${bountyId}:${slot}`] ?? null;
    },
    async getVoucher() {
      return null;
    },
    async getBounty() {
      return null;
    },
  };
}

function mockSubmitter(impl) {
  const calls = [];
  return {
    calls,
    async finalizeClaim(bountyId, slot) {
      calls.push([bountyId, slot]);
      if (impl) return impl(bountyId, slot);
      return "0xtx";
    },
  };
}

const BOUNTY = (over = {}) => ({
  id: 7, sponsor: "s", token: "0xtoken", criteria_hash: "0xch",
  slots: ["600000"], slots_filled: 1, total_amount: "600000",
  funded: true, deadline: 0, challenge_window: 0, created_at: 1, seq: 1, status: "funded", ...over,
});
const CLAIM = (over = {}) => ({
  bounty_id: 7, slot: 0, recipient: "0x1111111111111111111111111111111111111111",
  pr_number: 100, head_sha: "0x" + "ab".repeat(32), github_created: 50,
  claim_seq: 0, qualified_at: 90, challenge_ends_at: 100,
  status: "challengeable", pending_digest: null, signed: false, ...over,
});
const NOW = 200;
const CFG = {
  voucherVersion: "2", contractId: "omnibounty-v3.testnet", finalizeEnabled: true,
  maxAttempts: 1, expectedChainId: 84532n,
  escrowAddress: "0x0000000000000000000000000000000000000001",
  mpcSigner: "0x0000000000000000000000000000000000000002",
};
const store = () => new StateStore(join(mkdtempSync(join(tmpdir(), "rl-fin-")), "s.json"));
const quiet = () => {};

describe("discoverMaturedClaims", () => {
  it("finds unsigned matured claims and skips the rest", async () => {
    const near = mockNear({
      bounties: [BOUNTY({ id: 7 }), BOUNTY({ id: 8 }), BOUNTY({ id: 9 }), BOUNTY({ id: 10 }), null, { id: "nan" }],
      claims: {
        "7:0": CLAIM({}), // matured, unsigned, no dispatch -> eligible
        "8:0": CLAIM({ signed: true }), // signed -> skip
        "9:0": CLAIM({ pending_digest: "0x" + "cd".repeat(32), status: "finalized" }), // in flight -> skip
        "10:0": CLAIM({ challenge_ends_at: NOW + 3600 }), // immature -> skip
      },
    });
    const r = new Relayer({ config: CFG, near, escrow: {}, store: store(), submitter: mockSubmitter(), log: quiet });
    const found = await r.discoverMaturedClaims(NOW);
    assert.deepEqual(found.map((f) => [f.bountyId, f.slot]), [[7, 0]]);
  });

  it("treats missing pending_digest as no dispatch (forward-compat)", async () => {
    const c = CLAIM({});
    delete c.pending_digest;
    const near = mockNear({ bounties: [BOUNTY({})], claims: { "7:0": c } });
    const r = new Relayer({ config: CFG, near, escrow: {}, store: store(), submitter: mockSubmitter(), log: quiet });
    assert.equal((await r.discoverMaturedClaims(NOW)).length, 1);
  });

  it("pages past 100 bounties", async () => {
    const bounties = [];
    for (let i = 0; i < 101; i++) bounties.push(BOUNTY({ id: 1000 + i, slots_filled: 0 }));
    bounties[100] = BOUNTY({ id: 2000, slots_filled: 1 });
    const near = mockNear({ bounties, claims: { "2000:0": CLAIM({}) } });
    const r = new Relayer({ config: CFG, near, escrow: {}, store: store(), submitter: mockSubmitter(), log: quiet });
    const found = await r.discoverMaturedClaims(NOW);
    assert.deepEqual(found.map((f) => [f.bountyId, f.slot]), [[2000, 0]]);
  });

  it("skips bounties with no filled slots without probing", async () => {
    let probed = 0;
    const near = mockNear({ bounties: [BOUNTY({ slots_filled: 0 })] });
    const orig = near.getClaim;
    near.getClaim = async (...a) => { probed++; return orig(...a); };
    const r = new Relayer({ config: CFG, near, escrow: {}, store: store(), submitter: mockSubmitter(), log: quiet });
    assert.deepEqual(await r.discoverMaturedClaims(NOW), []);
    assert.equal(probed, 0);
  });
});

describe("finalizeOne", () => {
  const mk = (impl) => {
    const submitter = mockSubmitter(impl);
    const r = new Relayer({ config: CFG, near: mockNear(), escrow: {}, store: store(), submitter, log: quiet });
    return { r, submitter };
  };

  it("submits and reports the tx hash", async () => {
    const { r, submitter } = mk(async () => "0xabc");
    const res = await r.finalizeOne(7, 0);
    assert.deepEqual(res, { status: "finalized", bountyId: 7, slot: 0, txHash: "0xabc" });
    assert.deepEqual(submitter.calls, [[7, 0]]);
  });

  it("classifies SlotPending as a benign race", async () => {
    const { r } = mk(async () => { throw new Error("Smart contract panicked: SlotPending { bounty_id: 7, slot: 0 }"); });
    const res = await r.finalizeOne(7, 0);
    assert.equal(res.status, "finalize-race");
  });

  it("classifies AlreadyFinalized as a benign race", async () => {
    const { r } = mk(async () => { throw new Error("AlreadyFinalized"); });
    assert.equal((await r.finalizeOne(7, 1)).status, "finalize-race");
  });

  it("classifies ChallengeWindowClosed as immature (clock skew)", async () => {
    const { r } = mk(async () => { throw new Error("ChallengeWindowClosed"); });
    assert.equal((await r.finalizeOne(7, 0)).status, "finalize-immature");
  });

  it("reports genuine errors without throwing", async () => {
    const { r } = mk(async () => { throw new Error("RPC timeout"); });
    const res = await r.finalizeOne(7, 0);
    assert.equal(res.status, "finalize-error");
    assert.match(res.error, /RPC timeout/);
  });
});

describe("finalizePass + pollOnce", () => {
  it("isolates one claim failure without blocking the others", async () => {
    const near = mockNear({
      bounties: [BOUNTY({}), BOUNTY({ id: 8 })],
      claims: { "7:0": CLAIM({}), "8:0": CLAIM({}) },
    });
    const submitter = mockSubmitter(async (id) => {
      if (id === 7) throw new Error("boom");
      return "0xok";
    });
    const r = new Relayer({ config: CFG, near, escrow: {}, store: store(), submitter, log: quiet });
    const out = await r.finalizePass();
    assert.deepEqual(out.map((o) => [o.bountyId, o.status]), [[7, "finalize-error"], [8, "finalized"]]);
    assert.deepEqual(submitter.calls, [[7, 0], [8, 0]]);
  });

  it("settlement still proceeds when finalize discovery fails", async () => {
    const near = mockNear({ fail: "listBounties" });
    // Voucher discovery shares listBounties, so it fails too: pollOnce must
    // report both failures instead of throwing or dropping either.
    const r = new Relayer({ config: CFG, near, escrow: {}, store: store(), submitter: mockSubmitter(), log: quiet });
    const out = await r.pollOnce();
    assert.deepEqual(out.map((o) => o.status), ["finalize-pass-error", "poll-error"]);
  });

  it("finalize results precede settlement results in one poll", async () => {
    const near = mockNear({
      bounties: [BOUNTY({})],
      claims: { "7:0": CLAIM({}) }, // unsigned -> finalized, and yields no voucher
    });
    const r = new Relayer({ config: CFG, near, escrow: {}, store: store(), submitter: mockSubmitter(), log: quiet });
    const out = await r.pollOnce();
    assert.equal(out[0].status, "finalized");
    assert.equal(out.length, 1); // no signed vouchers discovered
  });

  it("runs settlement-only without a submitter", async () => {
    const near = mockNear({ bounties: [BOUNTY({})], claims: { "7:0": CLAIM({}) } });
    const r = new Relayer({ config: CFG, near, escrow: {}, store: store(), submitter: null, log: quiet });
    assert.deepEqual(await r.pollOnce(), []);
  });

  it("never finalizes in V1 mode even with a submitter", async () => {
    const near = mockNear({ bounties: [BOUNTY({})], claims: { "7:0": CLAIM({}) } });
    near.listUnrelayed = async () => [];
    const submitter = mockSubmitter();
    const v1 = { ...CFG, voucherVersion: "1" };
    const r = new Relayer({ config: v1, near, escrow: {}, store: store(), submitter, log: quiet });
    await r.pollOnce();
    assert.deepEqual(submitter.calls, []);
  });

  it("respects FINALIZE_ENABLED=false", async () => {
    const near = mockNear({ bounties: [BOUNTY({})], claims: { "7:0": CLAIM({}) } });
    const submitter = mockSubmitter();
    const off = { ...CFG, finalizeEnabled: false };
    const r = new Relayer({ config: off, near, escrow: {}, store: store(), submitter, log: quiet });
    await r.pollOnce();
    assert.deepEqual(submitter.calls, []);
  });
});

describe("finalize config", () => {
  const BASE_ENV = {
    NEAR_RPC_URL: "https://rpc.testnet.near.org",
    NEAR_CONTRACT_ID: "omnibounty-v3.testnet",
    BASE_RPC_URL: "https://sepolia.base.org",
    ESCROW_ADDRESS: "0x0000000000000000000000000000000000000001",
    MPC_SIGNER_ADDRESS: "0x0000000000000000000000000000000000000002",
    RELAYER_PRIVATE_KEY: "0x" + "11".repeat(32),
  };

  it("defaults to finalize-enabled with no operator (settlement-only)", () => {
    const c = loadConfig({ ...BASE_ENV });
    assert.equal(c.finalizeEnabled, true);
    assert.equal(c.operatorAccountId, null);
    assert.equal(c.operatorPrivateKey, null);
  });

  it("loads operator credentials when both are set", () => {
    const c = loadConfig({
      ...BASE_ENV,
      NEAR_OPERATOR_ACCOUNT_ID: "op.testnet",
      NEAR_OPERATOR_PRIVATE_KEY: "ed25519:secret",
    });
    assert.equal(c.operatorAccountId, "op.testnet");
    assert.equal(c.operatorPrivateKey, "ed25519:secret");
  });

  it("rejects half-configured operator credentials", () => {
    assert.throws(
      () => loadConfig({ ...BASE_ENV, NEAR_OPERATOR_ACCOUNT_ID: "op.testnet" }),
      /together/
    );
  });

  it("honors FINALIZE_ENABLED=false", () => {
    const c = loadConfig({ ...BASE_ENV, FINALIZE_ENABLED: "false" });
    assert.equal(c.finalizeEnabled, false);
  });
});
