// Minimal NEAR RPC client (view calls only; no signing). Uses global fetch so
// tests can inject a fake transport.
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

  getConfig(contractId) {
    return this.callFunction(contractId, "get_config", {});
  }
}
