# Provenance: frozen EVM artifacts (Method 1)

`OmniEscrowV2.json` and `MockUSDC.json` are exact copies of Foundry build
output, committed so the Node-only replay path (Method 1) runs without
installing Foundry. Consumers prefer a fresh local `forge build` when one
exists and fall back to these files otherwise (see
`integration/scripts/e2e-v3-lib.mjs` `loadArtifact` and
`relayer/test/abiV2.test.mjs`).

## Sources

- `OmniEscrowV2.json` ← `contracts/base-v3/src/OmniEscrowV2.sol`
- `MockUSDC.json` ← `contracts/base-v3/test/OmniEscrowV2.t.sol`
  (`contract MockUSDC`, 6-decimal test token)

## Build configuration

From `contracts/base-v3/foundry.toml` (no overrides):

- `solc_version = "0.8.24"` (reported as `0.8.24+commit.e11b9ed9`)
- `optimizer = true`, `optimizer_runs = 200`
- EVM target: `cancun` (solc 0.8.24 default; no `evm_version` set)
- `ffi = false`; libs `forge-std`

Generation command (from repo root):

```sh
cd contracts/base-v3 && forge build
cp out/OmniEscrowV2.sol/OmniEscrowV2.json out/OmniEscrowV2.t.sol/MockUSDC.json ../../testdata/evm/
```

Built 2026-11-14 with `forge 1.9.0` (commit `6056c58`, 2026-11-02).
A forced rebuild (`forge build --force`) on that date produced
byte-identical files to the copies committed here.

## Integrity hashes (SHA-256)

```text
1867ebb15a06bccac19c7755eb34313818d7b3b3cec7c8977a328c3e012c4c31  OmniEscrowV2.json
363be23e754633e929768629dbbe9af0ba677d0292d10427be99ecd66a271445  MockUSDC.json
```

Verify (from `testdata/evm/`):

```sh
sha256sum -c - <<'EOF'
1867ebb15a06bccac19c7755eb34313818d7b3b3cec7c8977a328c3e012c4c31  OmniEscrowV2.json
363be23e754633e929768629dbbe9af0ba677d0292d10427be99ecd66a271445  MockUSDC.json
EOF
```

## What the hashes prove (and do not prove)

The hashes prove **file integrity**: the committed JSON is exactly what
was generated and has not been modified since. They do **not** by
themselves prove source-to-bytecode correspondence.

To verify correspondence independently (requires Foundry, i.e. the
Method 3 toolchain, not Method 1):

```sh
cd contracts/base-v3 && forge build --force
diff <(python3 -c "import json;print(json.load(open('out/OmniEscrowV2.sol/OmniEscrowV2.json'))['bytecode']['object'])") \
     <(python3 -c "import json;print(json.load(open('../../testdata/evm/OmniEscrowV2.json'))['bytecode']['object'])") \
  && echo BYTECODE-MATCH
```

(Compare `bytecode.object`, not whole files: metadata blocks may embed
environment-specific fields while the executable bytecode stays
identical. The committed copies contain no absolute local paths.)

## Refresh procedure

Only when `contracts/base-v3/src` or `test/` changes: rebuild, re-copy
both files, update the hashes above, and re-run the relayer suite plus a
scenario replay to confirm the frozen copies still pass.
