#!/usr/bin/env python3
"""Run the near-v3 test suite in this sandbox (default stable toolchain,
per rust-toolchain.toml).

The committed manifest pins near-workspaces =0.21.0. Local runs
temporarily relax the xsuite-only deps exactly like the V2 sessions did
(harmless under any toolchain), then restore byte-identical files:

  backup (sha256) -> workspaces=0.10.0, time=0.3.36 -> cargo test "$@" ->
  restore manifest+lock -> verify hashes.

Restore runs in a finally block: a failed test run can never leave the tree
dirty. `cargo build` needs no dance (xsuite deps never compile without the
feature).

Usage:
  python tools/cargo_v3_test.py [-- <cargo test args...>]
  (default run: cargo test --locked --offline)
"""
import hashlib
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CRATE = os.path.join(ROOT, "contracts", "near-v3")
MANIFEST = os.path.join(CRATE, "Cargo.toml")
LOCK = os.path.join(CRATE, "Cargo.lock")

ENV = dict(os.environ)
ENV["CARGO_HOME"] = os.path.join(ROOT, ".cargo-home")
ENV["RUSTUP_HOME"] = os.path.join(ROOT, ".rustup")
ENV["TMP"] = os.path.join(ROOT, ".link-temp")
ENV["TEMP"] = os.path.join(ROOT, ".link-temp")
os.makedirs(os.path.join(ROOT, ".link-temp"), exist_ok=True)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        h.update(f.read())
    return h.hexdigest()


def run(cmd, **kw):
    print(f"+ {' '.join(cmd)}", flush=True)
    return subprocess.run(cmd, cwd=CRATE, env=ENV, **kw)


def main():
    test_args = sys.argv[1:]
    if test_args and test_args[0] == "--":
        test_args = test_args[1:]
    pristine_manifest = sha256_file(MANIFEST)
    pristine_lock = sha256_file(LOCK)
    tmpdir = tempfile.mkdtemp(prefix="v3test-")
    shutil.copy(MANIFEST, os.path.join(tmpdir, "Cargo.toml"))
    shutil.copy(LOCK, os.path.join(tmpdir, "Cargo.lock"))
    test_rc = 3
    try:
        with open(MANIFEST, encoding="utf-8") as f:
            text = f.read()
        relaxed, n = re.subn(
            r'near-workspaces = \{ version = "=0\.21\.0"',
            'near-workspaces = { version = "=0.10.0"',
            text,
        )
        if n != 1:
            raise SystemExit("manifest pin not found (already relaxed?)")
        with open(MANIFEST, "w", encoding="utf-8", newline="") as f:
            f.write(relaxed)
        r = run(["cargo", "update", "-p", "near-workspaces", "--precise", "0.10.0"])
        if r.returncode != 0:
            raise SystemExit("workspaces downgrade failed")
        r = run(["cargo", "update", "-p", "time", "--precise", "0.3.36"])
        if r.returncode != 0:
            raise SystemExit("time downgrade failed")
        cmd = ["cargo", "test", "--locked", "--offline"] + test_args
        test_rc = run(cmd).returncode
    finally:
        shutil.copy(os.path.join(tmpdir, "Cargo.toml"), MANIFEST)
        shutil.copy(os.path.join(tmpdir, "Cargo.lock"), LOCK)
        ok_manifest = sha256_file(MANIFEST) == pristine_manifest
        ok_lock = sha256_file(LOCK) == pristine_lock
        print(f"restore: manifest {'OK' if ok_manifest else 'MISMATCH'} "
              f"lock {'OK' if ok_lock else 'MISMATCH'}", flush=True)
        shutil.rmtree(tmpdir, ignore_errors=True)
        if not (ok_manifest and ok_lock):
            test_rc = 4
    print(f"cargo_v3_test: exit={test_rc}", flush=True)
    return test_rc


if __name__ == "__main__":
    sys.exit(main())
