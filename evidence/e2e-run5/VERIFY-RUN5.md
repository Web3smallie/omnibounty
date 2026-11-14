# Run 5 independent on-chain verification

Date (UTC): 2026-11-14. Purpose: re-verify the Run 5 settlement and the
deployed contract **without trusting** `E2E-RUN5.md`, the README, or any
stored file — every value below comes from a fresh RPC query made for
this check. Nothing here sends transactions, spends funds, or changes
any state.

## 1. Base Sepolia payout transaction

Recorded hash (treated as a claim to check, not a fact):
`0x3f171afb6649b3d0432bd4eaabdb90ede5fd2e871248a6153b89edc5024037e1`

Command:

```sh
curl -s -X POST https://sepolia.base.org -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt",
       "params":["0x3f171afb6649b3d0432bd4eaabdb90ede5fd2e871248a6153b89edc5024037e1"]}'
```

Actual result (receipt):

- `status`: `0x1`, block `58721205`
- `from`: `0x7b8726add6b17a99bdcb938060a9f40e86dc12a5` (relayer sender)
- `to`: `0x63391c272A49c30f79eb6c3d8E10F0652Bb0F767` (escrow)
- Log 1 — USDC `Transfer` (`0xddf252ad…`):
  escrow → `0xaa77daf4a174b3d05d6046462a7cb0e8eb9fa426`, `0xf4240` = 1,000,000
- Log 2 — escrow `VoucherClaimed` (`0xf40a6b7a…`), fully decoded:
  bountyId `414201122891941`, recipient `0xaa77…a426`, slot `0`,
  amount `1000000`, nonce `7`,
  criteriaHash `0x499fc4d32bc3bc91a8cab81785c6fb59e7073c3f769e2b03399b68bdcd7e95b6`,
  digest `0x15a3e5ec9186954161a396777885d803a8035b08ecab8da5e42f312c790dc7e0`

Verdict: payout CONFIRMED — succeeded, settled 1 testnet USDC to the
recorded recipient, event fields match the Run 5 voucher exactly.

## 2. Deployed NEAR contract WASM hash

Expected (from `DEPLOYED.md`, treated as a claim to check):
bytes `707605`, SHA-256
`766c6b14accb4730b634a5d659a10ae804e3e1eb86c77fe1ba9a1fefc02a94d4`.

Commands:

```sh
curl -s -X POST https://rpc.testnet.near.org -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":"j","method":"query","params":{"request_type":"view_code",
       "finality":"final","account_id":"omnibounty-v3.testnet"}}}' -o /tmp/ob-code.json
python3 -c 'import json,hashlib,base64; c=base64.b64decode(json.load(open("/tmp/ob-code.json"))["result"]["code_base64"]); print(len(c), hashlib.sha256(c).hexdigest())'
```

Actual result:

```text
707605 766c6b14accb4730b634a5d659a10ae804e3e1eb86c77fe1ba9a1fefc02a94d4
```

Verdict: deployed bytecode CONFIRMED — byte count and hash match exactly.

## 3. What this establishes (and does not)

- Establishes: the recorded payout transaction succeeded as described,
  and the live contract bytecode is exactly the audited deployment.
- Does not establish: anything about Rust test runs (see
  `../rust-verification/`, which is recorded execution evidence, not a
  live check), anything about local replay (offline simulation with
  test keys), mainnet readiness, or independent sponsor/contributor
  participation (Run 5 wallets were team-operated).
