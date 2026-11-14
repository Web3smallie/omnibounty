import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import {
  SETTLE_BASE_DELAY_MS,
  SETTLE_MAX_DELAY_MS,
  SETTLE_MAX_UNKNOWNS,
  classifyUsedValue,
  createSettlePoller,
  initialSettlePollState,
  isPermanentPollError,
  pollDelayForFailures,
  pollErrorMessage,
  settlePollReducer,
} from "../lib/settlePoll.mjs";
import { ESCROW_ABI } from "../lib/escrowAbi.mjs";
import {
  VOUCHER_CLAIMED_TOPIC,
  VOUCHER_CLAIMED_TOPIC_V2,
  isSuccessfulReceipt,
  payoutScanSpec,
} from "../lib/display.mjs";

// P1-10: resilient settlement polling. Every chain read is mocked or
// scripted; no live RPC, no transactions.
const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async (n = 8) => {
  for (let i = 0; i < n; i++) await tick();
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeScheduler() {
  let nextId = 1;
  const timers = new Map();
  const api = {
    timers,
    schedule(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, ms });
      return id;
    },
    cancel(id) {
      timers.delete(id);
    },
    fire(id) {
      const t = timers.get(id);
      assert.ok(t, "expected a pending timer");
      timers.delete(id);
      t.fn();
    },
    fireOnly() {
      assert.equal(timers.size, 1, "expected exactly one pending timer");
      api.fire([...timers.keys()][0]);
    },
    delays() {
      return [...timers.values()].map((t) => t.ms);
    },
  };
  return api;
}

/// Scripted reads: each entry is a value, an Error to throw, or a
/// deferred whose promise the read returns (for overlap races).
function makePoller(steps, opts = {}) {
  const states = [];
  const sched = makeScheduler();
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const read = async () => {
    const i = calls++;
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      const step = typeof steps === "function" ? steps(i) : steps[i];
      if (step && typeof step === "object" && "promise" in step) return await step.promise;
      if (step instanceof Error) throw step;
      return step;
    } finally {
      active--;
    }
  };
  const poller = createSettlePoller({
    read,
    onState: (s) => states.push({ ...s }),
    schedule: sched.schedule,
    cancel: sched.cancel,
    baseMs: 1000,
    maxMs: 8000,
    maxUnknowns: 3,
    ...opts,
  });
  return {
    poller,
    states,
    sched,
    calls: () => calls,
    maxActive: () => maxActive,
    last: () => states[states.length - 1],
  };
}

describe("classifyUsedValue", () => {
  it("accepts only exact booleans as evidence", () => {
    assert.equal(classifyUsedValue(true), "settled");
    assert.equal(classifyUsedValue(false), "not-settled");
    for (const v of [null, undefined, 0, 1, "true", "false", {}, [], NaN]) {
      assert.equal(classifyUsedValue(v), "unknown");
    }
  });
});

describe("isPermanentPollError", () => {
  it("flags reverts, undecodable data, and unsupported setups", () => {
    assert.equal(isPermanentPollError(Object.assign(new Error("reverted"), { code: "CALL_EXCEPTION" })), true);
    assert.equal(isPermanentPollError(Object.assign(new Error("bad"), { code: "BAD_DATA" })), true);
    assert.equal(isPermanentPollError(Object.assign(new Error("nope"), { code: "UNSUPPORTED_OPERATION" })), true);
    assert.equal(isPermanentPollError(new Error("Escrow version mismatch: needs V2 but reported v1.")), true);
    assert.equal(isPermanentPollError(new Error("eth_call unsupported on this provider")), true);
    assert.equal(isPermanentPollError(new Error("invalid contract address")), true);
  });

  it("treats transport blips, timeouts, and unknown shapes as transient", () => {
    assert.equal(isPermanentPollError(new Error("fetch failed")), false);
    assert.equal(isPermanentPollError(Object.assign(new Error("timeout"), { code: "TIMEOUT" })), false);
    assert.equal(isPermanentPollError(Object.assign(new Error("limit exceeded"), { code: "SERVER_ERROR" })), false);
    assert.equal(isPermanentPollError(Object.assign(new Error("oops"), { code: "NETWORK_ERROR" })), false);
    assert.equal(isPermanentPollError(new Error("Base RPC HTTP 503")), false);
    assert.equal(isPermanentPollError(null), false);
    assert.equal(isPermanentPollError("plain string"), false);
  });
});

