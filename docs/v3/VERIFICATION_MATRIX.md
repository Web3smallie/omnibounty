# OmniBounty V3 — Verification Matrix

Every row is one enforceable check. Tri-state semantics are absolute:
**PASS** = evidence present and rule holds; **FAIL** = evidence present and
rule violated; **UNVERIFIED** = evidence missing/incomplete — a claim with
any UNVERIFIED required check is rejected, never passed. Status PROVEN =
executed live with fixtures; SPECIFIED = designed from a proven mechanism
class, awaiting contract implementation + confirmatory run.

Conventions: `{repo}` = criteria repo byte-exact; `{n}` = claim PR number;
`{head}` = joined head SHA; `{id}` = check-run id. All GET. JSON endpoints
use `Accept: application/vnd.github+json` (pinned); diff uses
`application/vnd.github.diff` (pinned). Matcher patterns below are the
normative templates (regex flavor: Rust `regex` crate subset on-chain;
attestor-side PCRE-compatible as executed).

## A. Repository + PR identity

| Criterion | Endpoint | Matchers (exact templates) | Extracted | Cross-checks | On-chain rule | Fail → | Assumptions | Status |
|---|---|---|---|---|---|---|---|---|
| repo identity | `GET /repos/{repo}/pulls/{n}` | `"full_name":"(?<repo>.*?)"` | repo | URL repo == criteria repo | `== criteria.repo` | REPO_MISMATCH | API honesty | PROVEN (EXP-01b/c,02) |
| PR number | same | `"number":(?<number>.*?)[,}]` | number | URL number == extracted; recorded anti-double-claim | `== claim PR` | NUMBER_MISMATCH | same | PROVEN (EXP-01b/c,02) |
| author evidence | same | `"login":"(?<author>.*?)"` | author | display + association check | non-empty, ≤128 | PREDICATE_FAILED | first-`login` is PR author (verified shape) | PROVEN (EXP-01b/c,02) |
| author association | same | `"author_association":"(?<assoc>.*?)"` | assoc | — | ∈ allowlist if configured | PREDICATE_FAILED | enum stability | PROVEN (EXP-02) |
| head SHA | same | `"sha":"(?<head_sha>[0-9a-f]{40})"` (first = head; verified order) | head_sha | join key across ALL proofs | recorded; equality enforced | HEAD_DIVERGE | key order verified per endpoint | PROVEN (EXP-02) |
| base SHA | same | `"base":\{[\s\S]*?"sha":"(?<base_sha>[0-9a-f]{40})"` | base_sha | `== criteria.base_commit` if configured | equality iff configured | PREDICATE_FAILED | nesting-tolerant pattern required (naive fails — proven) | PROVEN (EXP-02) |
| merged state | same | `"merged":(?<merged>.*?)[,}]` | merged | — | `=="true"` iff policy=merged | PREDICATE_FAILED | — | PROVEN (EXP-01b/c) |
| fork policy | same | `"full_name"` on head.repo context | head repo | if `allow_forks=false`: head repo == criteria repo | equality iff configured | FORK_REJECTED | head object precedes base; verified order | SPECIFIED (mechanism proven) |
| payout commitment | same | contains `omnibounty:<bid>:<0xaddr>` | marker | recipient == proof owner == marker addr | equality iff policy=commitment | COMMITMENT_MISMATCH | branch-write ≈ authorship (residual) | SPECIFIED |

## B. CI checks (per required entry; one proof per check-run allowed)

| Criterion | Endpoint | Matchers | Extracted | Cross-checks | On-chain rule | Fail → | Assumptions | Status |
|---|---|---|---|---|---|---|---|---|
| run identity+verdict | `GET .../check-runs/{id}` | `"id"`, `"name"`, `"head_sha"`, `"status"`, `"conclusion"`, `"completed_at"` exact-key matchers | all 6 | head_sha == joined head | name ∈ required AND status==completed AND conclusion==success | CHECK_FAILED | single-object precision | PROVEN (EXP-03b) |
| app allowlist | same | `"app":\{[^}]*?"slug":"(?<app>.*?)"` | app | — | app ∈ entry.apps | APP_REJECTED | slug position verified | PROVEN (EXP-03b) |
| list binding (alt.) | `GET .../commits/{head}/check-runs?per_page=100` | anchored `"name":"<X>"[\s\S]*?"conclusion":"(?<c>.*?)"` + head + `total_count` | per-anchor | anchor occurrence == 1 (else UNVERIFIED); total_count bounds page | same verdict rule | CHECK_FAILED / UNVERIFIED | anchor uniqueness validated per page | PROVEN (EXP-03a) |
| check freshness | from above | `completed_at` string | ts | completed_at within max_age of claim time iff configured | comparison iff configured | CHECK_STALE | event-time is attested data, not proof (see L5) | SPECIFIED |

