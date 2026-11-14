# OmniBounty frontend

Next.js marketplace for sponsors (create + fund bounties with USDC on Base
Sepolia) and contributors (prove a merged PR with Reclaim zkTLS attestations,
track the MPC-signed voucher, watch the relayer settle the payout).

The app targets NEAR testnet and Base Sepolia together. Every bounty, voucher,
and payout shown is read live from the NEAR contract or the Base escrow —
nothing is fabricated, simulated, or cached as fact.

## Configure

```sh
cp .env.example .env.local
# defaults already point at the V3 deployment:
#   omnibounty-v3.testnet + 0x63391c272A49c30f79eb6c3d8E10F0652Bb0F767 on Base Sepolia (84532)
```

Only public endpoints/addresses use `NEXT_PUBLIC_*`. The Reclaim app secret
is server-side only (see below) and must never get a `NEXT_PUBLIC_` prefix.

## Run

```sh
npm install
npm test        # 441 tests, offline (validation + display + wallets + settlement + more)
npm run dev     # http://localhost:3000
npm run build && npm start
```

## User journeys

**Sponsor** (`/bounties/new`): connect NEAR + EVM wallets → fill in bounty
ID (or "Suggest next", derived from on-chain bounties) and criteria —
simple mode (title, description, repo, issue, slots, deadline, challenge
window, merge policy) or advanced raw criteria JSON → live listing
preview → preflight (contract state, ID uniqueness on both chains, USDC
balance) → five on-chain steps (NEAR `create_bounty`, Base
`createBounty`, USDC `approve`, `fundBounty`, NEAR `mark_funded`), each
with its transaction hash and explorer link. Failures keep completed
steps; "Resume" continues from the failed one.

**Contributor** (`/bounties/[id]`): browse the marketplace → open a bounty →
paste the two Reclaim attestations (PR + identity) → Analyze shows the PR
facts (merged/author/repo/number/head) and verifies the identity binding,
flagging mismatches → dry-run against the contract (free) → submit
`qualify_claim` from the NEAR wallet (1 NEAR deposit + gas) → watch the
MPC-signed voucher arrive → watch the relayer settle it → payout panel
links the real USDC transaction on Base Sepolia. Pending, settled, and
failed states are all explicit; nothing is shown as paid until the escrow
`VoucherClaimed` log exists.

V3 bounties render as `Bounty #<id>` with the criteria hash and slot counts;
the canonical criteria document is served from `public/criteria/<hash>.json`.
(V1 records keep their legacy `repo#number` rendering where encountered.)

## Generating proofs

The V3 claim needs two attestations from the SAME Reclaim app (the proof
owner derives from the app secret, and every owner must equal the payout
recipient). Generate server-side (secrets never leave your machine):

```sh
RECLAIM_APP_ID=0x... RECLAIM_APP_SECRET=0x... npm run prove -- octocat/Hello-World 7 ./proof-pr.json
RECLAIM_APP_ID=0x... RECLAIM_APP_SECRET=0x... GITHUB_TOKEN=<your-own-token> node scripts/prove_identity.mjs ./proof-identity.json
```

or persist credentials on this machine only in `frontend/.env.local`
(gitignored, loaded automatically by both scripts; shell variables take
precedence):

```sh
RECLAIM_APP_ID=0x...
RECLAIM_APP_SECRET=0x...
GITHUB_TOKEN=<your-own-token>
```

Never prefix these with `NEXT_PUBLIC_` — that would embed them in the
browser bundle. The GitHub token travels only inside the private TLS
session: it never enters the signed parameters, the proof files, or the
chain.

Each script fails fast unless its extractions satisfy the on-chain template
(7 mandated PR fields; login + numeric id for identity). Paste both JSON
files into the claim form. Payout always goes to the proof owner —
frontrunners cannot redirect funds.

## Layout

- `app/` — routes: marketplace home, sponsor page, bounty detail (NEAR data
  server-rendered, Base state read live in the browser), error boundaries.
- `components/` — wallet context (NEAR Wallet Selector + EVM with Base
  Sepolia switching), marketplace grid, `SponsorFormV3`/`ClaimFormV3`,
  settlement tracker, escrow/criteria panels.
- `lib/` — `near.ts`/`base.ts` contract access; DOM-free `*.mjs` helpers
  (`validation`, `display`, `settlement`, `reclaim`, `criteria`,
  `sponsorV3`, `evmWallet`, `walletInit`, `settlePoll`, `txConfirm`,
  `relayerStatus`, `errorRecovery`) shared with the tests.
- `scripts/` — `prove.mjs`, `prove_identity.mjs`, `load_env.mjs`.
- `public/criteria/` — served criteria artifacts, named by canonical hash.
- `test/` — 441 `node:test` assertions mirroring the lib modules.

## V3 demo flow (3-minute judging)

V3 bounties render automatically when the on-chain view carries
`criteria_hash`. The V3 journey is one submit:

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

V3 is the default target (see `.env.example`); override
`NEXT_PUBLIC_CONTRACT_ID`/`NEXT_PUBLIC_ESCROW_ADDRESS` in `.env.local`
only to inspect historical V1/V2 records.
