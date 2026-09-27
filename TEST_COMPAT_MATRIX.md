# Test compatibility matrix

Classifies every vendored upstream spec file and test (upstream pin 54fa40b, medici v7.3.0-1-g54fa40b — see `spec/UPSTREAM_PROVENANCE.json`) as Tier A, B, or C per ITD-88 plan r2 section 2 and the QA amendments on ITD-100. **Tier A** = client-facing, passes unmodified. **Tier B** = client-facing, passes via the compat shim (the shim part is named in the rationale). **Tier C** = Mongo-internals only; quarantined per-test by `test/mocha-setup.ts` with rationale + `replacement`/`client_impact` below.

Titles are the runtime (mocha) test titles — for loop-generated `it()`s (spec/handleVoidMemo.spec.ts) there is one row per runtime case. `kind` vocabulary: `spec` / `fixture` / `bootstrap` / `type-test` / `script`. A file-level row has title `—`. Any upstream spec file or test not listed is **unclassified** and fails the drift check (ITD-98) — the runtime suite-shape guard (test/mocha-setup.ts) enforces the same invariant on every `npm run test:code` run.

TIER_C_BUDGET: 2

| file | title | kind | tier | rationale | replacement | client_impact |
| --- | --- | --- | --- | --- | --- | --- |
| spec/balance.spec.ts | — | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. 1 of 9 tests is Tier B (row below). |  |  |
| spec/balance.spec.ts | should find snapshot | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/balance.spec.ts | should return proper number of notes | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/balance.spec.ts | should not confuse snapshots | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/balance.spec.ts | should not confuse snapshots - reverse querying | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/balance.spec.ts | should snapshot with mongodb query language | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/balance.spec.ts | should ignore the order of doc insertion | spec | B | Tier B (QA-pinned, ITD-100 amendment): touches no MongoDB internals — findOne/.sort("-_id")/.exec()/toObject()/deleteOne()/create()/collection.deleteMany, all implemented by ITD-91/101/93. Only test asserting a correct balance when _id order diverges from insertion order — the port's sharpest edge; kept unmodified. | — | — |
| spec/balance.spec.ts | should find snapshot by account | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/balance.spec.ts | should find snapshot with custom attribute | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/balance.spec.ts | should find snapshot with custom attribute and meta | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | — | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. 1 of 56 tests is Tier C (row below). |  |  |
| spec/book.spec.ts | should throw an error when name of book is not a string | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should throw an error when name of book is empty string | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should throw an error when name of book is a string with only whitespace | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should throw an error when maxAccountPath of book is a fraction | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should throw an error when maxAccountPath of book is a negative number | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should throw an error when maxAccountPath of book is not a number | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should throw an error when precision of book is a fraction | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should throw an error when precision of book is a negative number | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should throw an error when precision of book is not a number | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should throw an error when balanceSnapshotSec of book is not a number | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should throw an error when balanceSnapshotSec of book is a negative number | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should throw an error when expireBalanceSnapshotSec of book is not a number | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should throw an error when expireBalanceSnapshotSec of book is a negative number | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should error when trying to use an account with more than three parts | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should allow more than 4 subaccounts of third level | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should let you create and query a basic transaction | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should let you use strings for amounts | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should allow meta querying using mongodb query language | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should let you use string for original journal | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should throw INVALID_JOURNAL if an entry total is !=0 and <0 | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should throw INVALID_JOURNAL if an entry total is !=0 and >0 | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should handle extra data when creating an Entry | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should save all transactions in bulk and mitigate mongodb 'insertedIds' bug | spec | C | Asserts the raw `insertMany` options (`forceServerObjectId: true, ordered: true`) the Mongo driver receives — a Mongo driver internal that does not exist in the port. `forceServerObjectId: true` is not a driver workaround: it is how upstream gets globally monotonic server-side _ids (src/Entry.ts:57, src/Entry.ts:130). This is the only test in the suite pinning the id-generation architecture; in the port _ids come from the DB-backed medici_id_sequence (plan r2) and src/Entry.ts:144-158 becomes unreachable code. | none | Global id monotonicity is guaranteed by medici_id_sequence inside the write transaction instead of server-side ObjectId generation. SQL-native replacement covering concurrent writers required in ITD-96 (spec/sql/); until it exists this row is `none`. |
| spec/book.spec.ts | should give you the balance | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should give you the balance with partial meta queries | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should give you the balance without providing the account | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should give you the total balance for multiple accounts | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should reuse the snapshot balance | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should reuse the snapshot balance when meta is in the query | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should create only one snapshot document | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should create periodic balance snapshot document | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should not do balance snapshots if turned off | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should reuse the snapshot balance in multi account query | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should deal with JavaScript rounding weirdness | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should have updated the balance for assets and income and accurately give balance for subaccounts | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should throw an JournalNotFoundError if journal does not exist | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should throw an JournalNotFoundError if journal does not exist in book | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should allow you to void a journal entry | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should throw an error if journal was already voided | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should create the correct memo fields when reason is given | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should create the correct memo fields when reason was not given | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should void string journal IDs | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should have balance unchanged immediately after event date, when voiding event | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should have balance changed immediately after event date, when void journal keeps date of original journal | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should list all accounts | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should list accounts with 1 and 3 path parts | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should sort accounts alphabetically | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should not do listAccounts snapshots if turned off | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should return full ledger | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should return full ledger with hydrated objects when lean is not set | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should return full ledger with just ObjectId of the _journal attribute | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should return ledger with array of accounts | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should give you a paginated ledger when requested | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should give you a paginated ledger when requested and start by page 1 if page is not defined | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should give you a paginated ledger when requested and start by page 1 if page is defined | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/book.spec.ts | should retrieve transactions by time range | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/constructKey.spec.ts | — | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. |  |  |
| spec/constructKey.spec.ts | should handle empty account and meta | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/constructKey.spec.ts | should handle empty meta | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/constructKey.spec.ts | should handle meta with same keys but different order | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/extractObjectIdKeysFromSchema.spec.ts | — | spec | B | Tier A — client-facing, runs unmodified against the Prisma port. |  |  |
| spec/extractObjectIdKeysFromSchema.spec.ts | should get an array of the ObjectId-fields | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/fpPrecision.spec.ts | — | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. Contains two it()s with the identical title `should store a commit without errors` — two rows below. |  |  |
| spec/fpPrecision.spec.ts | should store a commit without errors | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/fpPrecision.spec.ts | should store a commit without errors | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/fpPrecision.spec.ts | should store a journal without error | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/handleVoidMemo.spec.ts | — | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. Six it()s generated by a loop over the `cases` array — one row per runtime case title (static `it()` count is 1; known limitation of the drift monitor's title extractor, see ITD-95 tally comment). |  |  |
| spec/handleVoidMemo.spec.ts | should passthrough reason | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/handleVoidMemo.spec.ts | should handle no specially tagged memo when no reason was provided | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/handleVoidMemo.spec.ts | should handle unvoiding | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/handleVoidMemo.spec.ts | should handle revoiding | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/handleVoidMemo.spec.ts | should handle unvoiding a revoided memo | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/handleVoidMemo.spec.ts | should handle no reason and no memo | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/parseBalanceQuery.spec.ts | — | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. |  |  |
| spec/parseBalanceQuery.spec.ts | should handle empty object and book name correctly | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/parseBalanceQuery.spec.ts | should put _journal string as string to meta | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/parseBalanceQuery.spec.ts | should put _journal ObjectId as ObjectId to meta | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/parseBalanceQuery.spec.ts | should handle start_date correctly | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/parseBalanceQuery.spec.ts | should handle end_date correctly | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/parseBalanceQuery.spec.ts | should handle start_date and end_date correctly | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/parseBalanceQuery.spec.ts | should handle start_tx_id correctly | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/parseBalanceQuery.spec.ts | should handle end_tx_id correctly | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/parseBalanceQuery.spec.ts | should handle start_tx_id and end_tx_id correctly | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/parseBalanceQuery.spec.ts | should handle start_tx_id, end_tx_id together with date range correctly | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/parseBalanceQuery.spec.ts | should not set _id when neither start_tx_id nor end_tx_id are provided | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/parseBalanceQuery.spec.ts | should handle meta correctly | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/parseBalanceQuery.spec.ts | should handle account with one path part correctly | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/parseBalanceQuery.spec.ts | should handle account with two path parts correctly | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/parseBalanceQuery.spec.ts | should handle account with two path parts and maxAccountPath = 2 correctly | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/parseBalanceQuery.spec.ts | should handle account with three path parts correctly | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/parseBalanceQuery.spec.ts | should handle account array with one path part correctly | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/parseBalanceQuery.spec.ts | should handle account array with two path parts correctly | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/parseBalanceQuery.spec.ts | should handle account array with three path parts correctly | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/parseBalanceQuery.spec.ts | should handle account array with one item and two path parts correctly | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/parseBalanceQuery.spec.ts | should handle account array with one item and three path parts correctly | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/parseBalanceQuery.spec.ts | should handle potential prototype injection correctly | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/parseDateField.spec.ts | — | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. |  |  |
| spec/parseDateField.spec.ts | should passthrough Date-Objects | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/parseDateField.spec.ts | should handle numbers as unix timestamps | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/parseDateField.spec.ts | should handle strings of numbers as unix timestamps | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/parseDateField.spec.ts | should handle strings which are not pure numbers gracefully | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/parseDateField.spec.ts | should handle moment.js, luxon and similar libraries | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/parseDateField.spec.ts | should return undefined if it is not parsable | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/parseFilterQuery.spec.ts | — | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. |  |  |
| spec/parseFilterQuery.spec.ts | should handle empty object and book name correctly | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/parseFilterQuery.spec.ts | should handle _journal string correctly | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/parseFilterQuery.spec.ts | should handle _journal ObjectId correctly | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/parseFilterQuery.spec.ts | should handle start_date correctly | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/parseFilterQuery.spec.ts | should handle end_date correctly | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/parseFilterQuery.spec.ts | should handle start_date and end_date correctly | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/parseFilterQuery.spec.ts | should handle meta correctly | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/parseFilterQuery.spec.ts | should handle account with one path part correctly | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/parseFilterQuery.spec.ts | should handle account with two path parts correctly | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/parseFilterQuery.spec.ts | should handle account with two path parts and maxAccountPath = 2 correctly | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/parseFilterQuery.spec.ts | should handle account with three path parts correctly | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/parseFilterQuery.spec.ts | should handle account array with one path part correctly | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/parseFilterQuery.spec.ts | should handle account array with two path parts correctly | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/parseFilterQuery.spec.ts | should handle account array with three path parts correctly | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/parseFilterQuery.spec.ts | should handle account array with one item and two path parts correctly | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/parseFilterQuery.spec.ts | should handle account array with one item and three path parts correctly | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/parseFilterQuery.spec.ts | should handle potential prototype injection correctly | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/safeSetKeyToMetaObject.spec.ts | — | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. |  |  |
| spec/safeSetKeyToMetaObject.spec.ts | should set a custom schema attribute | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/safeSetKeyToMetaObject.spec.ts | should set a meta attribute | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/safeSetKeyToMetaObject.spec.ts | should set custom and meta attributes | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/safeSetKeyToMetaObject.spec.ts | should not set prototype attributes | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/safeSetKeyToMetaObject.spec.ts | should not set original schema attributes | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/setTransactionSchema.spec.ts | — | spec | C | Its single it() is Tier C (test row below); the byte-identical file is quarantined whole — assertions cannot be dropped from a vendored file. | none | `setTransactionSchema` registration API is unchanged; Mongoose `diffIndexes` side effects are a no-op on the port by design (plan r2). SQL-native replacement required in ITD-96 (spec/sql/). |
| spec/setTransactionSchema.spec.ts | should return full ledger with _journal2 | spec | C | Asserts Mongoose `diffIndexes` internals (physical index-creation side effects of setTransactionSchema/syncIndexes), which the port makes a no-op by design (plan r2; SQLite indexes are declared in the Prisma schema). The byte-identical file cannot drop the assertions, so the whole it() is quarantined. | none | setTransactionSchema registration API is unchanged; clients relying on Mongoose index diffs see no error and no physical index diffing (Prisma schema declares the indexes). SQL-native replacement reproducing everything except the diffIndexes assertions required in ITD-96 (spec/sql/). |
| spec/xacid.spec.ts | — | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. Runs through the compat shim (`connection.transaction` / `ClientSession`, ITD-102). At this baseline the compat `connection` object lacks `transaction`, so all 12 fail until ITD-96 wires it (see ITD-95 tally comment). |  |  |
| spec/xacid.spec.ts | should not persist data when saving journal fails while using a session | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/xacid.spec.ts | check if mongoTransaction is working as an alias | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/xacid.spec.ts | should persist data while using a session | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/xacid.spec.ts | should not persist data if we throw an Error while using a session | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/xacid.spec.ts | should pass a stresstest when persisting data while using a session | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/xacid.spec.ts | should pass a stresstest when voiding while using a session | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/xacid.spec.ts | should pass a stresstest for erroring when committing | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/xacid.spec.ts | should pass a stresstest for erroring when voiding | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/xacid.spec.ts | should avoid double spending, commit() using writelockAccounts | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/xacid.spec.ts | should avoid double spending, commit() using writelockAccounts with a Regex | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/xacid.spec.ts | should avoid double spending, using book.writelockAccounts | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/xacid.spec.ts | should create correct locks | spec | A | Tier A — client-facing, runs unmodified against the Prisma port. | — | — |
| spec/index.spec.ts | — | bootstrap | A | Bootstrap entry point: byte-identical `import "./helper/MongoDB.spec";` — loads the (content-replaced, path-preserved) SQLite bootstrap. |  |  |
| spec/helper/MongoDB.spec.ts | — | bootstrap | C | Content replaced, path preserved (QA M1/R5). Load-bearing: spec/book.spec.ts:13 does `require("./helper/MongoDB.spec")` and spec/index.spec.ts imports it — deleting the path would MODULE_NOT_FOUND all 56 book tests. New content is the SQLite bootstrap: fresh in-memory DB + schema in root before (truncate once, QA S1), disconnect in root after. ACID_AVAILABLE is set from test/mocha-setup.ts (--require), never from this file (QA M11). | none | None — test-internal bootstrap. The SQL-native replacement is this file itself (same path). |
| spec/helper/delay.ts | — | fixture | A | Test helper (setTimeout promise); no database, no Mongo internals. |  |  |
| spec/helper/transactionSchema.ts | — | fixture | A | Fixture: builds the test `Schema` (custom `_journal2` ObjectId path + index) via the compat `Schema`/`Types` (ITD-91). Consumed by the Tier C setTransactionSchema test. |  |  |
| spec/types/medici.spec-d.ts | — | type-test | A | tsd type-test of the public surface (test:types); runtime no-op under mocha, type-checked separately. |  |  |
| npm run ci-mongoose5..9 | — | script | C | Upstream's Node/Mongoose version-compat matrix scripts; the port has no mongoose dependency (the compat shim is version-agnostic), so the scripts do not exist here. Accepted without reservation. | none | None — no client-facing behaviour is affected by the missing version-matrix scripts. |
