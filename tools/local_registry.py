#!/usr/bin/env python3
"""Build a local file:// crates.io mirror (git index) from pinned .crate files.

Sandbox TLS note: cargo/curl TLS is broken here, so cargo cannot reach
crates.io. This script builds a LOCAL git registry index from the already
downloaded .crate files (see vendor_crates.py fetch). Cargo then resolves
fully offline against file:// URLs, using the prefetched .crate cache for
downloads (no network leaves the machine).

Local-use only: reviewers with working cargo TLS just run `cargo test`.

Steps performed by `build`:
  1. Unpack each reachable .crate, read its manifest.
  2. Emit git-index JSON lines (deps/features/checksums from lock+manifest).
  3. Commit to vendor/registry-index (branch master).
  4. Write contracts/near/.cargo/config.toml source replacement (gitignored).

Usage:
  python tools/local_registry.py build
"""
import hashlib
import json
import os
import subprocess
import sys
import tarfile
import tempfile
import tomllib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from vendor_crates import parse_lock, SEED_LOCK, reachable  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX_DIR = os.path.join(ROOT, "vendor", "registry-index")
CARGO_CONFIG = os.path.join(ROOT, "contracts", "near", ".cargo", "config.toml")


def cache_crate_path(name, version):
    cargo_home = os.environ.get("CARGO_HOME", os.path.expanduser("~/.cargo"))
    base = os.path.join(cargo_home, "registry", "cache")
    fname = f"{name}-{version}.crate"
    for d in os.listdir(base):
        p = os.path.join(base, d, fname)
        if os.path.exists(p):
            return p
    raise SystemExit(f"missing .crate for {name}-{version} (run vendor_crates.py fetch)")


def index_path(name):
    # Verified against the live sparse index: every path component is
    # lowercase, including the final filename (e.g. in/fl/inflector).
    if len(name) == 1:
        return os.path.join("1", name).lower()
    if len(name) == 2:
        return os.path.join("2", name).lower()
    if len(name) == 3:
        return os.path.join("3", name[0], name).lower()
    return os.path.join(name[0:2], name[2:4], name).lower()


def manifest_deps(manifest):
    """Yield (dep_name, req, features, optional, default_features, target, kind, package)."""
    sections = [
        ("dependencies", None, "normal"),
        ("dev-dependencies", None, "dev"),
        ("build-dependencies", None, "build"),
    ]
    for target, table in (manifest.get("target") or {}).items():
        if not isinstance(table, dict):
            continue
        for key, kind in (
            ("dependencies", "normal"),
            ("dev-dependencies", "dev"),
            ("build-dependencies", "build"),
        ):
            if key in table:
                sections.append((key, target, kind))

    seen_tables = set()

    def walk(table, target, kind):
        for dep_name, spec in (table or {}).items():
            if isinstance(spec, str):
                yield (dep_name, spec, [], False, True, target, kind, None)
            elif isinstance(spec, dict):
                if "git" in spec or "path" in spec:
                    raise SystemExit(f"non-registry dep not supported: {dep_name}={spec}")
                yield (
                    dep_name,
                    spec.get("version", "*"),
                    list(spec.get("features", [])),
                    bool(spec.get("optional", False)),
                    spec.get("default-features", spec.get("default_features", True)),
                    target,
                    kind,
                    spec.get("package"),
                )
            else:
                raise SystemExit(f"bad dep spec: {dep_name}={spec}")

    for key, target, kind in sections:
        if target is None:
            table = manifest.get(key)
        else:
            table = (manifest.get("target", {}).get(target, {}) or {}).get(key)
        marker = (key, target)
        if marker in seen_tables:
            continue
        seen_tables.add(marker)
        yield from walk(table, target, kind)


def index_entry(pkg, manifest):
    deps = []
    for (dep_name, req, feats, optional, default_feats, target, kind, package) in manifest_deps(manifest):
        deps.append({
            "name": dep_name,
            "req": req,
            "features": feats,
            "optional": optional,
            "default_features": default_feats,
            "target": target,
            "kind": kind,
            "registry": None,
            "package": package,
        })
    features, features2 = {}, {}
    for fname, values in (manifest.get("features") or {}).items():
        vals = [str(v) for v in values]
        if any((":" in v or "?" in v) for v in vals):
            features2[fname] = vals
        else:
            features[fname] = vals
    package_meta = manifest.get("package", {})
    return {
        "name": pkg["name"],
        "vers": pkg["version"],
        "deps": deps,
        "cksum": pkg["checksum"],
        "features": features,
        "features2": features2,
        "yanked": False,
        "links": package_meta.get("links"),
        "rust_version": package_meta.get("rust-version"),
    }


