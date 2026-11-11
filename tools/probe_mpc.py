"""OmniBounty MPC handshake verification probe (read-only).

Determines the DEPLOYED testnet MPC contract's exact interface without
spending funds:
  1. `version` / `config` views pin the deployed build and gas rules.
  2. `public_key` / `derived_public_key` views return the root key and the
     exact voucher key for (v2.omnibounty.testnet, omnibounty-voucher-v1).
  3. `sign` is executed as a *view* call with candidate arg shapes. View
     calls attach zero deposit, so a shape that parses must fail at the
     deposit/precondition check, while a shape the contract does not know
     fails at JSON deserialization. The error kind therefore proves which
     request wire format the deployed contract accepts.

Usage:
    python tools/probe_mpc.py
"""
import base64
import json
import urllib.request

NEAR_RPC = "https://rpc.testnet.near.org"
MPC_ACCOUNT = "v1.signer-prod.testnet"
CONTRACT_ACCOUNT = "v2.omnibounty.testnet"
VOUCHER_PATH = "omnibounty-voucher-v1"


def near_view(account, method, args_obj="__empty__"):
    if args_obj == "__empty__":
        args_b64 = ""
    else:
        args_b64 = base64.b64encode(json.dumps(args_obj).encode()).decode()
    body = {"jsonrpc": "2.0", "id": "1", "method": "query", "params": {
        "request_type": "call_function", "finality": "final",
        "account_id": account, "method_name": method, "args_base64": args_b64}}
    req = urllib.request.Request(
        NEAR_RPC, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json",
                 "User-Agent": "omnibounty-probe/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def report(name, resp):
    if "result" in resp and "result" in resp["result"]:
        raw = bytes(resp["result"]["result"])
        try:
            txt = raw.decode()
        except UnicodeDecodeError:
            txt = "base64:" + base64.b64encode(raw).decode()
        print(f"RETURN  {name}: {txt[:600]}")
    else:
        inner = resp.get("result", {}).get("error") or resp.get("error", {})
        print(f"ERROR   {name}: {str(inner)[:600]}")


if __name__ == "__main__":
    report("version()", near_view(MPC_ACCOUNT, "version"))
    report("config()", near_view(MPC_ACCOUNT, "config"))
    report("public_key(null-domain)",
           near_view(MPC_ACCOUNT, "public_key", {"domain_id": None}))
    report("derived_public_key(voucher)",
           near_view(MPC_ACCOUNT, "derived_public_key",
                      {"path": VOUCHER_PATH, "predecessor": CONTRACT_ACCOUNT,
                       "domain_id": None}))
    payload_bytes = [7] * 32
    report("sign flat-v1",
           near_view(MPC_ACCOUNT, "sign",
                      {"payload": payload_bytes, "path": "probe", "key_version": 0}))
    report("sign wrapped-v2",
           near_view(MPC_ACCOUNT, "sign",
                      {"request": {"path": "probe",
                                   "payload_v2": {"Ecdsa": "07" * 32},
                                   "domain_id": 0}}))
    report("sign wrapped-legacy-inner",
           near_view(MPC_ACCOUNT, "sign",
                      {"request": {"path": "probe", "payload": payload_bytes,
                                   "key_version": 0}}))
