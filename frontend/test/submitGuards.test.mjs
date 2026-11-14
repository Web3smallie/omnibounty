import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SubmitGuardError,
  createBusyGuard,
  createGeneration,
  createSubmitGuard,
} from "../lib/submitGuard.mjs";
import { summarizeOwnClaimScan } from "../lib/settlement.mjs";

// P1-13: stale-state/double-submit protection and V3 returning-claim
// tracking. Guard, reconcile, and lookup logic is pure and tested
// directly with mocks; React wiring is pinned by placement tests (the
// repo has no render harness). No live transactions.
const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(HERE, "..", rel), "utf8");

describe("createBusyGuard", () => {
  it("lets exactly one submission win until release", () => {
    const g = createBusyGuard();
    assert.equal(g.isBusy(), false);
    assert.equal(g.tryAcquire(), true);
    assert.equal(g.isBusy(), true);
    assert.equal(g.tryAcquire(), false, "double-click loses the race");
    g.release();
    assert.equal(g.isBusy(), false);
  });

  it("supports retry after a genuine failure", () => {
    const g = createBusyGuard();
    assert.equal(g.tryAcquire(), true);
    g.release(); // failure path releases
    assert.equal(g.tryAcquire(), true, "retry acquires cleanly");
    g.release();
  });

  it("tolerates repeated releases", () => {
    const g = createBusyGuard();
    g.release();
    g.release();
    assert.equal(g.tryAcquire(), true);
  });
});

describe("createSubmitGuard", () => {
  const snap = { bountyId: 7, nearAccount: "a.testnet", evmAddress: "0xabc", evmOnBaseSepolia: true };

  it("snapshots identity and reports no drift when unchanged", () => {
    const g = createSubmitGuard(snap);
    assert.deepEqual(g.snapshot(), snap);
    assert.deepEqual(g.changed({ ...snap }), []);
    g.assertUnchanged({ ...snap });
  });

  it("names every drifted key", () => {
    const g = createSubmitGuard(snap);
    assert.deepEqual(g.changed({ ...snap, nearAccount: "b.testnet", evmOnBaseSepolia: false }), [
      "nearAccount",
      "evmOnBaseSepolia",
    ]);
    assert.deepEqual(g.changed(null), ["bountyId", "nearAccount", "evmAddress", "evmOnBaseSepolia"]);
  });

  it("throws a SubmitGuardError carrying the drifted keys", () => {
    const g = createSubmitGuard(snap);
    assert.throws(() => g.assertUnchanged({ ...snap, bountyId: 8 }), (e) => {
      assert.ok(e instanceof SubmitGuardError);
      assert.equal(e.name, "SubmitGuardError");
      assert.deepEqual(e.changed, ["bountyId"]);
      assert.match(e.message, /bountyId/);
      return true;
    });
  });

  it("copies the snapshot so later mutations cannot corrupt it", () => {
    const g = createSubmitGuard(snap);
    snap.bountyId = 999;
    assert.deepEqual(g.changed({ bountyId: 7, nearAccount: "a.testnet", evmAddress: "0xabc", evmOnBaseSepolia: true }), []);
    snap.bountyId = 7;
  });
});

describe("createGeneration", () => {
  it("marks only the latest async work current", () => {
    const gen = createGeneration();
    const first = gen.issue();
    const second = gen.issue();
    assert.equal(gen.isCurrent(first), false, "stale completion is dropped");
    assert.equal(gen.isCurrent(second), true);
    assert.equal(gen.current(), second);
  });

  it("drops every superseded scan when identity changes repeatedly", () => {
    const gen = createGeneration();
    const ids = [gen.issue(), gen.issue(), gen.issue()];
    assert.deepEqual(ids.map((id) => gen.isCurrent(id)), [false, false, true]);
  });
});

// NOTE: V1 sponsorship (SponsorForm + sponsorV1 reconcile) was removed with
// the V3-only switch; its unit tests were removed with it. V1 claim
// display (ClaimForm) remains as a data-driven legacy fallback.