describe("pollDelayForFailures", () => {
  it("backs off exponentially from the base delay", () => {
    assert.equal(pollDelayForFailures(0, { baseMs: 1000, maxMs: 8000 }), 1000);
    assert.equal(pollDelayForFailures(1, { baseMs: 1000, maxMs: 8000 }), 1000);
    assert.equal(pollDelayForFailures(2, { baseMs: 1000, maxMs: 8000 }), 2000);
    assert.equal(pollDelayForFailures(3, { baseMs: 1000, maxMs: 8000 }), 4000);
  });

  it("caps the delay at the configured maximum", () => {
    assert.equal(pollDelayForFailures(4, { baseMs: 1000, maxMs: 8000 }), 8000);
    assert.equal(pollDelayForFailures(99, { baseMs: 1000, maxMs: 8000 }), 8000);
    assert.equal(pollDelayForFailures(2), Math.min(SETTLE_MAX_DELAY_MS, SETTLE_BASE_DELAY_MS * 2));
  });

  it("falls back to defaults on invalid input", () => {
    assert.equal(pollDelayForFailures(-1), SETTLE_BASE_DELAY_MS);
    assert.equal(pollDelayForFailures(NaN), SETTLE_BASE_DELAY_MS);
    assert.equal(pollDelayForFailures(1, { baseMs: -5 }), SETTLE_BASE_DELAY_MS);
  });
});

describe("pollErrorMessage", () => {
  it("keeps actionable messages and caps length without throwing", () => {
    assert.equal(pollErrorMessage(new Error("Base RPC HTTP 503")), "Base RPC HTTP 503");
    assert.equal(pollErrorMessage(new Error("x".repeat(300))).length, 201);
    assert.equal(pollErrorMessage(new Error("   ")), "Settlement check failed.");
    assert.equal(pollErrorMessage(null), "Settlement check failed.");
  });
});

describe("settlePollReducer", () => {
  it("tracks attempt, settled, and not-settled", () => {
    let s = initialSettlePollState();
    s = settlePollReducer(s, { type: "ATTEMPT", attempt: 1 });
    assert.deepEqual(s, { status: "checking", used: null, failures: 0, error: null, attempt: 1 });
    assert.deepEqual(settlePollReducer(s, { type: "SETTLED", attempt: 1 }), {
      status: "settled",
      used: true,
      failures: 0,
      error: null,
      attempt: 1,
    });
    assert.deepEqual(settlePollReducer(s, { type: "NOT_SETTLED", attempt: 1 }), {
      status: "not-settled",
      used: false,
      failures: 0,
      error: null,
      attempt: 1,
    });
  });

  it("counts unknowns and flips to unavailable at the limit", () => {
    let s = settlePollReducer(initialSettlePollState(), { type: "ATTEMPT", attempt: 1 });
    s = settlePollReducer(s, { type: "UNKNOWN", attempt: 1, message: "e1", maxUnknowns: 3 });
    assert.deepEqual(s, { status: "checking", used: null, failures: 1, error: "e1", attempt: 1 });
    s = settlePollReducer(s, { type: "UNKNOWN", attempt: 1, message: "e2", maxUnknowns: 3 });
    assert.equal(s.status, "checking");
    s = settlePollReducer(s, { type: "UNKNOWN", attempt: 1, message: "e3", maxUnknowns: 3 });
    assert.deepEqual(s, { status: "unavailable", used: null, failures: 3, error: "e3", attempt: 1 });
  });

  it("honours the default unknown budget", () => {
    let s = settlePollReducer(initialSettlePollState(), { type: "ATTEMPT", attempt: 1 });
    for (let i = 1; i < SETTLE_MAX_UNKNOWNS; i++) {
      s = settlePollReducer(s, { type: "UNKNOWN", attempt: 1, message: "x" });
      assert.equal(s.status, "checking");
    }
    s = settlePollReducer(s, { type: "UNKNOWN", attempt: 1, message: "x" });
    assert.equal(s.status, "unavailable");
  });

  it("records permanent failures without touching the unknown budget", () => {
    const s = settlePollReducer(
      { status: "checking", used: null, failures: 1, error: null, attempt: 1 },
      { type: "FAILED", attempt: 1, message: "unsupported" }
    );
    assert.deepEqual(s, { status: "failed", used: null, failures: 1, error: "unsupported", attempt: 1 });
  });

  it("ignores stale settlements and unknown actions", () => {
    const s = { status: "checking", used: null, failures: 0, error: null, attempt: 2 };
    assert.equal(settlePollReducer(s, { type: "SETTLED", attempt: 1 }), s);
    assert.equal(settlePollReducer(s, { type: "NOT_SETTLED", attempt: 1 }), s);
    assert.equal(settlePollReducer(s, { type: "UNKNOWN", attempt: 1, message: "late" }), s);
    assert.equal(settlePollReducer(s, { type: "FAILED", attempt: 1, message: "late" }), s);
    assert.equal(settlePollReducer(s, { type: "NOPE" }), s);
    assert.equal(settlePollReducer(s, null), s);
  });
});

