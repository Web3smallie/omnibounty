import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NearRpc } from "../src/near.mjs";

function fakeFetch(handler) {
  return async (url, opts) => handler(url, JSON.parse(opts.body));
}

function rpcResult(value) {
  return {
    ok: true,
    json: async () => ({
      jsonrpc: "2.0",
      id: "x",
      result: { result: Array.from(Buffer.from(JSON.stringify(value))) },
    }),
  };
}

describe("near rpc", () => {
  it("decodes view results", async () => {
    const fetchImpl = fakeFetch(async (url, body) => {
      assert.equal(body.params.account_id, "v2.omnibounty.testnet");
      assert.equal(body.params.method_name, "list_unrelayed");
      return rpcResult([{ hello: "world" }]);
    });
    const rpc = new NearRpc("http://unused", fetchImpl);
    assert.deepEqual(await rpc.listUnrelayed("v2.omnibounty.testnet", 5), [{ hello: "world" }]);
  });

  it("surfaces contract, http, and shape errors", async () => {
    const bad1 = new NearRpc("http://u", fakeFetch(async () => ({
      ok: true,
      json: async () => ({ result: { error: "wasm panic: BOUNTY_NOT_FOUND: 3" } }),
    })));
    await assert.rejects(() => bad1.getConfig("c"), /BOUNTY_NOT_FOUND/);

    const bad2 = new NearRpc("http://u", fakeFetch(async () => ({ ok: false, status: 500 })));
    await assert.rejects(() => bad2.getConfig("c"), /HTTP 500/);

    const bad3 = new NearRpc("http://u", fakeFetch(async () => ({ ok: true, json: async () => ({}) })));
    await assert.rejects(() => bad3.getConfig("c"), /missing result/);
  });

  it("fetches a bounty by id", async () => {
    const fetchImpl = fakeFetch(async (url, body) => {
      assert.equal(body.params.method_name, "get_bounty");
      assert.deepEqual(JSON.parse(Buffer.from(body.params.args_base64, "base64").toString()), {
        bounty_id: 7,
      });
      return rpcResult({ id: 7, funded: true });
    });
    const rpc = new NearRpc("http://unused", fetchImpl);
    assert.deepEqual(await rpc.getBounty("v3.omnibounty.testnet", 7), { id: 7, funded: true });
  });
});
