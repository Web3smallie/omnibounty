import urllib.request
import json
import base64

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

print("=== TESTNET EPOCHS ===", flush=True)
for ep in range(1, 6):
    r = view_method("https://rpc.testnet.near.org", "reclaim-protocol.testnet", "get_epoch_by_id", {"epoch_id": str(ep)})
    print(f"Testnet Epoch {ep}:", r, flush=True)

print("\n=== MAINNET EPOCHS ===", flush=True)
for ep in range(1, 6):
    r = view_method("https://rpc.mainnet.near.org", "reclaim-protocol-mainnet.near", "get_epoch_by_id", {"epoch_id": str(ep)})
    print(f"Mainnet Epoch {ep}:", r, flush=True)
