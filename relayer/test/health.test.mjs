// Health endpoint + shutdown tests. No network beyond loopback; the
// only external dependency is node:http + fetch (both built in).
// Loopback must never go through a proxy (proxied sandboxes/CI would
// otherwise break these tests with 502s from the proxy itself).
process.env.no_proxy = [process.env.no_proxy, "127.0.0.1,localhost"].filter(Boolean).join(",");
process.env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1,localhost"].filter(Boolean).join(",");
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Relayer } from "../src/index.mjs";
import { shouldStartServer, resolvePort, startHealthServer, createShutdownCoordinator } from "../src/health.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, init) {
  const res = await fetch(url, init);
  return { status: res.status, body: await res.json() };
}

// Fake config carrying canary secrets: if any redaction breaks, the
// canaries below show up in the served JSON and fail loudly.
function fakeConfig() {
  return {
    nearRpcUrl: "http://near.invalid",
    contractId: "relayer.testnet",
    baseRpcUrl: "http://base.invalid",
    escrowAddress: "0x0000000000000000000000000000000000000001",
    mpcSigner: "0x0000000000000000000000000000000000000002",
    relayerAddress: "0x0000000000000000000000000000000000000003",
    privateKey: "CANARY-PRIVATE-KEY-AAAA",
    operatorPrivateKey: "CANARY-OPERATOR-KEY-BBBB",
    expectedChainId: 84532,
    pollIntervalMs: 50,
    confirmations: 1,
    voucherVersion: "2",
    finalizeEnabled: false,
    operatorAccountId: null,
  };
}

function fakeRelayer() {
  return new Relayer({
    config: fakeConfig(),
    near: {},
    escrow: {},
    store: { isRelayed: () => false, markRelayed: () => {}, markSkipped: () => {} },
    log: () => {},
  });
}

describe("shouldStartServer", () => {
  it("starts in daemon mode with a valid PORT", () => {
    assert.equal(shouldStartServer(["node", "index.mjs"], { PORT: "10000" }), true);
    assert.equal(shouldStartServer(["node", "index.mjs"], { PORT: "8080" }), true);
  });

  it("never starts without PORT", () => {
    assert.equal(shouldStartServer(["node", "index.mjs"], {}), false);
    assert.equal(shouldStartServer(["node", "index.mjs"], { PORT: "" }), false);
  });

  it("never starts in --once mode, even with PORT", () => {
    assert.equal(shouldStartServer(["node", "index.mjs", "--once"], { PORT: "10000" }), false);
  });

  it("rejects malformed PORT values", () => {
    for (const bad of ["abc", "0", "-1", "70000", "12.5", "  "]) {
      assert.equal(shouldStartServer(["node", "index.mjs"], { PORT: bad }), false, bad);
    }
    assert.throws(() => resolvePort({ PORT: "abc" }), /invalid PORT/);
  });
});

describe("startHealthServer", () => {
  it("serves 200 JSON on /health and /, 404 elsewhere", async () => {
    const { server, url } = await startHealthServer({ port: 0, getStatus: () => ({ status: "ok" }) });
    try {
      const h = await getJson(`${url}/health`);
      assert.equal(h.status, 200);
      assert.equal(h.body.status, "ok");
      const root = await getJson(`${url}/`);
      assert.equal(root.status, 200);
      const nope = await getJson(`${url}/nope`);
      assert.equal(nope.status, 404);
      const post = await getJson(`${url}/health`, { method: "POST" });
      assert.equal(post.status, 404);
    } finally {
      server.close();
    }
  });

  it("survives a throwing status function with 500, then keeps serving", async () => {
    let calls = 0;
    const { server, url } = await startHealthServer({
      port: 0,
      getStatus: () => {
        calls++;
        if (calls === 1) throw new Error("boom");
        return { status: "ok" };
      },
    });
    try {
      const first = await getJson(`${url}/health`);
      assert.equal(first.status, 500);
      assert.equal(first.body.status, "error");
      const second = await getJson(`${url}/health`);
      assert.equal(second.status, 200);
      assert.equal(second.body.status, "ok");
    } finally {
      server.close();
    }
  });

  it("rejects when the port cannot bind", async () => {
    const first = await startHealthServer({ port: 0, getStatus: () => ({}) });
    try {
      const port = first.server.address().port;
      await assert.rejects(startHealthServer({ port, getStatus: () => ({}) }), /EADDRINUSE/);
    } finally {
      first.server.close();
    }
  });
});

