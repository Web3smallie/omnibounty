import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SPONSOR_V3_STEPS,
  buildCreateBountyV3Args,
  buildCriteriaDocument,
  buildEscrowCreateArgs,
  buildMarkFundedArgs,
  isV3ContractConfig,
  reconcileSponsorV3,
  runSponsorV3Flow,
  validateSponsorV3Form,
} from "../lib/sponsorV3.mjs";

// P0-5: V3 sponsorship planner + flow runner, fully mocked (no live tx).
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const SIMPLE_CI = read("testdata/v3/criteria-valid/simple-ci.json");
const MULTI = read("testdata/v3/criteria-valid/multi-winner.json");
const GOLDEN = JSON.parse(read("testdata/v3/golden-hashes.json"));

const NEAR_ACCT = "sponsor.testnet";
const EVM = "0xEeee0000000000000000000000000000000000001";
const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const P = {
  bountyId: 7,
  criteriaJson: SIMPLE_CI,
  hash: GOLDEN["simple-ci"],
  slots: ["1000000"],
  total: "1000000",
  deadline: "0",
};
const WALLETS = { nearAccount: NEAR_ACCT, evmAddress: EVM, evmOnBaseSepolia: true };
const ZERO = "0x0000000000000000000000000000000000000000";
const nearBounty = (over = {}) => ({
  sponsor: NEAR_ACCT,
  criteria_hash: GOLDEN["simple-ci"],
  funded: false,
  ...over,
});
const escrowBounty = (over = {}) => ({
  token: TOKEN,
  sponsor: EVM,
  funded: false,
  totalFunded: "1000000",
  amounts: ["1000000"],
  claimedBitmap: "0",
  refundedBitmap: "0",
  deadline: "0",
  criteriaHash: GOLDEN["simple-ci"],
  ...over,
});
const freshSnapshots = () => ({
  params: P,
  wallets: WALLETS,
  contractIsV3: true,
  paused: false,
  near: null,
  escrow: null,
  allowance: 0n,
  balance: 5000000n,
});

describe("sponsor step order", () => {
  it("follows the deployed workflow: NEAR create first, mark funded last", () => {
    assert.deepEqual(SPONSOR_V3_STEPS, ["nearCreate", "escrowCreate", "approve", "fund", "markFunded"]);
  });
});

describe("validateSponsorV3Form", () => {
  it("accepts an id plus valid criteria and derives funding facts (golden-anchored)", () => {
    const r = validateSponsorV3Form({ bountyId: "7", criteriaText: SIMPLE_CI });
    assert.equal(r.ok, true);
    assert.deepEqual(r.errors, []);
    assert.equal(r.params.bountyId, 7);
    assert.equal(r.params.hash, GOLDEN["simple-ci"]);
    assert.deepEqual(r.params.slots, ["1000000"]);
    assert.equal(r.params.total, "1000000");
    assert.equal(r.params.deadline, "0");
    assert.equal(r.params.repo, "react/react");
  });

  it("sums multi-slot totals independently of the implementation", () => {
    const doc = JSON.parse(MULTI);
    const want = doc.slots.reduce((s, x) => s + BigInt(x.amount), 0n).toString();
    const r = validateSponsorV3Form({ bountyId: 9, criteriaText: MULTI });
    assert.equal(r.ok, true);
    assert.equal(r.params.total, want);
    assert.ok(BigInt(want) > 0n);
  });

  it("rejects bad ids, empty/malformed/invalid criteria", () => {
    for (const id of ["-1", "1.5", "abc", "", "9007199254740992"]) {
      assert.equal(validateSponsorV3Form({ bountyId: id, criteriaText: SIMPLE_CI }).ok, false);
    }
    assert.equal(validateSponsorV3Form({ bountyId: 7, criteriaText: "" }).ok, false);
    assert.equal(validateSponsorV3Form({ bountyId: 7, criteriaText: "{bad" }).ok, false);
    const bad = validateSponsorV3Form({
      bountyId: 7,
      criteriaText: read("testdata/v3/criteria-invalid/zero-amount.json"),
    });
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.some((e) => e.startsWith("criteria:")));
  });
});

