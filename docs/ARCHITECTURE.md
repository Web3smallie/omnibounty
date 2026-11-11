# OmniBounty architecture

## What it is

OmniBounty pays GitHub contributors in USDC for merged pull requests. A
sponsor funds a bounty on Base Sepolia; a contributor proves the merge with a
Reclaim zkTLS proof; the NEAR contract verifies the proof and authorizes an
EIP-712 payout voucher through NEAR Chain Signatures (MPC); a relayer
submits the voucher to the Base escrow, which pays the contributor.

## Component map

```
sponsor ──► Base escrow (fund USDC) ◄── bounty registry duplicated on NEAR
contributor ──► Reclaim attestor (zkFetch GitHub PR) ──► proof JSON
contributor ──► NEAR claim(proof) ──► verify ──► MPC sign(digest) ──► voucher
relayer ──► NEAR list_unrelayed ──► validate ──► escrow.claim ──► USDC out
frontend ──► views + wallet tx for all of the above
```

| Component | Path | Trust role |
|---|---|---|
| NEAR contract | `contracts/near` | Verifies proofs, binds PR→bounty→owner, mints vouchers via MPC |
| Base escrow | `contracts/base` | Holds USDC, settles MPC-authorized vouchers only |
| Relayer | `relayer` | Untrusted courier; cannot redirect or forge payouts |
| Frontend | `frontend` | UX + wallet signing; all checks re-done on-chain |
| Fixtures | `testdata` + `tools` | Independent-oracle vectors shared by every suite |

## Why the NEAR contract owns verification

An early design called the deployed `reclaim-protocol.testnet` verifier.
Investigation showed the deployed code diverges from its published source
(unexplained panics and storage writes), its owner can add arbitrary witness
epochs at any time, and its encoding contract (`0x`-handling,
canonicalization) is incompatible with SDK-native proofs. Depending on it
would outsource payout authorization to unverified, mutable third-party
logic. The contract therefore embeds verification with **pinned witness
sets** under its own governance and never calls the Reclaim contract.

## Proof verification pipeline (NEAR)

For `claim(bounty_id, proof, recipient)`:

1. **Guards**: not paused, bounty `Open`, bounty unexpired, MPC configured.
2. **Strict normalization** (`normalize`): identifier/owner/signatures accept
   an optional single `0x`, exact length, any case → lowercase bare bytes.
   Everything else is rejected, never repaired.
3. **Core verification** (`reclaim`): provider check; parameters must parse
   as JSON *and* be byte-canonical (attestors always emit canonical bytes);
   context may be any valid JSON and is canonicalized before hashing
   (SDK-compatible); `identifier == keccak256("http\\nparams\\ncanon_ctx")`;
   EIP-191 sign-data rebuilt canonically; every signature recovered;
   recovered set must equal the pinned epoch set exactly (count, members,
   distinctness).
4. **Binding**: `recipient == proof.owner` (frontrunning cannot steal);
   identifier not previously nullified.
5. **Freshness**: `timestampS` within `[now - 7d, now + 5m]` (configurable).
6. **Template** (`template`): params URL must equal exactly
   `https://api.github.com/repos/{repo}/pulls/{number}` with GET and
   well-formed matchers; extracted `merged == "true"` (merged, not merely
   closed), `author` non-empty, `repo`/`number` equal the bounty.
7. **Voucher**: `{bountyId, recipient=owner, token, amount, nonce++, expiry,
   chainId, escrow}` → EIP-712 digest; bounty → `Pending`; MPC `sign`
   requested over the 32-byte digest.
8. **Callback** (`on_voucher_signed`): the promise result is read as raw
   bytes (`env::promise_result`, never a typed `#[callback_result]` — a
   framework deserialization panic would wedge the bounty in `Pending`);
   the v3 envelope is strictly parsed (scheme tag, compressed R point
   with prefix/parity cross-check, scalar, recovery id); the signer is
   re-derived and required to equal the configured MPC address; voucher
   stored, bounty → `Claimed`, identifier nullified. Any failure releases
   the bounty to `Open` for a safe retry — returned as data
   (`VoucherCallbackOutcome::Rejected`, successful receipt, plus a
   `voucher_rejected` log), never via panic, so the release commits
   instead of rolling back (the bounty #3 wedge).

`dry_run` executes steps 1–6 read-only for preflight.

## MPC wire interface (verified, not assumed)

The deployed testnet signer `v1.signer-prod.testnet` (contract
`version()` = `"3.18.0"`) speaks the wrapped v3 API — the legacy flat-arg
v1 shape is rejected with `missing field 'request'` (proven by read-only
view probes in `tools/probe_mpc.py` against the `near/mpc` tag `3.18.0`
sources under `tools/mpc_ref/3.18.0`):

- Request: `sign({"request": {"path", "payload_v2": {"Ecdsa": hex},
  "domain_id": 0}})` + 1 yoctoNEAR deposit + ≥15 Tgas.
- Response: `{"scheme": "Secp256k1", "big_r": {"affine_point":
  "02|03||x"}, "s": {"scalar": hex}, "recovery_id": 0|1}`.
- Voucher key: `derived_public_key(path, predecessor=contract)`; the KDF
  (`root + sha3_256(prefix||pred||","||path)·G`) is independently
  re-verified by `tools/mpc_derive.mjs` on every run (`KDF MATCH`).

The live handshake (`tools/live_handshake.mjs`) exercises this end to end
on testnet and exports `testdata/live_voucher.json`, which the Foundry
suite settles for real (`LiveVoucherTest`).

## Voucher and escrow

EIP-712 domain `("OmniBounty", "1", chainId, escrow)`; struct
`Voucher(bountyId, recipient, token, amount, nonce, expiry, chainId,
escrow)`. The escrow re-checks every field plus digest single-use, bounty
funded/claimed state, token/amount equality, `v ∈ {27,28}`, and
`ecrecover == mpcSigner`. Voucher digests are byte-identical across the
Rust, Solidity, and ethers implementations (proven by shared fixtures).

## Relayer trust model

The relayer holds only a gas key. It cannot forge vouchers (no MPC key),
cannot redirect payouts (recipient is signed), and cannot double-pay
(single-use digests + claimed flags). It validates locally to avoid
doomed transactions and treats `escrow.usedVoucher` as ground truth, so
restarts and crashes are safe.

## What is deliberately out of scope for v1

Automated witness rotation (manual `upsert_epoch` under owner control),
multi-winner / partial payouts, ERC-20 fee abstraction on Base, and
mainnet deployment parameters. Each is a documented follow-up, not a
silent assumption — see `SECURITY.md` and `DEPLOYMENT.md`.
