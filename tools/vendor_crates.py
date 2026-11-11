#!/usr/bin/env python3
"""Offline-vendoring helper for the OmniBounty NEAR contract.

Sandbox TLS note: cargo/curl TLS (schannel) is broken in this environment,
but Python HTTPS works. This script downloads the exact crates.io files
pinned by the seed lockfile into the local cargo cache so `cargo --offline`
can build and test without network.

It is a LOCAL workaround: reviewers with working cargo TLS should just run
`cargo test` (the committed contracts/near/Cargo.lock pins all versions).

Usage:
  python tools/vendor_crates.py analyze   # report lock stats + dupes
  python tools/vendor_crates.py fetch     # download missing .crate files
  python tools/vendor_crates.py lock      # write adapted contracts/near/Cargo.lock
"""
import hashlib
import os
import re
import shutil
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SEED_LOCK = os.path.join(ROOT, "spikes", "near-sdk-onchain-integration", "Cargo.lock")
OUT_LOCK = os.path.join(ROOT, "contracts", "near", "Cargo.lock")
CARGO_HOME = os.environ.get("CARGO_HOME", os.path.expanduser("~/.cargo"))


def cache_dirs():
    base = os.path.join(CARGO_HOME, "registry", "cache")
    if not os.path.isdir(base):
        return []
    return [os.path.join(base, d) for d in os.listdir(base)]


def primary_cache_dir():
    base = os.path.join(CARGO_HOME, "registry", "cache")
    # Reuse an existing hash dir if present, else use cargo's current default
    # for the sparse index (cargo recreates/ignores as needed; --offline only
    # needs the .crate files present).
    found = cache_dirs()
    if found:
        return found[0]
    default = os.path.join(base, "index.crates.io-6f17d22bba15001f")
    os.makedirs(default, exist_ok=True)
    return default

ROOT_DEPS = [
    "anyhow",
    "hex",
    "k256",
    "near-sdk",
    "near-workspaces",
    "schemars",
    "serde",
    "serde_json",
    "tokio",
]


def parse_lock(path):
    with open(path, encoding="utf-8") as f:
        text = f.read()
    header, _, _ = text.partition("[[package]]")
    pkgs = []
    for chunk in text.split("[[package]]")[1:]:
        name = re.search(r'^name = "(.*)"', chunk, re.M).group(1)
        version = re.search(r'^version = "(.*)"', chunk, re.M).group(1)
        src = re.search(r'^source = "(.*)"', chunk, re.M)
        cks = re.search(r'^checksum = "(.*)"', chunk, re.M)
        deps_m = re.search(r"^dependencies = \[(.*?)\]", chunk, re.M | re.S)
        deps = re.findall(r'"([^"]+)"', deps_m.group(1)) if deps_m else []
        pkgs.append({
            "name": name, "version": version,
            "source": src.group(1) if src else None,
            "checksum": cks.group(1) if cks else None,
            "deps": deps,
        })
    return header, pkgs


def cached_path(name, version):
    fname = f"{name}-{version}.crate"
    for d in cache_dirs():
        p = os.path.join(d, fname)
        if os.path.exists(p):
            return p
    return None


def home_cached_path(name, version):
    """Read-only shared home cache (seed to avoid re-downloads)."""
    home_base = os.path.join(os.path.expanduser("~/.cargo"), "registry", "cache")
    if not os.path.isdir(home_base):
        return None
    if os.path.abspath(CARGO_HOME) == os.path.abspath(
        os.path.expanduser("~/.cargo")
    ):
        return None
    fname = f"{name}-{version}.crate"
    for d in os.listdir(home_base):
        p = os.path.join(home_base, d, fname)
        if os.path.exists(p):
            return p
    return None


def reachable(pkgs):
    """Packages reachable from ROOT_DEPS following lock edges."""
    by_name = {}
    for p in pkgs:
        by_name.setdefault(p["name"], []).append(p)

    def resolve(dep_str):
        parts = dep_str.split(" ")
        if len(parts) == 1:
            cands = by_name.get(parts[0], [])
            if len(cands) == 1:
                return cands[0]
            raise SystemExit(f"ambiguous dep {dep_str}: {cands}")
        name, version = parts[0], parts[1]
        for c in by_name.get(name, []):
            if c["version"] == version:
                return c
        raise SystemExit(f"unresolvable dep {dep_str}")

    seen = set()
    stack = []
    for r in ROOT_DEPS:
        cands = [p for p in by_name.get(r, []) if p["source"]]
        if len(cands) != 1:
            raise SystemExit(f"root {r}: {cands}")
        stack.append(cands[0])
    while stack:
        p = stack.pop()
        key = (p["name"], p["version"])
        if key in seen:
            continue
        seen.add(key)
        for d in p["deps"]:
            stack.append(resolve(d))
    return [p for p in pkgs if (p["name"], p["version"]) in seen]


def cmd_analyze():
    header, pkgs = parse_lock(SEED_LOCK)
    reg = [p for p in pkgs if p["source"] and "crates.io" in p["source"]]
    print(f"total packages: {len(pkgs)}, registry: {len(reg)}")
    seen = {}
    for p in reg:
        seen.setdefault(p["name"], []).append(p["version"])
    dupes = {k: v for k, v in seen.items() if len(v) > 1}
    print(f"duplicate-name crates: {len(dupes)}")
    for k, v in sorted(dupes.items()):
        print(f"  {k}: {v}")
    missing = [p for p in reg if not cached_path(p["name"], p["version"])]
    print(f"missing from cargo cache: {len(missing)}")
    for p in missing[:40]:
        print(f"  {p['name']}-{p['version']}")
    if len(missing) > 40:
        print(f"  ... and {len(missing) - 40} more")
    roots = [p for p in pkgs if not p["source"]]
    print(f"root packages: {[(p['name'], p['deps']) for p in roots]}")


