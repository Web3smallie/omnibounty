// Minimal NEAR RPC client (view calls only; no signing). Uses global fetch so
// tests can inject a fake transport.
import { createRequire } from "node:module";

export class NearRpc {
  constructor(baseUrl, fetchImpl = globalThis.fetch) {
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
  }

  async callFunction(contractId, method, argsObj) {
    const argsBase64 = Buffer.from(JSON.stringify(argsObj)).toString("base64");
    const res = await this.fetchImpl(this.baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "omnibounty-relayer",
        method: "query",
        params: {
          request_type: "call_function",
          finality: "final",
          account_id: contractId,
          method_name: method,
          args_base64: argsBase64,
        },
      }),
    });
    if (!res.ok) throw new Error(`NEAR RPC HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(`NEAR RPC error: ${JSON.stringify(data.error)}`);
    const r = data.result;
    if (!r) throw new Error("NEAR RPC: missing result");
    if (r.error) throw new Error(`contract error: ${r.error}`);
    const bytes = Buffer.from(r.result);
    return JSON.parse(bytes.toString("utf8"));
  }

  listUnrelayed(contractId, limit = 50) {
    return this.callFunction(contractId, "list_unrelayed", { limit });
  }

  listBounties(contractId, from = 0, limit = 100) {
    return this.callFunction(contractId, "list_bounties", { from, limit });
  }

  getClaim(contractId, bountyId, slot) {
    return this.callFunction(contractId, "get_claim", { bounty_id: bountyId, slot });
  }

  getVoucher(contractId, bountyId, slot) {
    return this.callFunction(contractId, "get_voucher", { bounty_id: bountyId, slot });
  }

  getBounty(contractId, bountyId) {
    return this.callFunction(contractId, "get_bounty", { bounty_id: bountyId });
  }

  getConfig(contractId) {
    return this.callFunction(contractId, "get_config", {});
  }
}

// Writable NEAR client: submits the permissionless V3 `finalize_claim` call
// with an operator key. Same constants as tools/finalize.mjs (300 Tgas,
// 0.1 NEAR storage deposit). near-api-js resolves lazily — the installed
// dependency first, the frontend's copy as a fallback — so view-only
// imports and unit tests never pay for it.
const FINALIZE_GAS = "300000000000000";
const FINALIZE_DEPOSIT_YOCTO = "100000000000000000000000";

function loadNearApi() {
  const require = createRequire(import.meta.url);
  try {
    return require("near-api-js");
  } catch {
    return require("../../frontend/node_modules/near-api-js");
  }
}

export class NearSubmitter {
  constructor(account, contractId) {
    this.account = account;
    this.contractId = contractId;
  }

  static async connect({ rpcUrl, accountId, privateKey, contractId }) {
    const nearApi = loadNearApi();
    const keystore = new nearApi.keyStores.InMemoryKeyStore();
    await keystore.setKey("testnet", accountId, nearApi.KeyPair.fromString(privateKey));
    const near = await nearApi.connect({ networkId: "testnet", keyStore: keystore, nodeUrl: rpcUrl });
    return new NearSubmitter(await near.account(accountId), contractId);
  }

  // Submits finalize_claim and resolves to the tx hash. Contract-level
  // rejections (SlotPending, AlreadyFinalized, ChallengeWindowClosed)
  // propagate as errors for the caller to classify; the key never signs
  // anything else.
  async finalizeClaim(bountyId, slot) {
    const out = await this.account.functionCall({
      contractId: this.contractId,
      methodName: "finalize_claim",
      args: { bounty_id: bountyId, slot },
      gas: BigInt(FINALIZE_GAS),
      attachedDeposit: BigInt(FINALIZE_DEPOSIT_YOCTO),
    });
    return out?.transaction?.hash ?? null;
  }
}
