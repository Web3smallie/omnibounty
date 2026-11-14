import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashCriteriaDocument } from "../lib/criteria.mjs";
import { verifyCriteriaText } from "../lib/criteriaSource.mjs";
import {
  createCriteriaCache,
  createSharedResolver,
  extractCreateCandidates,
  extractCriteriaFromTx,
  isTxSuccess,
  resolveCriteriaDocument,
} from "../lib/criteriaResolve.mjs";

// Universal criteria resolution: one shared mechanism for Browse, Details,
// and Claim. Sources in order: verified cache -> served artifact ->
// transaction-anchored recovery (creation-tx args) -> caller paste (UI
// layer only). Every candidate passes verifyCriteriaText; NOTHING
// unverified is ever returned. All network is injected via fetchImpl, so
// every test below is offline. Fixtures: testdata/v3/tx-anchored/ (see
// PROVENANCE.md) — synthetic simple + advanced bounties plus the real
// on-chain creation data of bounty 414201122891942 as one regression
// case among several (the resolver holds no bounty-specific logic).
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const TXD = join(ROOT, "testdata/v3/tx-anchored");
const read = (p) => readFileSync(join(TXD, p), "utf8");
const readJson = (p) => JSON.parse(read(p));

const META = readJson("meta.json");
const SIMPLE_DOC = read("simple-doc.json");
const ADVANCED_DOC = read("advanced-doc.json");
const VALEN_DOC = read("valen-414201122891942-doc.json");
const SIMPLE_TX = readJson("simple-tx.json");
const ADVANCED_TX = readJson("advanced-tx.json");
const FAILED_TX = readJson("failed-tx.json");
const VALEN_TX = readJson("valen-414201122891942-tx.json");
const PAGE1 = readJson("receipts-page1.json");
const PAGE2 = readJson("receipts-page2.json");
const VALEN_RECEIPTS = readJson("valen-414201122891942-receipts.json");

const CONTRACT = "omnibounty-v3.testnet";
const RPC_URL = "https://rpc.test";
const INDEXER_URL = "https://indexer.test";

/// Offline network double. `artifact`: served /criteria text (null = 404).
/// `pages`: indexer pages by 1-based page number. `txs`: txHash -> RPC body.
function makeNet({ artifact = null, pages = [], txs = {} } = {}) {
  const calls = { artifact: 0, indexer: [], rpc: [] };
  const fetchImpl = async (url, opts = {}) => {
    if (url.startsWith("/criteria/")) {
      calls.artifact++;
      if (artifact == null) return { ok: false, status: 404, text: async () => "" };
      return { ok: true, status: 200, text: async () => artifact };
    }
    if (url.includes("/v1/account/")) {
      const m = /[?&]page=(\d+)/.exec(url);
      calls.indexer.push(m ? Number(m[1]) : 1);
      const page = Number(m ? m[1] : 1);
      return { ok: true, status: 200, json: async () => pages[page - 1] ?? { txns: [] } };
    }
    const req = JSON.parse(opts.body);
    calls.rpc.push(req.params);
    const tx = txs[req.params[0]];
    if (!tx) {
      return { ok: true, status: 200, json: async () => ({ error: { message: "tx unknown" } }) };
    }
    return { ok: true, status: 200, json: async () => tx };
  };
  return { fetchImpl, calls };
}

function depsFor(net, cache = createCriteriaCache()) {
  return {
    fetchImpl: net.fetchImpl,
    indexerBaseUrl: INDEXER_URL,
    contractId: CONTRACT,
    nearRpcUrl: RPC_URL,
    cache,
  };
}

describe("fixture sanity", () => {
  it("meta hashes match the fixture documents (no drift)", () => {
    assert.equal(hashCriteriaDocument(SIMPLE_DOC), META.simple.hash);
    assert.equal(hashCriteriaDocument(ADVANCED_DOC), META.advanced.hash);
    assert.equal(hashCriteriaDocument(VALEN_DOC), META.valen.hash);
    assert.equal(META.valen.bountyId, 414201122891942);
    assert.equal(META.valen.hash, "0x0fa2d3bc5fe25355f680ed62c534899904bfe172fa6856996178db35d2f7f2f4");
  });

  it("all fixture documents verify against their own hashes", () => {
    assert.equal(verifyCriteriaText(SIMPLE_DOC, META.simple.hash).ok, true);
    assert.equal(verifyCriteriaText(ADVANCED_DOC, META.advanced.hash).ok, true);
    assert.equal(verifyCriteriaText(VALEN_DOC, META.valen.hash).ok, true);
  });
});

