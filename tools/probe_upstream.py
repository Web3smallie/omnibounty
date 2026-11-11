"""OmniBounty upstream verification probe (read-only).

1. Probes the live MPC contract for known view methods (root public key).
2. Lists latest release assets for cargo-near and near-sandbox-rs to
   determine Windows availability.
3. Locates the MPC contract source tree on GitHub so the sign
   request/response interface can be verified against the actual code.

Exit 0 only if every query succeeds. Prints raw evidence.

Usage:
    python tools/probe_upstream.py
"""
import base64
import json
import urllib.request

NEAR_RPC = "https://rpc.testnet.near.org"
MPC_ACCOUNT = "v1.signer-prod.testnet"
UA = {"User-Agent": "omnibounty-probe/1.0"}
FAILURES = []


def gh_json(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def near_view(account, method, args_b64=""):
    body = {"jsonrpc": "2.0", "id": "1", "method": "query", "params": {
        "request_type": "call_function", "finality": "final",
        "account_id": account, "method_name": method, "args_base64": args_b64}}
    req = urllib.request.Request(
        NEAR_RPC, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", **UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def show(name, ok, detail):
    print(f"{'ok  ' if ok else 'FAIL'}  {name}: {detail}")
    if not ok:
        FAILURES.append(name)


if __name__ == "__main__":
    print("== MPC view-method probe ==")
    for method in ("public_key", "latest_public_key", "public_key_for",
                   "derived_public_key", "sign"):
        r = near_view(MPC_ACCOUNT, method)
        if "result" in r and "result" in r["result"]:
            raw = bytes(r["result"]["result"])
            try:
                txt = raw.decode()
            except UnicodeDecodeError:
                txt = base64.b64encode(raw).decode()
            show(f"mpc-view-{method}", True, f"returned {len(raw)} bytes: {txt[:300]}")
        else:
            inner = r.get("result", {}).get("error") or r.get("error", {})
            show(f"mpc-view-{method}", True,
                 f"no result ({str(inner)[:200]})")

    print("== release assets ==")
    for repo in ("near/cargo-near",):
        try:
            rel = gh_json(f"https://api.github.com/repos/{repo}/releases/latest")
            names = sorted(a["name"] for a in rel.get("assets", []))
            show(f"release-{repo}", True,
                 f"tag={rel.get('tag_name')} assets={len(names)}")
            for n in names:
                print(f"        asset: {n}")
        except Exception as e:  # noqa: BLE001 - probe reports, not crashes
            show(f"release-{repo}", False, f"{type(e).__name__}: {e}")
    # near-workspaces 0.10 fetches its sandbox binary from the nearcore S3
    # builds (there is no sandbox release repo anymore). A HEAD on the
    # Linux artifact proves availability for Linux CI; Windows has no
    # sandbox binary by design (near-sandbox-utils::platform).
    try:
        req = urllib.request.Request(
            "https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/Linux-x86_64/1.35.0/1e781bcccfaeb9a4bb9531155193a459257afd8d/near-sandbox.tar.gz",
            headers={"User-Agent": "omnibounty-probe/1.0"},
            method="HEAD",
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            show("sandbox-s3-linux", True,
                 f"http={r.status} bytes={r.headers.get('Content-Length')}")
    except Exception as e:  # noqa: BLE001
        show("sandbox-s3-linux", False, f"{type(e).__name__}: {e}")

    print("== MPC contract source tree ==")
    found = False
    for repo in ("near/mpc", "near/near-mpc", "near/chain-signatures",
                 "near/mpc-contract"):
        for branch in ("main", "master"):
            try:
                tree = gh_json(
                    f"https://api.github.com/repos/{repo}/git/trees/{branch}?recursive=1")
                paths = [t["path"] for t in tree.get("tree", [])
                         if t["path"].endswith(".rs") and "contract" in t["path"]]
                show(f"tree-{repo}@{branch}", True,
                     f"{len(paths)} contract rs files")
                for p in sorted(paths)[:20]:
                    print(f"        rs: {p}")
                found = True
            except Exception as e:  # noqa: BLE001
                print(f"      skip {repo}@{branch}: {type(e).__name__}: {e}")
    if not found:
        show("mpc-source-tree", False, "no candidate repo resolved")

    if FAILURES:
        print(f"\n{len(FAILURES)} probe(s) failed: {', '.join(FAILURES)}")
        raise SystemExit(1)
    print("\nprobe complete")