def fetch_one(pkg):
    name, version = pkg["name"], pkg["version"]
    url = f"https://crates.io/api/v1/crates/{name}/{version}/download"
    req = urllib.request.Request(url, headers={"User-Agent": "omnibounty-vendor/1.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = resp.read()
    digest = hashlib.sha256(data).hexdigest()
    if digest != pkg["checksum"]:
        raise SystemExit(f"CHECKSUM MISMATCH {name}-{version}")
    d = primary_cache_dir()
    with open(os.path.join(d, f"{name}-{version}.crate"), "wb") as f:
        f.write(data)
    return len(data)


def cmd_fetch():
    _, pkgs = parse_lock(SEED_LOCK)
    reg = [p for p in reachable(pkgs) if p["source"] and "crates.io" in p["source"]]
    print(f"reachable registry packages: {len(reg)}", flush=True)
    missing = [p for p in reg if not cached_path(p["name"], p["version"])]
    print(f"fetching {len(missing)} crates...", flush=True)
    total = 0
    for i, p in enumerate(missing):
        try:
            home = home_cached_path(p["name"], p["version"])
            if home:
                with open(home, "rb") as f:
                    data = f.read()
                if hashlib.sha256(data).hexdigest() != p["checksum"]:
                    raise SystemExit(f"HOME CACHE CORRUPT {p['name']}")
                dest = os.path.join(
                    primary_cache_dir(), f"{p['name']}-{p['version']}.crate"
                )
                with open(dest, "wb") as f:
                    f.write(data)
                n = len(data)
            else:
                n = fetch_one(p)
        except Exception as e:
            raise SystemExit(f"FAILED {p['name']}-{p['version']}: {e}")
        total += n
        if (i + 1) % 20 == 0:
            print(f"  {i + 1}/{len(missing)} ({total // 1024} KiB)", flush=True)
    print(f"done: {len(missing)} crates, {total // 1024} KiB")


def cmd_lock():
    with open(SEED_LOCK, encoding="utf-8") as f:
        text = f.read()
    # Replace the root package stanza (name + deps) with ours.
    pattern = re.compile(
        r'\[\[package\]\]\nname = "reclaim-near-contract"\nversion = "0\.1\.0"\ndependencies = \[(.*?)\]',
        re.S,
    )
    m = pattern.search(text)
    if not m:
        raise SystemExit("root stanza not found in seed lock")
    deps = "\n" + "".join(f' "{d}",\n' for d in ROOT_DEPS)
    repl = '[[package]]\nname = "omnibounty"\nversion = "1.0.0"\ndependencies = [%s]' % deps
    text = pattern.sub(repl, text, count=1)
    with open(OUT_LOCK, "w", encoding="utf-8") as f:
        f.write(text)
    print(f"wrote {OUT_LOCK}")


def cmd_seed_cache():
    """Copy prefetched .crates into the replacement-source cache dir.

    Cargo addresses the file:// mirror's download cache by a hash of the
    mirror URL (observed as registry/cache/-<16hex>). The hash is
    path-dependent, so discover it from the registry/index clone dir created
    by the first `cargo fetch` (same `-<16hex>` name) instead of hardcoding.
    """
    import glob

    base = os.path.join(CARGO_HOME, "registry")
    clones = glob.glob(os.path.join(base, "index", "-*"))
    if not clones:
        raise SystemExit("no local-mirror index clone found; run cargo fetch once first")
    tag = os.path.basename(clones[0])
    dest = os.path.join(base, "cache", tag)
    os.makedirs(dest, exist_ok=True)
    src = primary_cache_dir()
    n = 0
    for fname in os.listdir(src):
        if fname.endswith(".crate"):
            if os.path.abspath(src) == os.path.abspath(dest):
                n += 1
                continue
            shutil.copy(os.path.join(src, fname), os.path.join(dest, fname))
            n += 1
    print(f"seeded {n} crates into {dest}")


def cmd_dupes():
    import collections

    _, pkgs = parse_lock(SEED_LOCK)
    reg = [p for p in reachable(pkgs) if p["source"]]
    by = collections.defaultdict(list)
    for p in reg:
        by[p["name"]].append(p["version"])
    dupes = {k: v for k, v in by.items() if len(v) > 1}
    print(f"reachable: {len(reg)} dupes: {len(dupes)}")
    for k, v in sorted(dupes.items()):
        print(f"  {k}: {v}")


def cmd_fetch_one():
    """Fetch one crate@version from the seed lock into the cargo cache.

    Usage: python tools/vendor_crates.py fetch-one <name> <version>
    """
    if len(sys.argv) != 4:
        raise SystemExit("usage: vendor_crates.py fetch-one <name> <version>")
    name, version = sys.argv[2], sys.argv[3]
    _, pkgs = parse_lock(SEED_LOCK)
    cands = [p for p in pkgs if p["name"] == name and p["version"] == version]
    if not cands:
        raise SystemExit(f"{name}-{version} not in seed lock")
    if cached_path(name, version):
        print(f"already cached: {name}-{version}")
        return
    n = fetch_one(cands[0])
    print(f"fetched {name}-{version} ({n} bytes)")


if __name__ == "__main__":
    cmds = {
        "analyze": cmd_analyze,
        "fetch": cmd_fetch,
        "fetch-one": cmd_fetch_one,
        "lock": cmd_lock,
        "dupes": cmd_dupes,
        "seed-cache": cmd_seed_cache,
    }
    if len(sys.argv) < 2 or sys.argv[1] not in cmds:
        raise SystemExit(__doc__)
    cmds[sys.argv[1]]()
