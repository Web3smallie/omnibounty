import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ESCROW_READ_LIMIT, PoolCancelledError, createReadPool, escrowReads } from "../lib/escrowPool.mjs";

// P1-11: bounded Marketplace escrow-read concurrency. Reads are mocked
// tasks; no live RPC, no transactions.
const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async (n = 10) => {
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

describe("createReadPool", () => {
  it("requires a task function", () => {
    const pool = createReadPool({ limit: 2 });
    assert.throws(() => pool.run("k", null), /task function/);
  });

  it("falls back to the default limit on invalid input", () => {
    assert.equal(ESCROW_READ_LIMIT, 8);
    for (const limit of [0, -1, 1.5, NaN, "8", null]) {
      assert.equal(createReadPool({ limit }).stats().limit, 8);
    }
    assert.equal(createReadPool().stats().limit, 8);
    assert.equal(createReadPool({ limit: 3 }).stats().limit, 3);
  });

  it("never exceeds the limit across 120 queued reads", async () => {
    const pool = createReadPool({ limit: 8 });
    let active = 0;
    let maxActive = 0;
    const N = 120;
    const all = Array.from({ length: N }, (_, i) =>
      pool.run(`v1:${i}`, async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await tick();
        active--;
        return i;
      }).promise
    );
    const values = await Promise.all(all);
    assert.deepEqual(values, Array.from({ length: N }, (_, i) => i));
    assert.ok(maxActive <= 8, `max ${maxActive} simultaneous reads must stay within the limit`);
    assert.ok(maxActive > 1, "reads actually overlap up to the limit");
    assert.deepEqual(pool.stats(), { active: 0, queued: 0, limit: 8 });
  });

  it("starts queued reads FIFO", async () => {
    const pool = createReadPool({ limit: 1 });
    const started = [];
    const gates = [deferred(), deferred(), deferred()];
    const all = gates.map((g, i) =>
      pool.run(`k:${i}`, async () => {
        started.push(i);
        await g.promise;
        return i;
      }).promise
    );
    await flush(3);
    assert.deepEqual(started, [0]);
    gates[0].resolve();
    await flush(3);
    assert.deepEqual(started, [0, 1]);
    gates[1].resolve();
    await flush(3);
    assert.deepEqual(started, [0, 1, 2]);
    gates[2].resolve();
    assert.deepEqual(await Promise.all(all), [0, 1, 2]);
  });

  it("maps each result to its own bounty when reads finish out of order", async () => {
    const pool = createReadPool({ limit: 5 });
    const gates = Array.from({ length: 5 }, () => deferred());
    const all = gates.map((g, i) => pool.run(`v1:${100 + i}`, () => g.promise).promise);
    await flush(3);
    // Settle in reverse: every promise must still resolve its own value.
    for (let i = 4; i >= 0; i--) gates[i].resolve({ id: 100 + i });
    const values = await Promise.all(all);
    assert.deepEqual(
      values.map((v) => v.id),
      [100, 101, 102, 103, 104]
    );
  });

  it("isolates one failed read while the rest succeed", async () => {
    const pool = createReadPool({ limit: 3 });
    const ok = [0, 1, 3, 4].map((i) => pool.run(`v1:${i}`, async () => i).promise);
    const bad = pool.run("v1:2", async () => {
      throw new Error("Base RPC HTTP 503");
    }).promise;
    await assert.rejects(bad, /503/);
    assert.deepEqual(await Promise.all(ok), [0, 1, 3, 4]);
    assert.deepEqual(pool.stats(), { active: 0, queued: 0, limit: 3 });
  });

  it("drains the queue past multiple failures", async () => {
    const pool = createReadPool({ limit: 2 });
    const settled = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        pool.run(`v1:${i}`, async () => {
          if (i % 3 === 0) throw new Error(`boom-${i}`);
          return i;
        }).promise
      )
    );
    assert.deepEqual(
      settled.map((r) => (r.status === "fulfilled" ? r.value : String(r.reason))),
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => (i % 3 === 0 ? `Error: boom-${i}` : i))
    );
    assert.deepEqual(pool.stats(), { active: 0, queued: 0, limit: 2 });
  });

  it("converts synchronous task throws into rejections without stalling", async () => {
    const pool = createReadPool({ limit: 1 });
    const bad = pool.run("bad", () => {
      throw new Error("sync blowup");
    }).promise;
    const good = pool.run("good", async () => "ok").promise;
    await assert.rejects(bad, /sync blowup/);
    assert.equal(await good, "ok");
  });

  it("shares identical in-flight reads instead of duplicating them", async () => {
    const pool = createReadPool({ limit: 8 });
    let calls = 0;
    const gate = deferred();
    const a = pool.run("v1:42", () => {
      calls++;
      return gate.promise;
    });
    const b = pool.run("v1:42", () => {
      calls++;
      return gate.promise;
    });
    await flush(3);
    assert.equal(calls, 1);
    gate.resolve({ funded: true });
    assert.deepEqual(await a.promise, { funded: true });
    assert.deepEqual(await b.promise, { funded: true });
  });

  it("scopes sharing by full key: V1 and V2 reads for one id stay distinct", async () => {
    const pool = createReadPool({ limit: 8 });
    let calls = 0;
    const mk = (v) => async () => {
      calls++;
      return v;
    };
    const [a, b] = await Promise.all([pool.run("v1:7", mk("one")).promise, pool.run("v2:7", mk("two")).promise]);
    assert.equal(calls, 2);
    assert.equal(a, "one");
    assert.equal(b, "two");
  });

  it("never serves stale results: sequential runs re-execute", async () => {
    const pool = createReadPool({ limit: 8 });
    let calls = 0;
    const task = async () => ++calls;
    assert.equal(await pool.run("v1:9", task).promise, 1);
    assert.equal(await pool.run("v1:9", task).promise, 2);
  });

  it("cancel drops queued work nobody wants and rejects it as cancelled", async () => {
    const pool = createReadPool({ limit: 1 });
    const gate = deferred();
    let queuedRan = false;
    const first = pool.run("first", () => gate.promise).promise;
    const dropped = pool.run("dropped", async () => {
      queuedRan = true;
      return "never";
    });
    const kept = pool.run("kept", async () => "kept").promise;
    await flush(3);
    dropped.cancel();
    await assert.rejects(dropped.promise, (e) => e instanceof PoolCancelledError && e.code === "POOL_CANCELLED");
    assert.equal(queuedRan, false);
    gate.resolve("first");
    assert.equal(await first, "first");
    assert.equal(await kept, "kept");
    assert.deepEqual(pool.stats(), { active: 0, queued: 0, limit: 1 });
  });

  it("cancel keeps queued work alive while another holder remains", async () => {
    const pool = createReadPool({ limit: 1 });
    const gate = deferred();
    let calls = 0;
    const block = pool.run("block", () => gate.promise).promise;
    const a = pool.run("shared", async () => {
      calls++;
      return "shared";
    });
    const b = pool.run("shared", async () => {
      calls++;
      return "shared";
    });
    await flush(3);
    a.cancel(); // one card unmounted; the other still needs the read
    gate.resolve("go");
    assert.equal(await block, "go");
    assert.equal(await b.promise, "shared");
    assert.equal(calls, 1);
    await assert.rejects(a.promise, PoolCancelledError);
  });

  it("cancel during flight releases the holder while the read runs on", async () => {
    const pool = createReadPool({ limit: 8 });
    const gate = deferred();
    let calls = 0;
    const h = pool.run("v1:5", () => {
      calls++;
      return gate.promise;
    });
    await flush(3);
    h.cancel();
    await assert.rejects(h.promise, PoolCancelledError);
    const late = pool.run("v1:5", () => {
      calls++;
      return gate.promise;
    });
    gate.resolve("late");
    assert.equal(await late.promise, "late", "late joiners still get the in-flight result");
    assert.equal(calls, 1, "the read ran exactly once");
  });

  it("cancel is idempotent", async () => {
    const pool = createReadPool({ limit: 1 });
    const gate = deferred();
    const block = pool.run("block", () => gate.promise).promise;
    const h = pool.run("q", async () => "q");
    h.cancel();
    h.cancel();
    gate.resolve("go");
    assert.equal(await block, "go");
    await assert.rejects(h.promise, PoolCancelledError);
  });

  it("reports live slot usage", async () => {
    const pool = createReadPool({ limit: 2 });
    const gates = [deferred(), deferred(), deferred()];
    const all = gates.map((g, i) => pool.run(`k:${i}`, () => g.promise).promise);
    await flush(3);
    assert.deepEqual(pool.stats(), { active: 2, queued: 1, limit: 2 });
    gates.forEach((g) => g.resolve(true));
    await Promise.all(all);
    assert.deepEqual(pool.stats(), { active: 0, queued: 0, limit: 2 });
  });
});