describe("summarizeOwnClaimScan", () => {
  const C = (recipient, seq, pr) => ({ recipient, claim_seq: seq, pr_number: pr });
  const entries = [
    { slot: 0, claim: null },
    { slot: 1, claim: C("0xother", 1, 11) },
    { slot: 2, claim: C("0xMINE", 4, 22) },
    { slot: 3, claim: C("0xmine", 9, 23) },
  ];

  it("identifies the wallet's latest claim for state reconstruction", () => {
    assert.deepEqual(summarizeOwnClaimScan(entries, "0xmine", 0), {
      status: "found",
      slot: 3,
      claim: C("0xmine", 9, 23),
    });
  });

  it("reports none only when every read succeeded", () => {
    assert.deepEqual(summarizeOwnClaimScan(entries, "0xstranger", 0), {
      status: "none",
      slot: null,
      claim: null,
    });
    assert.deepEqual(summarizeOwnClaimScan([], "0xmine", 0).status, "none");
  });

  it("reports uncertain instead of a false none when reads failed", () => {
    assert.deepEqual(summarizeOwnClaimScan(entries, "0xstranger", 2), {
      status: "uncertain",
      slot: null,
      claim: null,
    });
  });

  it("lets a found claim win over unrelated read failures", () => {
    const found = summarizeOwnClaimScan(entries, "0xmine", 2);
    assert.equal(found.status, "found");
    assert.equal(found.slot, 3);
  });
});

describe("form wiring: double-submit and stale guards", () => {
  const forms = [
    "components/ClaimForm.tsx",
    "components/ClaimFormV3.tsx",
    "components/SponsorFormV3.tsx",
  ];

  it("all submission paths acquire a synchronous busy guard and release it", () => {
    for (const f of forms) {
      const src = read(f);
      assert.ok(src.includes("createBusyGuard"), `${f} uses the busy guard`);
      assert.ok(src.includes("tryAcquire()"), `${f} acquires synchronously (no double-click race)`);
      assert.ok(src.includes(".release()"), `${f} releases so genuine retries stay possible`);
    }
  });

  it("all submission paths drop work after unmount", () => {
    for (const f of forms) {
      const src = read(f);
      assert.ok(src.includes("mountedRef"), `${f} tracks mount state`);
      assert.ok(src.includes("if (!mountedRef.current) return;"), `${f} invalidates obsolete async work`);
    }
  });

  it("all submission paths snapshot submit identity and re-check it", () => {
    for (const f of forms) {
      const src = read(f);
      assert.ok(src.includes("createSubmitGuard"), `${f} snapshots submit identity`);
      assert.ok(src.includes("assertUnchanged"), `${f} re-checks identity before sending`);
    }
  });

  it("suggestId never clobbers user input with a stale response", () => {
    for (const f of ["components/SponsorFormV3.tsx"]) {
      assert.ok(
        read(f).includes("setBountyId((prev) => (prev === current ? String(max + 1) : prev))"),
        `${f} applies suggestions only to an untouched field`
      );
    }
  });
});

describe("form wiring: reconcile and lost-receipt recovery", () => {
  it("V1 claim detects already-claimed bounties and tracks instead of resubmitting", () => {
    const src = read("components/ClaimForm.tsx");
    assert.ok(src.includes("const a = analyze()"), "V1 analyzes fresh at submit (no stale proof)");
    assert.ok(src.includes("getBounty(bountyId)"), "V1 checks live bounty state pre-submit");
    assert.ok(src.includes("alreadyClaimed"), "V1 renders the tracker for landed claims");
  });

  it("V3 claim detects existing claim slots and tracks instead of resubmitting", () => {
    const src = read("components/ClaimFormV3.tsx");
    assert.ok(src.includes("getClaimByPr(bountyId"), "V3 checks for an existing slot pre-submit");
    assert.ok(src.includes("alreadyPr"), "V3 renders the tracker for landed claims");
    assert.ok(src.includes("guard.assertUnchanged"), "V3 re-checks identity at sign time");
  });

  it("V3 sponsor guards every write against wallet drift", () => {
    const src = read("components/SponsorFormV3.tsx");
    for (const fn of ["createNear", "createEscrow", "approveUSDC", "fundEscrow", "markFunded"]) {
      assert.ok(src.includes(`${fn}: guarded(io.${fn})`), `V3 guards ${fn}`);
    }
  });
});