describe("creation-candidate extraction", () => {
  it("keeps only create_bounty receipts for this contract, deduped, with signers", () => {
    const r = extractCreateCandidates({ txns: [...PAGE1.txns, ...PAGE2.txns] }, { contractId: CONTRACT });
    assert.equal(r.ok, true);
    assert.deepEqual(
      r.candidates,
      [
        { txHash: FAILED_TX.txHash, signer: META.simple.signer },
        { txHash: META.simple.txHash, signer: META.simple.signer },
        { txHash: META.advanced.txHash, signer: META.advanced.signer },
      ]
    );
  });

  it("finds the real creation receipt among noise", () => {
    const r = extractCreateCandidates(VALEN_RECEIPTS, { contractId: CONTRACT });
    assert.equal(r.ok, true);
    assert.deepEqual(r.candidates, [{ txHash: META.valen.txHash, signer: META.valen.signer }]);
  });

  it("tolerates empty or partial pages without throwing", () => {
    assert.deepEqual(extractCreateCandidates({ txns: [] }, { contractId: CONTRACT }).candidates, []);
    assert.deepEqual(extractCreateCandidates({}, { contractId: CONTRACT }).candidates, []);
    assert.deepEqual(
      extractCreateCandidates({ txns: [null, {}, { actions: null }] }, { contractId: CONTRACT }).candidates,
      []
    );
  });

  it("rejects unusable indexer payloads", () => {
    for (const bad of [null, 42, "x", []]) {
      const r = extractCreateCandidates(bad, { contractId: CONTRACT });
      assert.equal(r.ok, false);
      assert.equal(r.reason, "invalid");
    }
  });
});

describe("transaction criteria extraction", () => {
  it("extracts the document from a successful creation tx", () => {
    const r = extractCriteriaFromTx(SIMPLE_TX.rpc, { bountyId: META.simple.bountyId });
    assert.equal(r.ok, true);
    assert.equal(r.criteriaText, SIMPLE_DOC);
  });

  it("detects success vs failure outcomes", () => {
    assert.equal(isTxSuccess(SIMPLE_TX.rpc), true);
    assert.equal(isTxSuccess(FAILED_TX.rpc), false);
    assert.equal(isTxSuccess({}), false);
    assert.equal(isTxSuccess(null), false);
  });

  it("refuses failed transactions even when the bounty id matches", () => {
    const r = extractCriteriaFromTx(FAILED_TX.rpc, { bountyId: META.simple.bountyId });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "not-success");
  });

  it("skips transactions for other bounties", () => {
    const r = extractCriteriaFromTx(ADVANCED_TX.rpc, { bountyId: META.simple.bountyId });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "other-bounty");
  });

  it("rejects malformed transaction shapes without throwing", () => {
    for (const bad of [
      null,
      {},
      { result: {} },
      { result: { status: { SuccessValue: "" } } },
      { result: { status: { SuccessValue: "" }, transaction: { actions: [] } } },
      { result: { status: { SuccessValue: "" }, transaction: { actions: [{ Transfer: {} }] } } },
      {
        result: {
          status: { SuccessValue: "" },
          transaction: { actions: [{ FunctionCall: { method_name: "mark_funded", args: "e30=" } }] },
        },
      },
      {
        result: {
          status: { SuccessValue: "" },
          transaction: { actions: [{ FunctionCall: { method_name: "create_bounty", args: "!!!not-base64!!!" } }] },
        },
      },
      {
        result: {
          status: { SuccessValue: "" },
          transaction: {
            actions: [{ FunctionCall: { method_name: "create_bounty", args: Buffer.from("{oops").toString("base64") } }],
          },
        },
      },
      {
        result: {
          status: { SuccessValue: "" },
          transaction: {
            actions: [
              { FunctionCall: { method_name: "create_bounty", args: Buffer.from("[]").toString("base64") } },
            ],
          },
        },
      },
    ]) {
      const r = extractCriteriaFromTx(bad, { bountyId: META.simple.bountyId });
      assert.equal(r.ok, false, `must reject ${JSON.stringify(bad)?.slice(0, 60)}`);
      assert.ok(["malformed", "no-create-args", "not-success"].includes(r.reason), `reason ${r.reason}`);
    }
  });
});