describe("createSettlePoller", () => {
  it("requires a read function", () => {
    assert.throws(() => createSettlePoller({}), /read function/);
    assert.throws(() => createSettlePoller(), /read function/);
  });

  it("detects immediate settlement and stops", async () => {
    const t = makePoller([true]);
    assert.equal(t.poller.start(), true);
    await flush();
    assert.equal(t.calls(), 1);
    assert.deepEqual(t.last(), { status: "settled", used: true, failures: 0, error: null, attempt: 1 });
    assert.equal(t.sched.timers.size, 0);
    assert.deepEqual(t.poller.getState().status, "settled");
  });

  it("reports not-yet-settled and keeps polling on cadence", async () => {
    const t = makePoller([false, false]);
    t.poller.start();
    await flush();
    assert.deepEqual(t.last(), { status: "not-settled", used: false, failures: 0, error: null, attempt: 1 });
    assert.deepEqual(t.sched.delays(), [1000]);
    t.sched.fireOnly();
    await flush();
    assert.equal(t.calls(), 2);
    assert.equal(t.last().status, "not-settled");
    assert.equal(t.last().attempt, 2);
    t.poller.stop();
  });

  it("recovers after a transient RPC failure", async () => {
    const t = makePoller([new Error("Base RPC HTTP 503"), false]);
    t.poller.start();
    await flush();
    assert.equal(t.last().status, "checking");
    assert.equal(t.last().failures, 1);
    assert.match(t.last().error, /503/);
    assert.deepEqual(t.sched.delays(), [1000]);
    t.sched.fireOnly();
    await flush();
    assert.deepEqual(t.last(), { status: "not-settled", used: false, failures: 0, error: null, attempt: 2 });
    t.poller.stop();
  });

  it("backs off across consecutive failures, then goes unavailable", async () => {
    const t = makePoller([new Error("down"), new Error("down"), new Error("down")]);
    t.poller.start();
    await flush();
    assert.deepEqual(t.sched.delays(), [1000]);
    t.sched.fireOnly();
    await flush();
    assert.equal(t.last().failures, 2);
    assert.deepEqual(t.sched.delays(), [2000]);
    t.sched.fireOnly();
    await flush();
    assert.equal(t.calls(), 3);
    assert.deepEqual(t.last(), { status: "unavailable", used: null, failures: 3, error: "down", attempt: 3 });
    assert.equal(t.sched.timers.size, 0, "auto-polling stops when unavailable");
  });

  it("treats null and malformed values as unknown, never settled", async () => {
    for (const v of [null, undefined, 0, "true", {}]) {
      const t = makePoller([v], { maxUnknowns: 99 });
      t.poller.start();
      await flush();
      assert.equal(t.last().status, "checking", `value ${String(v)} must not settle`);
      assert.equal(t.last().used, null);
      assert.equal(t.last().failures, 1);
      assert.match(t.last().error, /no usable settlement state/);
      assert.equal(t.sched.timers.size, 1, "unknown values schedule a retry");
      t.poller.stop();
    }
  });

  it("stops at once on permanent/unsupported errors", async () => {
    const revert = Object.assign(new Error("execution reverted"), { code: "CALL_EXCEPTION" });
    const t = makePoller([revert]);
    t.poller.start();
    await flush();
    assert.equal(t.last().status, "failed");
    assert.equal(t.last().used, null);
    assert.match(t.last().error, /reverted/);
    assert.equal(t.sched.timers.size, 0, "no auto-retry after a permanent error");

    const mismatch = makePoller([new Error("Escrow version mismatch: needs V1 but reported unknown.")]);
    mismatch.poller.start();
    await flush();
    assert.equal(mismatch.last().status, "failed");
  });

  it("recovers through manual retry after becoming unavailable", async () => {
    const t = makePoller([new Error("down"), new Error("down"), new Error("down"), false]);
    t.poller.start();
    await flush();
    t.sched.fireOnly();
    await flush();
    t.sched.fireOnly();
    await flush();
    assert.equal(t.last().status, "unavailable");
    assert.equal(t.poller.retry(), true, "retry polls immediately");
    await flush();
    assert.equal(t.calls(), 4);
    assert.deepEqual(t.last(), { status: "not-settled", used: false, failures: 0, error: null, attempt: 4 });
    assert.deepEqual(t.sched.delays(), [1000]);
    t.poller.stop();
  });

  it("recovers through manual retry after a permanent error", async () => {
    const revert = Object.assign(new Error("execution reverted"), { code: "CALL_EXCEPTION" });
    const t = makePoller([revert, true]);
    t.poller.start();
    await flush();
    assert.equal(t.last().status, "failed");
    t.poller.retry();
    await flush();
    assert.equal(t.last().status, "settled");
    assert.equal(t.last().used, true);
  });

  it("never overlaps reads: start and retry during flight are ignored", async () => {
    const d1 = deferred();
    const d2 = deferred();
    const t = makePoller([d1, d2]);
    assert.equal(t.poller.start(), true);
    await flush(2);
    assert.equal(t.poller.start(), false);
    assert.equal(t.poller.retry(), false);
    assert.equal(t.calls(), 1);
    d1.resolve(false);
    await flush();
    assert.equal(t.last().status, "not-settled");
    t.sched.fireOnly();
    await flush(2);
    assert.equal(t.calls(), 2);
    assert.equal(t.poller.retry(), false, "retry during the second flight is ignored");
    d2.resolve(false);
    await flush();
    assert.equal(t.maxActive(), 1, "reads never overlapped");
    t.poller.stop();
  });

  it("stop() cancels the timer and drops late updates (unmount-safe)", async () => {
    const d = deferred();
    const t = makePoller([d]);
    t.poller.start();
    await flush(2);
    const before = t.states.length;
    t.poller.stop();
    assert.equal(t.sched.timers.size, 0);
    d.resolve(true);
    await flush();
    assert.equal(t.states.length, before, "no update after stop");
    assert.equal(t.poller.getState().status, "checking");

    const t2 = makePoller([false]);
    t2.poller.start();
    await flush();
    assert.equal(t2.sched.timers.size, 1);
    t2.poller.stop();
    assert.equal(t2.sched.timers.size, 0, "pending timer cancelled on stop");
  });

  it("ignores a stale settlement when a restart supersedes it", async () => {
    const slow = deferred();
    const t = makePoller([slow, false]);
    t.poller.start();
    await flush(2);
    t.poller.stop();
    t.poller.start(); // restart races the in-flight read: no overlap, re-poll on settle
    assert.equal(t.calls(), 1);
    slow.resolve(true); // stale success must not report settlement
    await flush();
    assert.equal(t.calls(), 2, "restart re-polls once the stale read settles");
    assert.ok(t.states.every((s) => s.status !== "settled"), "stale true never surfaces");
    assert.equal(t.last().status, "not-settled");
    t.poller.stop();
  });

  it("converts synchronous read throws into retryable unknowns", async () => {
    const t = makePoller(
      (i) => {
        if (i === 0) throw new Error("sync blowup");
        return false;
      },
      { maxUnknowns: 99 }
    );
    t.poller.start();
    await flush();
    assert.equal(t.last().status, "checking");
    assert.match(t.last().error, /sync blowup/);
    t.sched.fireOnly();
    await flush();
    assert.equal(t.last().status, "not-settled");
    t.poller.stop();
  });
});

