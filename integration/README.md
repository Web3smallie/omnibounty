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
verified report. `npm run e2e:local -- --no-regen` instead replays the
committed frozen fixture (`testdata/v3/e2e-vouchers.json`) with no
regeneration. Prerequisites: Node ≥ 22, `node_modules` in `integration/` and `relayer/`
(`npm ci` in each; the harness imports relayer sources whose `ethers`
resolves via `relayer/node_modules`); the default regen mode additionally
needs Foundry (`forge`) and a Rust toolchain with `cargo +stable` (see
`scripts/setup.sh`), while replay mode needs neither.

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
clock is synchronized to it — never the reverse.

Two modes, separated by design:

- **Regen** (default `npm run e2e:local`): mints a fresh wall-clock
  fixture seconds before running, then requires the fresh chain to
  start within `FIXTURE_FRESHNESS_SEC` (1h) of its epoch
  (`assertChainSane`); anything older fails fast with regen
  instructions. The standard flow can never go stale.
- **Frozen replay** (`--no-regen`): runs the committed 2036 fixture
  directly. Its epoch is ahead of the fresh chain's wall-clock start,
  so the harness pins the chain **forward** to the epoch with
  `evm_setNextBlockTimestamp` + `evm_mine`, re-reads the tip, and
  asserts the pin before anything else runs. The pin branch requires
  the epoch to be strictly ahead, so the harness can never move a
  chain backwards in time.

Three clocks, one anchor (the fixture epoch):

1. **Harness/EVM clock** — the pin above; the escrow contract is
   unchanged and its existing `block.timestamp` expiry checks execute
   normally against the pinned chain.
2. **Relayer clock** — each scenario's relayer receives the fixture
   epoch through the test-only `nowSec` validation hook, so voucher
   expiry is evaluated at fixture time. Production construction
   (`fromEnv`) never sets it: live validation always uses real time.
3. **Fixture clock** — `generated_at` itself, minted by the pinned
   Rust regen (`E2E_FIXTURE_TIME`).

No global wall-clock override exists: expiry, signature, digest,
schedule, and replay checks all still execute — the expired-voucher
negative is still rejected pre-submit *and* still reverts
`VoucherExpired` on-chain, and scenario E's `evm_increaseTime` refund
still crosses the real deadline. Only the time anchor moved.

`E2E_FIXTURE_TIME` pins the regen epoch for byte-reproducible fixtures
(same inputs → identical file, verifiable with `cmp`);
`E2E_FIXTURE_PATH` overrides which fixture file a run reads (default:
`testdata/v3/e2e-vouchers.json`). Production freshness rules (proof
windows, voucher TTL) are untouched — only test clocks are controlled.

## Frozen-fixture horizon and refresh

The committed fixture is pinned to epoch `2082758400`
(`2036-01-01T00:00:00Z`, SHA-256 recorded in JUDGES.md §3b). Replay
works indefinitely until wall-clock time passes that epoch; after that
the pin is impossible (no backwards time travel) and the run fails
loudly naming the horizon. Refresh procedure (requires the Method 3
toolchain, and only then):

```sh
# from the repo root; prints E2E_* exports and writes integration/out/e2e-env.json
(cd integration && npx hardhat run --no-compile scripts/e2e-v3-prepare.mjs)
# from contracts/near-v3, with a new epoch at least a decade out:
E2E_FIXTURE_TIME=<new-epoch> E2E_ESCROW_ADDRESS=<from-env> \
E2E_TOKEN_ADDRESS=<from-env> E2E_CHAIN_ID=<from-env> \
E2E_OUT_PATH=../../testdata/v3/e2e-vouchers.json \
cargo +stable test --locked --lib regen_e2e_fixture -- --ignored --nocapture --exact tests::regen_e2e_fixture
```

Then re-run the replay plus the relayer suite, and update the epoch,
hash, and horizon notes here and in JUDGES.md §3b.

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
