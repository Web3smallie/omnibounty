# OmniBounty tools

## Fixtures (reviewers run these)

- `npm run gen` — regenerate `../testdata/*.json` from first principles
  (ethers v6 oracle). Fails loudly if any oracle self-check (identifier
  recomputation, signature recovery, R-point validity) does not hold.
- `npm run check` — recompute every committed vector and assert equality.
  Reviewers run this to confirm fixtures were not tampered with.

All keys referenced anywhere under `testdata/` are fixed, publicly visible,
test-only values. Production code never embeds keys.

## Live verification (testnet; free except where noted)

- `python preflight.py` — read-only prerequisites: NEAR testnet status, MPC
  + Reclaim code hashes, Base chain ID + USDC presence,
  crates/GitHub/helper reachability. Exit 0 required before any live step.
- `python probe_mpc.py` — read-only: pins the deployed MPC `version()`,
  gas/deposit rules, and proves which `sign` arg shapes it accepts by
  error discrimination. No funds spent.
- `node mpc_derive.mjs [predecessor] [path]` — fetches root + derived MPC
  keys, independently re-derives (`KDF MATCH`), prints the voucher ETH
  address for `set_mpc_signer` / `setMpcSigner`.
- `node live_handshake.mjs` — full NEAR-leg rehearsal on testnet with free
  helper accounts: deploy, configure, real MPC claim, digest + ecrecover
  assertions, replay check; exports `../testdata/live_voucher.json`.
- `python probe_upstream.py`, `python fetch_mpc_ref.py` — upstream
  interface verification helpers (release assets, MPC source tree).

## Cross-contract suite prep

- `python canon_leb.py INPUT OUTPUT` — rewrite LLVM's padded LEB128
  immediates at `call_indirect`/`memory.size`/`memory.grow` sites to
  canonical form so nearcore's strict parser accepts the module
  (`OUTPUT` may equal `INPUT` for in-place). Needed for the xsuite
  wasms; see `contracts/near/tests/README.md`.
- `python canon_leb.py --check FILE` — exit 0 iff no padded sites
  remain (reviewer self-check).

## Sandbox vendoring (local workarounds only)

Cargo TLS is broken in the build sandbox, so these scripts fetch pinned
crates.io files via Python HTTPS and resolve against a local file:// git
registry mirror. Not needed on machines with working cargo networking;
committed `Cargo.lock` files use standard sparse URLs + checksums.

- `python vendor_crates.py {analyze,fetch,fetch-one,lock,dupes,seed-cache}`
- `python local_registry.py build` — rebuild the mirror index.
- `python mirror_extras.py name@req ...` — extend the mirror beyond the
  seed lock (e.g. `near-abi` for cargo-near ABI generation).
- `python finalize_lock.py [lockfile]` — convert a sandbox-resolved lock
  back to standard sparse URLs for reviewers.
- `python fetch_cargo_near.py` — download + sha256-verify cargo-near.
