# Phase 2 — Criteria Specification: Log

Branch: `v3-rebuild`. No contract code in this phase (forbidden); no pushes,
deploys, or transactions. No production builds (dev-server courtesy).

## Work record
- Scouted contents/compare/multi-review endpoints (read-only); fixed workflow
  path after a 404 on a guessed filename.
- P2-01 contents-API proof: PASS (path/sha/size exact) — protected-file
  mechanism proven.
- P2-02 multi-review anchored binding: PASS (both reviewers exact) — closes
  Phase 1 follow-up F2.
- P2-03 row-occurrence files proof: PASS (3 rows x 4 fields exact, 189s).
  Finding: my first `^`-anchored occurrence pattern had an off-by-one
  (consumed occurrences then required one more); corrected to skip-(k-1) +
  span form WITHOUT `^` (leftmost matching makes `^` redundant — verified
  locally AND live). Slow attestations (~3min for spanning patterns) must
  shape claim-UX timeouts.
- Wrote docs/v3/CRITERIA_SCHEMA.json + frontend/lib/criteria.mjs (strict
  parse, canon, validate, hash, join, nullifier) + 8 valid + 10 invalid
  fixtures + golden hashes + frontend/test/criteria.test.mjs (13 tests).
- Pinned canonicalize@2.1.0 exact in frontend (matches tools/ + canon.rs).
- Wrote docs/v3/{ACCEPTANCE_CRITERIA_SPEC,VERIFICATION_MATRIX,SECURITY_MODEL,
  CANONICALIZATION}.md. Suite: 53/53 green; tsc clean.
- GitHub rate discipline: unauthenticated quota is shared on sandbox egress;
  secondary limiting observed once; 65s cooldown recovered. Live scripts
  minimize direct reads (attestor-side fetches unaffected).