describe("artifact path", () => {
  it("serves a verified artifact without touching indexer or RPC", async () => {
    const net = makeNet({ artifact: SIMPLE_DOC });
    const r = await resolveCriteriaDocument(
      { bountyId: META.simple.bountyId, criteriaHash: META.simple.hash },
      depsFor(net)
    );
    assert.equal(r.ok, true);
    assert.equal(r.source, "artifact");
    assert.equal(r.text, SIMPLE_DOC);
    assert.equal(r.doc.repo, "octocat/Hello-World");
    assert.deepEqual(net.calls.indexer, []);
    assert.deepEqual(net.calls.rpc, []);
  });

  it("rejects malformed inputs before any fetch", async () => {
    for (const args of [
      { bountyId: META.simple.bountyId, criteriaHash: "xyz" },
      { bountyId: META.simple.bountyId, criteriaHash: "" },
      { bountyId: -1, criteriaHash: META.simple.hash },
      { bountyId: 1.5, criteriaHash: META.simple.hash },
      { bountyId: "9001", criteriaHash: META.simple.hash },
    ]) {
      const net = makeNet({ artifact: SIMPLE_DOC });
      const r = await resolveCriteriaDocument(args, depsFor(net));
      assert.equal(r.ok, false);
      assert.equal(r.reason, "invalid");
      assert.equal(net.calls.artifact, 0, `no fetch for ${JSON.stringify(args)}`);
    }
  });
});

