# Test compatibility matrix

Maps every upstream spec file and test to its coverage tier in the SQL port. The
drift monitor (`npm run upstream:check`, class C) enforces the core rule: **a new
upstream spec file or a new `it()` cannot be silently skipped** — it is
*unclassified* and the check exits non-zero until it has a row below with a tier
and a rationale.

## Format contract (read by `scripts/upstream-check.mjs`)

- One markdown table. Header: `file | title | kind | tier | rationale | replacement | client_impact`
- **File-level row**: `title` is `—`; `kind` is `file` | `spec` | `helper` | `fixture` | `types`.
  A new upstream spec file needs one of these.
- **Test-level row**: `title` is the exact upstream `it()` title (string literal
  as it appears in the spec file; dynamic titles are tracked as
  `(dynamic: <arg>)`). A new `it()` in an existing file needs one of these.
- `tier`: `A` (covered by port tests as-is) | `B` (covered after SQL adaptation) |
  `C` (carved out — see rules below).
- **Tier C rules** (plan r2): a Tier C row needs a non-empty `rationale` and
  either `replacement: spec/sql/<file>.ts :: <title>` (the file must exist and
  contain that title) or `replacement: none` with a non-empty `client_impact`.
  Test-level Tier C rows count against the budget below.
- **Pin-bump audit**: a commit that bumps `upstream/PINNED_SHA` while spec
  hashes change must also change this file (same commit).

TIER_C_BUDGET: 2

| file | title | kind | tier | rationale | replacement | client_impact |
| --- | --- | --- | --- | --- | --- | --- |
| spec/helper/MongoDB.spec.ts | — | helper | C | Mocha before/after helper that boots a mongodb-memory-server instance; content-replaced by an in-memory SQLite fixture helper, path preserved because spec/book.spec.ts imports it | none | Port tests boot an in-memory SQLite database instead of a Mongo memory server; no client-facing change. |
| spec/book.spec.ts | should save all transactions in bulk and mitigate mongodb 'insertedIds' bug | test | C | Exercises forceServerObjectId `_id` backfill during Mongo bulk insert (Entry.ts:144-158), which is unreachable in the SQL adapter; SQL-native replacement planned as G2 in [ITD-96](/ITD/issues/ITD-96) | none | Client code relying on bulk-insert `_id` backfill gets SQLite-generated 24-hex ObjectIds instead; the public API shape (journal with ids) is preserved. |
| spec/setTransactionSchema.spec.ts | should return full ledger with _journal2 | test | C | Relies on the Mongo `_journal2` field name in the raw transaction document; quarantined in whole, SQL-native replacement mandatory | none | Raw transaction documents expose the SQL column name instead of `_journal2`; documented in the type-parity notes owned by [ITD-97](/ITD/issues/ITD-97). |

<!--
Remaining rows are owned by [ITD-95](/ITD/issues/ITD-95) (test harness): 134
A/B test-level rows for the it()s at the pinned SHA (136 total minus the 2 Tier
C rows above) plus file-level rows for the remaining spec files.
-->
