# Porting notes — scaffold (ITD-90)

Decisions, limitations, and gotchas established while standing up the
medici-sql scaffold. Supersedes nothing; where a later ticket (ITD-91+)
changes behavior, update this file in the same commit.

## Version pins (QA S11)

Pinned and measured by the ITD-89 spike (`spike/FINDINGS.md`):

| Package | Version | Note |
| --- | --- | --- |
| prisma / @prisma/client | 7.10.0 | exact pins in `package.json` |
| @prisma/adapter-better-sqlite3 | 7.10.0 | the only SQLite path in Prisma 7 |
| @prisma/client-runtime-utils | 7.10.0 | required at runtime by the generated client (`runtime/client.js`) |
| better-sqlite3 | 13.0.3 | bundles **SQLite 3.53.4** |
| bson | 7.3.3 | the only package we take from the mongo ecosystem |
| node (measured) | v24.14.0 | engines `>=20` |

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
- The allocation code lands with the compat core (ITD-91); the table
  exists and is seeded from the scaffold stage.

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