## C. Files, diff, protected paths

| Criterion | Endpoint | Matchers | Extracted | Cross-checks | On-chain rule | Fail → | Assumptions | Status |
|---|---|---|---|---|---|---|---|---|
| changed rows | `GET .../pulls/{n}/files?per_page=100` | per-row `filename/status/additions/deletions` anchored | rows | URL pr == joined PR; row-count vs `changed_files` from PR proof (completeness) | allow/forbid/required/touched + sums vs caps | FILES_* | page completeness via changed_files cross-check | PROVEN rows (EXP-04a); cross-check SPECIFIED |
| patch contains | same | `contains` per required string | (presence only) | — | all present | PATCH_MISS | substring presence, not position | PROVEN (EXP-04a) |
| protected blob | `GET .../contents/{path}?ref={head}` | `path`, `sha`, `size` exact-key | blob triple | URL ref == joined head; path == criteria path | blob_sha == committed blob | PROTECTED_CHANGED | one proof per file (≤16) | PROVEN (EXP P2-01) |
| diff format | `GET .../pulls/{n}` + `Accept: ...diff` | `diff --git (?<f>.*?)[\n]` etc. | diff spans | headers pinned in signed params | contains-rules as configured | PATCH_MISS | Accept pinned (proven recordable) | PROVEN (EXP-08) |

## D. Labels, reviews, issues

| Criterion | Endpoint | Matchers | Extracted | Cross-checks | On-chain rule | Fail → | Assumptions | Status |
|---|---|---|---|---|---|---|---|---|
| required labels | PR object | `"labels":\[[\s\S]*?"name":"(?<label>.*?)"` per label | label0… | — | each required label attested | LABEL_MISS | first-label order verified; multi-label = multi-matcher | PROVEN single (EXP-05a) |
| reviewer approval | `GET .../pulls/{n}/reviews?per_page=100` | `"login":"<L>"[\s\S]*?"state":"(?<s>.*?)"` per required login | state per reviewer | — | each == APPROVED (+ association if configured) | REVIEW_MISS | anchor per login; counts NOT supported | PROVEN multi (P2-02) |
| issue close ref | PR object | single alternation `(?<ref>closes #N\|fixes #N\|…)` | ref | N == criteria issue number | present iff required | ISSUE_REF_MISS | title/body presence (both link on GitHub) | SPECIFIED (contains proven) |

## E. Rewards, timing, binding (no Reclaim endpoint; pure on-chain rules)

| Rule | Check | Fail → | Status |
|---|---|---|---|
| slots valid | 1..16 slots, amounts canonical u256 > 0, policy⇔length consistent | INVALID_ALLOCATION | SPECIFIED (TS-enforced now) |
| funding exactness | escrowed total == sum(slots) at fund time | FUND_MISMATCH | SPECIFIED |
| slot fill | slot *i* ← *i*-th qualifier in contract sequence order | SLOT_TAKEN | SPECIFIED |
| deadline | claim block time < deadline (0 = none) | EXPIRED | SPECIFIED |
| challenge | finalize only after qualified_at + window; counter-evidence re-executes checks | CHALLENGE_WINDOW / CHALLENGE_UPHELD | SPECIFIED |
| evidence freshness | every proof ts within criteria evidence_max_age_sec of claim | PROOF_TOO_OLD | SPECIFIED (mechanism = current) |
| identifier scope | nullifier key = `keccak("OMNIBOUNTY-V3-NULL"‖bounty:u64be‖recipient:20B‖type:u8‖id:32B)`; unused required | REPLAY | SPECIFIED (golden vector in tests) |
| join integrity | ≥1 PR proof; all PR numbers equal; all head SHAs equal; contents refs == head | JOIN_FAILED | SPECIFIED (TS-tested on real fixtures) |
| criteria immutability | re-hash claim-supplied doc, compare to committed hash | CRITERIA_MISMATCH | SPECIFIED |
| duplicate PR | (bounty, pr_number) claimed once | DUPLICATE_PR | SPECIFIED |
| refund | post-expiry, sponsor-only, unfilled slots only, exact amounts | REFUND_DENIED | SPECIFIED |