describe("contract argument builders", () => {
  it("builds exact NEAR create_bounty / mark_funded args", () => {
    assert.deepEqual(buildCreateBountyV3Args({ bountyId: 7, token: TOKEN, criteriaJson: SIMPLE_CI }), {
      bounty_id: 7,
      token: TOKEN,
      criteria_json: SIMPLE_CI,
    });
    assert.deepEqual(buildMarkFundedArgs(7), { bounty_id: 7 });
  });

  it("builds exact escrow createBounty inputs without aliasing the schedule", () => {
    const a = buildEscrowCreateArgs({
      bountyId: 7,
      token: TOKEN,
      slots: ["1000000", "2000000"],
      deadline: "0",
      hash: GOLDEN["simple-ci"],
    });
    assert.deepEqual(a, {
      bountyId: 7,
      token: TOKEN,
      amounts: ["1000000", "2000000"],
      deadline: "0",
      criteriaHash: GOLDEN["simple-ci"],
    });
    a.amounts.push("1");
    assert.deepEqual(a.amounts.length, 3);
  });
});

describe("isV3ContractConfig", () => {
  it("detects V3 by the V3-only pending_owner field", () => {
    assert.equal(isV3ContractConfig({ owner: "x", pending_owner: null, paused: false }), true);
    assert.equal(isV3ContractConfig({ owner: "x", paused: false }), false);
    assert.equal(isV3ContractConfig(null), false);
    assert.equal(isV3ContractConfig(undefined), false);
    assert.equal(isV3ContractConfig("v3"), false);
  });
});

describe("reconcileSponsorV3", () => {
  it("passes fresh state with nothing adopted", () => {
    const r = reconcileSponsorV3(freshSnapshots());
    assert.deepEqual(r.blockers, []);
    assert.deepEqual(r.warnings, []);
    assert.deepEqual(r.adopted, [false, false, false, false, false]);
  });

  it("blocks on wallets, network, contract, pause, and balance", () => {
    const base = freshSnapshots();
    assert.ok(reconcileSponsorV3({ ...base, wallets: { ...WALLETS, nearAccount: null } }).blockers.length > 0);
    assert.ok(reconcileSponsorV3({ ...base, wallets: { ...WALLETS, evmAddress: null } }).blockers.length > 0);
    assert.ok(
      reconcileSponsorV3({ ...base, wallets: { ...WALLETS, evmOnBaseSepolia: false } }).blockers.some((b) =>
        b.includes("wrong network")
      )
    );
    assert.ok(reconcileSponsorV3({ ...base, contractIsV3: false }).blockers.some((b) => b.includes("V3 contract")));
    assert.ok(reconcileSponsorV3({ ...base, paused: true }).blockers.some((b) => b.includes("paused")));
    assert.ok(reconcileSponsorV3({ ...base, balance: null }).blockers.some((b) => b.includes("balance")));
    assert.ok(
      reconcileSponsorV3({ ...base, balance: 999999n }).blockers.some((b) => b.includes("Insufficient USDC"))
    );
  });

  it("adopts own NEAR progress and blocks foreign or mismatched bounties", () => {
    const own = reconcileSponsorV3({ ...freshSnapshots(), near: nearBounty() });
    assert.deepEqual(own.blockers, []);
    assert.deepEqual(own.adopted, [true, false, false, false, false]);
    const foreign = reconcileSponsorV3({ ...freshSnapshots(), near: nearBounty({ sponsor: "other.testnet" }) });
    assert.ok(foreign.blockers.some((b) => b.includes("different sponsor")));
    assert.deepEqual(foreign.adopted, [false, false, false, false, false]);
    const mismatched = reconcileSponsorV3({ ...freshSnapshots(), near: nearBounty({ criteria_hash: "0x00" }) });
    assert.ok(mismatched.blockers.some((b) => b.includes("different criteria")));
  });

  it("adopts own escrow progress and blocks taken or rescheduled ids", () => {
    const base = { ...freshSnapshots(), near: nearBounty() };
    const created = reconcileSponsorV3({ ...base, escrow: escrowBounty() });
    assert.deepEqual(created.adopted, [true, true, false, false, false]);
    const approved = reconcileSponsorV3({ ...base, escrow: escrowBounty(), allowance: 1000000n });
    assert.deepEqual(approved.adopted, [true, true, true, false, false]);
    const funded = reconcileSponsorV3({ ...base, escrow: escrowBounty({ funded: true }) });
    assert.deepEqual(funded.adopted, [true, true, true, true, false]);
    const foreign = reconcileSponsorV3({
      ...base,
      escrow: escrowBounty({ sponsor: "0xFfff000000000000000000000000000000000002" }),
    });
    assert.ok(foreign.blockers.some((b) => b.includes("taken on the Base escrow")));
    const resched = reconcileSponsorV3({ ...base, escrow: escrowBounty({ amounts: ["5"] }) });
    assert.ok(resched.blockers.some((b) => b.includes("different schedule")));
    const zeroSponsor = reconcileSponsorV3({ ...base, escrow: escrowBounty({ sponsor: ZERO }) });
    assert.deepEqual(zeroSponsor.blockers, []);
    assert.deepEqual(zeroSponsor.adopted, [true, false, false, false, false]);
  });

  it("warns (recoverably) when NEAR is marked funded ahead of the escrow", () => {
    const r = reconcileSponsorV3({ ...freshSnapshots(), near: nearBounty({ funded: true }) });
    assert.deepEqual(r.blockers, []);
    assert.equal(r.warnings.length, 1);
    assert.deepEqual(r.adopted, [true, false, false, false, true]);
  });

  it("reports fully complete flows with nothing remaining", () => {
    const r = reconcileSponsorV3({
      ...freshSnapshots(),
      near: nearBounty({ funded: true }),
      escrow: escrowBounty({ funded: true }),
    });
    assert.deepEqual(r.blockers, []);
    assert.deepEqual(r.adopted, [true, true, true, true, true]);
  });
});