describe("transaction path (contributor: no sponsor data)", () => {
  it("discovers the creation tx across pages, skipping failures and noise", async () => {
    const net = makeNet({
      pages: [PAGE1, PAGE2],
      txs: { [META.simple.txHash]: SIMPLE_TX.rpc, [FAILED_TX.txHash]: FAILED_TX.rpc, [META.advanced.txHash]: ADVANCED_TX.rpc },
    });
    const r = await resolveCriteriaDocument(
      { bountyId: META.simple.bountyId, criteriaHash: META.simple.hash },
      depsFor(net)
    );
    assert.equal(r.ok, true);
    assert.equal(r.source, "transaction");
    assert.equal(r.txHash, META.simple.txHash);
    assert.equal(r.text, SIMPLE_DOC);
    assert.deepEqual(net.calls.indexer, [1, 2]);
    // Failed attempt fetched (then skipped); advanced never fetched (early return).
    assert.deepEqual(
      net.calls.rpc.map((p) => p[0]),
      [FAILED_TX.txHash, META.simple.txHash]
    );
    assert.deepEqual(net.calls.rpc[1], [META.simple.txHash, META.simple.signer]);
  });

  it("reports missing when no page holds the creation", async () => {
    const net = makeNet({ pages: [PAGE1, { txns: [] }], txs: { [FAILED_TX.txHash]: FAILED_TX.rpc } });
    const r = await resolveCriteriaDocument(
      { bountyId: 424242, criteriaHash: META.simple.hash },
      depsFor(net)
    );
    assert.equal(r.ok, false);
    assert.equal(r.reason, "missing");
    assert.ok(r.tried.includes("artifact") && r.tried.includes("transaction"));
  });

  it("reports unavailable when indexer and RPC both fail", async () => {
    const failing = async () => {
      throw new Error("net down");
    };
    const r = await resolveCriteriaDocument(
      { bountyId: META.simple.bountyId, criteriaHash: META.simple.hash },
      { fetchImpl: failing, indexerBaseUrl: INDEXER_URL, contractId: CONTRACT, nearRpcUrl: RPC_URL, cache: createCriteriaCache() }
    );
    assert.equal(r.ok, false);
    assert.equal(r.reason, "unavailable");
  });

  it("fails closed on a successful tx whose document mismatches the hash", async () => {
    // Same bounty id, successful status, but a DIFFERENT document: must
    // return mismatch and must not poison the cache.
    const cache = createCriteriaCache();
    // Rewrite the advanced tx args to claim the SIMPLE bounty id.
    const forged = JSON.parse(JSON.stringify(ADVANCED_TX.rpc));
    const args = { bounty_id: META.simple.bountyId, token: "0x00", criteria_json: ADVANCED_DOC };
    forged.result.transaction.actions[0].FunctionCall.args = Buffer.from(JSON.stringify(args), "utf8").toString("base64");
    const net2 = makeNet({
      pages: [{ txns: PAGE2.txns.filter((t) => t.transaction_hash === META.simple.txHash) }],
      txs: { [META.simple.txHash]: forged },
    });
    const r = await resolveCriteriaDocument(
      { bountyId: META.simple.bountyId, criteriaHash: META.simple.hash },
      { fetchImpl: net2.fetchImpl, indexerBaseUrl: INDEXER_URL, contractId: CONTRACT, nearRpcUrl: RPC_URL, cache }
    );
    assert.equal(r.ok, false);
    assert.equal(r.reason, "mismatch");
    assert.equal(cache.readDocument(META.simple.hash), null);
  });

  it("skips garbage tx payloads and keeps scanning", async () => {
    const garbage = { result: { status: { SuccessValue: "" }, transaction: { actions: [{ Transfer: {} }] } } };
    const net = makeNet({
      pages: [PAGE1, PAGE2],
      txs: {
        [FAILED_TX.txHash]: garbage,
        [META.simple.txHash]: SIMPLE_TX.rpc,
        [META.advanced.txHash]: ADVANCED_TX.rpc,
      },
    });
    const r = await resolveCriteriaDocument(
      { bountyId: META.simple.bountyId, criteriaHash: META.simple.hash },
      depsFor(net)
    );
    assert.equal(r.ok, true);
    assert.equal(r.txHash, META.simple.txHash);
  });
});

describe("transaction path (sponsor: creation hash known)", () => {
  it("fetches the known creation tx directly with no discovery scan", async () => {
    const net = makeNet({ txs: { [META.advanced.txHash]: ADVANCED_TX.rpc } });
    const r = await resolveCriteriaDocument(
      {
        bountyId: META.advanced.bountyId,
        criteriaHash: META.advanced.hash,
        createTxHash: META.advanced.txHash,
        signer: META.advanced.signer,
      },
      depsFor(net)
    );
    assert.equal(r.ok, true);
    assert.equal(r.source, "transaction");
    assert.equal(r.text, ADVANCED_DOC);
    assert.deepEqual(net.calls.indexer, []);
    assert.deepEqual(net.calls.rpc, [[META.advanced.txHash, META.advanced.signer]]);
  });

  it("refuses direct lookup without the signer (RPC needs it)", async () => {
    const net = makeNet({ txs: { [META.simple.txHash]: SIMPLE_TX.rpc } });
    const r = await resolveCriteriaDocument(
      { bountyId: META.simple.bountyId, criteriaHash: META.simple.hash, createTxHash: META.simple.txHash },
      depsFor(net)
    );
    assert.equal(r.ok, false);
    assert.equal(r.reason, "invalid");
    assert.deepEqual(net.calls.rpc, []);
  });
});

