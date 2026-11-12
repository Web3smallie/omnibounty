# Phase 1 — Reclaim Evidence Experiments: Implementation Log

Branch: `v3-rebuild` (from `main` @ `a95b01c`, verified clean + in sync with origin).
Scope: establish, with executed evidence, what Reclaim can genuinely attest for task-first bounties.
Rules: no secrets in this log or any committed file (key NAMES only); no chain txs; read-only GitHub API; proofs generated against public endpoints only.

## Environment (recorded, not modified)
- TBD: node version, zk-fetch version, credential presence, sandbox network behavior.

## Experiment index
| ID | Question | Status | Evidence |
|----|----------|--------|----------|
| EXP-00 | Can this environment reach Reclaim backend + attestor? Does the Devtool app still exist? | DONE PASS | scripts/exp00-connectivity.mjs |
| EXP-00b | No-proxy control (is egress proxy-mediated?) | DONE PASS | scripts/exp00b-noproxy.mjs |
| EXP-01 | Minimal live zkFetch proof (PR endpoint, current matchers) | DONE (stock :444 path fails environmentally; see 01b/01c) | scripts/exp01-live-proof.mjs |
| EXP-01b/c | Live proof + 5-matcher variant incl. dry_run OK | DONE PASS | scripts/exp01b-*, exp01c-* |
| EXP-02 | Evidence matrix A: identity fields | DONE PASS | scripts/exp02-identity.mjs |
| EXP-03 | Evidence matrix B: check-run list + single | DONE PASS | scripts/exp03-checkruns.mjs |
| EXP-04 | Evidence matrix C: files/diff + absence negative | DONE PASS | scripts/exp04-files.mjs |
| EXP-05 | Evidence matrix D: body/labels/reviews | DONE PASS | scripts/exp05-meta.mjs |
| EXP-06 | First-match/array-binding behavior | DONE (covered across EXP-02/03/05 + analysis) | — |
| EXP-07 | Negative controls: stale + mismatched evidence | DONE PASS | scripts/exp07-negatives.mjs |
| EXP-08 | Header binding (Accept) probe | DONE PASS | scripts/exp08-accept-binding.mjs |

## Daily / running notes
- (Session 1) Branch created. SDK inventoried: zk-fetch 1.1.0 (pinned), attestor-core 5.1.6, appId+secret present (names only).
- EXP-00 PASS (all 3 probes): node v24.14.0; app lookup HTTP 200, app name "OmniBounty" (Devtool record exists + zk-enabled); WSS attestor OPEN in 10.5s (egress slow ~10-14s, functional). No secrets printed.
- EXP-00b control: WITHOUT proxy env, all egress fails fast (EACCES) => sandbox egress is proxy-mediated, 443-only. WSS :444 hangs => zkFetch (flag-steered to :444) cannot run stock here. Workaround: steer ONLY the flag response to the SDK's canonical :443 attestor (documented in-script).
- EXP-01 (stock path): FAILED environmentally (3x 90s RPC timeouts to :444). Proves nothing about Reclaim health; proves sandbox blocks :444.
- EXP-01b (:443, current 4 matchers, react#38132): FULL PASS. zkFetch 47.7s; epoch=1, fresh ts, owner=app wallet, 1 sig; extracted merged/author/repo/number exact; identifier MATCH; signer 0x2448 == pinned epoch-1 witness MATCH; freshness INSIDE. dry_run #4 => IDENTIFIER_REPLAY (correct: same PR+matchers as spent bounty-#2 claim; proves nullifier live).
- EXP-01c (5 matchers, +state): FULL PASS incl. dry_run #4 OK digest=0x75b0…8767 nonce=1. Proves: Devtool creds work, matcher extension works, unknown keys ignored on-chain. DESIGN NOTE: identifier binds (params,context) only — same PR can never back two bounties; V3 needs bounty/recipient-bound identifiers.
- EXP-02 (identity: +head_sha/author_association/base_sha, 7 matchers): FULL PASS, 21.3s, all extractions == ground truth. FINDINGS: (a) attestor FAILS THE WHOLE PROOF if any single matcher doesn't match ("Invalid receipt") — all-or-nothing semantics, good fail-closed property; (b) base object key order is label,ref,repo{...},...,sha — naive `[^}]*?` anchoring fails, nesting-tolerant pattern required and verified; matcher design must be validated per endpoint against real payloads.
- EXP-03 (check-runs): FULL PASS both parts. (A) 307KB/100-row list page: anchored name→conclusion + name→head_sha + total_count all exact (22.3s) — array binding WORKS given anchor uniqueness (occurrence-count gate encoded); total_count attestation enables page-completeness proofs (V3 design input). (B) 3KB single run: all 7 fields exact in 4.4s. Full local verification green on both (identifier/signer-set/freshness).
- EXP-04 (files/diff): FULL PASS. (A) files endpoint: first-row filename/status/+/- exact; `contains` matcher type works as presence assertion (no extracted key), 22.1s. (B) absent-file matcher => "Invalid receipt" fail-closed. FINDING: absence-of-content is UNPROVABLE via matchers — protected-file integrity needs allowlist-comparison or per-file blob proofs in V3, not absence patterns.
- EXP-05 (body/labels/reviews): FULL PASS. (A) body contains-probe + first label exact, 21.1s. (B) single review: reviewer/state/commit==head exact, 4.6s. NOTE: only 1 review existed; multi-review reviewer→state binding relies on the same anchor-uniqueness discipline proven in EXP-03A (recommend one confirmatory multi-review run during implementation).
- EXP-07 (negatives, views only): PASS all three. (A) fresh #38132 proof vs bounty #1 => number-mismatch panic. (B) 1-char-tampered copy => binding-failure panic (attestation is tamper-evident). (C) spike proof (age 3.4d, INSIDE window) => PREDICATE_FAILED as its PR is unmerged — served as predicate control, NOT a staleness isolation (no >7d-old real proof exists to execute ProofTooOld live; age-gate logic itself is covered by existing Rust unit tests).
- EXP-08 (Accept binding): FULL PASS. Custom Accept IS sent, diff format attested, headers ARE inside signed params — V3 can pin representation with no SDK change. Closes the audit's Accept gap.
- Phase 1 experiment campaign COMPLETE. 9 real proofs generated + verified (4.4s–47.7s each), all against epoch-1 witness 0x2448… matching the V2 pinned set. RESULTS.md written. No txs sent, no state changed, no secrets stored.
