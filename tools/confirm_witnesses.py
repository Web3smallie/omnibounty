#!/usr/bin/env python3
"""Confirm Reclaim epoch witnesses from the DEPLOYED contract (read-only).

Queries `get_epoch_by_id` on reclaim-protocol.testnet and prints each
epoch's witness addresses. Use the output to pin witnesses in
`upsert_epoch` — confirmed live contract state, not chat lore.

Usage:
  python tools/confirm_witnesses.py [epoch ...]   # default: 1 2 3
"""
import base64
import json
import sys
import urllib.request

NEAR_RPC = "https://rpc.testnet.near.org"
RECLAIM = "reclaim-protocol.testnet"


def view(method, args):
    body = {"jsonrpc": "2.0", "id": "1", "method": "query", "params": {
        "request_type": "call_function", "finality": "final",
        "account_id": RECLAIM, "method_name": method,
        "args_base64": base64.b64encode(json.dumps(args).encode()).decode()}}
    req = urllib.request.Request(
        NEAR_RPC, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json",
                 "User-Agent": "omnibounty-probe/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def main():
    epochs = sys.argv[1:] or ["1", "2", "3"]
    for ep in epochs:
        r = view("get_epoch_by_id", {"epoch_id": str(ep)})
        res = r.get("result", {})
        if "result" not in res:
            print(f"epoch {ep}: NO RESULT ({str(res.get('error') or r.get('error'))[:160]})")
            continue
        raw = bytes(res["result"]).decode()
        try:
            epoch = json.loads(raw)
        except ValueError:
            print(f"epoch {ep}: non-JSON: {raw[:200]}")
            continue
        if epoch is None:
            print(f"epoch {ep}: (empty)")
            continue
        print(f"epoch {ep}: id={epoch.get('id')} "
              f"min_witnesses={epoch.get('minimum_witness_for_claim_creation')}")
        for w in epoch.get("witnesses", []):
            print(f"  witness address=0x{w.get('address')} host={w.get('host')}")


if __name__ == "__main__":
    main()
