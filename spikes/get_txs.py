import urllib.request
import json

url = "https://api-testnet.nearblocks.io/v1/account/reclaim-protocol.testnet/txns?page=1&per_page=10"
req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
try:
    with urllib.request.urlopen(req, timeout=5) as resp:
        data = json.loads(resp.read().decode("utf-8"))
        print("Tx count:", len(data.get("txns", [])))
        for tx in data.get("txns", []):
            print(f"Hash: {tx.get('transaction_hash')}, Signer: {tx.get('signer_account_id')}, Method: {tx.get('method_name')}, Block: {tx.get('block_timestamp')}")
except Exception as e:
    print("Error:", e)