describe("verified cache", () => {
  it("serves the second resolve with zero fetches", async () => {
    const cache = createCriteriaCache();
    const net = makeNet({
      pages: [PAGE1, PAGE2],
      txs: { [META.simple.txHash]: SIMPLE_TX.rpc, [FAILED_TX.txHash]: FAILED_TX.rpc, [META.advanced.txHash]: ADVANCED_TX.rpc },
    });
    const first = await resolveCriteriaDocument(
      { bountyId: META.simple.bountyId, criteriaHash: META.simple.hash },
      depsFor(net, cache)
    );
    assert.equal(first.ok, true);
    const callsAfterFirst = net.calls.artifact + net.calls.indexer.length + net.calls.rpc.length;
    assert.ok(callsAfterFirst > 0);
    const second = await resolveCriteriaDocument(
      { bountyId: META.simple.bountyId, criteriaHash: META.simple.hash },
      depsFor(net, cache)
    );
    assert.equal(second.ok, true);
    assert.equal(second.source, "cache");
    assert.equal(net.calls.artifact + net.calls.indexer.length + net.calls.rpc.length, callsAfterFirst);
  });

  it("rejects a poisoned cache entry and refetches", async () => {
    const cache = createCriteriaCache();
    cache.storeDocument(META.simple.hash, ADVANCED_DOC); // wrong doc for this hash
    const net = makeNet({ artifact: SIMPLE_DOC });
    const r = await resolveCriteriaDocument(
      { bountyId: META.simple.bountyId, criteriaHash: META.simple.hash },
      depsFor(net, cache)
    );
    assert.equal(r.ok, true);
    assert.equal(r.text, SIMPLE_DOC);
    assert.equal(net.calls.artifact, 1);
  });

  it("remembers creation-tx mappings (sponsor seeds, contributor reuses)", async () => {
    const cache = createCriteriaCache();
    cache.storeCreateTx(META.simple.bountyId, { txHash: META.simple.txHash, signer: META.simple.signer });
    const round = cache.readCreateTx(META.simple.bountyId);
    assert.deepEqual(round, { txHash: META.simple.txHash, signer: META.simple.signer });
    const net = makeNet({ txs: { [META.simple.txHash]: SIMPLE_TX.rpc } });
    const r = await resolveCriteriaDocument(
      { bountyId: META.simple.bountyId, criteriaHash: META.simple.hash },
      depsFor(net, cache)
    );
    assert.equal(r.ok, true);
    assert.deepEqual(net.calls.indexer, []);
  });

  it("sponsor seeding makes the bounty resolvable fully offline (publish handoff)", async () => {
    // Exactly what the sponsor done-panel does after creation: seed the
    // canonical document plus the creation-tx mapping. A contributor on the
    // same device must then resolve with zero network, even when every
    // fetch would throw.
    const cache = createCriteriaCache();
    assert.equal(cache.storeDocument(META.advanced.hash, ADVANCED_DOC), true);
    assert.equal(
      cache.storeCreateTx(META.advanced.bountyId, { txHash: META.advanced.txHash, signer: META.advanced.signer }),
      true
    );
    const offline = async () => {
      throw new Error("network must not be touched");
    };
    const r = await resolveCriteriaDocument(
      { bountyId: META.advanced.bountyId, criteriaHash: META.advanced.hash },
      { fetchImpl: offline, indexerBaseUrl: INDEXER_URL, contractId: CONTRACT, nearRpcUrl: RPC_URL, cache }
    );
    assert.equal(r.ok, true);
    assert.equal(r.source, "cache");
    assert.equal(r.text, ADVANCED_DOC);
    assert.equal(r.doc.title, "Harden the auth boundary");
  });

  it("evicts oldest entries past the cap", () => {
    const cache = createCriteriaCache({ maxEntries: 2 });
    const h = (i) => `0x${String(i).padStart(64, "0")}`;
    cache.storeDocument(h(1), SIMPLE_DOC);
    cache.storeDocument(h(2), SIMPLE_DOC);
    cache.storeDocument(h(3), SIMPLE_DOC);
    assert.equal(cache.readDocument(h(1)), null);
    assert.equal(cache.readDocument(h(3)), SIMPLE_DOC);
  });

  it("writes through to storage and survives storage failures", () => {
    const mem = new Map();
    const storage = {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => void mem.set(k, v),
      removeItem: (k) => void mem.delete(k),
    };
    const cache = createCriteriaCache({ storage });
    cache.storeDocument(META.simple.hash, SIMPLE_DOC);
    assert.ok([...mem.keys()].some((k) => k.includes(META.simple.hash)));
    const cache2 = createCriteriaCache({ storage });
    assert.equal(cache2.readDocument(META.simple.hash), SIMPLE_DOC);

    const exploding = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    const cache3 = createCriteriaCache({ storage: exploding });
    cache3.storeDocument(META.simple.hash, SIMPLE_DOC); // must not throw
    assert.equal(cache3.readDocument(META.simple.hash), SIMPLE_DOC); // memory still works
  });
});

