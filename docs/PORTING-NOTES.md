# Porting notes — scaffold (ITD-90)

Decisions, limitations, and gotchas established while standing up the
medici-sql scaffold. Supersedes nothing; where a later ticket (ITD-91+)
changes behavior, update this file in the same commit.

## Version pins (QA S11)

Pinned and measured by the ITD-89 spike (`spike/FINDINGS.md`):

| Package                        | Version  | Note                                                              |
| ------------------------------ | -------- | ----------------------------------------------------------------- |
| prisma / @prisma/client        | 7.10.0   | exact pins in `package.json`                                      |
| @prisma/adapter-better-sqlite3 | 7.10.0   | the only SQLite path in Prisma 7                                  |
| @prisma/client-runtime-utils   | 7.10.0   | required at runtime by the generated client (`runtime/client.js`) |
| better-sqlite3                 | 13.0.3   | bundles **SQLite 3.53.4**                                         |
| bson                           | 7.3.3    | the only package we take from the mongo ecosystem                 |
| node (measured)                | v24.14.0 | engines `>=20`                                                    |

SQLite ≥ 3.43 `SUM` uses Kahan–Babuška–Neumaier extended-precision
accumulation, which is **not bit-identical to JS left-to-right addition**.
`fpPrecision.spec.ts` passes either way today, but this divergence is a
known quantity and must stay one — hence the pins.

## Prisma 7 architecture facts (measured, spike)

- The Rust query engine and `?pragma=` connection-string params are gone.
  `url` is not allowed in `schema.prisma` (P1012); the CLI reads
  `prisma.config.ts`, the runtime gets its URL from the driver adapter.
