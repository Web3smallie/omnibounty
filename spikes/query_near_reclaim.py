import urllib.request
import json
import base64

def rpc_call(url, method, params):
    req_data = json.dumps({
        "jsonrpc": "2.0",
        "id": "dontcare",
        "method": method,
        "params": params
    }).encode("utf-8")
    req = urllib.request.Request(url, data=req_data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        return {"error": str(e)}

print("--- Checking reclaim-protocol.testnet ---")
res_testnet = rpc_call("https://rpc.testnet.near.org", "query", {
    "request_type": "view_account",
    "finality": "final",
    "account_id": "reclaim-protocol.testnet"
})
print("Testnet account:", json.dumps(res_testnet, indent=2))

print("\n--- Checking reclaim-protocol-mainnet.near ---")
res_mainnet = rpc_call("https://rpc.mainnet.near.org", "query", {
    "request_type": "view_account",
    "finality": "final",
    "account_id": "reclaim-protocol-mainnet.near"
})
print("Mainnet account:", json.dumps(res_mainnet, indent=2))