describe("healthStatus redaction", () => {
  it("exposes status fields but never config secrets", () => {
    const r = fakeRelayer();
    const body = r.healthStatus();
    assert.equal(body.status, "ok");
    assert.equal(typeof body.uptimeSec, "number");
    assert.equal(typeof body.startedAt, "string");
    assert.equal(body.lastPollAt, null);
    assert.equal(body.lastPollOk, null);
    assert.equal(body.lastError, null);
    assert.equal(body.polling, false);
    assert.equal(body.loopStale, false);
    assert.equal(body.pollIntervalMs, 50);
    assert.equal(body.config.relayerAddress, "0x0000000000000000000000000000000000000003");
    const leaked = JSON.stringify(body);
    assert.ok(!leaked.includes("CANARY-PRIVATE-KEY-AAAA"), "private key leaked");
    assert.ok(!leaked.includes("CANARY-OPERATOR-KEY-BBBB"), "operator key leaked");
  });
});

describe("runForever recording + interval", () => {
  it("keeps polling at the configured interval and records outcomes", async () => {
    const r = fakeRelayer();
    let calls = 0;
    const times = [];
    r.pollOnce = async () => {
      calls++;
      times.push(Date.now());
      if (calls >= 3) r.stopped = true;
      return [{ status: "already", digest: "0x1" }];
    };
    await r.runForever();
    assert.equal(calls, 3);
    assert.ok(times[1] - times[0] >= 30, "interval preserved between polls");
    assert.ok(times[2] - times[1] >= 30, "interval preserved between polls");
    assert.equal(typeof r.health.lastPollAt, "string");
    assert.equal(r.health.lastPollOk, true);
    assert.equal(r.health.lastError, null);
    assert.equal(r.polling, false);
  });

  it("an unexpected poll throw degrades to log-and-continue, not a crash", async () => {
    const r = fakeRelayer();
    let calls = 0;
    r.pollOnce = async () => {
      calls++;
      r.stopped = true;
      throw new Error("boom-unexpected");
    };
    await r.runForever();
    assert.equal(calls, 1);
    assert.equal(r.health.lastPollOk, false);
    assert.ok(r.health.lastError.includes("boom-unexpected"));
  });
});

describe("createShutdownCoordinator", () => {
  function harness({ polling = false, graceMs = 5000 } = {}) {
    const events = [];
    let isPolling = polling;
    const coord = createShutdownCoordinator({
      isPolling: () => isPolling,
      onStop: () => events.push("stop"),
      closeServer: () => events.push("close"),
      exit: (code) => events.push(`exit:${code}`),
      graceMs,
      log: () => {},
    });
    return { coord, events, setPolling: (v) => { isPolling = v; } };
  }

  it("idle shutdown stops, closes, and exits 0 promptly", async () => {
    const h = harness();
    assert.equal(h.coord.onSignal("SIGTERM"), "stopping");
    await sleep(250);
    assert.deepEqual(h.events, ["stop", "close", "exit:0"]);
  });

  it("waits for an in-flight iteration, then exits 0", async () => {
    const h = harness({ polling: true });
    assert.equal(h.coord.onSignal("SIGINT"), "stopping");
    await sleep(120);
    assert.deepEqual(h.events, ["stop", "close"]);
    h.setPolling(false);
    await sleep(150);
    assert.deepEqual(h.events, ["stop", "close", "exit:0"]);
  });

  it("bounded grace forces exit 0 even if a poll never finishes", async () => {
    const h = harness({ polling: true, graceMs: 100 });
    h.coord.onSignal("SIGTERM");
    await sleep(400);
    assert.deepEqual(h.events, ["stop", "close", "exit:0"]);
  });

  it("ignores repeated signals (no double exit)", async () => {
    const h = harness();
    h.coord.onSignal("SIGTERM");
    assert.equal(h.coord.onSignal("SIGTERM"), "ignored");
    await sleep(250);
    assert.equal(h.events.filter((e) => e === "exit:0").length, 1);
  });
});