describe("V1/V2 settlement routing regression", () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const V1_SRC = readFileSync(join(ROOT, "contracts", "base", "OmniEscrow.sol"), "utf8");
  const V2_SRC = readFileSync(join(ROOT, "contracts", "base-v3", "src", "OmniEscrowV2.sol"), "utf8");

  it("reads settlement through one usedVoucher(bytes32)->bool accessor on both versions", () => {
    const fn = new ethers.Interface(ESCROW_ABI).getFunction("usedVoucher");
    assert.deepEqual(fn.inputs.map((p) => p.type), ["bytes32"]);
    assert.deepEqual(fn.outputs.map((p) => p.type), ["bool"]);
    // Both Solidity sources declare the same public mapping, which
    // generates the identical getter selector — the shared read used by
    // isVoucherUsed stays version-safe without a version gate.
    assert.ok(V1_SRC.includes("mapping(bytes32 => bool) public usedVoucher"), "V1 declares usedVoucher");
    assert.ok(V2_SRC.includes("mapping(bytes32 digest => bool) public usedVoucher"), "V2 declares usedVoucher");
    const v2Selector = new ethers.Interface(["function usedVoucher(bytes32) view returns (bool)"]).getFunction(
      "usedVoucher"
    ).selector;
    assert.equal(fn.selector, v2Selector);
  });

  it("isVoucherUsed validates the boolean shape instead of casting", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "base.ts"), "utf8");
    assert.ok(src.includes('typeof used !== "boolean"'), "non-boolean reads are rejected");
    assert.ok(src.includes("malformed usedVoucher result"), "rejection names the malformed read");
  });

  it("routes payout discovery by escrow version and refuses unknown versions", () => {
    const v1 = payoutScanSpec("v1");
    const v2 = payoutScanSpec("v2");
    assert.equal(v1.topic, VOUCHER_CLAIMED_TOPIC);
    assert.equal(v2.topic, VOUCHER_CLAIMED_TOPIC_V2);
    assert.notEqual(v1.topic, v2.topic);
    assert.equal(typeof v1.decode, "function");
    assert.equal(typeof v2.decode, "function");
    assert.throws(() => payoutScanSpec("unknown"), /unsupported escrow version/);
    assert.throws(() => payoutScanSpec(null), /unsupported escrow version/);
  });

  it("proves payout transactions by receipt status 0x1 only", () => {
    assert.equal(isSuccessfulReceipt({ status: "0x1" }), true);
    assert.equal(isSuccessfulReceipt({ status: "0x0" }), false);
    assert.equal(isSuccessfulReceipt({ status: 1 }), false);
    assert.equal(isSuccessfulReceipt({}), false);
    assert.equal(isSuccessfulReceipt(null), false);
  });
});

describe("SettlementPanel polling wiring", () => {
  it("drives both trackers through the poller with retry actions", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "components", "SettlementPanel.tsx"), "utf8");
    assert.ok(src.includes('from "../lib/settlePoll.mjs"'), "panel uses the polling lifecycle");
    assert.ok(src.includes("createSettlePoller"), "panel creates a poller per watched voucher");
    assert.ok(src.includes("poller.stop()"), "timers and late updates are cleaned up");
    assert.ok(src.includes("VOUCHER_FETCH_MAX_FAILURES"), "transient voucher-fetch failures are tolerated");
    assert.ok(src.includes("Settlement check temporarily unavailable"), "unavailable state is surfaced");
    assert.ok(src.includes("Settlement check failed"), "failed state is surfaced");
    assert.ok(src.includes("Retry check"), "exhausted checks offer a retry action");
    assert.equal(
      src.split("onRetrySettle={() => pollerRef.current?.retry()}").length - 1,
      2,
      "V1 and V3 both wire manual retry to the poller"
    );
  });
});
