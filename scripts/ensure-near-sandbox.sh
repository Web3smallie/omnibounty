#!/usr/bin/env bash
# Ensure a verified NEAR sandbox binary for xsuite, then print its path.
#
# Background: near-workspaces 0.21 downloads near-sandbox at COMPILE time
# with a proxy-blind HTTP client, so sandboxed/proxied environments fail
# the xsuite build with "unable to download near-sandbox" even though the
# URL is alive. This script fetches the SAME artifact with curl (which
# honors proxy env), verifies both tarball and binary SHA-256 digests, and
# exports it via NEAR_SANDBOX_BIN_PATH — the override the crate itself
# honors at build time (build.rs) and at runtime (bin_path()).
#
# Idempotent: reuses the cached binary after re-verifying its digest.
# Output contract: prints ONLY the absolute binary path on stdout (logs
# go to stderr), so callers do:
#   export NEAR_SANDBOX_BIN_PATH="$(bash scripts/ensure-near-sandbox.sh)"
#
# If the user already exported NEAR_SANDBOX_BIN_PATH to an existing file,
# that override wins and nothing is downloaded.
set -euo pipefail

VERSION="2.9.0"
URL="https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/Linux-x86_64/${VERSION}/near-sandbox.tar.gz"
# Observed 2026-11-14 from the live URL above (same bytes the crate fetches).
# If upstream rotates the artifact, refresh both digests together.
TARBALL_SHA256="5f8480806d2d7e6d5978d652d2df96e52388a29427e51463fbfe7f1cfe5c1b48"
BINARY_SHA256="268d91f78ab13a74cf8aab74343e877f73ebaec7bb640b913c862cdff4829bec"
CACHE_DIR="${HOME}/.cache/omnibounty/near-sandbox-${VERSION}"
BIN="${CACHE_DIR}/near-sandbox"

log() { echo "ensure-near-sandbox: $1" >&2; }

if [ -n "${NEAR_SANDBOX_BIN_PATH:-}" ]; then
  if [ -f "$NEAR_SANDBOX_BIN_PATH" ]; then
    echo "$NEAR_SANDBOX_BIN_PATH"
    exit 0
  fi
  log "warning: NEAR_SANDBOX_BIN_PATH=$NEAR_SANDBOX_BIN_PATH does not exist; re-provisioning"
fi

if [ -f "$BIN" ]; then
  if [ "$(sha256sum "$BIN" | cut -d' ' -f1)" = "$BINARY_SHA256" ]; then
    log "cached binary verified ($BIN)"
    echo "$BIN"
    exit 0
  fi
  log "warning: cached binary failed digest check; re-downloading"
fi

command -v curl >/dev/null || { log "missing 'curl' (install it, then re-run)"; exit 1; }
command -v sha256sum >/dev/null || { log "missing 'sha256sum' (install coreutils, then re-run)"; exit 1; }
mkdir -p "$CACHE_DIR"
TMP="$(mktemp "${CACHE_DIR}/dl.XXXXXX")"
trap 'rm -f "${TMP:-}"' EXIT
log "downloading near-sandbox ${VERSION} ..."
curl -fSL --retry 2 -o "$TMP" "$URL" >&2
[ "$(sha256sum "$TMP" | cut -d' ' -f1)" = "$TARBALL_SHA256" ] \
  || { log "tarball digest mismatch (upstream rotated?); refusing to install. Refresh TARBALL_SHA256/BINARY_SHA256 in $0 after auditing the new artifact."; exit 1; }
tar -xzf "$TMP" -C "$CACHE_DIR" "Linux-x86_64/near-sandbox"
mv "${CACHE_DIR}/Linux-x86_64/near-sandbox" "${BIN}.new"
rmdir "${CACHE_DIR}/Linux-x86_64"
chmod +x "${BIN}.new"
[ "$(sha256sum "${BIN}.new" | cut -d' ' -f1)" = "$BINARY_SHA256" ] \
  || { log "binary digest mismatch after extract; refusing to install"; exit 1; }
mv "${BIN}.new" "$BIN"
log "installed verified binary ($BIN)"
echo "$BIN"
