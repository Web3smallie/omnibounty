import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FINALIZE_OVERDUE_SEC,
  RELAYER_POLL_SEC,
  SCHEDULER_TICK_SEC,
  SETTLE_OVERDUE_SEC,
  finalizeOverdue,
  formatWaitDuration,
  maturedAtSec,
  relayerPipelineStatus,
  settleOverdue,
  stageElapsedSec,
} from "../lib/relayerStatus.mjs";

// P1-14: honest relayer/pipeline status. Thresholds pin the documented
// off-chain cadences (30s relayer poll, 10-minute finalize scheduler);
// overdue rules fire only on healthy reads, so our own RPC failures can
// never read as a relayer delay. No live chains, no transactions.
const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(HERE, "..", rel), "utf8");

const NOW = 2000000;

describe("documented cadences", () => {
  it("pins the relayer poll, scheduler tick, and overdue multiples", () => {
    assert.equal(RELAYER_POLL_SEC, 30);
    assert.equal(SCHEDULER_TICK_SEC, 600);
    assert.equal(FINALIZE_OVERDUE_SEC, 3 * SCHEDULER_TICK_SEC);
    assert.equal(SETTLE_OVERDUE_SEC, 60 * RELAYER_POLL_SEC);
  });
});

describe("stageElapsedSec", () => {
  it("measures stage waits without negatives or throws", () => {
    assert.equal(stageElapsedSec(1000, 1090), 90);
    assert.equal(stageElapsedSec(1000, 1000), 0);
    assert.equal(stageElapsedSec(1000, 500), 0);
    assert.equal(stageElapsedSec(0, NOW), 0, "missing start never fabricates an epoch wait");
    assert.equal(stageElapsedSec(-5, NOW), 0);
    assert.equal(stageElapsedSec(NaN, NOW), 0);
    assert.equal(stageElapsedSec(1000, NaN), 0);
  });
});

describe("formatWaitDuration", () => {
  it("renders short human durations", () => {
    assert.equal(formatWaitDuration(0), "0s");
    assert.equal(formatWaitDuration(45), "45s");
    assert.equal(formatWaitDuration(90), "1m 30s");
    assert.equal(formatWaitDuration(600), "10m 00s");
    assert.equal(formatWaitDuration(3700), "1h 1m");
    assert.equal(formatWaitDuration(-3), "0s");
    assert.equal(formatWaitDuration(NaN), "0s");
  });
});

describe("maturedAtSec", () => {
  it("prefers the challenge end and falls back to qualification", () => {
    assert.equal(maturedAtSec({ challenge_ends_at: 100, qualified_at: 50 }), 100);
    assert.equal(maturedAtSec({ challenge_ends_at: 0, qualified_at: 50 }), 50);
    assert.equal(maturedAtSec({ qualified_at: 50 }), 50);
    assert.equal(maturedAtSec({}), 0);
    assert.equal(maturedAtSec(null), 0);
  });
});

describe("finalizeOverdue", () => {
  it("fires only when matured long ago with zero observed progress", () => {
    const maturedAt = NOW - FINALIZE_OVERDUE_SEC - 1;
    assert.equal(finalizeOverdue({ maturedAt, hasProgress: false, nowSec: NOW }), true);
    assert.equal(finalizeOverdue({ maturedAt, hasProgress: true, nowSec: NOW }), false);
  });

  it("stays quiet inside the normal window and before maturity", () => {
    assert.equal(
      finalizeOverdue({ maturedAt: NOW - 60, hasProgress: false, nowSec: NOW }),
      false
    );
    assert.equal(
      finalizeOverdue({ maturedAt: NOW - FINALIZE_OVERDUE_SEC, hasProgress: false, nowSec: NOW }),
      false,
      "exactly at the threshold is not overdue"
    );
    assert.equal(finalizeOverdue({ maturedAt: NOW + 60, hasProgress: false, nowSec: NOW }), false);
    assert.equal(finalizeOverdue({ maturedAt: 0, hasProgress: false, nowSec: NOW }), false);
  });
});

