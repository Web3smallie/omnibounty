#!/usr/bin/env python3
"""Extend the local file:// registry mirror with extra crates.

cargo-near's ABI generator needs crates (e.g. near-abi 0.4.x) that are not
in the seed lock. This script resolves them via the crates.io API, verifies
checksums, downloads the .crate files into the cargo cache, emits index
entries into the mirror, and recommits it.

Usage:
  python tools/mirror_extras.py near-abi@^0.4.0 [name@req ...]
"""
import hashlib
import json
import os
import subprocess
import sys
import tarfile
import tempfile
import tomllib
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from local_registry import index_path, index_entry  # noqa: E402
from vendor_crates import primary_cache_dir  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX_DIR = os.path.join(ROOT, "vendor", "registry-index")
CARGO_HOME = os.environ.get("CARGO_HOME", os.path.expanduser("~/.cargo"))
UA = {"User-Agent": "omnibounty-mirror/1.0"}


def fetch_bytes(req, timeout=120):
    import time

    last = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001 - transient network faults
            last = e
            print(f"    retry {attempt + 1}/4 after {type(e).__name__}: {e}",
                  flush=True)
            time.sleep(10)
    raise SystemExit(f"network failed: {last}")


def api(path):
    req = urllib.request.Request(f"https://crates.io/api/v1{path}", headers=UA)
    return json.loads(fetch_bytes(req, timeout=60).decode())


