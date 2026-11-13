# OmniBounty frontend

Next.js marketplace for sponsors (create + fund bounties with USDC on Base
Sepolia) and contributors (prove a merged PR with Reclaim zkTLS, track the
MPC-signed voucher, watch the relayer settle the payout).

Base Sepolia is the only chain this app targets. Every bounty, voucher, and
payout shown is read live from the NEAR contract or the Base escrow —
nothing is fabricated, simulated, or cached as fact.

## Configure

```sh
cp .env.example .env.local
# defaults already point at the V2 deployment:
#   v2.omnibounty.testnet + 0xee5C…2C99 on Base Sepolia (84532)
```

Only public endpoints/addresses use `NEXT_PUBLIC_*`. The Reclaim app secret
is server-side only (see below) and must never get a `NEXT_PUBLIC_` prefix.

## Run

```sh
npm install
npm test        # 30 unit tests, no network (validation + display + env)
npm run dev     # http://localhost:3000
npm run build && npm start
```

## User journeys

**Sponsor** (`/bounties/new`): connect NEAR + EVM wallets → fill in bounty
ID (or "Suggest next", derived from on-chain bounties), repo, PR number,
reward in human USDC, optional deadline → live listing preview → preflight
(contract state, ID uniqueness on both chains, USDC balance) → four
on-chain steps (NEAR `create_bounty`, Base `createBounty`, USDC `approve`,
`fundBounty`), each with its transaction hash and explorer link. Failures
keep completed steps; "Resume" continues from the failed one.

**Contributor** (`/bounties/[id]`): browse the marketplace → open a bounty →
paste the Reclaim proof → the app shows what the proof claims
(merged/author/repo/number) and flags mismatches → dry-run against the
contract (free) → submit `claim` from the NEAR wallet → watch the
MPC-signed voucher arrive → watch the relayer settle it → payout panel
links the real USDC transaction on Base Sepolia. Pending, settled, and
failed states are all explicit; nothing is shown as paid until the escrow
`VoucherClaimed` log exists.

The on-chain template stores repo, PR number, amount, and deadline — the
marketplace title (`repo#number`) and criteria line are derived from those
fields, never from free text.

## Generating proofs

Proofs must extract `merged`, `author`, `repo`, and `number` for the PR, or
the contract rejects them. Generate server-side (the app secret never leaves
your machine). Set the credentials per command:

```sh
RECLAIM_APP_ID=0x... RECLAIM_APP_SECRET=0x... npm run prove -- octocat/Hello-World 7 ./proof.json
```

or persist them on this machine only in `frontend/.env.local` (gitignored,
loaded automatically by the script; shell variables take precedence):

```sh
RECLAIM_APP_ID=0x...
RECLAIM_APP_SECRET=0x...
```

Never prefix these with `NEXT_PUBLIC_` — that would embed them in the
browser bundle.

The script fails fast if the extraction does not satisfy the on-chain
predicate (e.g. the PR is not merged). Paste the resulting JSON into the
claim form. Payout always goes to the proof owner — frontrunners cannot
redirect funds.

## Layout

- `app/` — routes: marketplace home, sponsor page, bounty detail (NEAR data
  server-rendered, Base state read live in the browser).
- `components/` — wallet context (NEAR + EVM with Base Sepolia switching),
  marketplace grid, sponsor/claim flows, settlement tracker.
- `lib/near.ts`, `lib/base.ts` — contract access; `lib/validation.mjs` +
  `lib/display.mjs` + `lib/settlement.mjs` — pure, dependency-free helpers shared with the tests.

## V3 demo flow (3-minute judging)

V3 bounties render automatically when the on-chain view carries
`criteria_hash` (V1 rendering is unchanged). The V3 journey is one submit:

1. Generate both proofs with the SAME Reclaim app secret (the proof owner
   derives from it, and every proof owner must equal the payout recipient):
   `node scripts/prove.mjs <owner/repo> <pr> ./proof-pr.json` (7 mandated
   PR extractions) and `GITHUB_TOKEN=<your-own-token> node
   scripts/prove_identity.mjs ./proof-identity.json` (your login + numeric
   id; the token stays on your machine and never enters the proof).
2. Paste the claim bundle (`{ criteria_json, proofs }` with
   `{ evidence_type: 1, proof }` + `{ evidence_type: 7, proof }` entries) —
   Analyze shows the PR facts and verifies the identity binding.
3. Submit once from the NEAR wallet (1 NEAR deposit + gas): the form first
   runs the read-only `dry_qualify` preflight with the exact same arguments
   and only opens the wallet approval when the contract reports success.
4. The panel tracks qualifying → qualified → finalizing → signing →
   settling → paid. Finalization is automatic: the relayer submits
   permissionless `finalize_claim` on its next poll (demo bounties use
   `challenge_window_sec: "0"`), and "paid" appears only after the Base
   escrow confirms the payout. See `../docs/v3/FINALIZATION.md`.

Point the app at V3 with `NEXT_PUBLIC_CONTRACT_ID=omnibounty-v3.testnet`
(plus the V3 escrow address) in `.env.local`.
