"""Fetch MPC contract interface sources for verification (read-only).

Downloads the audited interface files from near/mpc@main into a local
read-only reference directory so the OmniBounty MPC request encoding can be
checked line-by-line against the real contract.

Usage:
    python tools/fetch_mpc_ref.py [--rev <git-rev>]
"""
import pathlib
import sys
import urllib.request

REV = "main"
if "--rev" in sys.argv:
    REV = sys.argv[sys.argv.index("--rev") + 1]

FILES = (
    "crates/contract/src/lib.rs",
    "crates/contract/src/api.rs",
    "crates/contract/src/api/keys.rs",
    "crates/contract/src/api/sign.rs",
    "crates/contract/src/api/ckd.rs",
    "crates/contract/src/primitives.rs",
    "crates/near-mpc-contract-interface/src/lib.rs",
    "crates/near-mpc-contract-interface/src/method_names.rs",
    "crates/near-mpc-contract-interface/src/deposits.rs",
    "crates/near-mpc-contract-interface/src/call_args.rs",
    "crates/near-mpc-contract-interface/src/types/sign.rs",
    "crates/near-mpc-contract-interface/src/types/primitives.rs",
    "crates/near-mpc-crypto-types/src/sign.rs",
    "crates/near-mpc-crypto-types/src/crypto.rs",
    "crates/near-mpc-crypto-types/src/primitives.rs",
    "crates/near-mpc-crypto-types/src/kdf.rs",
    "crates/near-mpc-crypto-types/src/conversions/k256.rs",
    "crates/contract/src/api/common.rs",
    "crates/primitives/src/domain.rs",
)

DEST = pathlib.Path(__file__).resolve().parent / "mpc_ref" / REV.replace("/", "_")


def fetch(path):
    url = f"https://raw.githubusercontent.com/near/mpc/{REV}/{path}"
    req = urllib.request.Request(url, headers={"User-Agent": "omnibounty-probe/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def list_matches(substr):
    url = f"https://api.github.com/repos/near/mpc/git/trees/{REV}?recursive=1"
    req = urllib.request.Request(url, headers={"User-Agent": "omnibounty-probe/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        tree = json.loads(r.read().decode())
    for t in tree.get("tree", []):
        if substr in t["path"] and t["path"].endswith(".rs"):
            print(f"        tree: {t['path']}")
    print("    (truncated)" if tree.get("truncated") else "    (complete)")


if __name__ == "__main__":
    import json

    if "--list" in sys.argv:
        list_matches(sys.argv[sys.argv.index("--list") + 1])
        raise SystemExit(0)
    if "--tags" in sys.argv:
        req = urllib.request.Request(
            "https://api.github.com/repos/near/mpc/tags?per_page=20",
            headers={"User-Agent": "omnibounty-probe/1.0"},
        )
        with urllib.request.urlopen(req, timeout=60) as r:
            tags = json.loads(r.read().decode())
        for t in tags:
            print(f"        tag: {t['name']}")
        raise SystemExit(0)
    DEST.mkdir(parents=True, exist_ok=True)
    for path in FILES:
        try:
            body = fetch(path)
        except Exception as e:  # noqa: BLE001 - report and continue
            print(f"SKIP  {path}: {type(e).__name__}: {e}")
            continue
        out = DEST / path.replace("/", "__")
        out.write_bytes(body)
        print(f"ok    {path} -> {out} ({len(body)} bytes)")
