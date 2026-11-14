# OmniBounty — Judge Guide & Terminal Runbook

**Executive summary.**
OmniBounty: cross-chain testnet bounties (criteria NEAR, USDC Base Sepolia, Reclaim proofs, MPC vouchers).
Contract: `omnibounty-v3.testnet` (NEAR testnet).
WASM SHA-256: `766c6b14accb4730b634a5d659a10ae804e3e1eb86c77fe1ba9a1fefc02a94d4`.
Code hash: `8yGzesTCJSRu4egz4bBeS19ABLSb6Y6TJQpRHH7quiYj`.
Escrow: `0x63391c272A49c30f79eb6c3d8E10F0652Bb0F767` (Base Sepolia).
Setup: `./scripts/setup.sh`. Verify: `./scripts/verify.sh`.
Best views: `get_bounty` + `get_voucher` (§2). Caveats: [known limitations](#12-known-limitations-all-re-verified-none-silently-dropped).

Two audiences, in order: (1) human hackathon judges verifying the deployed
testnet implementation; (2) AI coding agents reproducing the workflow from a
terminal. Every command below was verified against this repository; anything
that could not be tested is marked as such rather than asserted.

> Testnet only. Everything here runs on NEAR testnet and Base Sepolia with
> testnet USDC. Nothing in this document describes mainnet production
> infrastructure.

## Part A — Human judge guide

### 1. What OmniBounty is

OmniBounty is a cross-chain bounty marketplace: sponsors commit cryptographic
acceptance criteria on NEAR testnet and fund USDC rewards in an escrow on Base
Sepolia; contributors prove a merged GitHub pull request plus their GitHub
identity with Reclaim zkTLS, the NEAR contract verifies the claim, an MPC
signer authorizes a payout voucher, and the Base escrow independently verifies
and settles the USDC reward.

### 2. Read-only verification (no keys, no transactions)

Prerequisites: `curl`, `python3`, `node` (any recent version; only used to
decode ABI data). No wallets, no secrets, no installs beyond that.

**Deployed code identity** (verified live for this document on 2026-11-14):

| Fact | Value |
|---|---|
| NEAR contract account | `omnibounty-v3.testnet` |
| Deployed WASM SHA-256 | `766c6b14accb4730b634a5d659a10ae804e3e1eb86c77fe1ba9a1fefc02a94d4` (707605 bytes) |
| NEAR code hash | `8yGzesTCJSRu4egz4bBeS19ABLSb6Y6TJQpRHH7quiYj` |
| Deploy tx | [7yqc5RpEyfHcqBwXuvLgJtCoJQEbb2BjKQgarKRXvef5](https://testnet.nearblocks.io/txns/7yqc5RpEyfHcqBwXuvLgJtCoJQEbb2BjKQgarKRXvef5) |
| Base escrow | `0x63391c272A49c30f79eb6c3d8E10F0652Bb0F767` (6276 bytes on-chain) |
| Base chain | Sepolia, chain ID 84532 |
| Testnet USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| MPC signer | `0x4b204ae1890a0cd49cc594fe712fea4ac765a2f9` |

The WASM hash and code hash above were re-verified live against
`rpc.testnet.near.org` (`view_code` + `view_account`) and match the
deployment record byte-for-byte. Reproduce it:

```sh
# Code hash (expect 8yGz...quiYj)
curl -s -X POST https://rpc.testnet.near.org -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":"j","method":"query","params":{"request_type":"view_account","finality":"final","account_id":"omnibounty-v3.testnet"}}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["code_hash"])'

# Full WASM SHA-256 (expect 766c6b14..., 707605 bytes)
curl -s -X POST https://rpc.testnet.near.org -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":"j","method":"query","params":{"request_type":"view_code","finality":"final","account_id":"omnibounty-v3.testnet"}}' \
  -o /tmp/ob-code.json
python3 -c 'import json,hashlib,base64; c=base64.b64decode(json.load(open("/tmp/ob-code.json"))["result"]["code_base64"]); print(len(c), hashlib.sha256(c).hexdigest())'
```

**Reference bounty.** The authoritative end-to-end demonstration is E2E #4
(bounty `223339065907692`, criteria hash
`0x499fc4d32bc3bc91a8cab81785c6fb59e7073c3f769e2b03399b68bdcd7e95b6`,
recipient `0xaa77daf4a174b3d05d6046462a7cb0e8eb9fa426`, 1 USDC). Evidence
record: `evidence/e2e-run4/E2E-RUN4.md` (tracked; checksummed in
`evidence/e2e-run4/SHA256SUMS`). All of its claims re-verify live below
and via the explorer links inside it — do not substitute older runs.

**Live identity proofs.** E2E #4 used fresh Reclaim sessions: the PR and
identity proofs in `evidence/e2e-run4/proofs4/` were generated live during
the run (timestamps 2026-11-13 20:51–20:52 UTC, epoch 1) and verified
against the on-chain witness set — not fabricated fixtures. The archived
proofs contain no GitHub token (the token travels only inside the TLS
session; the run record confirms zero token patterns in artifacts).

**Exact read-only view commands** (all five, live-verified for this
document; outputs abbreviated to the decisive fields):

```sh
RPC=https://rpc.testnet.near.org; C=omnibounty-v3.testnet
view() { # $1 = method, $2 = JSON args
  argsb64=$(echo -n "$2" | base64 -w0)
  curl -s -X POST $RPC -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":\"j\",\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$C\",\"method_name\":\"$1\",\"args_base64\":\"$argsb64\"}}" \
    | python3 -c 'import json,sys; print(bytes(json.load(sys.stdin)["result"]["result"]).decode())'
}
view get_config '{}'
# {"owner":"omnibounty-v3.testnet","paused":false,...,"mpc_signer":"0x4b20...A2f9",
#  "escrow":"0x6339...0F767","chain_id":84532,...,"max_proof_age_sec":604800,
#  "future_skew_sec":300,"voucher_ttl_sec":86400,...,"next_nonce":5,"bounty_count":4}
view get_epoch '{"epoch_id":1}'
# {"epoch_id":1,"witnesses":["0x244897572368eadf65bfbc5aec98d8e5443a9072"]}
view get_bounty '{"bounty_id":223339065907692}'
# {"id":223339065907692,...,"criteria_hash":"0x499f...e95b6","slots":["1000000"],
#  "slots_filled":1,"total_amount":"1000000","funded":true,"deadline":0,...}
view get_claim '{"bounty_id":223339065907692,"slot":0}'
# {"recipient":"0xaa77...fa426",...,"status":"finalized","pending_digest":null,"signed":true}
view get_voucher '{"bounty_id":223339065907692,"slot":0}'
# {"voucher":{...,"amount":"1000000","nonce":4,...,"digest":"0x934e1cea..."},"v":28,...}
```

**Base settlement check** (E2E #4 payout tx
[0xd946...8f81](https://sepolia.basescan.org/tx/0xd946ced8e9570c493841c86200e78290737c6dba681c9446e149023fd25a8f81)):

```sh
# Receipt: expect status 0x1, a USDC Transfer of 0x0f4240 (1,000,000) and a
# VoucherClaimed log from the escrow (topic 0xf40a6b7a...; full event shape
# in contracts/base-v3/src/OmniEscrowV2.sol).
curl -s -X POST https://sepolia.base.org -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt","params":["0xd946ced8e9570c493841c86200e78290737c6dba681c9446e149023fd25a8f81"]}' \
  | python3 -c 'import json,sys; r=json.load(sys.stdin)["result"]; print("status:",r["status"],"to:",r["to"]); [print(l["address"],l["topics"][0],l["data"][:66]) for l in r["logs"]]'

# Slot truth (cast ships with Foundry; or any eth_call client):
cast call 0x63391c272A49c30f79eb6c3d8E10F0652Bb0F767 \
  "slotStatus(uint256,uint8)(bool,bool)" 223339065907692 0 --rpc-url https://sepolia.base.org
# true / false  == claimed, not refunded
```

Or run one command for the whole read-only gate (§9): `./scripts/verify.sh`.

### 3. Fresh-clone test instructions

Toolchains (all pinned by repo config or verified installs):

| Toolchain | Pinned version | Source |
|---|---|---|
| Node.js | 22 (CI `setup-node`) | `.github/workflows/*.yml` (local runs here used 24.22.2 without issues) |
| Rust (tests/clippy/fmt) | stable 1.99.1 | `contracts/near-v3/rust-toolchain.toml` + lockfile (`time` needs ≥1.88) |
| Rust (WASM builds) | 1.86.0 + `wasm32-unknown-unknown` | `rust-toolchain.toml` comment + CI `near-xsuite` job |
| Foundry | 1.9.0 (`forge`/`cast`/`anvil`) | installed 2026-11-14 via `foundryup`; `solc 0.8.24` auto-via-svm |
| Python | 3.x | WASM canonicalizer, JSON decoding |
| System | `curl git python3 build-essential pkg-config` | compilers/linkers for Rust + node-gyp |

NEAR suites (`contracts/near-v3`; current implementation):

```sh
cd contracts/near-v3
cargo +stable test --locked --lib            # unit: 133 passed, 0 failed, 2 ignored
cargo +stable clippy --locked --all-targets -- -D warnings   # CI gate (see note)
cargo +stable fmt --check                     # CI gate (see note)
./run-xsuite.sh                               # sandbox xsuite: 6 passed (needs network once:
                                              # near-sandbox binary download + fixture regen)
```

`run-xsuite.sh` is the one command: unit tests, fresh 7-day fixture regen,
both 1.86 WASM builds, LEB128 canonicalization gates, then the 6 sandbox
scenarios. First run downloads the `neard` sandbox binary from
`build.nearprotocol.com` (network required; override path via
`NEAR_SANDBOX_BIN_PATH`); proxied environments need
`NO_PROXY=127.0.0.1,localhost` (the script sets it; see
`contracts/near-v3/tests/README.md`). The `neard` kernel-param ERROR lines
it prints in containers are sandbox noise; the suite result is
authoritative. clippy/fmt could not run in the documenting environment
(read-only toolchain dir) — CI runs them; treat as CI-verified, not
locally verified.

Base suites (Foundry):

```sh
cd contracts/base-v3 && forge build && forge test   # escrow: 26 passed (unit+fuzz+invariant)
forge fmt --check                                    # passes
cd ../base && forge install --no-git foundry-rs/forge-std && forge test  # legacy: 30 passed
```

(`--no-git` keeps the fetch out of git state: no submodule bookkeeping,
just the vendored sources under gitignored `contracts/base/lib/`.)

Relayer / tools / frontend / integration (Node 22; `npm ci` per package first):

```sh
cd relayer && npm ci && npm test            # 87 passed
cd ../tools && npm ci && npm test           # 37 passed
cd ../frontend && npm ci && npm test        # 440 passed
cd ../frontend && npm run build             # production build, 4 routes
cd ../integration && npm ci
npx hardhat run --no-compile scripts/e2e-v3-prepare.mjs   # prints E2E_* env
# then, from contracts/near-v3 (see prepare output):
E2E_ESCROW_ADDRESS=0x... E2E_TOKEN_ADDRESS=0x... E2E_CHAIN_ID=84532 \
  cargo +stable test --locked --lib regen_e2e_fixture -- --ignored --nocapture --exact tests::regen_e2e_fixture
cd ../integration && npx hardhat run --no-compile scripts/e2e-v3-run.mjs  # 7 scenarios pass
```

Legacy NEAR unit suite (historical implementation; note the `+stable`
override — its lockfile also needs rustc ≥ 1.88):

```sh
cd contracts/near && cargo +stable test --locked --lib   # 44 passed
```

Legacy cross-contract suite (`contracts/near`: build both WASMs, then
`cargo +stable test --locked --features xsuite --test cross_contract`)
was attempted but its `near-workspaces 0.21` build script fails on modern
toolchains — documented here as not verified, not as passing. All counts
above come from runs performed 2026-11-14 unless noted.

## Part B — Terminal-only AI agent runbook

### 4. One setup path (fresh Linux)

```sh
git clone https://github.com/Web3smallie/omnibounty omnibounty && cd omnibounty
./scripts/setup.sh
```

`scripts/setup.sh` is the canonical path: it checks for Linux + `curl git
python3 node(≥22) npm`, installs the Rust toolchains (`stable`, `1.86.0`,
`wasm32-unknown-unknown` target, `rustfmt`/`clippy`), installs Foundry,
runs `npm ci` in `frontend relayer tools integration`, vendors legacy
`forge-std`, generates disposable identities (§6), and smoke-checks both
RPC endpoints. It sends no transactions and is safe to re-run. It needs a
network connection (toolchain + package downloads) and a pre-installed
Node ≥ 22 (Ubuntu: `sudo apt-get install -y curl git python3
build-essential pkg-config`, then Node via nvm or nodejs.org).

Honest scope note: `setup.sh` was assembled from individually verified
steps but has NOT been validated with a from-scratch container run (no
container runtime was available), so treat the first clean-machine run as
a beta and report gaps. Every step it performs was verified in isolation.

### 5. Environment variables

Root `.env.example` is the complete catalog: every variable the tracked
workflows read, grouped by workflow (read-only, tests, sponsorship,
claiming, relayer, scheduler, frontend bundle, legacy), each marked
required/optional, with example values that are placeholders only — no
real credentials anywhere in this repo's examples. Machine secrets live in
gitignored files instead: `frontend/.env.local` (Reclaim/GitHub),
`secrets/*.json` (NEAR key files, 0600). Never copy a real `.env` into an
example; the setup script never prints private keys.

### 6. Disposable testnet identities

`scripts/setup.sh` runs `node scripts/keygen.mjs`, which writes two
throwaway identities to gitignored `secrets/` (0600, refuses to
overwrite; `--force` rotates):

- `secrets/agent-near.json` — fresh ed25519 keypair + implicit account id.
  Fund it from any funded testnet account (or attach the key to a named
  account you control) before it can sign. Needs: ~0.05 NEAR + gas per
  bounty creation, 1 NEAR + gas per qualification, 0.1 NEAR + gas per
  finalization, gas only for funding confirmation.
- `secrets/agent-evm.json` — fresh secp256k1 address + key. Needs Base
  Sepolia ETH for gas on every Base step; sponsoring additionally needs
  testnet USDC (Circle testnet faucet or a funded peer).

Funding is MANUAL — no script funds anything, and agents must never use
real funds or touch any pre-existing funded operator/sponsor/claimant/
relayer identities. Agents point every script at the disposable key with
`export NEAR_KEY_FILE=$PWD/secrets/agent-near.json` (the scripts' built-in
default is the operator path `secrets/v3-operator.json`, which does not
exist on fresh clones and fails loudly if unset).

### 7. Terminal-only end-to-end workflow

Conventions: `export NEAR_KEY_FILE=$PWD/secrets/agent-near.json`
(disposable NEAR key),
`export RELAYER_PRIVATE_KEY=0x…` (disposable EVM key, env only),
`RPC=https://rpc.testnet.near.org C=omnibounty-v3.testnet`,
`BRPC=https://sepolia.base.org ESCROW=0x6339...0F767 USDC=0x036C...CF7e`.
`cast` commands use `--rpc-url $BRPC --private-key $RELAYER_PRIVATE_KEY`
(omitted below for brevity on reads).

Read-only steps (verified live while writing this guide):

1. **Validate**: `./scripts/verify.sh` — exits 0 only when config, code
   hash, epoch, escrow, and the fast suites all check out.
2. **Identities**: `node scripts/keygen.mjs` (see §6).
3. **Config checks**: the `view get_config` / `get_epoch` commands from §2;
   confirm `paused=false`, expected escrow/signer/chain, epoch witness set.

Transaction steps (terminal-native; each prints its tx hash):

4. **Bounty creation (NEAR)** — `tools/sponsor_bounty.mjs` (tracked;
    `--dry-run` verified live, `--submit` sends a real tx):
    ```sh
    node tools/sponsor_bounty.mjs create --bounty-id <unused-u64> \
      --token 0x036CbD53842c5426634e7929541eC2318f3dCF7e \
      --criteria <criteria.json> --dry-run   # validates + checks id unused
    node tools/sponsor_bounty.mjs create ... --submit   # 0.05 NEAR + gas
    ```
    Criteria must pass the production gate (the script enforces it and
    prints hash/slots/total); starting from the 517-byte demo criteria at
    `frontend/public/criteria/0x499fc4d32bc3bc91a8cab81785c6fb59e7073c3f769e2b03399b68bdcd7e95b6.json`
    is allowed for testnet demos.
5. **Escrow creation, approval, funding (Base)** — `cast`, no wrapper:
    ```sh
    cast send $ESCROW "createBounty(uint256,address,uint256[],uint64,bytes32)" \
      <id> $USDC "[1000000]" 0 <criteria-hash> --rpc-url $BRPC --private-key $RELAYER_PRIVATE_KEY
    cast send $USDC "approve(address,uint256)" $ESCROW 1000000 --rpc-url $BRPC --private-key $RELAYER_PRIVATE_KEY
    cast send $ESCROW "fundBounty(uint256)" <id> --rpc-url $BRPC --private-key $RELAYER_PRIVATE_KEY
    ```
6. **NEAR funding confirmation** — re-verified, never trusted:
    ```sh
    node tools/sponsor_bounty.mjs mark-funded --bounty-id <id> --dry-run  # READY only if escrow holds the total
    node tools/sponsor_bounty.mjs mark-funded --bounty-id <id> --submit   # sponsor key only, no deposit
    ```
7. **Claim preparation** — live proofs need a merged PR by the claimant
    plus `RECLAIM_APP_ID/RECLAIM_APP_SECRET` (same pair for both) and the
    claimant's own `GITHUB_TOKEN`:
    ```sh
    cd frontend
    RECLAIM_APP_ID=0x... RECLAIM_APP_SECRET=0x... node scripts/prove.mjs <owner/name> <pr> ./proof-pr.json
    RECLAIM_APP_ID=0x... RECLAIM_APP_SECRET=0x... GITHUB_TOKEN=ghp_... node scripts/prove_identity.mjs ./proof-identity.json
    ```
    > **GitHub token safety.** Never request or use another person's real
    > GitHub token, and never commit or log a token (these examples show
    > placeholders only). A live Reclaim proof requires a
    > human-provided authenticated session and appropriate credentials. An
    > unattended agent should use the recorded-proof fallback (§8) and stop
    > at the documented dry-run boundary unless explicitly authorized and
    > supplied with the required credentials.
    Without a live GitHub session, use the recorded-proof fallback (§8).
8. **NEAR claim qualification** — `tools/qualify_claim.mjs` (tracked;
    `--dry-run` verified live against the recorded proofs, §8):
    ```sh
    node tools/qualify_claim.mjs <proofsDir> <bountyId> --criteria <criteria.json> --dry-run  # + live dry_qualify view
    node tools/qualify_claim.mjs <proofsDir> <bountyId> --criteria <criteria.json> --submit   # 300 Tgas + 1 NEAR
    ```
9. **MPC voucher finalization** — `node tools/finalize.mjs <bountyId>
    <slot>` (300 Tgas + 0.1 NEAR; polls for the voucher; races collapse
    into polling, never resubmit). Batch/scheduled form:
    `node tools/finalize_batch.mjs`.
10. **Base settlement** — relayer, one shot, no daemon:
    ```sh
    NEAR_RPC_URL=... NEAR_CONTRACT_ID=omnibounty-v3.testnet BASE_RPC_URL=... \
    ESCROW_ADDRESS=0x6339...0F767 MPC_SIGNER_ADDRESS=0x4b20...A2f9 \
    RELAYER_PRIVATE_KEY=0x... VOUCHER_VERSION=2 \
    node relayer/src/index.mjs --once
    ```
    It re-validates digest/signature/schedule pre-submit and checks
    `usedVoucher` ground truth; already-settled vouchers report
    `already` and submit nothing.
11. **Independent verification** — re-run §2 views for the new bounty id
    (`slots_filled`, `signed`, voucher digest), the `cast call slotStatus`
    check, and `./scripts/verify.sh`.

Verification status, honestly: steps 1–3, 7-validation, 8-dry-run, and 11
were executed live while writing this guide. The `--submit` / `cast send`
/ `finalize` / relayer-settle paths follow the exact patterns of the
audited E2E #4 run but were NOT re-executed (sending testnet transactions
for documentation is out of bounds), so the live E2E is
terminal-complete but live-unretested end to end. No step needs a wallet
popup, a browser, or GUI interaction; the one human dependency is funding
(§6) plus, for live proofs, GitHub/Reclaim credentials (§7–8).

### 8. Recorded-proof fallback

When no live GitHub session exists, use recorded proofs — and never present
them as fresh attestations.

**What is recorded.** All tracked in every clone: `evidence/e2e-run4/proofs4/`
(the E2E #4 PR + identity proofs, generated 2026-11-13 20:52 UTC, epoch 1,
owner `0xaa77…`), `evidence/e2e-run4/proofs/` (earlier run),
`testdata/e2e_claim.json` (a valid proof shape),
`testdata/v3/xsuite-claim.json` (regenerable sandbox fixture),
`testdata/v3/e2e-vouchers.json`, `testdata/eip712-voucher2.json`, and
`testdata/{reclaim,eip712,live_voucher}.json` (shape/oracle vectors). The
published criteria artifact is
`frontend/public/criteria/0x499fc4d32bc3bc91a8cab81785c6fb59e7073c3f769e2b03399b68bdcd7e95b6.json`
(517 bytes, byte-identical to the run's criteria).

**Expiry rules** (`contracts/near-v3/src/lib.rs`: global default 7 days,
per-criteria window capped at 7 days, 300 s future-skew cap, 24 h voucher
TTL). Recorded proofs are safe honesty demos precisely because live
`dry_qualify` deterministically rejects them — nothing submitted:

```sh
# Fresh-clone demo (tracked fixtures): stage the recorded proof shape, then
# dry-run. Local shape validation passes; the live contract rejects on
# commitment + slot state (actual output):
mkdir -p /tmp/ob-rc && node -e "
const {readFileSync,writeFileSync} = require('node:fs');
const d = JSON.parse(readFileSync('testdata/e2e_claim.json','utf8'));
writeFileSync('/tmp/ob-rc/proof-pr.json', JSON.stringify(d.proof));
writeFileSync('/tmp/ob-rc/proof-identity.json', JSON.stringify(d.proof));"
node tools/qualify_claim.mjs /tmp/ob-rc 223339065907692 \
  --criteria testdata/v3/criteria-valid/simple-ci.json --dry-run
# dry_qualify: {"ok":false,...,"errors":["NO_OPEN_SLOT: ... has no unfilled slot",
#   "CRITERIA_MISMATCH: supplied document does not hash to committed criteria"]}
# (/tmp/ob-rc staged above from testdata/e2e_claim.json; simple-ci is not
# the demo bounty's criteria, so the commitment gate fires by design.)

# E2E #4 recorded demo (proofs still inside their 7-day window but
# CONSUMED on-chain — nullifiers spent, slot filled):
node tools/qualify_claim.mjs evidence/e2e-run4/proofs4 223339065907692 \
  --criteria frontend/public/criteria/0x499fc4d32bc3bc91a8cab81785c6fb59e7073c3f769e2b03399b68bdcd7e95b6.json --dry-run
# dry_qualify: {"ok":false,...,"errors":["NO_OPEN_SLOT...","IDENTIFIER_REPLAY"]}
# (Actual outputs captured while writing this guide.)
```

**Live vs recorded, unmistakable.** Live = `prove.mjs`/`prove_identity.mjs`
output with your session's timestamps, verified by `dry_qualify ok:true`
on an open slot. Recorded = any file above: good for shape validation,
crypto-path checks, dry-run plumbing, and replay-demonstration; NEVER a
fresh GitHub attestation and NEVER submittable for a new qualification.
Regenerate live proofs with the §7 commands (needs merged PR + GitHub
token + Reclaim app credentials); regenerate sandbox fixtures with
`run-xsuite.sh` / `regen_e2e_fixture` (§3).

### 9. One verification command

`./scripts/verify.sh` — read-only; exits 0 only if all six gates pass
(prereqs, NEAR code hash, live-config-vs-record match, epoch witnesses,
Base bytecode, tools+relayer+frontend suites). It sends no transactions.
Actual output captured 2026-11-14:

```
==> 1/6 prerequisite commands
PASS: curl python3 node npm present
==> 2/6 deployed NEAR code hash (read-only)
PASS: on-chain code hash matches DEPLOYED.md (8yGzesTCJSRu4egz4bBeS19ABLSb6Y6TJQpRHH7quiYj)
==> 3/6 live config matches the deployment record (read-only)
PASS: get_config matches record (chain/escrow/signer/paused=false)
==> 4/6 pinned epoch witnesses (read-only)
PASS: epoch 1 pins the single recorded witness (known testnet limitation)
==> 5/6 Base escrow bytecode present (read-only)
PASS: Base escrow has deployed bytecode (6276 bytes)
==> 6/6 fast automated suites (offline)
PASS: tools suite green (ℹ tests 37 ℹ pass 37 ℹ fail 0 )
PASS: relayer suite green (ℹ tests 87 ℹ pass 87 ℹ fail 0 )
PASS: frontend suite green (ℹ tests 440 ℹ pass 440 ℹ fail 0 )

verify: 8 passed, 0 failed (read-only; no transactions sent)
```

This is the READ-ONLY gate. The separate testnet E2E (§7 steps 4–10) is
the command path that submits transactions, and it is intentionally not
part of verification.

## Part C — Security audit guide

### 10. Trust model

| Actor | Can do | Cannot do | Constraining checks | Implementation |
|---|---|---|---|---|
| Contract owner (testnet: single key = contract account) | Pause; rotate MPC signer/escrow/chain/freshness; manage epochs; 2-step ownership transfer | Change funded criteria (no setters); touch escrow funds; forge proofs/vouchers | `assert_owner` on every admin fn; criteria hash immutable post-funding | `contracts/near-v3/src/lib.rs` admin fns; `transfer_ownership`/`accept_ownership` |
| Relayer | Submit permissionless `finalize_claim`; submit valid vouchers to escrow | Forge, redirect, or double-pay: escrow re-checks everything | Pre-submit digest/signature/schedule validation; `usedVoucher` ground truth; slot bitmaps | `relayer/src/index.mjs` `handleOne`, `relayer/src/validate.mjs`, `OmniEscrowV2.sol` `claim` |
| MPC signer | Sign dispatched digests (Chain Signatures) | Sign anything undispatchable: responses are parsed strictly + signer self-checked on-chain | `parse_mpc_signature`, `check_mpc_signer` vs configured address; `pending` entry accounting | `contracts/near-v3/src/mpc.rs`, `lib.rs` `apply_mpc_signature` |
| Reclaim attestor (+ epoch witnesses) | Attest GitHub TLS sessions (data authenticity at an instant) | Mint claims alone: recovered signer set must equal pinned epoch exactly; identifier binds claim bytes | `verify_core` exact-set check; canonical params; nullifiers | `contracts/near-v3/src/reclaim.rs`; epoch 1 = single witness `0x2448…9072` (limitation, §12) |
| Sponsor | Fund; truthfully `mark_funded`; reclaim post-deadline unclaimed slots | Change criteria post-funding; divert others' funds; claim own bounty without a valid proof | No criteria setters; escrow fixed rules; `mark_funded` is sponsor-only and auditable (but honesty-assumed — the contract cannot observe Base) | `create_bounty`/`mark_funded` in `lib.rs`; `OmniEscrowV2.sol` `fundBounty`/`refundSlot` |

Honesty notes: `mark_funded` trusts the sponsor's off-chain funding check
(frontend/relayer verify escrow holdings first; the contract cannot); the
testnet owner key is single-signature (production needs multisig +
timelock — the interface already centralizes admin calls for that
migration); GitHub API truthfulness at attestation instant is assumed.

### 11. Attack tests

Every entry below names a real test verified in-tree. Suite key: N3 =
`contracts/near-v3` unit, XS = xsuite sandbox, B3 = `contracts/base-v3`
forge, R = relayer, T = tools, F = frontend.

| Attack | Test | File | Result |
|---|---|---|---|
| Replay (same proof twice) | `replay_duplicate_and_ordered_slots` | XS `contracts/near-v3/tests/xsuite.rs` | pass (6/6 suite) |
| Replay (voucher double-claim) | `test_claim_replay_and_double_claim`, `testFuzz_replay_never_pays_twice` | B3 `test/OmniEscrowV2.t.sol` | pass (26/26) |
| Nullifier scoping/cross-bounty reuse | `qualify_success_consumes_slot_seq_and_nullifiers`, `same_evidence_reusable_across_bounties` | N3 `src/lib.rs`, XS | pass |
| Forged identity | `forged_identity_first_rejected_at_qualify`, `identity_impostor_cannot_claim_others_pr`, `identity_binding_rejects_impostors` | N3 `src/lib.rs`, XS | pass |
| Forged identity (rules layer) | `forged_identity_first_rejected`, `forged_pr_first_rejected` | N3 `src/rules.rs` | pass |
| Wrong witness / tampered proof | `wrong_witness_rejected`, `tampered_identifier_rejected`, `tampered_signature_rejected` | N3 `src/reclaim.rs` | pass |
| Copied PR (duplicate claim) | `duplicate_pr_and_ordered_multi_slot` | N3 `src/lib.rs` | pass |
| Altered recipient (escrow) | `test_claim_field_mismatches` | B3 `test/OmniEscrowV2.t.sol` | pass |
| Altered recipient (relayer pre-check) | `rejects tampered ${name} (original signature)` | R `test/validateV2.test.mjs` | pass (87/87) |
| Expired voucher | `expired_voucher_reaped_for_fresh_retry_live_voucher_blocks`; `test_claim_expiry_boundaries` | N3 `src/lib.rs`; B3 | pass |
| Modified protected file | `protected_path_matching_adversarial`, `files_rules_end_to_end` | N3 `src/rules.rs` | pass |
| Stale / future proofs | `qualify_enforces_freshness_windows`, `qualify_rejects_wrong_binding_stale_and_future_proofs` | N3 `src/lib.rs` | pass |
| Double dispatch / finalizer races | `finalize_gates_window_signer_and_double_dispatch`; `waits instead of resubmitting when another finalizer wins the race` | N3; T `test/finalize.test.mjs` | pass |
| Refund-vs-claim race | `test_claim_refund_race_both_orders` | B3 `test/OmniEscrowV2.t.sol` | pass |
| Signature malleability | `test_malleated_signature_pays_same_recipient_or_reverts_used` | B3 | pass |
| Reentrancy / weird tokens | `test_reentrant_token_blocked_by_guard`, `test_reverting_and_false_tokens_fail_closed` | B3 | pass |
| Wrong signer / malformed sigs | `test_claim_wrong_signer_and_malformed_sigs`; `rejects wrong signer` | B3; R `test/validateV2.test.mjs` | pass |
| Live E2E#4 voucher round-trip | `accepts the real E2E#4 chain voucher with digest match` | R `test/validateV2.test.mjs` | pass |
| Token secrecy (identity proof) | `keeps the GitHub token out of everything the verifier sees` | F `test/reclaim.test.mjs` | pass (440/440) |
| Identity/recipient binding (client) | `binds identity to PR author and proofs to recipient` | F `test/reclaim.test.mjs` | pass |
| Challenge-window / deadline gates | `qualify_window_gate_deadline_zero_and_overflow`, `window_storage_auth_and_gas_guards` | N3; XS | pass |

### 12. Known limitations (all re-verified, none silently dropped)

1. **No dependable always-on finalize keeper.** Finalization code exists
   twice — relayer `finalizePass` (needs a manually operated relayer with
   operator credentials) and `tools/finalize_batch.mjs` + the scheduler
   workflow (`.github/workflows/finalize-scheduler.yml`). The scheduler
   file is merged to `main` and shows 3 successful runs (1 manual dispatch
   plus 2 scheduled, 2026-11-13/14), but its `*/10` cron is not ticking
   normally (2 scheduled runs in ~16 h), so unattended finalization is
   not yet dependable. Impact: claims may wait for a manual
   `finalize.mjs` / relayer run; permissionless, but human.
2. **MPC first-response mismatch + retry (observed on testnet).** E2E #4's
   first dispatch returned a prefix/recovery mismatch (`MPC_BAD_RESPONSE`,
   released cleanly); the retry signed successfully (nonce 4). Impact:
   finalization is retry-shaped in practice; the contract releases stuck
   dispatches safely (`release_pending`, supersede-after-timeout covered by
   `stuck_dispatch_superseded_after_timeout`).
3. **Single testnet attestor.** Epoch 1 pins one witness
   (`0x2448…9072`, re-verified live in §2). Its compromise forges
   arbitrary claims. Acceptable for testnet; production needs a
   multi-witness epoch + rotation procedure (`upsert_epoch` exists).
4. **Demo bounty deadline configuration.** Bounty #4 (and the demo
   criteria) use `deadline: 0` — never refundable, claimable forever —
   and `challenge_window: 0`. Deliberate demo configuration, immutable
   per bounty; production bounties must set meaningful values.
5. **Refund-versus-claim race.** A qualified-but-unpaid slot can remain
   refundable after a sponsor deadline: Base cannot see pending NEAR
   claims. Narrowed (30 s relayer polls, permissionless redemption,
   generous deadlines) but not eliminated; escrow-level protection is
   future work. (Confirmed current in `contracts/near-v3/tests/README.md`
   security notes.)
6. **Criteria strength is the sponsor's responsibility.** The demo
   criteria prove merge + identity binding, not that code solves the
   task. The contract enforces whatever was committed — weak criteria
   yield weak bounties. AI-drafted criteria stay advisory-only (see
   `docs/v3/SECURITY_MODEL.md` §5).
7. **Owner can rotate the signer.** `set_mpc_signer` is a single
   owner-gated call (like pause/epochs/escrow), and the testnet owner is
   one key. Rotation is a feature (compromise recovery); its abuse mode
   is mitigated only by moving to multisig + timelock for production.
8. **Bounty #2 funds locked by a zero deadline.** Bounty `223339065907690`
   is funded (1 USDC in escrow, verified live) with `deadline: 0` and no
   filled slots: deadline-0 bounties are never refundable, so the funds
   sit until someone qualifies a claim — claimable, not refundable.
9. **Scheduler holds a full-access operator key.** The scheduler workflow
   consumes `NEAR_OPERATOR_KEY_JSON` (a full-access testnet key) from
   Actions secrets. Combined with its REVIEW-DRAFT header and sparse run
   history (item 1), it must not be relied upon or extended casually:
   anyone depending on it should re-review the workflow, secret scope,
   and run history first.

---

## Quality gate (how this document was checked)

- Every command was run against this repository or is explicitly marked
  (submit paths, clean-container setup, legacy xsuite, clippy/fmt here).
- Every referenced path exists (verified by inspection at write time).
- No Windows paths; no real credentials/keys/tokens (examples are placeholders).
- `.env.example` covers all inventoried variables (see §5).
- Read-only verification needs no private keys (§2, §9).
- Terminal agents get explicit commands with no wallet popups (§7).
- Recorded vs live proofs are distinguished in §8 and in the dry-run output.
- `./scripts/verify.sh` was run; its actual output is quoted in §9.
- Could not be tested: live transaction submission (out of bounds),
  clean-machine setup (no container runtime), legacy cross-contract
  xsuite (fails to build on modern toolchains), clippy/rustfmt locally
  (read-only toolchain dir; CI covers them).
