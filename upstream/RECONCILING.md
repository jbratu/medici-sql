# Reconciling upstream changes

This repository is an API-compatible SQL (Prisma/SQLite) port of
[flash-oss/medici](https://github.com/flash-oss/medici). The contract: upstream
`src/` business logic is copied **verbatim** (see `VERBATIM_FILES.txt`), the
public API is **additive-only**, and no upstream test may be silently skipped
(see `TEST_COMPAT_MATRIX.md`).

The drift monitor is `npm run upstream:check`. It fetches `upstream/master`,
compares it against the pinned SHA (`PINNED_SHA`), and reports three classes:

- **A — Public API surface.** Builds upstream `types/index.d.ts` at the new SHA
  (`dts-bundle-generator`, same as upstream's `build:types`) and diffs the
  export list against `api-surface.json`. Added exports are additive
  (informational); a removed export or changed signature is **breaking**.
- **B — Verbatim `src/` files.** Plain-diffs each file in `VERBATIM_FILES.txt`
  (our copy vs upstream at the new SHA). If upstream moved the file but our
  copy still matches the pin, that is a **clean fast-forward** (informational —
  re-copy it). Any other difference is **drift** and fails the check.
- **C — `spec/` drift.** Compares the new `spec/` tree against
  `spec/UPSTREAM_PROVENANCE.md` (per-file sha256 + `it()` count at the pin).
  New spec files or new `it()`s are **unclassified** and fail the check until
  `TEST_COMPAT_MATRIX.md` has a tier+rationale row for them. Changed files are
  diffed and their matrix rows flagged stale.

A git-history audit additionally fails the check if a commit bumped
`PINNED_SHA` while spec hashes changed without updating `TEST_COMPAT_MATRIX.md`
in the same commit.

Exit codes: `0` clean, `1` findings, `2` operational error. Outputs: a
human-readable report on stdout, `upstream-check.report.json` and
`upstream-check-report.md` in the repo root (both gitignored).

## Adopting an upstream change (the procedure)

1. **Run the check and read the report.**

   ```sh
   npm run upstream:check
   ```

   Findings are grouped by class (A/B/C) with per-file detail and a unified
   diff where relevant.

2. **Triage unclassified specs (class C) into the matrix.**
   For each new spec file or new `it()`, add a row to `TEST_COMPAT_MATRIX.md`
   with a tier (`A`/`B`/`C`) and a rationale. Tier C rows need a verified
   `replacement: spec/sql/<file>.ts :: <title>` or `replacement: none` plus a
   `client_impact` sentence, and they count against `TIER_C_BUDGET`.
   For changed files, review the diff in the report and update any now-stale
   matrix rows (titles, tiers).

3. **Triage surface changes (class A).**
   - *Additive* (new exports): accept them — the port may add exports but must
     never remove or change existing ones.
   - *Breaking* (removed export or changed signature): **cannot be adopted as
     is.** The client-facing API must stay additive-only. Decide consciously
     (keep our export, document the divergence, or plan a compat shim) and
     record the decision in a comment on the reconciliation issue before
     bumping the pin.

4. **Resolve verbatim drift (class B).**
   - *Clean fast-forward*: nothing to do beyond the re-copy in step 5.
   - *Drift / deleted upstream file*: review the unified diff. Our copy must
     end up byte-identical to upstream (re-copy) or the divergence must be a
     deliberate, documented decision (e.g. a compat adapter boundary) — if it
     is deliberate, move the file out of `VERBATIM_FILES.txt` and say so in the
     matrix/issue so future checks do not flag it.

5. **Regenerate the baseline at the new SHA.**

   ```sh
   npm run upstream:baseline <new-upstream-sha>
   ```

   This re-copies the verbatim files, regenerates `spec/UPSTREAM_PROVENANCE.md`,
   `api-surface.json` and `PINNED_SHA`, and runs `upstream:check --full`
   against the new SHA. Fix anything it reports (usually: matrix rows from
   step 2 are not yet in place).

6. **Verify the check is clean.**

   ```sh
   npm run upstream:check   # must exit 0
   ```

7. **Commit everything in ONE commit.** Matrix + verbatim re-copies +
   `UPSTREAM_PROVENANCE.md` + `api-surface.json` + `PINNED_SHA` (+ any compat
   changes). The pin-bump audit fails if spec hashes changed in a pin-bump
   commit that does not touch `TEST_COMPAT_MATRIX.md`.

8. **Push.** CI (`.github/workflows/upstream-check.yml`) re-runs the check on
   the push; on failure outside PRs it opens/updates a GitHub issue labeled
   `upstream-drift` with the full report.

## Scratch usage

`--ref` checks any ref instead of `upstream/master` — useful for reviewing a
specific upstream commit or PR head before it lands:

```sh
node scripts/upstream-check.mjs --ref <sha-or-ref>
```

`--full` forces the full pipeline (including the type-surface build) even when
the ref is already at the pinned SHA.

## Operational notes

- The script auto-adds the `upstream` remote
  (`https://github.com/flash-oss/medici.git`) if it is missing — CI checkouts
  have a fresh `.git/config`, so never assume the remote exists.
- The surface build installs the *upstream* dependency tree in a temp dir with
  `npm ci --ignore-scripts` (mongodb-memory-server's postinstall downloads a
  binary and is never needed here).
- Making `upstream-check` a *required* status check is a GitHub branch-protection
  setting — an owner action, not doable from an agent run.
- The weekly cadence before the workflow's cron is live on the default branch
  is the Paperclip routine registered by the operator against
  `npm run upstream:check` (see ITD-98).