describe("settleOverdue", () => {
  const old = NOW - SETTLE_OVERDUE_SEC - 1;

  it("fires only for confirmed-unsettled vouchers far past creation", () => {
    assert.equal(settleOverdue({ voucherCreatedAt: old, used: false, nowSec: NOW }), true);
    assert.equal(settleOverdue({ voucherCreatedAt: NOW - 60, used: false, nowSec: NOW }), false);
    assert.equal(
      settleOverdue({ voucherCreatedAt: NOW - SETTLE_OVERDUE_SEC, used: false, nowSec: NOW }),
      false,
      "exactly at the threshold is not overdue"
    );
  });

  it("never alarms on unknown or settled reads", () => {
    assert.equal(settleOverdue({ voucherCreatedAt: old, used: null, nowSec: NOW }), false);
    assert.equal(settleOverdue({ voucherCreatedAt: old, used: true, nowSec: NOW }), false);
    assert.equal(settleOverdue({ voucherCreatedAt: old, used: "yes", nowSec: NOW }), false);
    assert.equal(settleOverdue({ voucherCreatedAt: 0, used: false, nowSec: NOW }), false);
    assert.equal(settleOverdue({ voucherCreatedAt: old, used: false, nowSec: NaN }), false);
  });
});

describe("relayerPipelineStatus", () => {
  const claim = (overrides = {}) => ({ qualified_at: NOW - 5000, challenge_ends_at: NOW - 5000, ...overrides });

  it("reports settled and never lets status hide a confirmed payout", () => {
    assert.deepEqual(relayerPipelineStatus({ phase: "paid", readsOk: true, nowSec: NOW }), { status: "settled" });
    assert.deepEqual(
      relayerPipelineStatus({ phase: "settling", used: true, readsOk: false, nowSec: NOW }),
      { status: "settled" },
      "settlement wins even when reads are failing"
    );
    assert.deepEqual(
      relayerPipelineStatus({
        phase: "settling",
        used: true,
        voucherCreatedAt: NOW - SETTLE_OVERDUE_SEC - 9999,
        readsOk: true,
        nowSec: NOW,
      }),
      { status: "settled" },
      "settlement wins no matter how stale the voucher looks"
    );
  });

  it("reports unknown when evidence is insufficient", () => {
    assert.deepEqual(relayerPipelineStatus({ phase: "finalizing", claim: claim(), readsOk: false, nowSec: NOW }), {
      status: "unknown",
    });
    assert.deepEqual(
      relayerPipelineStatus({ phase: "settling", used: null, voucherCreatedAt: 1, readsOk: true, nowSec: NOW }),
      { status: "unknown" },
      "unreadable settlement state stays unknown, never delayed"
    );
  });

  it("reports processing on positive on-chain evidence of pipeline action", () => {
    assert.deepEqual(relayerPipelineStatus({ phase: "signing", readsOk: true, nowSec: NOW }), {
      status: "processing",
    });
  });

  it("reports awaiting for normal pending settlement", () => {
    assert.deepEqual(relayerPipelineStatus({ phase: "qualifying", readsOk: true, nowSec: NOW }), {
      status: "awaiting",
    });
    assert.deepEqual(relayerPipelineStatus({ phase: "qualified", readsOk: true, nowSec: NOW }), {
      status: "awaiting",
    });
    assert.deepEqual(
      relayerPipelineStatus({ phase: "finalizing", claim: claim({ challenge_ends_at: NOW - 60 }), readsOk: true, nowSec: NOW }),
      { status: "awaiting" }
    );
    assert.deepEqual(
      relayerPipelineStatus({ phase: "settling", used: false, voucherCreatedAt: NOW - 60, readsOk: true, nowSec: NOW }),
      { status: "awaiting" }
    );
  });

  it("reports delayed only on overdue waits with healthy reads", () => {
    const fin = relayerPipelineStatus({ phase: "finalizing", claim: claim(), readsOk: true, nowSec: NOW });
    assert.equal(fin.status, "delayed");
    assert.equal(fin.stage, "finalize");
    assert.equal(fin.sinceSec, NOW - 5000);
    const stl = relayerPipelineStatus({
      phase: "settling",
      used: false,
      voucherCreatedAt: NOW - 5000,
      readsOk: true,
      nowSec: NOW,
    });
    assert.equal(stl.status, "delayed");
    assert.equal(stl.stage, "settle");
  });

  it("defaults safely on empty input", () => {
    assert.deepEqual(relayerPipelineStatus(), { status: "awaiting" });
    assert.deepEqual(relayerPipelineStatus({}), { status: "awaiting" });
  });
});

