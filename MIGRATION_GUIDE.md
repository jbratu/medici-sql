# Migration guide — medici → medici-sql

This document answers "can I swap `medici-sql` in for `medici`, and what changes?" for code written against upstream [flash-oss/medici](https://github.com/flash-oss/medici) `v7.3.0-1-g54fa40b` (pin `54fa40b`). The data-access layer under the verbatim business logic is Prisma + SQLite; the public API is additive-only. Every behavioural claim below cites the test that pins it or the `file:line` that implements it.

## What we deliberately did NOT break

An earlier, unrelated conversion (`medici-sql-srp`, a TypeORM/SQLite attempt) broke the client contract. This port was specified against that failure mode; each break is checked off:

| `medici-sql-srp` broke | this port | evidence |
| --- | --- | --- |
| `_id` became an auto-increment integer | `_id` stays a BSON `ObjectId`, stored as a 24-char lowercase-hex `String`; lexicographic order of that hex string equals ObjectId byte order equals time order | `prisma/schema.prisma` (`id String @id @map("_id")` on all four models); ordering verified across byte boundaries in `spike/FINDINGS.md` ("ObjectId storage validation") and `spec/filterTranslator.sqlite.spec.ts` ("_id range across a byte boundary (QA G5)") |
| `mongoTransaction` renamed to `sqliteTransaction` | `mongoTransaction` keeps its name and wraps `connection.transaction` | `src/index.ts` (export); `spec/xacid.spec.ts` ("check if mongoTransaction is working as an alias"); `spec/transaction.spec.ts` ("mongoTransaction is the kept-name alias of connection.transaction") |
| `setTransactionSchema` / `setJournalSchema` / `setLockSchema` deleted | all exist with their original signatures | `src/models/transaction.ts:67`, `src/models/journal.ts:39`, `src/models/lock.ts:36` |
| `syncIndexes` deleted | exists, same signature (`options?: { background: boolean }`); near-inert — see below | `src/helper/syncIndexes.ts` |
| `initModels` deleted | exists, same signature (ensures schema + connected client) | `src/helper/initModels.ts`; `src/index.ts` (export) |
| mandatory `initializeDataSource()` init call | no init call is required. Importing the package performs no I/O; the first database operation connects and bootstraps the schema lazily. Pointing at a non-default database is the optional `connection.connect(url)` (or `MEDICI_SQL_DATABASE_URL`) | `spec/transaction.spec.ts` ("importing the module is pure: no client, no file (QA S3)", "connect(url?) is idempotent"); `src/database/schema.ts` (`ensureSchemaLazy`); `src/database/client.ts` (`databaseUrl`) |
| `IOptions` lost its Mongo keys | `IOptions` still accepts `readPreference`, `readConcern`, `hint`, `session` — the Mongo-flavoured ones are accepted and ignored | `src/IOptions.ts` (verbatim copy); `src/database/sqlCollection.ts:71` (`SqlCollectionOptions` — `session` plus an index signature the adapter never reads) |

The full additive surface (nothing renamed, nothing removed, plus `connection`, `ClientSession`, `UnsupportedMongoOperationError`, `SessionClosedError`, `TransactionIdReuseError`) is in `src/index.ts`.

## Behavioural differences you must know

### 1. TTL indexes are not enforced

Upstream declares two TTL indexes (upstream `v7.3.0-1-g54fa40b`):

- `medici_locks`: `{ updatedAt: 1 }` with `expireAfterSeconds: 60*60*24` — lock rows expire 24 h after their last write (upstream `src/models/lock.ts:31`).
- `medici_balances`: `{ expireAt: 1 }` with `expireAfterSeconds: 0` — balance snapshots expire at their `expireAt` timestamp, which by default is `createdAt + 48 h` (upstream `src/models/balance.ts:39`; `expireBalanceSnapshotSec` defaults to twice `balanceSnapshotSec`, 24 h).

This port keeps both columns (`updatedAt`, `expireAt`) but **has no sweeper** — nothing ever deletes from `medici_locks` or `medici_balances`. Consequences:

- Both tables grow without bound. **The operator owns cleanup.** Sample statements (double-quoted identifiers are SQLite/Prisma style):

  ```sql
  -- expire lock rows like upstream's 24 h TTL
  DELETE FROM medici_locks WHERE "updatedAt" < datetime('now', '-24 hours');

  -- expire balance snapshots like upstream's expireAt TTL
  DELETE FROM medici_balances WHERE "expireAt" < datetime('now');
  ```

- **Balance correctness is unaffected.** Snapshot selection picks the newest snapshot by `_id` with no `expireAt` filter (upstream `src/models/balance.ts:101-104`, verbatim copy in `src/models/balance.ts`), and snapshot freshness is enforced in JS (`createdAt + balanceSnapshotSec`, `src/Book.ts`). Stale-but-present rows are simply ignored once a newer snapshot exists. Pinned by `spec/balance.spec.ts` ("should find snapshot", "should not confuse snapshots").
- `spec/scaffold.spec.ts` and the table DDL pin the no-op: the TTL indexes are absent from `prisma/schema.prisma` (comments on `model Lock` and `model Balance` say so explicitly), and no test depends on expiry firing.

### 2. `_id` generation

Upstream lets MongoDB assign transaction `_id`s (`forceServerObjectId: true`): the id is allocated by the server **inside the write transaction**, which is what keeps `Book.balance` snapshot pagination monotonic. This port reproduces that guarantee without MongoDB:

- Transaction `_id`s are allocated from a **database-backed monotonic sequence** — `medici_id_sequence` (`id = seconds || instance || counter`, `instance` is 5 random bytes fixed at database creation) — **inside the write transaction** (`prisma/schema.prisma`, `model IdSequence`). Within one writer process transactions are serialized, so allocation order matches commit order. Pinned by `spec/transaction.spec.ts` ("allocates transaction ids from medici_id_sequence inside the write tx (QA M3)").
- Journal, lock, and balance `_id`s stay **client-generated** `bson` ObjectIds (24-char lowercase hex at write time).
- **Residual hazard — identical to upstream, not a regression:** allocation order is not commit order in general. A transaction that allocated an id earlier may commit later (for example after a retry re-allocation), so a larger `_id` is "newer" in the same sense upstream's is — no stronger, no weaker. Cross-*process* monotonicity within the same second is what the sequence exists for; `spike/FINDINGS.md` ("ObjectId storage validation") measures the failure mode it removes.
- Consequence for consumers: never compare `_id`s numerically (`parseInt`/`Number` on 24 hex chars collides — measured in the spike, "Number trap"). Compare them as strings.

### 3. Concurrency and retry semantics

SQLite is single-writer. The settings actually used (`src/database/client.ts`, `src/database/transaction.ts`):

- `PRAGMA journal_mode=WAL` — set once at bootstrap, persistent on the file (skipped for `:memory:`).
- `PRAGMA synchronous=NORMAL` — per connection, re-applied on every connect.
- `busy_timeout` = 5000 ms — the better-sqlite3 adapter `timeout` option (`ADAPTER_TIMEOUT_MS`, `src/database/client.ts:27`); in Prisma 7 there is no SQL path to it.
- Prisma interactive-transaction defaults `maxWait=2000` / `timeout=5000` ms, passable per call.

Under contention, `connection.transaction(fn, options?)` retries the callback:

- **Retriable** (attempt fully rolled back): `P2028` *with* the message "Unable to start a transaction" (start/queue timeout), and cross-connection contention whose `cause` is `SQLITE_BUSY` / `SQLITE_LOCKED` / `SocketTimeout` (surfaced as P2010/P1008 — matched on the cause, never the user-facing message).
- **Never retriable:** unique/PK violations (`P2002` / `SQLITE_CONSTRAINT`), `P2023` (bad isolation), and `P2028` with "Transaction already closed" (a use-after-commit code bug — fail fast).
- **Backoff:** exponential with jitter (base 50 ms, cap 2 s per sleep, factor 0.5–1.5), **max 5 attempts** by default (≈ ≤5 s total).
- **After retries are exhausted the original error is re-thrown** — not a wrapped one.

Citations: `src/database/transaction.ts` (`isRetriable`, `runWithRetry`, `DEFAULT_MAX_ATTEMPTS`); `spike/FINDINGS.md` sections (a) and (d) (measured, not inferred); `spec/transaction.spec.ts` — "retries a P2028 start-queue timeout and succeeds (retry-then-succeed under induced contention)", "rethrows the original error after exhausting retries", "classifies the spike's measured error shapes (isRetriable / isUniqueConstraintError)". The 18-way concurrent double-spend case is pinned twice: `spec/xacid.spec.ts:260-315` (upstream spec) and `spec/transaction.spec.ts` ("reproduces the xacid.spec.ts:260-315 double-spend shape at N=18, three runs").

**Retry safety is conditional — read this.** The callback is re-run on retry, and re-running is only safe if the `Entry` is constructed **inside** the callback, so its ObjectIds are regenerated on every attempt. If you build an `Entry` outside the callback and commit it inside, the second attempt re-inserts the same identifiers and hits a duplicate-`_id` violation. The port detects exactly that shape — a unique/PK violation on attempt ≥ 2 — and throws a **named `TransactionIdReuseError`** (with the original constraint violation attached as `cause`) instead of a raw `P2002`. Pinned by `spec/transaction.spec.ts` — "surfaces a named error when an outside-constructed id is reinserted on retry (QA S6)" and "retry core: named error on retry-time unique violation, original error on exhaustion (QA S6 unit)". To opt out of retrying, pass `{ retries: 0 }` (`parseTransactionOptions`, `src/database/transaction.ts`).

`connection.transaction` options (loose `IAnyObject`, unknown keys ignored): `maxWait`, `timeout`, `retries` / `maxAttempts` (0 disables retrying), `retryBaseDelayMs`, `retryMaxDelayMs`. A `ClientSession` used after its transaction finished **rejects** (never throws synchronously) with `SessionClosedError` — required because `Book.balance`'s background re-snapshot fires an unawaited promise carrying the caller's now-closed session (`src/Book.ts:165-186`). Pinned by `spec/transaction.spec.ts` ("a closed session rejects cleanly, never synchronously (QA S4, Book.ts:165-186 shape)").

Reads inside a write transaction see that transaction's own uncommitted writes (`spike/FINDINGS.md` (e), measured; `spec/transaction.spec.ts` "reads its own uncommitted writes inside a write transaction (xacid.spec.ts:249)").

### 4. Float summation

Balance summation happens **in SQL** — `SUM(credit - debit)` via the aggregate the adapter maps to raw SQL (the single supported pipeline, `docs/SUPPORTED_OPERATIONS.md`); rounding happens **in JS** at `src/Book.ts:130` (`parseFloat(result.balance.toFixed(this.precision))`, `precision` default 8). SQLite ≥ 3.43 accumulates `SUM` in extended precision (Kahan–Babuška–Neumaier), so results are **not bit-identical** to JS left-to-right addition. This is a known quantity, not a bug: the pinned stack exists to keep it one. Pinned versions: Prisma `7.10.0`, `@prisma/adapter-better-sqlite3` `7.10.0`, `better-sqlite3` `13.0.3` (**SQLite 3.53.4**), `bson` `7.3.3` (`package.json`; `docs/PORTING-NOTES.md` "Version pins (QA S11)", measured by the ITD-89 spike). `spec/fpPrecision.spec.ts` passes under the pinned stack.

### 5. Custom schema fields

A field added via `setTransactionSchema` that has **no** Prisma column on `medici_transactions` (i.e. is not one of the fixed columns) is:

- **written** into the `meta` JSON column, not its own column;
- **read back** as a **top-level** field on the transaction (callers see the same shape as upstream — no `t.meta.clientId` indirection);
- **filterable** — `book.balance({ account, clientId })` and `book.ledger({ clientId })` work on custom fields.

The split between column and meta is driven by `Schema.paths` (`defaultTransactionSchemaKeys` / `isValidTransactionKey`), and custom `Schema.Types.ObjectId` fields round-trip as `ObjectId`s including the `._id` self-reference (the port's `Types.ObjectId` is a subclass of `bson.ObjectId` with a `_id` getter returning itself — `src/compat/mongoose.ts:66`). Citations: `docs/PORTING-NOTES.md` ("Custom schema fields: write / read / filter rule (ITD-94, QA R4)"); `spec/setTransactionSchema.spec.ts` (custom-field round-trip incl. `_journal2._id` instanceof); `spec/balance.spec.ts` ("should snapshot with mongodb query language" — balance filtered by a custom field).

### 6. `readPreference` / `readConcern` / `hint` are inert

Single SQLite file, no secondaries, no replica set. The options are accepted by the type (`src/IOptions.ts`, verbatim) and by every adapter method (`SqlCollectionOptions` index signature, `src/database/sqlCollection.ts:71`) and then ignored. Upstream even defaults `readPreference` to `"secondaryPreferred"` when no session is given (`src/Book.ts:83`, verbatim) — that default happens here too and does nothing. `writeConcern: { w: 1, j: true }` (upstream `src/Entry.ts:133`, `src/models/balance.ts:94` when no session) is accepted and ignored as well.

### 7. `syncIndexes` / `diffIndexes` are near-inert

Prisma owns the DDL (`prisma/schema.prisma`, applied by `npm run db:push`). `syncIndexes({ background })` keeps its signature, validates that the schemas are present, and must not throw — it does not create or drop indexes. `diffIndexes()` returns the truthful minimal `{ toDrop: [], toCreate: [] }`. Add indexes via `prisma/schema.prisma` or raw SQL (see README → "Indexes"). Citations: `src/helper/syncIndexes.ts`, `src/compat/mongoose.ts` (`model.syncIndexes` / `diffIndexes`), `docs/PORTING-NOTES.md` ("Helper ports (ITD-94)").

### 8. Data migration from a live MongoDB deployment: not implemented

There is no `migrateFromMongoDB()` or equivalent in this port, and none is promised here. Moving an existing ledger to SQLite is the operator's job. What the port does make deliberately mechanical: the SQLite **table names are identical to the upstream collection names** (`medici_transactions`, `medici_journals`, `medici_locks`, `medici_balances` — `prisma/schema.prisma` `@@map`s), the `_id`s are the same 24-char lowercase hex strings, and the column set mirrors the document fields. A future exporter can map field-for-field.

## Storage layout (what is actually on disk)

- **`_id`** on all four tables: 24-char lowercase-hex `TEXT`, primary key. Transaction ids come from `medici_id_sequence` (above); the rest are client-generated `bson` ids.
- **`medici_transactions`**: `credit`/`debit` REAL, `meta` nullable JSON `TEXT`, `account_path` JSON `TEXT` **plus** the first three segments denormalized into indexed columns `account_path_0/1/2` (so the `account_path.N` filters Medici emits become plain column predicates). Filters for `account_path.N` with `N ≥ 3` (only if you raised `maxAccountPath`) fall back to an unindexed `json_extract` predicate — `src/database/filterTranslator.ts`, documented in `docs/SUPPORTED_OPERATIONS.md` ("account_path.N").
- **`medici_journals`**: `_transactions` is a JSON `TEXT` array of 24-char hex id strings.
- **`medici_locks`**: unique on `(account, book)`; `__v` counter.
- **`medici_balances`**: `key` is **hex-encoded `TEXT`** (40 hex chars) while `hashKey()` itself still returns the raw latin1 20-byte digest — roughly 7.7% of SHA-1 digests contain a `0x00` byte and SQLite string functions truncate at NUL, so the digest is hex-encoded at rest (`prisma/schema.prisma` `model Balance`; `spike/FINDINGS.md` "NUL round-trip"). The raw digest is kept in `rawKey` for DX. If you read these tables directly or plan a migration, decode `key` from hex and expect `rawKey` to be latin1, not UTF-8.
- **Dates** are stored as `YYYY-MM-DDTHH:MM:SS.mmm+00:00` `TEXT`; lexicographic comparison equals chronological comparison (`docs/SUPPORTED_OPERATIONS.md` "Value coercion").
- `medici_balances.meta` is a JSON *string* (the `JSON.stringify` of the query's meta object), not structured JSON — `spec/book.spec.ts:373` asserts the exact stored text.
- `spec/scaffold.spec.ts` pins the full table/column set.

## Coverage note

`.nycrc` no longer sets `check-coverage`. Upstream demanded 100 % lines/statements/functions/branches, which is unsatisfiable here: `src/Entry.ts:144-158` (the `forceServerObjectId` insertedIds re-find) is permanently unreachable in the SQL adapter — the adapter always returns real client-side ids — and `Entry.ts` must stay byte-identical to upstream. The reason is documented in `docs/PORTING-NOTES.md` ("nycrc: check-coverage dropped (QA S2)"); coverage is still reported by `npm run test:coverage`.