describe("shared resolver", () => {
  it("dedupes concurrent resolves into one scan", async () => {
    const net = makeNet({
      pages: [PAGE1, PAGE2],
      txs: { [META.simple.txHash]: SIMPLE_TX.rpc, [FAILED_TX.txHash]: FAILED_TX.rpc, [META.advanced.txHash]: ADVANCED_TX.rpc },
    });
    const shared = createSharedResolver({
      fetchImpl: net.fetchImpl,
      indexerBaseUrl: INDEXER_URL,
      contractId: CONTRACT,
      nearRpcUrl: RPC_URL,
      cache: createCriteriaCache(),
    });
    const args = { bountyId: META.simple.bountyId, criteriaHash: META.simple.hash };
    const [a, b, c] = await Promise.all([shared.resolve(args), shared.resolve(args), shared.resolve(args)]);
    assert.equal(a.ok && b.ok && c.ok, true);
    assert.deepEqual(net.calls.indexer, [1, 2]);
  });

  it("caches across sequential resolves", async () => {
    const net = makeNet({ artifact: ADVANCED_DOC });
    const shared = createSharedResolver({
      fetchImpl: net.fetchImpl,
      indexerBaseUrl: INDEXER_URL,
      contractId: CONTRACT,
      nearRpcUrl: RPC_URL,
      cache: createCriteriaCache(),
    });
    const args = { bountyId: META.advanced.bountyId, criteriaHash: META.advanced.hash };
    assert.equal((await shared.resolve(args)).source, "artifact");
    assert.equal((await shared.resolve(args)).source, "cache");
    assert.equal(net.calls.artifact, 1);
  });
});

describe("general mechanism across all fixtures (no special cases)", () => {
  const CASES = [
    { name: "simple", doc: SIMPLE_DOC, tx: SIMPLE_TX, pages: [PAGE1, PAGE2] },
    { name: "advanced", doc: ADVANCED_DOC, tx: ADVANCED_TX, pages: [PAGE1, PAGE2] },
    { name: "valen-414201122891942", doc: VALEN_DOC, tx: VALEN_TX, pages: [VALEN_RECEIPTS] },
  ];

  for (const c of CASES) {
    it(`recovers ${c.name} through discovery with zero sponsor input`, async () => {
      const meta = META[c.name === "valen-414201122891942" ? "valen" : c.name];
      const txs = { [meta.txHash]: c.tx.rpc, [FAILED_TX.txHash]: FAILED_TX.rpc };
      if (c.name !== "valen-414201122891942") {
        txs[META.simple.txHash] = SIMPLE_TX.rpc;
        txs[META.advanced.txHash] = ADVANCED_TX.rpc;
      }
      const net = makeNet({ pages: c.pages, txs });
      // Contributor side: fresh cache, no tx hash, no signer, no wallet.
      const r = await resolveCriteriaDocument(
        { bountyId: meta.bountyId, criteriaHash: meta.hash },
        depsFor(net, createCriteriaCache())
      );
      assert.equal(r.ok, true, `${c.name}: ${r.reason} ${r.detail}`);
      assert.equal(r.source, "transaction");
      assert.equal(r.text, c.doc);
      assert.equal(hashCriteriaDocument(r.text), meta.hash);
    });
  }

  it("renders human-readable fields from each recovered document", () => {
    assert.equal(JSON.parse(SIMPLE_DOC).title, "Fix the login redirect loop");
    assert.equal(JSON.parse(ADVANCED_DOC).title, "Harden the auth boundary");
    assert.equal(JSON.parse(VALEN_DOC).title, "Improve Valen's README documentation");
    assert.equal(JSON.parse(VALEN_DOC).repo, "Web3smallie/valen");
    assert.equal(JSON.parse(ADVANCED_DOC).checks.required.length, 2);
  });
});
