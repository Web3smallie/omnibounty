# V3 cross-chain integration harness

Executes scenarios A–F against Hardhat's in-process EVM using REAL
NEAR-produced vouchers (offline-executed Rust logic, real ECDSA) and the
REAL relayer class submitting to the REAL compiled escrow bytecode.

## Flow

One command from the repo root (canonical):

```sh
npm run e2e:local
```

It checks prerequisites, builds the escrow artifacts, regenerates a fresh
fixture (deterministic clock, see below), runs scenarios A–F, and prints a
verified report. `npm run e2e:local -- --no-regen` reuses the previous
run's fixture instead of regenerating. Prerequisites: Node ≥ 22, `node_modules` in `integration/` and `relayer/`
(`npm ci` in each; the harness imports relayer sources whose `ethers`
resolves via `relayer/node_modules`), Foundry (`forge`), and, for regen,
a Rust toolchain with `cargo +stable` (see `scripts/setup.sh`).

Manual flow (same steps, for debugging):

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

## Deterministic test clock

The harness redeploys in identical order and fails fast if addresses
drift from the fixture (deploy-order guard). All fixture timestamps
(deadline = epoch + 1h, voucher expiries = epoch + 24h, proof times)
derive from a single recorded `generated_at` epoch, and every runtime
clock is checked against it: the fresh chain must start within
`FIXTURE_FRESHNESS_SEC` (1h) of the fixture epoch or the run fails fast
with regen instructions. Because `e2e:local` regenerates seconds before
running, the standard flow can never go stale.

`E2E_FIXTURE_TIME` pins the regen epoch for byte-reproducible fixtures
(same inputs → identical file, verifiable with `cmp`);
`E2E_FIXTURE_PATH` overrides which fixture file a run reads (default:
`testdata/v3/e2e-vouchers.json`). Production freshness rules (proof
windows, voucher TTL) are untouched — only test clocks are controlled.

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
