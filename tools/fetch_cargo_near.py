#!/usr/bin/env python3
"""Download and verify the cargo-near release binary (pinned version).

cargo-near 0.23.0 ships Windows builds. The tarball + detached sha256 are
fetched from the GitHub release, the digest is verified, and the binary is
installed into .tool-bin/ (gitignored, local use).

Usage:
  python tools/fetch_cargo_near.py [--version 0.23.0]
"""
import hashlib
import os
import sys
import tarfile
import urllib.request

VERSION = "0.23.0"
if "--version" in sys.argv:
    VERSION = sys.argv[sys.argv.index("--version") + 1]

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOL_BIN = os.path.join(ROOT, ".tool-bin")
ASSET = "cargo-near-x86_64-pc-windows-msvc.tar.gz"
BASE = f"https://github.com/near/cargo-near/releases/download/cargo-near-v{VERSION}"


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "omnibounty-fetch/1.0"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def main():
    os.makedirs(TOOL_BIN, exist_ok=True)
    print(f"downloading {ASSET} ...", flush=True)
    blob = get(f"{BASE}/{ASSET}")
    want = get(f"{BASE}/{ASSET}.sha256").decode().split()[0]
    got = hashlib.sha256(blob).hexdigest()
    if got != want:
        raise SystemExit(f"SHA256 MISMATCH:\n  want {want}\n  got  {got}")
    print(f"sha256 ok ({len(blob)} bytes)", flush=True)
    tmp = os.path.join(TOOL_BIN, ASSET)
    with open(tmp, "wb") as f:
        f.write(blob)
    with tarfile.open(tmp, "r:gz") as tf:
        names = tf.getnames()
        tf.extractall(TOOL_BIN)
    os.remove(tmp)
    print(f"extracted: {names}")
    # The binary may sit one directory down; hoist it to .tool-bin/.
    for dirpath, _dirnames, filenames in os.walk(TOOL_BIN):
        for fn in filenames:
            if fn in ("cargo-near.exe", "cargo-near"):
                src = os.path.join(dirpath, fn)
                dest = os.path.join(TOOL_BIN, fn)
                if os.path.abspath(src) != os.path.abspath(dest):
                    if os.path.exists(dest):
                        os.remove(dest)
                    os.replace(src, dest)
                print(f"installed: {dest}")
                return
    raise SystemExit("cargo-near binary not found after extraction")


if __name__ == "__main__":
    main()
