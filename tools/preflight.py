"""OmniBounty deployment preflight probe.

Checks live-network prerequisites without spending funds or submitting
transactions:
  - NEAR testnet RPC reachability + chain id
  - MPC signer account presence and contract code hash
  - Reclaim protocol contract code hash (provenance record)
  - Base Sepolia chain id + USDC contract presence
  - Release-binary reachability (cargo-near / near-sandbox sources)

Read-only. Exit 0 only if every check passes.

Usage:
    python tools/preflight.py
"""
import base64
import hashlib
import json
import urllib.error
import urllib.request

NEAR_RPC = "https://rpc.testnet.near.org"
BASE_RPC = "https://sepolia.base.org"
MPC_ACCOUNT = "v1.signer-prod.testnet"
RECLAIM_ACCOUNT = "reclaim-protocol.testnet"
BASE_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
EXPECT_BASE_CHAIN_ID = 84532

FAILURES = []


def post(url, body, timeout=25):
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json",
                 "User-Agent": "omnibounty-preflight/1.0"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def get_status(url, timeout=25):
    req = urllib.request.Request(url, headers={"User-Agent": "omnibounty-preflight/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status


def check(name, fn):
    try:
        detail = fn()
    except Exception as e:  # noqa: BLE001 - probe must report, not crash
        print(f"FAIL  {name}: {type(e).__name__}: {e}")
        FAILURES.append(name)
        return
    print(f"ok    {name}: {detail}")


def near_status():
    r = post(NEAR_RPC, {"jsonrpc": "2.0", "id": "1", "method": "status", "params": []})
    cid = r["result"]["chain_id"]
    assert cid == "testnet", f"unexpected chain {cid}"
    return f"chain_id={cid} height={r['result']['sync_info']['latest_block_height']}"


def near_account(account):
    r = post(NEAR_RPC, {"jsonrpc": "2.0", "id": "2", "method": "query", "params": {
        "request_type": "view_account", "finality": "final", "account_id": account}})
    if "error" in r:
        raise RuntimeError(r["error"])
    return f"amount={r['result']['amount']} code_hash={r['result']['code_hash']}"


def near_code(account):
    r = post(NEAR_RPC, {"jsonrpc": "2.0", "id": "3", "method": "query", "params": {
        "request_type": "view_code", "finality": "final", "account_id": account}})
    if "error" in r:
        raise RuntimeError(r["error"])
    raw = base64.b64decode(r["result"]["code_base64"])
    return f"wasm_bytes={len(raw)} sha256={hashlib.sha256(raw).hexdigest()}"


def base_chain_id():
    r = post(BASE_RPC, {"jsonrpc": "2.0", "id": "1", "method": "eth_chainId", "params": []})
    cid = int(r["result"], 16)
    assert cid == EXPECT_BASE_CHAIN_ID, f"unexpected chain {cid}"
    return f"chainId={cid}"


def base_code(addr, label):
    r = post(BASE_RPC, {"jsonrpc": "2.0", "id": "2", "method": "eth_getCode",
                        "params": [addr, "latest"]})
    n = (len(r["result"]) - 2) // 2
    assert n > 0, f"{label} has no code"
    return f"{label} code_bytes={n}"


def reachable(url):
    return f"http={get_status(url)}"


def github_api_rate_limit():
    req = urllib.request.Request(
        "https://api.github.com/rate_limit",
        headers={"User-Agent": "omnibounty-preflight/1.0"},
    )
    with urllib.request.urlopen(req, timeout=25) as r:
        body = json.loads(r.read().decode())
    return f"remaining={body['resources']['core']['remaining']}"


def helper_reachable():
    # Any HTTP response (even 404/405 at root) proves the helper is up;
    # only connection failures matter here.
    req = urllib.request.Request(
        "https://helper.testnet.near.org",
        headers={"User-Agent": "omnibounty-preflight/1.0"},
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            return f"http={r.status}"
    except urllib.error.HTTPError as e:
        return f"http={e.code} (reachable)"


def crates_io_object():
    # A real one-byte ranged fetch; the bucket root itself 403s by design.
    req = urllib.request.Request(
        "https://static.crates.io/crates/itoa/itoa-1.0.15.crate",
        headers={"Range": "bytes=0-0", "User-Agent": "omnibounty-preflight/1.0"},
    )
    with urllib.request.urlopen(req, timeout=25) as r:
        body = r.read()
    # Server may ignore Range and return the whole object; either proves fetch.
    assert body[:2] == b"\x1f\x8b", f"not a gzip object ({len(body)} bytes)"
    return f"object-fetch ok ({len(body)} bytes)"


if __name__ == "__main__":
    check("near-rpc-status", near_status)
    check("near-mpc-account", lambda: near_account(MPC_ACCOUNT))
    check("near-mpc-code", lambda: near_code(MPC_ACCOUNT))
    check("near-reclaim-code", lambda: near_code(RECLAIM_ACCOUNT))
    check("base-chain-id", base_chain_id)
    check("base-usdc-code", lambda: base_code(BASE_USDC, "USDC"))
    check("github-reachable", lambda: reachable("https://github.com"))
    check("github-api", github_api_rate_limit)
    check("static-crates-object", crates_io_object)
    check("testnet-helper", lambda: helper_reachable())
    if FAILURES:
        print(f"\n{len(FAILURES)} check(s) failed: {', '.join(FAILURES)}")
        raise SystemExit(1)
    print("\npreflight: all checks passed")