describe("runSponsorV3Flow", () => {
  const mockIo = (over = {}) => {
    const calls = [];
    const state = { near: null, escrow: null, allowance: 0n };
    const io = {
      createNear: async (args) => {
        calls.push(["createNear", args]);
        state.near = { sponsor: NEAR_ACCT, criteria_hash: GOLDEN["simple-ci"], funded: false };
        return { txHash: "near-create" };
      },
      getNear: async (id) => {
        calls.push(["getNear", id]);
        return state.near;
      },
      createEscrow: async (args) => {
        calls.push(["createEscrow", args]);
        state.escrow = { ...escrowBounty(), funded: false };
        return { txHash: "base-create", receipt: { status: 1 } };
      },
      getEscrow: async (id) => {
        calls.push(["getEscrow", id]);
        return state.escrow;
      },
      approveUSDC: async (total) => {
        calls.push(["approveUSDC", total]);
        state.allowance = BigInt(total);
        return { txHash: "approve", receipt: { status: 1 } };
      },
      getAllowance: async () => {
        calls.push(["getAllowance"]);
        return state.allowance;
      },
      fundEscrow: async (id) => {
        calls.push(["fundEscrow", id]);
        state.escrow = { ...state.escrow, funded: true };
        return { txHash: "fund", receipt: { status: 1 } };
      },
      markFunded: async (id) => {
        calls.push(["markFunded", id]);
        state.near = { ...state.near, funded: true };
        return { txHash: "mark" };
      },
      ...over,
    };
    return { io, calls, state };
  };
  const events = () => {
    const seen = [];
    return { seen, onStep: (i, s) => seen.push([i, s.status, s.tx ?? null]) };
  };

  it("executes the full sequence in order with exact args and receipts", async () => {
    const { io, calls } = mockIo();
    const { seen, onStep } = events();
    const r = await runSponsorV3Flow({ params: P, token: TOKEN, adopted: [false, false, false, false, false], io, onStep });
    assert.equal(r.ok, true);
    assert.deepEqual(r.done, [true, true, true, true, true]);
    assert.deepEqual(r.txs, ["near-create", "base-create", "approve", "fund", "mark"]);
    const order = calls.map((c) => c[0]).filter((n) => !n.startsWith("get"));
    assert.deepEqual(order, ["createNear", "createEscrow", "approveUSDC", "fundEscrow", "markFunded"]);
    assert.deepEqual(calls.find((c) => c[0] === "createNear")[1], {
      bounty_id: 7,
      token: TOKEN,
      criteria_json: P.criteriaJson,
    });
    assert.deepEqual(calls.find((c) => c[0] === "createEscrow")[1], {
      bountyId: 7,
      token: TOKEN,
      amounts: ["1000000"],
      deadline: "0",
      criteriaHash: GOLDEN["simple-ci"],
    });
    assert.equal(calls.find((c) => c[0] === "approveUSDC")[1], "1000000");
    assert.ok(seen.some(([i, s]) => i === 4 && s === "done"));
  });

  it("touches no chain calls when everything is adopted (duplicate-run safe)", async () => {
    const { io, calls } = mockIo();
    const r = await runSponsorV3Flow({
      params: P,
      token: TOKEN,
      adopted: [true, true, true, true, true],
      io,
      onStep: () => {},
    });
    assert.equal(r.ok, true);
    assert.deepEqual(calls, []);
  });

  it("resumes partial flows without re-submitting completed steps", async () => {
    const { io, calls } = mockIo();
    const r = await runSponsorV3Flow({
      params: P,
      token: TOKEN,
      adopted: [true, true, false, false, false],
      io,
      onStep: () => {},
    });
    assert.equal(r.ok, true);
    const writes = calls.map((c) => c[0]).filter((n) => !n.startsWith("get"));
    assert.deepEqual(writes, ["approveUSDC", "fundEscrow", "markFunded"]);
  });

  it("surfaces wallet rejection with prior steps kept", async () => {
    const { io } = mockIo({
      fundEscrow: async () => {
        throw new Error("User rejected the request");
      },
    });
    const r = await runSponsorV3Flow({
      params: P,
      token: TOKEN,
      adopted: [true, true, true, false, false],
      io,
      onStep: () => {},
    });
    assert.equal(r.ok, false);
    assert.equal(r.failedStep, 3);
    assert.match(r.message, /User rejected/);
    assert.deepEqual(r.done, [true, true, true, false, false]);
  });

  it("fails Base writes on reverted receipts and unverified state", async () => {
    for (const receipt of [{ status: 0 }, { status: "0x0" }, {}, null]) {
      const { io } = mockIo({
        createEscrow: async () => ({ txHash: "x", receipt }),
      });
      const r = await runSponsorV3Flow({
        params: P,
        token: TOKEN,
        adopted: [true, false, false, false, false],
        io,
        onStep: () => {},
      });
      assert.equal(r.ok, false);
      assert.equal(r.failedStep, 1);
    }
    const invisible = mockIo({ getEscrow: async () => null });
    const r = await runSponsorV3Flow({
      params: P,
      token: TOKEN,
      adopted: [true, false, false, false, false],
      io: invisible.io,
      onStep: () => {},
    });
    assert.equal(r.ok, false);
    assert.match(r.message, /not visible/);
    const lowAllowance = mockIo({ getAllowance: async () => 1n });
    const r2 = await runSponsorV3Flow({
      params: P,
      token: TOKEN,
      adopted: [true, true, false, false, false],
      io: lowAllowance.io,
      onStep: () => {},
    });
    assert.equal(r2.ok, false);
    assert.match(r2.message, /allowance/);
  });

  it("fails NEAR creation when the bounty is not visible afterwards", async () => {
    const { io } = mockIo({ getNear: async () => null });
    const r = await runSponsorV3Flow({
      params: P,
      token: TOKEN,
      adopted: [false, false, false, false, false],
      io,
      onStep: () => {},
    });
    assert.equal(r.ok, false);
    assert.equal(r.failedStep, 0);
  });

  it("refuses to mark funded unless the escrow is funded (fresh re-read)", async () => {
    let marked = 0;
    const { io } = mockIo({
      getEscrow: async () => escrowBounty({ funded: false }),
      markFunded: async () => {
        marked++;
        return { txHash: "mark" };
      },
    });
    const r = await runSponsorV3Flow({
      params: P,
      token: TOKEN,
      adopted: [true, true, true, true, false],
      io,
      onStep: () => {},
    });
    assert.equal(r.ok, false);
    assert.equal(r.failedStep, 4);
    assert.equal(marked, 0);
    assert.match(r.message, /refusing to mark funded/);
  });

  it("survives progress-reporter failures", async () => {
    const { io } = mockIo();
    const r = await runSponsorV3Flow({
      params: P,
      token: TOKEN,
      adopted: [false, false, false, false, false],
      io,
      onStep: () => {
        throw new Error("ui exploded");
      },
    });
    assert.equal(r.ok, true);
  });

  it("stops at NEAR steps whose outcome reports failure, preserving the hash", async () => {
    const { io, calls } = mockIo();
    const failing = {
      ...io,
      createNear: async (args) => {
        calls.push(["createNear", args]);
        return {
          txHash: "Hnear",
          outcome: {
            status: { Failure: { error_message: "Smart contract panicked: BountyExists(7)" } },
            transaction: { hash: "Hnear" },
          },
        };
      },
    };
    const seen = [];
    const r = await runSponsorV3Flow({
      params: P,
      token: TOKEN,
      adopted: [false, false, false, false, false],
      io: failing,
      onStep: (i, s) => seen.push([i, s.status]),
    });
    assert.equal(r.ok, false);
    assert.equal(r.failedStep, 0);
    assert.match(r.message, /BountyExists/);
    assert.deepEqual(r.txs[0], "Hnear");
    assert.deepEqual(calls.map((c) => c[0]), ["createNear"]);
    assert.deepEqual(seen, [
      [0, "pending"],
      [0, "error"],
    ]);
  });

  it("preserves hashes from thrown NEAR errors without advancing", async () => {
    const { io } = mockIo({
      getEscrow: async () => ({ funded: true }),
      markFunded: async () => {
        throw Object.assign(new Error("NEAR transaction could not be verified (missing execution status)."), {
          txHash: "Hmark",
        });
      },
    });
    const r = await runSponsorV3Flow({
      params: P,
      token: TOKEN,
      adopted: [true, true, true, true, false],
      io,
      onStep: () => {},
    });
    assert.equal(r.ok, false);
    assert.equal(r.failedStep, 4);
    assert.deepEqual(r.txs[4], "Hmark");
    assert.deepEqual(r.done, [true, true, true, true, false]);
  });

  it("preserves Base hashes when a write reverts", async () => {
    const { io } = mockIo({
      fundEscrow: async () => ({ txHash: "Hrevert", receipt: { status: 0 } }),
    });
    const r = await runSponsorV3Flow({
      params: P,
      token: TOKEN,
      adopted: [true, true, true, false, false],
      io,
      onStep: () => {},
    });
    assert.equal(r.ok, false);
    assert.equal(r.failedStep, 3);
    assert.deepEqual(r.txs[3], "Hrevert");
  });
});

