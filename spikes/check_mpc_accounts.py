import urllib.request
import json

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

for acc in ["v1.signer-prod.testnet", "multichain-testnet-2.testnet"]:
    res = rpc_call("https://rpc.testnet.near.org", "query", {
        "request_type": "view_account",
        "finality": "final",
        "account_id": acc
    })
    print(f"Account {acc}:", res.get("result", {}).get("code_hash", "NOT FOUND or Error"))
