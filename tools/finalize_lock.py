#!/usr/bin/env python3
"""Finalize contracts/near/Cargo.lock for reviewers.

The sandbox build resolves against a local file:// git mirror, so cargo
records legacy `registry+https://github.com/...` source URLs. Reviewers with
network need standard `sparse+https://index.crates.io/` URLs. The package
set and checksums are identical (same .crate bytes); only the source labels
differ. Run once at the end of a sandbox build session.
"""
import os
import re
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_LOCK = os.path.join(ROOT, "contracts", "near", "Cargo.lock")


def main():
    lock = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_LOCK
    mirror = lock + ".mirror"
    with open(lock, encoding="utf-8") as f:
        text = f.read()
    if "sparse+https://index.crates.io/" in text and "registry+https://github" not in text:
        print("lock already in sparse form; nothing to do")
        return
    shutil.copy(lock, mirror)
    text = text.replace(
        "registry+https://github.com/rust-lang/crates.io-index",
        "sparse+https://index.crates.io/",
    )
    with open(lock, "w", encoding="utf-8") as f:
        f.write(text)
    # Report the resolved set for the record.
    pkgs = []
    for chunk in text.split("[[package]]")[1:]:
        name = re.search(r'^name = "(.*)"', chunk, re.M).group(1)
        version = re.search(r'^version = "(.*)"', chunk, re.M).group(1)
        pkgs.append((name, version))
    print(f"packages: {len(pkgs)}")
    for name in ("near-sdk", "k256", "serde", "serde_json", "borsh", "hex"):
        versions = sorted({v for n, v in pkgs if n == name})
        print(f"  {name}: {versions}")
    for chunk in text.split("[[package]]")[1:]:
        if 'name = "omnibounty"' in chunk or 'name = "mock-mpc"' in chunk:
            deps = re.search(r"^dependencies = \[(.*?)\]", chunk, re.M | re.S)
            if deps:
                print("  root deps:", re.findall(r'"([^"]+)"', deps.group(1)))


if __name__ == "__main__":
    sys.exit(main())