describe("returning-claim tracker wiring", () => {
  it("looks up the wallet's own claim from chain reads with race guards", () => {
    const src = read("components/ReturningClaimTracker.tsx");
    assert.ok(src.includes("getClaim(bountyId, i)"), "scans slots with the deployed view");
    assert.ok(src.includes("summarizeOwnClaimScan"), "derives found/none/uncertain");
    assert.ok(src.includes("createGeneration"), "drops stale scans on identity change");
    assert.ok(src.includes("mountedRef"), "drops work after unmount");
    assert.ok(src.includes("Math.min(slots.length, 16)"), "scan stays within the slot bound");
  });

  it("renders connect, scanning, uncertain, none, and found states", () => {
    const src = read("components/ReturningClaimTracker.tsx");
    assert.ok(src.includes("Connect EVM wallet"), "disconnected wallets get a connect path");
    assert.ok(src.includes("Looking up your claim on NEAR"), "scanning state is explicit");
    assert.ok(src.includes("Could not verify your claim"), "uncertain is distinct from none");
    assert.ok(src.includes("Retry lookup"), "uncertain offers retry");
    assert.ok(src.includes("No claim from the connected wallet yet"), "none is explicit");
    assert.ok(src.includes("v3={{ slots, recipient: evmAddress, prNumber: found.claim.pr_number }}"), "found claims reconstruct tracker state");
  });

  it("distinguishes NEAR claim state from Base settlement state", () => {
    const src = read("components/ReturningClaimTracker.tsx");
    assert.ok(src.includes("<SettlementPanel"), "settlement display stays with the settlement component");
    assert.ok(!src.includes("isVoucherUsed"), "tracker never conflates lookup with settlement reads");
    assert.ok(!src.includes("Paid out"), "tracker never declares payout itself");
  });

  it("is mounted on the V3 bounty page inside an isolated boundary", () => {
    const src = read("app/bounties/[id]/page.tsx");
    assert.ok(src.includes("<ReturningClaimTracker key={bounty.id}"), "tracker is mounted per bounty");
    assert.ok(src.includes('label="returning claim tracker"'), "tracker failure cannot take the page");
  });
});

describe("route-change remounting", () => {
  it("keys stateful bounty components per bounty id", () => {
    const src = read("app/bounties/[id]/page.tsx");
    for (const tag of ["<ClaimForm", "<ClaimFormV3", "<SettlementPanel"]) {
      const at = src.indexOf(tag);
      assert.ok(at >= 0, `${tag} is mounted on the page`);
      assert.ok(src.slice(at, at + 200).includes("key={bounty.id}"), `${tag} remounts per bounty`);
    }
  });
});

describe("V1 claim display and prior fixes preserved", () => {
  it("keeps the legacy V1 claim display and receipt surfacing", () => {
    assert.ok(read("components/ClaimForm.tsx").includes("dryRun("), "V1 dry-run flow intact");
    assert.ok(read("components/ClaimForm.tsx").includes("thrownTxHash"), "V1 failed-tx links intact (P1-8)");
  });

  it("keeps P1-9 through P1-12 wiring in place", () => {
    assert.ok(read("components/wallets.tsx").includes("walletInitReducer"), "P1-9 intact");
    assert.ok(read("lib/near.ts").includes("interpretNearTxOutcome"), "P1-8 intact");
    assert.ok(read("components/SettlementPanel.tsx").includes("createSettlePoller"), "P1-10 intact");
    assert.ok(read("components/Marketplace.tsx").includes("pool.run"), "P1-11 intact");
    assert.ok(read("components/Marketplace.tsx").includes("ErrorBoundary"), "P1-12 intact");
  });
});
