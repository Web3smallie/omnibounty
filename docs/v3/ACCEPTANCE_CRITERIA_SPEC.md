# OmniBounty V3 — Acceptance Criteria Specification

Normative product/protocol spec for task-first bounties. Companions:
`CRITERIA_SCHEMA.json` (shape), `CANONICALIZATION.md` (bytes+hash),
`VERIFICATION_MATRIX.md` (per-criterion evidence), `SECURITY_MODEL.md`
(threats+trust). No contract code exists yet; this document governs it.

## 1. Model overview

A bounty is **funded terms + committed criteria + escrowed reward**:

- The sponsor authors a criteria document (title, description, repo, PR
  rules, CI rules, file rules, optional metadata rules, reward slots,
  timing). Authoring tooling validates it strictly and shows the exact
  canonical bytes + `criteria_hash`.
- Funding commits `criteria_hash` (plus bounty id, token, slot amounts,
  deadlines) on-chain and escrows exactly `sum(slots)` USDC. The full
  document lives off-chain (metadata service), but enforcement never
  trusts the host: every claim re-supplies the document, the contract
  re-hashes and compares.
- Contributors open any PR (number unknown at funding). Qualification is a
  bundle of Reclaim proofs cross-referenced on-chain to one PR head SHA.
- Ordered slots fill by deterministic qualification sequence. Challenge
  window, then permissionless finalize, then MPC-signed slot voucher,
  then Base settlement. Unfilled slots refund post-expiry.

Non-goals for v1 of this spec: bare approval counts ("N approvals" —
unenforceable, see SECURITY_MODEL.md), AI-judged criteria, private repos
(no auth story yet), multi-repo tasks.

## 2. Criteria sections (normative summary; schema is authoritative)

- **A. Identity**: `repo` (exact slug), optional `base_commit` (exact 40-hex;
  when present the PR's base SHA must equal it — pins which base the work
  targets; stale-base PRs fail closed, documented).
- **B. PR rules**: `merge_policy` (`merged` requires `merged=="true"`;
  `ci_verified` imposes no merged constraint — merged PRs with green CI
  also qualify); `allow_forks` (explicit, no default; false pins
  head-repo == criteria repo); optional `author_association` allowlist.
- **C. CI rules**: `checks.required[]` of `{name, apps[]}`; each needs ≥1
  completed+success run on the PR head from an allowed GitHub App slug.
  Existential semantics per entry. Optional `max_age_sec` bounds
  completed_at recency. Exact head-SHA binding always required.
- **D. File rules**: `allowed_paths` (every changed path matches ≥1),
  `forbidden_paths` (none may match), `required_touched` (each matches
  ≥1 changed path), `max_changed_files/additions/deletions` (sums over
  the attested file rows), `protected[]` (`{path, blob_sha}` exact
  equality via contents API at PR head), `patch_contains_all` (each
  string present in the unified diff). Path patterns: exact paths or
  `dir/` subtree prefixes; no other glob syntax exists.
- **E. Metadata rules**: `labels.required_all`, `reviews.required_approvals[]`
  (`{login, association?}` — each login must have an APPROVED review;
  counts deliberately unsupported), `issue` (repo-bound URL +
  optional close-reference marker).
- **F. Rewards**: `policy` + `slots[{amount}]` (base-unit decimal strings;
  equal vs weighted is expressed by making amounts equal vs different —
  no second mode can disagree with the money). Consistency enforced:
  `single_winner` ⇔ exactly 1 slot; all amounts > 0 and u256-bounded;
  funded total MUST equal the sum (checked at funding). `unfilled` is
  `refund_sponsor` (only policy defined).
- **G. Timing**: `deadline` (0 = none; claims at/after a nonzero deadline
  fail), `challenge_window_sec` (0 = immediate finality),
  `evidence_max_age_sec` (required, 1..604800 — tighter than the 7d
  protocol ceiling is allowed, looser is not).

## 3. Funding = commitment (immutability mechanism)

1. Sponsor authors → tooling validates strictly → preview shows canonical
   bytes + hash + a human rendering.
2. `fund` transaction stores `(criteria_hash, slots, amounts, deadline,
   policy)` and escrows `sum(slots)`. The contract exposes NO criteria
   setters — post-funding change is structurally impossible, not merely
   discouraged.
3. The metadata service publishes the full document; every reader
   re-hashes and compares. A compromised host can hide listings (liveness)
   but cannot alter enforced terms (integrity).

## 4. Claim model (multi-proof)

A claim references an ordered bundle of proofs, each tagged with an
evidence type (PR=1, CHECK_RUN=2, FILES=3, REVIEW=4, CONTENTS=5, DIFF=6).
The contract, per proof: verifies signatures/freshness/replay (replay key
= `keccak("OMNIBOUNTY-V3-NULL" || bounty_id:u64be || recipient:20B ||
type:u8 || identifier:32B)` — scoped per bounty/recipient/type so identical
evidence can back distinct bounties without cross-replay, and no proof is
reusable). Then it joins: every proof's URL must match its endpoint
template for the criteria repo; PR numbers extracted from URLs must agree;
every head SHA (PR head, check-run head, review commit, contents ref,
list sha) must be byte-equal; the PR number is recorded to block same-PR
second claims. Finally each criterion's rule in §2 evaluates over the
joined evidence. One failing rule fails the claim; missing evidence is
UNVERIFIED, never PASS.

## 5. Identity policies (honest statement)

- `open`: first valid prover is paid; the GitHub author is attested
  evidence and UI display only. No cryptographic GitHub↔wallet link is
  claimed (none exists in this stack).
- `commitment`: the PR title/body MUST contain
  `omnibounty:<bounty_id>:<recipient_hex>` with recipient == proof owner.
  Only someone with branch-write access (normally the PR author) can place
  it; maintainers-with-push-access is the documented residual. This is the
  recommended policy whenever authorship credit matters.

## 6. Winner sequencing, challenge, finality

- Qualification order = contract-assigned monotonic sequence at claim
  execution (canonical chain order — deterministic within and across
  blocks, no wall-clock races). Slot *i* goes to the *i*-th qualifier.
- Challenge: fixed `challenge_window_sec` per qualification; during it,
  anyone may submit deterministic counter-evidence (a newer proof showing
  a criterion now fails, a duplicate-claim proof); resolution is
  re-execution, never voting. No bonded challenges in v1 (spam costs gas;
  window is fixed; finalize happens exactly once).
- Finalize is permissionless after the window; only then is the slot
  voucher MPC-signed. A qualifying head is LOCKED at qualification:
  later pushes need a new claim (which loses on ordering/duplicates).
  Expiry refunds unfilled slots to the sponsor; filled slots are final.

## 7. Worked example (simple-ci fixture)

`testdata/v3/criteria-valid/simple-ci.json` (`criteria_hash 0x499d…4110`):
react/react, any fork, CI-verified, one required check (`cleanup` from
`github-actions`), 1 USDC single slot. A contributor opens any PR, waits
for green CI, generates two proofs (PR object + the named check-run),
submits; the contract verifies both signatures/freshness, joins on head
SHA `5621284b…`, checks run name/app/status/conclusion, fills slot 0,
and after the (here zero-length) challenge window signs
`voucher(bounty, slot=0, recipient, 1000000, criteria_hash, …)`.

## 8. What this spec deliberately excludes

Bare approval counts, AI-judged or subjective criteria, private repos,
multi-repo tasks, editable criteria, sponsor post-funding discretion,
and any criterion without a VERIFICATION_MATRIX.md row marked PROVEN or
SPECIFIED-with-acceptance-test. Each exclusion is a future version's
explicit extension, never silent scope creep.
