import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TX_CONFIRM_TIMEOUT_MS,
  TxConfirmTimeoutError,
  waitForTxReceipt,
} from "../lib/txConfirm.mjs";
import { reconcileSponsorV3, runSponsorV3Flow } from "../lib/sponsorV3.mjs";

// P2-1: bounded EVM confirmation waits. Everything runs on mock tx
// handles and millisecond budgets — no chain, no wallet, no live tx.
const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(HERE, "..", p), "utf8");
const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async (n = 6) => {
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

const mockTx = (hash, waitImpl) => ({ hash, wait: waitImpl });

describe("waitForTxReceipt", () => {
  it("pins a bounded default budget", () => {
    assert.equal(TX_CONFIRM_TIMEOUT_MS, 120000);
  });

  it("passes successful confirmations straight through", async () => {
    const receipt = { status: 1, hash: "0xabc" };
    const out = await waitForTxReceipt(mockTx("0xabc", async () => receipt), { timeoutMs: 500 });
    assert.equal(out, receipt);
  });

  it("passes wait-time throws through untouched (revert path preserved)", async () => {
    const err = new Error("transaction execution reverted");
    const tx = mockTx("0xabc", async () => {
      throw err;
    });
    await assert.rejects(waitForTxReceipt(tx, { timeoutMs: 500 }), (e) => {
      assert.equal(e, err);
      return true;
    });
  });

  it("rejects with a timeout error carrying the hash, never a revert", async () => {
    const gate = deferred();
    const tx = mockTx("0xdeadbeef", () => gate.promise);
    await assert.rejects(waitForTxReceipt(tx, { timeoutMs: 20 }), (e) => {
      assert.ok(e instanceof TxConfirmTimeoutError);
      assert.equal(e.name, "TxConfirmTimeoutError");
      assert.equal(e.code, "TX_CONFIRM_TIMEOUT");
      assert.equal(e.txHash, "0xdeadbeef");
      assert.match(e.message, /timed out/);
      assert.match(e.message, /not proof it failed/);
      assert.doesNotMatch(e.message, /revert/i);
      assert.ok(e.message.includes("0xdeadbeef"));
      return true;
    });
    gate.resolve({ status: 1 });
    await flush();
  });

  it("falls back to the default budget on invalid timeouts", async () => {
    // A 0/negative budget must not fire immediately: a 50ms receipt still wins.
    for (const timeoutMs of [0, -5, NaN]) {
      const tx = mockTx("0xabc", async () => {
        await new Promise((r) => setTimeout(r, 50));
        return { status: 1 };
      });
      assert.deepEqual(await waitForTxReceipt(tx, { timeoutMs }), { status: 1 });
    }
  });

  it("accepts an explicit hash when the handle lacks one", async () => {
    const gate = deferred();
    const p = waitForTxReceipt({ wait: () => gate.promise }, { timeoutMs: 20, txHash: "0xexplicit" });
    await assert.rejects(p, (e) => {
      assert.equal(e.txHash, "0xexplicit");
      return true;
    });
    gate.resolve({ status: 1 });
    await flush();
  });

  it("ignores a late success after timeout without further updates", async () => {
    const gate = deferred();
    const p = waitForTxReceipt(mockTx("0xlate", () => gate.promise), { timeoutMs: 20 });
    await assert.rejects(p, TxConfirmTimeoutError);
    gate.resolve({ status: 1, hash: "0xlate" });
    await flush();
    await assert.rejects(p, TxConfirmTimeoutError, "settlement stays rejected");
  });

  it("swallows a late rejection after timeout (never unhandled)", async () => {
    const gate = deferred();
    const p = waitForTxReceipt(mockTx("0xlate", () => gate.promise), { timeoutMs: 20 });
    await assert.rejects(p, TxConfirmTimeoutError);
    gate.reject(new Error("late transport failure"));
    await flush();
    await assert.rejects(p, (e) => {
      assert.ok(e instanceof TxConfirmTimeoutError, "original timeout stands, late error swallowed");
      return true;
    });
  });
});

describe("timeout inside the sponsor flow", () => {
  const P = { bountyId: 7, criteriaJson: "{}", hash: "0xhash", slots: ["1000000"], total: "1000000", deadline: "0" };

  it("fails the step with the hash preserved and a resumable message", async () => {
    const seen = [];
    const io = {
      createEscrow: async () => {
        throw new TxConfirmTimeoutError("0xtimedout", 50);
      },
    };
    const out = await runSponsorV3Flow({
      params: P,
      token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      adopted: [true, false, false, false, false],
      io,
      onStep: (i, s) => seen.push([i, { ...s }]),
    });
    assert.equal(out.ok, false);
    assert.equal(out.failedStep, 1);
    assert.equal(out.txs[1], "0xtimedout", "hash preserved for the explorer link");
    assert.match(out.message, /timed out/);
    const err = seen.find(([i, s]) => i === 1 && s.status === "error");
    assert.ok(err, "step reports error");
    assert.equal(err[1].tx, "0xtimedout");
  });

  it("resume re-checks chain state and adopts the mined step (no resubmit)", () => {
    // The timed-out createBounty actually mined: Resume's reconcile sees
    // the on-chain entry and adopts the step instead of sending again.
    const EVM = "0xEeee0000000000000000000000000000000000001";
    const rec = reconcileSponsorV3({
      params: P,
      wallets: { nearAccount: "a.testnet", evmAddress: EVM, evmOnBaseSepolia: true },
      contractIsV3: true,
      paused: false,
      near: { sponsor: "a.testnet", criteria_hash: "0xhash", funded: false },
      escrow: {
        token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        sponsor: EVM,
        funded: false,
        totalFunded: "1000000",
        amounts: ["1000000"],
        claimedBitmap: "0",
        refundedBitmap: "0",
        deadline: "0",
        criteriaHash: "0xhash",
      },
      allowance: 0n,
      balance: 5000000n,
    });
    assert.deepEqual(rec.blockers, []);
    assert.deepEqual(rec.adopted, [true, true, false, false, false]);
  });
});

describe("confirmation-timeout wiring", () => {
  const src = read("components/SponsorFormV3.tsx");

  it("routes every EVM confirmation wait through the bounded helper", () => {
    assert.ok(src.includes('from "../lib/txConfirm.mjs"'), "form uses the timeout helper");
    assert.equal(
      src.split("waitForTxReceipt(tx)").length - 1,
      3,
      "create, approve, and fund waits are all bounded"
    );
    assert.ok(!src.includes("tx.wait()"), "no bare indefinite waits remain");
  });

  it("preserves revert classification and post-flow unmount safety", () => {
    assert.ok(read("lib/sponsorV3.mjs").includes("transaction reverted"), "revert verdicts intact");
    assert.ok(
      src.includes("if (!mountedRef.current) return;\n      if (!out.ok)"),
      "late flow results never touch unmounted state"
    );
  });

  it("keeps P1-8 and P1-13 protections in place", () => {
    assert.ok(read("lib/near.ts").includes("interpretNearTxOutcome"), "P1-8 intact");
    assert.ok(src.includes("guardedIo"), "P1-13 per-write guards intact");
    assert.ok(src.includes("tryAcquire()"), "P1-13 double-submit guard intact");
    assert.ok(src.includes("reconcileSponsorV3"), "P1-13 reconcile intact");
  });
});