describe("tracker wiring", () => {
  const panel = read("components/SettlementPanel.tsx");

  it("derives V3 display from evidence with healthy-read gating", () => {
    assert.ok(panel.includes('from "../lib/relayerStatus.mjs"'), "tracker uses the status module");
    assert.ok(panel.includes("relayerPipelineStatus({"), "finalization display is derived, not asserted");
    assert.ok(panel.includes("readsOk: error === null"), "overdue alarms require healthy reads");
  });

  it("shows elapsed waits and an honest delayed state for finalization", () => {
    assert.ok(panel.includes("Matured — waiting for finalization ("), "normal wait shows elapsed time");
    assert.ok(panel.includes('pipe.status === "delayed"'), "delayed branch is explicit");
    assert.ok(panel.includes("Matured — finalization delayed ("), "delayed wait shows elapsed time");
    assert.ok(
      panel.includes("The finalization path may be"),
      "delayed copy hedges: outage is possible, not confirmed"
    );
    assert.ok(panel.includes("chain reads are fine and this panel keeps watching"), "delayed keeps polling");
  });

  it("makes no unsupported promises about relayer timing", () => {
    assert.ok(!panel.includes("≤30s"), "no 30s dispatch promise (scheduler path runs 10-minute ticks)");
    assert.ok(!panel.includes("the relayer is submitting finalization"), "no asserted relayer action");
    assert.ok(
      panel.includes("matured claims are picked up for finalization automatically"),
      "qualified copy stays neutral across finalization paths"
    );
  });

  it("alarms settlement delays only on confirmed-unsettled vouchers", () => {
    assert.ok(panel.includes("settleOverdue({ voucherCreatedAt, used, nowSec })"), "settling display checks overdue");
    assert.ok(
      panel.includes("used === false && settleOverdue"),
      "unknown settlement states never trigger the delayed note"
    );
    assert.ok(panel.includes("Still not settled after"), "delayed settlement is surfaced with elapsed time");
    assert.ok(panel.includes("The relayer path may be"), "settlement delay hedges honestly");
  });

  it("keeps settlement attribution where the relayer is the only settler", () => {
    assert.ok(
      panel.includes("Signed — waiting for the relayer to settle on Base"),
      "settlement wait still names the relayer (only settlement path)"
    );
  });

  it("keeps the claim form free of unsupported finalization claims", () => {
    const form = read("components/ClaimFormV3.tsx");
    assert.ok(!form.includes("the relayer finalizes matured claims"), "no single-path attribution");
    assert.ok(form.includes("matured claims are finalized automatically"), "success copy stays neutral");
  });
});

describe("prior fixes preserved", () => {
  it("keeps P1-10 polling, P1-8 validation, and P1-13 guards wired", () => {
    const panel = read("components/SettlementPanel.tsx");
    assert.ok(panel.includes("createSettlePoller"), "P1-10 polling still drives settlement checks");
    assert.ok(panel.includes("settleStatus"), "P1-10 unknown/unavailable states still render");
    assert.ok(read("lib/near.ts").includes("interpretNearTxOutcome"), "P1-8 intact");
    assert.ok(read("components/SponsorFormV3.tsx").includes("guardedIo"), "P1-13 submit guards intact");
    assert.ok(
      read("components/ClaimFormV3.tsx").includes("getClaimByPr(bountyId"),
      "P1-13 lost-receipt check intact"
    );
  });
});