def mirror_versions():
    """name -> set(versions) already indexed.

    Also records (name, version) -> dependency list so cache hits still
    pull their transitive closure (a hit must not skip recursion).
    """
    out = {}
    for dirpath, _, filenames in os.walk(INDEX_DIR):
        if ".git" in dirpath:
            continue
        for fn in filenames:
            if fn == "config.json":
                continue
            with open(os.path.join(dirpath, fn), encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    e = json.loads(line)
                    out.setdefault(e["name"], set()).add(e["vers"])
                    INDEX_DEPS[(e["name"], e["vers"])] = e.get("deps", [])
    return out


INDEX_DEPS = {}


def parse_ver(v):
    return tuple(int(x) for x in v.split("+")[0].split("-")[0].split("."))


def satisfies(version, req):
    req = req.strip()
    if req == "*":
        return True
    if "*" in req:
        # Wildcard req (e.g. "1.0.*"): numeric prefix equality.
        core = req.lstrip("^~= ").split(",")[0]
        want = [int(p) for p in core.split(".") if p != "*"]
        return list(parse_ver(version)[: len(want)]) == want
    if req.startswith("^"):
        req = req[1:]
    if req.startswith("="):
        return parse_ver(version) == parse_ver(req[1:])
    if req.startswith("~"):
        base = parse_ver(req[1:])
        v = parse_ver(version)
        if len(base) >= 3:
            return v[:2] == base[:2] and v >= base
        return v[:1] == base[:1] and v >= base
    if req[0].isdigit():
        base = parse_ver(req)
        v = parse_ver(version)
        if base[0] != 0:
            return v[0] == base[0] and v >= base
        if len(base) > 1 and base[1] != 0:
            return v[:2] == base[:2] and v >= base
        return v == base
    if "," in req or any(c in req for c in "<>="):
        # Compound ranges: evaluate each clause.
        for clause in req.split(","):
            clause = clause.strip()
            v, b = parse_ver(version), None
            for op in (">=", "<=", ">", "<", "="):
                if clause.startswith(op):
                    b = parse_ver(clause[len(op):].strip())
                    if op == ">=" and not (v >= b):
                        return False
                    if op == "<=" and not (v <= b):
                        return False
                    if op == ">" and not (v > b):
                        return False
                    if op == "<" and not (v < b):
                        return False
                    if op == "=" and not (v == b):
                        return False
                    break
            else:
                return satisfies(version, clause)
        return True
    raise SystemExit(f"unsupported req syntax: {req}")


INDEXED = mirror_versions()
ADDED = []
VISITED = set()


def ensure(name, req, parent="?"):
    have = INDEXED.get(name, set())
    cands = sorted((v for v in have if satisfies(v, req)), key=parse_ver)
    if cands:
        ver = cands[-1]
        recurse(name, ver)
        return ver
    # Resolve the highest non-yanked matching version from the API.
    meta = api(f"/crates/{name}")
    versions = [v for v in meta["versions"] if not v["yanked"]]
    versions.sort(key=lambda v: parse_ver(v["num"]))
    match = [v for v in versions if satisfies(v["num"], req)]
    if not match:
        raise SystemExit(f"no version of {name} matches {req}")
    ver = match[-1]["num"]
    cksum = match[-1]["checksum"]
    print(f"adding {name}-{ver} (req {req} via {parent})", flush=True)
    # Download + verify.
    dl_req = urllib.request.Request(
        f"https://crates.io/api/v1/crates/{name}/{ver}/download", headers=UA)
    blob = fetch_bytes(dl_req)
    if hashlib.sha256(blob).hexdigest() != cksum:
        raise SystemExit(f"CHECKSUM MISMATCH {name}-{ver}")
    dest = os.path.join(primary_cache_dir(), f"{name}-{ver}.crate")
    with open(dest, "wb") as f:
        f.write(blob)
    # Index entry from the manifest.
    with tempfile.TemporaryDirectory() as tmp:
        with tarfile.open(dest, "r:gz") as tf:
            tf.extractall(tmp)
        with open(os.path.join(tmp, f"{name}-{ver}", "Cargo.toml"), "rb") as f:
            manifest = tomllib.load(f)
    entry = index_entry({"name": name, "version": ver, "checksum": cksum}, manifest)
    rel = index_path(name)
    dest_idx = os.path.join(INDEX_DIR, rel)
    os.makedirs(os.path.dirname(dest_idx), exist_ok=True)
    with open(dest_idx, "a", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(entry, separators=(",", ":")) + "\n")
    INDEXED.setdefault(name, set()).add(ver)
    INDEX_DEPS[(name, ver)] = entry["deps"]
    ADDED.append(f"{name}-{ver}")
    recurse(name, ver)
    return ver


MANIFEST_CACHE = {}


def default_optional_deps(name, ver):
    """Optional dep names enabled by the crate's default features.

    Parsed from the cached .crate manifest (`dep:foo` and bare `foo`
    enable; weak `foo?/x` does not). If the manifest is unavailable the
    dep is treated as disabled: cargo names any truly-missing crate in
    its error, and it can be added explicitly.
    """
    key = (name, ver)
    if key in MANIFEST_CACHE:
        return MANIFEST_CACHE[key]
    enabled = set()
    path = os.path.join(primary_cache_dir(), f"{name}-{ver}.crate")
    if os.path.exists(path):
        with tempfile.TemporaryDirectory() as tmp:
            with tarfile.open(path, "r:gz") as tf:
                tf.extractall(tmp)
            with open(os.path.join(tmp, f"{name}-{ver}", "Cargo.toml"),
                      "rb") as f:
                manifest = tomllib.load(f)
        feats = manifest.get("features", {})
        optional = set()
        for section in ("dependencies", "dev-dependencies",
                        "build-dependencies"):
            for dep_name, spec in manifest.get(section, {}).items():
                if isinstance(spec, dict) and spec.get("optional"):
                    optional.add(dep_name)
        for target in manifest.get("target", {}).values():
            for section in ("dependencies", "dev-dependencies",
                            "build-dependencies"):
                for dep_name, spec in target.get(section, {}).items():
                    if isinstance(spec, dict) and spec.get("optional"):
                        optional.add(dep_name)
        # Transitive closure over feature refs (bare tokens can name both
        # a feature and an implicit optional dep of the same name).
        stack, seen = ["default"], set()
        while stack:
            feat = stack.pop()
            if feat in seen or feat not in feats:
                continue
            seen.add(feat)
            for tok in feats[feat]:
                tok = tok.strip()
                if tok.startswith("dep:"):
                    enabled.add(tok[4:])
                elif "?" in tok or "/" in tok:
                    continue  # weak / dep-feature: enables nothing itself
                else:
                    if tok in optional:
                        enabled.add(tok)
                    if tok in feats:
                        stack.append(tok)
    MANIFEST_CACHE[key] = enabled
    return enabled


def recurse(name, ver):
    # Normal/build deps only: dev-deps of non-workspace members never
    # resolve, so they are skipped like cargo skips them. Optional deps
    # are followed only when the parent's default features enable them;
    # anything genuinely missing is named by cargo's error and added
    # explicitly.
    if (name, ver) in VISITED:
        return
    VISITED.add((name, ver))
    optionals = default_optional_deps(name, ver)
    for dep in INDEX_DEPS.get((name, ver), []):
        if dep["kind"] == "dev":
            continue
        if dep.get("optional") and dep["name"] not in optionals:
            continue
        ensure(dep["package"] or dep["name"], dep["req"],
               parent=f"{name}-{ver}"
               + ("[optional]" if dep.get("optional") else "")
               + (f"[{dep['target']}]" if dep.get("target") else ""))


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    for spec in sys.argv[1:]:
        name, _, req = spec.partition("@")
        ensure(name, req or "*")
    if ADDED:
        git = ["git", "-C", INDEX_DIR]
        subprocess.run(git + ["add", "-A"], check=True, capture_output=True)
        subprocess.run(
            git + ["-c", "user.email=omnibounty@local",
                   "-c", "user.name=omnibounty",
                   "commit", "-m", f"mirror extras: {', '.join(ADDED)}"],
            check=True, capture_output=True)
        print(f"committed {len(ADDED)} new crates: {', '.join(ADDED)}")
        print("NOTE: delete the cargo index-clone cache so cargo re-clones:")
        print("  Remove-Item -Recurse -Force $env:CARGO_HOME/registry/index/-*")
    else:
        print("all requirements already satisfied by the mirror")


if __name__ == "__main__":
    main()