describe("buildCriteriaDocument", () => {
  const FIELDS = {
    title: "Fix the login redirect",
    description: "Land a merged PR with a regression test.",
    repo: "owner/name",
    slotAmounts: ["25.50"],
    deadline: "",
    challengeWindowSec: "0",
  };

  it("composes a valid document that passes the strict gate", () => {
    const built = buildCriteriaDocument(FIELDS);
    assert.equal(built.ok, true);
    const v = validateSponsorV3Form({ bountyId: "7", criteriaText: built.json });
    assert.equal(v.ok, true);
    assert.equal(v.params.title, "Fix the login redirect");
    assert.equal(v.params.description, "Land a merged PR with a regression test.");
    assert.equal(v.params.repo, "owner/name");
    assert.equal(v.params.policy, "single_winner");
    assert.deepEqual(v.params.slots, ["25500000"]);
    assert.equal(v.params.total, "25500000");
    assert.equal(v.params.deadline, "0");
    assert.match(v.params.hash, /^0x[0-9a-f]{64}$/);
  });

  it("derives ordered_slots for multi-slot schedules", () => {
    const built = buildCriteriaDocument({ ...FIELDS, slotAmounts: ["5", "5", "5"] });
    assert.equal(built.ok, true);
    const v = validateSponsorV3Form({ bountyId: "7", criteriaText: built.json });
    assert.equal(v.ok, true);
    assert.equal(v.params.policy, "ordered_slots");
    assert.deepEqual(v.params.slots, ["5000000", "5000000", "5000000"]);
  });

  it("carries schema fixed values and trims inputs", () => {
    const built = buildCriteriaDocument({ ...FIELDS, title: "  T  ", challengeWindowSec: " 3600 " });
    assert.equal(built.ok, true);
    const doc = JSON.parse(built.json);
    assert.equal(doc.schema, "omnibounty/criteria");
    assert.equal(doc.version, "1");
    assert.equal(doc.title, "T");
    assert.equal(doc.merge_policy, "merged");
    assert.equal(doc.allow_forks, true);
    assert.equal(doc.identity_policy, "open");
    assert.equal(doc.unfilled, "refund_sponsor");
    assert.equal(doc.evidence_max_age_sec, "604800");
    assert.equal(doc.challenge_window_sec, "3600");
    assert.ok(!("issue" in doc), "empty issue URL omits the block");
    assert.ok(!("author_association" in doc), "optional advanced knobs stay out");
  });

  it("includes a validated issue block when a URL is set", () => {
    const built = buildCriteriaDocument({
      ...FIELDS,
      issueUrl: "https://github.com/owner/name/issues/123",
      issueKeywords: "closes, fixes",
      closeReference: true,
    });
    assert.equal(built.ok, true);
    const v = validateSponsorV3Form({ bountyId: "7", criteriaText: built.json });
    assert.equal(v.ok, true);
    assert.deepEqual(JSON.parse(built.json).issue, {
      url: "https://github.com/owner/name/issues/123",
      require_close_reference: true,
      keywords: ["closes", "fixes"],
    });
  });

  it("rejects empty core fields with actionable errors", () => {
    assert.deepEqual(buildCriteriaDocument({ ...FIELDS, title: "  " }).errors, ["title must not be empty"]);
    assert.deepEqual(buildCriteriaDocument({ ...FIELDS, description: "" }).errors, ["description must not be empty"]);
    assert.deepEqual(buildCriteriaDocument({ ...FIELDS, repo: "" }).errors, ["repo must not be empty"]);
  });

  it("rejects bad slot amounts, deadlines, windows, and keywords", () => {
    assert.match(
      buildCriteriaDocument({ ...FIELDS, slotAmounts: ["abc"] }).errors.join(";"),
      /slot #0/
    );
    assert.match(
      buildCriteriaDocument({ ...FIELDS, slotAmounts: ["1.1234567"] }).errors.join(";"),
      /slot #0/
    );
    assert.match(
      buildCriteriaDocument({ ...FIELDS, slotAmounts: [] }).errors.join(";"),
      /1 and 16/
    );
    assert.match(
      buildCriteriaDocument({ ...FIELDS, deadline: "not-a-date" }).errors.join(";"),
      /deadline/
    );
    assert.match(
      buildCriteriaDocument({ ...FIELDS, challengeWindowSec: "1.5" }).errors.join(";"),
      /challenge window/
    );
    assert.match(
      buildCriteriaDocument({
        ...FIELDS,
        issueUrl: "https://github.com/owner/name/issues/1",
        issueKeywords: "  ",
      }).errors.join(";"),
      /keywords/
    );
  });

  it("lets the strict gate catch cross-field violations", () => {
    // Builder assembles; the criteria gate still owns repo/URL binding.
    const built = buildCriteriaDocument({
      ...FIELDS,
      repo: "owner/name",
      issueUrl: "https://github.com/other/repo/issues/1",
      issueKeywords: "closes",
    });
    assert.equal(built.ok, true);
    const v = validateSponsorV3Form({ bountyId: "7", criteriaText: built.json });
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes("issue.url")));
  });
});
