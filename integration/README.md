# V3 cross-chain integration harness

Executes scenarios A–F against Hardhat's in-process EVM using REAL
NEAR-produced vouchers (offline-executed Rust logic, real ECDSA) and the
REAL relayer class submitting to the REAL compiled escrow bytecode.

## Flow

```sh
# 1. Build escrow artifacts + install deps
(cd ../contracts/base-v3 && forge build)
npm ci   # in integration/ and relayer/

# 2. Deterministic addresses + fresh fixture
npm run e2e:prepare
# → paste its E2E_* exports, then in contracts/near-v3:
#   cargo test regen_e2e_fixture -- --ignored --nocapture

# 3. Run all scenarios
npm run e2e
```

The harness redeploys in identical order and fails fast if addresses
drift from the fixture (deploy-order guard). Voucher expiries are
gen-time + 24h and the fixture deadline is gen-time + 1h, so regenerate
whenever the run is more than minutes after generation (the harness
rejects stale fixtures with instructions).

## Provenance (read before citing results)

| Leg | Status |
|---|---|
| NEAR verify/qualify/finalize/apply | REAL LOGIC, offline (fixture-embedded views) |
| Witness + MPC signatures | REAL ECDSA (test keys) |
| MPC network / promises / callbacks | SUBSTITUTED (unit-tested; xsuite covers async legs on Linux) |
| Relayer validate/submit/retry | LIVE (real class, real tx flow) |
| Base escrow execution | LIVE-LOCAL (in-process EVM, real bytecode) |
| NEAR chain / Base network | NOT live (see docs/v3/INTEGRATION_MATRIX.md §8) |

## Trace artifact

Each run writes `out/v3-e2e-trace-<ts>.json` with per-scenario steps in
the states pending/qualified/awaiting-signature/voucher-ready/submitted/
confirmed/failed/refunded, each labeled `fixture` (observed) or `live`
(executed). Success requires a confirmed receipt PLUS a parsed
`VoucherClaimed` event — never submission alone.