def cmd_build():
    _, pkgs = parse_lock(SEED_LOCK)
    reg = [p for p in reachable(pkgs) if p["source"] and "crates.io" in p["source"]]
    print(f"indexing {len(reg)} crates...", flush=True)
    # Fresh index dir (keep .git; drop stale files from prior runs).
    import shutil as _shutil

    os.makedirs(INDEX_DIR, exist_ok=True)
    for entry in os.listdir(INDEX_DIR):
        if entry == ".git":
            continue
        full = os.path.join(INDEX_DIR, entry)
        if os.path.isdir(full) and not os.path.islink(full):
            _shutil.rmtree(full)
        else:
            os.remove(full)
    with open(os.path.join(INDEX_DIR, "config.json"), "w", encoding="utf-8") as f:
        json.dump({"dl": "https://static.crates.io/crates/{crate}/{version}/download", "api": "https://crates.io"}, f)
    lines_by_file = {}
    with tempfile.TemporaryDirectory() as tmp:
        for i, pkg in enumerate(reg):
            crate_path = cache_crate_path(pkg["name"], pkg["version"])
            with open(crate_path, "rb") as f:
                digest = hashlib.sha256(f.read()).hexdigest()
            if digest != pkg["checksum"]:
                raise SystemExit(f"checksum mismatch {pkg['name']}-{pkg['version']}")
            with tarfile.open(crate_path, "r:gz") as tf:
                tf.extractall(tmp)
            manifest_path = os.path.join(tmp, f"{pkg['name']}-{pkg['version']}", "Cargo.toml")
            with open(manifest_path, "rb") as f:
                manifest = tomllib.load(f)
            entry = index_entry(pkg, manifest)
            lines_by_file.setdefault(index_path(pkg["name"]), []).append(json.dumps(entry, separators=(",", ":")))
            # Clean unpacked dir for the next crate.
            unpacked = os.path.join(tmp, f"{pkg['name']}-{pkg['version']}")
            import shutil

            shutil.rmtree(unpacked, ignore_errors=True)
            if (i + 1) % 100 == 0:
                print(f"  {i + 1}/{len(reg)}", flush=True)
    for rel, lines in lines_by_file.items():
        dest = os.path.join(INDEX_DIR, rel)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "w", encoding="utf-8", newline="\n") as f:
            f.write("\n".join(lines) + "\n")
    print(f"wrote {len(lines_by_file)} index files", flush=True)

    # Commit the index. The repo is rebuilt from scratch every run because
    # Windows git preserves old path casing across renames (index paths must
    # be all-lowercase).
    import shutil as _shutil2

    _shutil2.rmtree(os.path.join(INDEX_DIR, ".git"), ignore_errors=True)
    git = ["git", "-C", INDEX_DIR]
    subprocess.run(git + ["init", "-b", "master"], check=True, capture_output=True)
    subprocess.run(git + ["add", "-A"], check=True, capture_output=True)
    subprocess.run(
        git + ["-c", "user.email=omnibounty@local", "-c", "user.name=omnibounty", "commit", "-m", "local crates.io mirror", "--allow-empty"],
        check=True,
        capture_output=True,
    )
    print("index committed", flush=True)

    # Source replacement (local workaround; gitignored).
    os.makedirs(os.path.dirname(CARGO_CONFIG), exist_ok=True)
    url = "file:///" + INDEX_DIR.replace("\\", "/")
    with open(CARGO_CONFIG, "w", encoding="utf-8", newline="\n") as f:
        f.write(
            "# LOCAL SANDBOX WORKAROUND (gitignored): cargo TLS is broken in this\n"
            "# environment, so crates-io is replaced with a local file:// mirror\n"
            "# built from pinned .crate files. Reviewers with network delete this\n"
            "# file (or it is simply absent from git) and build normally.\n"
            '[source.crates-io]\nreplace-with = "local-mirror"\n\n'
            '[source.local-mirror]\nregistry = "'
            + url
            + '"\n'
        )
    print(f"wrote {CARGO_CONFIG}", flush=True)


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] != "build":
        raise SystemExit(__doc__)
    cmd_build()