describe("shared escrowReads pool", () => {
  it("is bounded to the app-wide limit", () => {
    assert.equal(escrowReads.stats().limit, ESCROW_READ_LIMIT);
  });
});

describe("Marketplace pool wiring", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "components", "Marketplace.tsx"), "utf8");

  it("routes every card read through the shared pool with a version-scoped key", () => {
    assert.ok(src.includes('from "../lib/escrowPool.mjs"'), "marketplace uses the read pool");
    assert.ok(src.includes("pool.run(`v${v3 ? 2 : 1}:${bounty.id}`"), "reads are keyed by version and id");
  });

  it("preserves V1/V2 routing and the malformed-state guard", () => {
    assert.ok(src.includes("escrowBountyStateV2(bounty.id)"), "V3 cards read the V2 struct");
    assert.ok(src.includes("escrowBountyState(bounty.id)"), "V1 cards read the V1 struct");
    assert.ok(src.includes("v3EscrowCardState(s)"), "V2 structs are mapped for cards");
    assert.ok(src.includes("malformed V2 escrow state"), "unmappable V2 states fail loud");
  });

  it("keeps loading, funded, claimed, and unreachable states accurate", () => {
    assert.ok(src.includes("FundingPill funded={escrow?.funded ?? null}"), "loading stays unknown, never unfunded");
    assert.ok(src.includes("Escrow unreachable"), "failures render as unreachable, not unfunded");
    assert.ok(src.includes('if (live) setState("error")'), "only live cards take failures");
  });

  it("frees the card's hold on cleanup after dropping late updates", () => {
    assert.ok(src.includes("live = false;\n      cancel();"), "unmount drops the result first, then cancels");
  });
});
