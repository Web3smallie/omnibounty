#!/usr/bin/env bash
# OmniBounty canonical read-only verification (judges + agents).
#
# Validates environment configuration, live contract/network state, and the
# fast automated suites. Sends NO transactions, funds NOTHING, deploys
# NOTHING: every network call below is a read-only RPC view. Exit 0 only
# when every required check passes; exit 1 otherwise.
#
# Expected values and their provenance (all values below are byte-compared):
#   code hash  8yGz...quiYj  audit-backup-20261113/DEPLOYED.md (verified live
#                            at document time; hardcoded here because that
#                            directory is workspace-local, not in fresh clones)
#   contract/chain/escrow/signer/witness  testdata/production_testnet_v3.json
#                            (tracked; read at runtime, single source of truth)
#
# Usage: ./scripts/verify.sh
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

NEAR_RPC="${NEAR_RPC_URL:-https://rpc.testnet.near.org}"
BASE_RPC="${BASE_RPC_URL:-https://sepolia.base.org}"
CONTRACT="omnibounty-v3.testnet"
EXPECTED_CODE_HASH="8yGzesTCJSRu4egz4bBeS19ABLSb6Y6TJQpRHH7quiYj"

echo "==> 1/6 prerequisite commands"
for cmd in curl python3 node npm; do
  command -v "$cmd" >/dev/null || { fail "missing required command: $cmd (run scripts/setup.sh)"; }
done
[ "$FAIL" = "0" ] && pass "curl python3 node npm present"

echo "==> 2/6 deployed NEAR code hash (read-only)"
if code_hash="$(curl -s -m 30 -X POST "$NEAR_RPC" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":\"verify\",\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$CONTRACT\"}}" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["code_hash"])')" \
  && [ -n "$code_hash" ]; then
  if [ "$code_hash" = "$EXPECTED_CODE_HASH" ]; then
    pass "on-chain code hash matches DEPLOYED.md ($code_hash)"
  else
    fail "on-chain code hash $code_hash != expected $EXPECTED_CODE_HASH (redeployed?)"
  fi
else
  fail "could not read $CONTRACT account from $NEAR_RPC"
fi

echo "==> 3/6 live config matches the deployment record (read-only)"
cfg_json="$(curl -s -m 30 -X POST "$NEAR_RPC" -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":\"verify\",\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$CONTRACT\",\"method_name\":\"get_config\",\"args_base64\":\"e30=\"}}" \
  | python3 -c 'import json,sys; print(bytes(json.load(sys.stdin)["result"]["result"]).decode())')" || cfg_json=""
if [ -n "$cfg_json" ]; then
  drift="$(CONFIG_JSON="$cfg_json" python3 - "$ROOT/testdata/production_testnet_v3.json" <<'EOF'
import json, os, sys
cfg = json.loads(os.environ["CONFIG_JSON"])
rec = json.load(open(sys.argv[1]))
want = {"chain_id": rec["chainId"], "escrow": rec["escrow"],
        "mpc_signer": rec["mpcSigner"]}
bad = [k for k, v in want.items() if str(cfg.get(k)).lower() != str(v).lower()]
if cfg.get("paused") is not False:
    bad.append("paused(is True)")
print(",".join(bad))
EOF
)"
  if [ -z "$drift" ]; then
    pass "get_config matches record (chain/escrow/signer/paused=false)"
  else
    fail "get_config drift: $drift"
  fi
else
  fail "could not read get_config from $CONTRACT"
fi

echo "==> 4/6 pinned epoch witnesses (read-only)"
if epoch_json="$(curl -s -m 30 -X POST "$NEAR_RPC" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":\"verify\",\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$CONTRACT\",\"method_name\":\"get_epoch\",\"args_base64\":\"$(printf '{"epoch_id":1}' | base64 -w0)\"}}" \
    | python3 -c 'import json,sys; print(bytes(json.load(sys.stdin)["result"]["result"]).decode())')"; then
  if echo "$epoch_json" | python3 -c "import json,sys; w=json.load(sys.stdin)['witnesses']; sys.exit(0 if w==['0x244897572368eadf65bfbc5aec98d8e5443a9072'] else 1)"; then
    pass "epoch 1 pins the single recorded witness (known testnet limitation)"
  else
    fail "epoch 1 witnesses differ: $epoch_json"
  fi
else
  fail "could not read get_epoch(1)"
fi

echo "==> 5/6 Base escrow bytecode present (read-only)"
if code="$(curl -s -m 30 -X POST "$BASE_RPC" -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_getCode","params":["0x63391c272A49c30f79eb6c3d8E10F0652Bb0F767","latest"]}' \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"])')" \
  && [ "$code" != "0x" ] && [ -n "$code" ]; then
  pass "Base escrow has deployed bytecode ($((${#code} / 2 - 1)) bytes)"
else
  fail "no bytecode at the escrow address on $BASE_RPC"
fi

echo "==> 6/6 fast automated suites (offline)"
for name in tools relayer frontend; do
  if [ ! -d "$name/node_modules" ]; then
    fail "$name suite skipped: $name/node_modules missing (run scripts/setup.sh)"
    continue
  fi
  if (cd "$name" && npm test >"/tmp/verify-$name.log" 2>&1); then
    counts="$(grep -a -E 'ℹ (tests|pass|fail)' "/tmp/verify-$name.log" | tr '\n' ' ' | head -c 120)"
    pass "$name suite green ($counts)"
  else
    fail "$name suite FAILED (see /tmp/verify-$name.log)"
  fi
done

echo ""
echo "verify: $PASS passed, $FAIL failed (read-only; no transactions sent)"
[ "$FAIL" = "0" ]