- **Generator choice (deviation from the spike's checklist):** we use the
  legacy `prisma-client-js` generator, not the new `prisma-client` (TS)
  generator. The new generator emits TypeScript with `import.meta` (ESM);
  the package must stay CommonJS (`require("medici-sql")` is part of the
  client contract), so the CJS JS+`d.ts` output of `prisma-client-js` is
  the correct shape. Runtime requirements are identical for both
  generators: a driver adapter (`@prisma/adapter-better-sqlite3`) is
  mandatory — `new PrismaClient()` with no adapter throws.
- Generated client lands in `src/generated/` (gitignored). `build:node`
  copies it into `build/generated/` via `scripts/copy-prisma-client.mjs`
  (tsc does not emit `.js` inputs). The Node runtime uses the embedded
  base64 wasm; the raw `.wasm` ships only for edge workers.
- The adapter sets `defaultSafeIntegers(true)`: **raw `$queryRaw` /
  `$executeRaw` integers come back as `BigInt`**. Map with `Number()` at
  the read site (the scaffold spec pins this behavior).

## Pragma strategy (spike section b)

- `PRAGMA journal_mode=WAL` — once at bootstrap; persistent on the file,
  sticky per live connection.
- `PRAGMA synchronous=NORMAL` — **per connection**, re-applied on every
  connect (see `connectPrisma()` in `src/database/client.ts`).
- `busy_timeout` — the adapter `timeout` option
  (`ADAPTER_TIMEOUT_MS = 5000`); there is no SQL path to it in Prisma 7.
- In-memory databases: WAL is skipped (journal mode stays `memory`).

## Database bootstrap

- `src/database/client.ts`: lazily-constructed singleton. **Module-load
  purity (QA S3):** importing it constructs nothing and touches no file
  system; the client exists after the first `getPrismaClient()` and
  pragmas apply via `connectPrisma()`.
- URL: `MEDICI_SQL_DATABASE_URL` env, defaulting to `medici-sql.db` under
  the repo root. Tests select `file::memory:` (QA S1: the harness must
  start from a guaranteed-empty database — an in-memory database or a
  freshly reset file both satisfy this).
- Programmatic reset: `resetDatabase()` / `createSchema()` in
  `src/database/schema.ts` execute the embedded DDL (generated from
  `prisma/schema.prisma`) — no shelling out to the Prisma CLI, no file
  reads at runtime. Keep the DDL in sync with `npm run db:sync-ddl` after
  any schema change.
- `npm run db:push` = `prisma db push` (works unattended).
  `npm run db:reset` = `prisma db push --force-reset`: Prisma 7 guards
  force-reset as a dangerous action — in an interactive terminal it asks
  for consent; unattended/CI runs abort instead of proceeding. The
  programmatic `resetDatabase()` is the unattended reset path.

## id sequence (ITD-89 amendment A, QA M3)

`medici_id_sequence` (single row: `seconds`, `counter`, 5-byte
`instance` fixed at database creation) is the DB-backed monotonic source
for **transaction** `_id`s, allocated inside the write transaction.
Journal / lock / balance `_id`s stay client-side (upstream generates
those client-side too; nothing orders on them).

- Cross-process bson `ObjectId`s are **not** monotonic within the same
  second (5-byte random prefix decides order — measured full inversion in
  2/10 rounds); the sequence design restores allocation-order ==
  id-order.
- **Allocation order is not commit order** (a transaction allocating
  earlier may commit later). Upstream has the identical hazard with
  server-assigned Mongo ids; we match that guarantee level, not exceed it.
- Counter overflow needs >16.7M ids in one second — documented bound, not
  engineered around.
- The allocation code lands with compat core C (ITD-102,
  `src/database/idSequence.ts`); the table exists and is seeded from the
  scaffold stage.

## Balance `key` is hex-encoded (QA M9)

`hashKey()` returns 20 chars of arbitrary U+0000…U+00FF (latin1); ~7.7%
of sha1 digests contain a `0x00` byte and SQLite string functions
truncate at NUL. `medici_balances.key` stores the digest
**hex-encoded** (40 chars); encode/decode lives in the collection adapter
(ITD-93) so `hashKey()` itself stays byte-identical to upstream.
`rawKey` is plain text and stays TEXT as-is.

## TTL indexes are documented no-ops

Upstream declares `expireAfterSeconds` on `lock.updatedAt` (86400 s) and
`balance.expireAt` (0). No test in the spec suite depends on TTL expiry
firing, so the port keeps the `updatedAt` / `expireAt` columns, builds
no sweeper, and creates no TTL indexes. Expired lock rows and balance
snapshots are never garbage-collected; `getBestBalanceSnapshot` filters
by `expireAt` in queries. (To be restated in the docs ticket.)

## `account_path` denormalization limit

`account_path` (upstream `string[]`) is stored as TEXT JSON plus
denormalized `account_path_0/1/2` columns so the filters emitted by
`parseAccountField` (`account_path.0/.1/.2`) become plain indexed column
predicates. `maxAccountPath` defaults to 3. **If a caller raises
`maxAccountPath`, path segments beyond index 2 must fall back to a JSON
predicate** — the adapter (ITD-92/93) must implement that fallback
explicitly; do not silently drop deeper segments.

## nycrc: check-coverage dropped (QA S2)

Upstream demanded 100% lines/statements/functions/branches with
`all: true`. Unsatifiable in the port: `Entry.ts:144-158` (the
`insertedIds` re-find) is permanently unreachable in the SQL adapter
inside a file that must stay byte-identical. Coverage **reporting** is
kept; the coverage gate is removed. Also dropped:
`USE_MEMORY_REPL_SET=true` from `test:coverage` (there is no Mongo
replica set to select).

## Module aliasing and packaging (QA M10/M16)

`"mongoose"` (and the type-only `"mongodb"` import in `IOptions.ts`)
resolve to `src/compat/mongoose.ts` / `src/compat/mongodb.ts` via
`tsconfig` `paths`. tsc does not rewrite module specifiers, so
`build:node` runs **tsc-alias** after tsc (`-p tsconfig.json` — the
directory form `-p .` is rejected by tsc-alias's tsconfig loader) and
rewrites the emitted `require("mongoose")` to relative
`require("./compat/mongoose.js")`. `dts-bundle-generator` gets the same
`paths` so the bundled `.d.ts` inlines the compat types. **No module
named `mongoose` is shipped or depended on** — verified by the ITD-90
packaging probe (`npm pack` → install with no mongoose → require
`build/Book.js`, whose first line imports `{ Types } from "mongoose"`).

`src/compat/mongoose.ts` is a **placeholder stub** at this stage: just
enough typed surface for the verbatim files to compile. ITD-91 replaces
it with the real compat core.

## Transaction strategy for ITD-91 (spike sections a, c, d)

- `prisma.$transaction` (interactive) survives N=18 (measured N=128)
  concurrent callers: the adapter wraps every interactive transaction in
  an in-process async mutex on one connection, so in-process contention
  cannot occur.
- In-process failure mode: P2028 start-queue timeout when
  callback-duration × queue-position exceeds `maxWait` (default 2000 ms).
  Raise `maxWait`/`timeout` per call for slow callbacks.
- No `BEGIN IMMEDIATE` through Prisma (P2010); transactions start
  DEFERRED. Cross-process write contention is handled by the adapter
  busy-timeout plus the retry wrapper: retry P2028 "Unable to start a
  transaction" and cause-`SQLITE_BUSY`/`SQLITE_LOCKED` only; never
  constraint errors (P2002 may mean a previous attempt committed);
  exponential backoff + jitter, ≤5 attempts; **regenerate the entry's and
  journal's ObjectIds inside the callback on every attempt**.
- Inside a transaction callback use only the `tx` client: the single
  connection makes background outer-client calls piggyback on the open
  transaction.
- `aggregate` over an empty match returns `{ _sum: {...nulls}, _count: 0
}` — map `_count === 0` to "no row" (Book.ts:129 guards on the row).

## Transaction boundary as implemented (compat core C, ITD-102)

Public surface (all additive, `src/index.ts`): `connection`
(`MediciConnection`), `ClientSession`, `mongoTransaction` (public alias
for `connection.transaction` — the upstream name is kept because the
xacid spec imports it by that name), and the database-layer errors
`SessionClosedError` / `TransactionIdReuseError` (`src/database/errors.ts`
— `src/errors/` stays verbatim; ITD-91's `UnsupportedMongoOperationError`
is the only addition there so far).

### `connection.transaction(fn, options)`

- Wraps `prisma.$transaction` (interactive) in a retry loop
  (`runWithRetry`, `src/database/transaction.ts`). The session's client is
  the interactive `tx` client itself: `ItxClient` =
  `Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$use" | "$extends">`
  (the callback param type in Prisma 7; a full `PrismaClient` is
  assignable to it). The session is closed in a `finally` — callbacks
  never manage lifetime.
- `options` (loose `IAnyObject`, unknown keys ignored): `maxWait` /
  `timeout` pass through to Prisma; `retries` (default 5 total attempts;
  `retries: 0` = exactly one attempt), `retryBaseDelayMs` (50),
  `retryMaxDelayMs` (2000). Backoff: `min(cap, base * 2^(attempt-1))`
  × uniform 0.5–1.5 jitter.
- **Retriable:** P2028 _with_ the "Unable to start a transaction" message
  (in-process start-queue timeout), any error whose
  `cause.originalCode` is `SQLITE_BUSY`/`SQLITE_LOCKED` (cross-process
  write contention), or `cause.kind === "SocketTimeout"`. **Never
  retried:** constraint errors (P2002/P2010, `SQLITE_CONSTRAINT*`) — a
  unique violation on attempt 1 is a legitimate user error, and one on a
  later attempt means the previous attempt committed.
- **S6:** a unique-constraint error on attempt ≥ 2 is rethrown as
  `TransactionIdReuseError` with `cause` = the original Prisma error, so
  callers can distinguish id reuse across a retry from a first-attempt
  constraint hit (which surfaces raw). Both unique shapes are classified:
  model-API writes fail as **P2002**; raw SQL as **P2010** with
  `cause.originalCode = SQLITE_CONSTRAINT_PRIMARYKEY` and
  `cause.kind = "UniqueConstraintViolation"` (measured, WAL mode).
- Non-retriable or exhausted → the original error is rethrown unchanged.

### S4 — closing the session

No Proxy: `session.close()` flips a flag. `session.client` after close
throws `SessionClosedError` (the interactive client is dead anyway —
Prisma rejects post-`$disconnect` use — but the flag makes the failure
immediate and named); `allocateTransactionIds` on a closed session throws
`SessionClosedError` before touching the client.

### M3 — id allocation as implemented

`allocateTransactionIds` runs on the session's tx client (the sequence
advance commits/rolls back with the caller); session-less writes through
`SqlCollection.insertMany` allocate inside a dedicated
`prisma.$transaction`. Read-modify-write of `medici_id_sequence` row 1,
inside the write transaction. Id layout: 4-byte seconds BE | 5-byte
instance | 3-byte counter BE (24 hex chars). The counter is 0-based per
second: the first allocation of a second sets the row to `count - 1`
(ids carry counters 0..count-1), later allocations in the same second
advance it by `count`, a new second resets it. Clock skew is not handled
(single-writer assumption, matching upstream's server clock).

### `SqlCollection` — interim scope

`connection.collection(name)` and `connection.db.collection(name)` return
the adapter over the four Prisma models. In this ticket:
`insertOne`/`insertMany` (auto M3 allocation for `medici_transactions`
docs without `_id` — all-or-none per batch), `updateOne` for the
`medici_locks` upsert shape only (`upsert` + `$inc __v`; other
collections throw `notYetImplemented`), `find`/`findOne`/
`countDocuments`/`deleteOne`/`deleteMany`. `aggregate`/`distinct` throw
`notYetImplemented` (the query surface lands in ITD-101; collection
semantics in ITD-93). Ids are 24-char lowercase-hex strings end to end;
the bson `ObjectId` boundary is ITD-91's `Types.ObjectId`.

### d.ts: the generated Prisma client stays out of public types

`ClientSession.client` is typed `PrismaClientView` (structural: the five
model delegates as `any` plus the two raw-query methods) — deliberately
NOT `PrismaClient`/`ItxClient`. Measured: bundling the generated
multi-file Prisma client d.ts into `types/index.d.ts` breaks
`dts-bundle-generator` (unresolvable `$Utils`/`$Extensions`/`$Result`/
`$Public`/`runtime` namespaces) and collides with Prisma's own
`ClientSession` type name. The view keeps `types/index.d.ts` small and
self-contained; per-collection argument/result shapes are enforced at
runtime by the adapter layer (same trade-off as the Prisma delegate
unions in `SqlCollection.delegate`).

Related: `src/compat/mongoose.ts` is the tsconfig-`paths` target of
`"mongoose"`, and the verbatim upstream surface (IOptions.ts, models/,
helper/) imports `ClientSession` from it. That placeholder
(`type ClientSession = any`) now re-exports the real
`database/session` class, so the verbatim imports stay type-correct and
the bundle carries a single `ClientSession` declaration.

## ObjectId storage

24-char **lowercase-hex TEXT** (`@map("_id")`): lexicographic order ==
byte order == time order (verified at the `…000f` vs `…0010` boundary).
Never compare ids numerically (float64 collision on 24 hex chars).
`bson` 7.x `getTimestamp()` returns a `Date`, not seconds.

## Repo conventions

- Verbatim upstream files (see `upstream/VERBATIM_FILES.txt`) are excluded
  from `prettier` because the drift monitor diffs them byte-for-byte and
  one upstream file at the pinned SHA is not prettier-clean.
- Commit messages end with exactly
  `Co-Authored-By: Paperclip <noreply@paperclip.ing>`.

## Filter translation (ITD-92)

`src/database/filterTranslator.ts` converts the Mongo-shaped filters
`parseFilterQuery` / `parseBalanceQuery` emit into parameterized SQLite
`WHERE` fragments: `translateFilter(filter, { collection }) → { where,
params }` (`where` is `""` for an empty filter; `?` placeholders; params in
order of appearance). ITD-93 executes them via `$queryRawUnsafe`. The full
operator surface, the object-valued-`meta` rule (JSON deep equality, QA
M13/G7), value coercion, and limitations are specified in
`docs/SUPPORTED_OPERATIONS.md`.

Measured facts the translator relies on (SQLite 3.53.4 via
better-sqlite3 13.0.3):

- `DateTime` columns are stored as TEXT
  `YYYY-MM-DDTHH:MM:SS.mmm+00:00` (verified against rows written through
  `prisma.transaction.create`). The translator emits date parameters in
  that exact format; `Date` objects must never be passed as
  `$queryRawUnsafe` parameters (the adapter serializes them as `BigInt`
  and fails), and a `Z`-suffixed parameter would break boundary
  comparisons (`"…+00:00" < "…Z"` lexicographically at the same instant).
- `json_object_length` does **not exist** in the bundled SQLite.
- `json`, `json_type`, `json_array_length`, and `json_extract` are strict:
  they throw on a bare (non-JSON) string. The translator emits flat,
  unguarded paths because a `json_extract` result is always valid JSON
  text or `NULL`, so the strict functions can never see a bare string.
- JSON path syntax: object keys join with dots, array indexes must be
  bracketed (`$.tags[0]`); bracket _string_ keys (`$.["a"]`) are rejected
  by SQLite, and a dot-digit on an object is a key lookup — hence all-digit
  meta path segments take the array-index form.
