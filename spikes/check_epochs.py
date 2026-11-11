import urllib.request
import json
import base64
import sys

def view_method(url, account_id, method_name, args_obj):
    args_base64 = base64.b64encode(json.dumps(args_obj).encode("utf-8")).decode("utf-8")
    req_data = json.dumps({
        "jsonrpc": "2.0",
        "id": "dontcare",
        "method": "query",
        "params": {
            "request_type": "call_function",
            "finality": "final",
            "account_id": account_id,
            "method_name": method_name,
            "args_base64": args_base64
        }
    }).encode("utf-8")
    req = urllib.request.Request(url, data=req_data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if "result" in data and "result" in data["result"]:
                raw_bytes = bytes(data["result"]["result"])
                try:
                    return json.loads(raw_bytes.decode("utf-8"))
                except:
                    return raw_bytes.decode("utf-8")
            return data
    except Exception as e:
        return {"error": str(e)}

print("Querying testnet epoch 1 (epoch_id: 1)...", flush=True)
r1 = view_method("https://rpc.testnet.near.org", "reclaim-protocol.testnet", "get_epoch_by_id", {"epoch_id": 1})
print("Epoch 1:", json.dumps(r1), flush=True)

print("Querying testnet epoch 2 (epoch_id: 2)...", flush=True)
r2 = view_method("https://rpc.testnet.near.org", "reclaim-protocol.testnet", "get_epoch_by_id", {"epoch_id": 2})
print("Epoch 2:", json.dumps(r2), flush=True)

print("Querying testnet epoch 1 (epoch_id: '1')...", flush=True)
r1_s = view_method("https://rpc.testnet.near.org", "reclaim-protocol.testnet", "get_epoch_by_id", {"epoch_id": "1"})
print("Epoch 1 (str):", json.dumps(r1_s), flush=True)
