# ITD-89 Findings — Prisma + SQLite concurrency and transaction semantics

Spike for the greenfield API-compatible SQL port of medici ([ITD-88](/ITD/issues/ITD-88), [ITD-89](/ITD/issues/ITD-89)).
Harnesses live in `spike/itd89/` (throwaway); measured outputs in `spike/itd89/results/h1..h6-adapter.txt`.
Every number below was measured in this spike, not inferred.

**Environment (pin these):** prisma 7.10.0, @prisma/client 7.10.0, @prisma/adapter-better-sqlite3 7.10.0,
better-sqlite3 13.0.3 (bundles **SQLite 3.53.4** ≥ 3.43 required for extended-precision SUM per plan),
bson 7.3.3, node v24.14.0.

**Prisma 7 architecture fact (measured, changes the plan's assumption):** the Rust query engine and the
`?pragma=` connection-string feature are gone. `url` is no longer allowed in `schema.prisma` for either
generator (P1012); generated clients for **both** `prisma-client` and legacy `prisma-client-js` **require a
driver adapter at runtime** (`new PrismaClient()` with no adapter throws; documented dead-end in
`spike/itd89/engine/`). There is exactly one SQLite path in Prisma 7: `@prisma/adapter-better-sqlite3` +
better-sqlite3. Use the `prisma-client` generator; its output is TypeScript, so the scaffold needs a TS
toolchain (tsx/tsc) to run the client.

## (a) Does `prisma.$transaction` survive N=18 concurrent callers?

**Yes — with fast callbacks it survives N=18 *and* N=128 with zero errors; with slow callbacks it degrades
by design (P2028 start-timeout), tunable per call.**

Mechanism (source + measured): the adapter opens **one** better-sqlite3 connection per PrismaClient and
wraps every interactive transaction in an **in-process async mutex** (`startTransaction` →
`#mutex.acquire()` → plain `BEGIN`; commit/rollback release). Concurrent in-process transactions are fully
serialized by that mutex — **SQLite lock contention cannot occur within one process**; there is no
interleaving, no SQLITE_BUSY, no "Transaction already closed", no lost updates.

Measured (`results/h1-adapter.txt`):

| Scenario | Result |
|---|---|
| N=18 vanilla (insert → upsert-increment → aggregate read) | **18/18 ok, 131 ms wall, final aggregate exact, lock `__v`=18, 0 errors** |
| N ladder 1/2/4/8/18/32/64/128, fast txns | all pass, ~5.0–6.2 ms/txn serialized (N=128: 649 ms), aggregates exact at every N |
| 18-way xacid double-spend fidelity (seed +2, 18 spend −1 with in-txn balance check) | **ok=2, notEnoughBalance=16, finalIncome=0, lock `__v`=2** — exactly the upstream spec outcome (`results/h2-adapter.txt`) |

Failure mode and break point: interactive-txn defaults are `maxWait=2000ms` (time to *start*, includes the
in-process queue wait) and `timeout=5000ms` (callback+commit after BEGIN). If callbacks do in-txn work of
duration D, queue position k waits ≈ k·D; callers whose queue wait exceeds maxWait are rejected with
`PrismaClientKnownRequestError` **P2028** "Unable to start a transaction in the given time." Measured
(slow-writer, defaults): delay=250 ms → **8/18 ok, 10×P2028**; 400 ms → 5/18; 700 ms → 3/18.
With `{maxWait:60000, timeout:60000}` and delay=400 ms → **18/18 ok (7335 ms wall)**. So
**N_effective ≈ maxWait / D** — not a hard concurrency limit, a tunable one (per-call opts or global
`transactionOptions`). Losers roll back atomically (final aggregate == ok count in every run).
"Transaction already closed" (same P2028 code, different message) occurs only on use-after-commit — a code
bug, not contention (see (d)).

## (b) journal_mode / busy_timeout / synchronous — how to set through Prisma

- **`?pragma=` URL params: dead.** The adapter does `url.replace(/^file:/, "")` with no query parsing;
  `file:./x.db?pragma=journal_mode(WAL)` creates a literal 0-byte file named
  `x.db?pragma=journal_mode(WAL)` (measured: `results/h3-adapter.txt` S2).
- **journal_mode:** set once at bootstrap via `prisma.$executeRawUnsafe("PRAGMA journal_mode=WAL")`.
  It is **persistent** (a fresh client sees `wal`) but **sticky per live connection** (a connection opened
  before the switch keeps the old mode until reconnect) — measured.
- **busy_timeout:** not reachable via SQL through Prisma; set it through the better-sqlite3 option passed to
  the adapter factory: `new PrismaBetterSqlite3({ url: "file:...", timeout: 5000 })` (better-sqlite3 default
  is 5000 ms). This is the only knob.
- **synchronous:** **per-connection** (measured: set NORMAL on client A → A=1, fresh client B=2 FULL
  default). Re-issue `PRAGMA synchronous=NORMAL` after every connect.
- Gotcha: the adapter sets `defaultSafeIntegers(true)` — raw `$queryRaw`/`$executeRaw` integers come back as
  **BigInt** (measured). Handle when reading SUM/COUNT results.

## (c) Can we get BEGIN IMMEDIATE through Prisma?

**No.** `BEGIN`, `BEGIN IMMEDIATE`, `BEGIN EXCLUSIVE` via `$executeRawUnsafe` inside `$transaction` all fail
with **P2010**, `cause = { originalCode: SQLITE_ERROR, originalMessage: "cannot start a transaction within
a transaction" }` (measured). The adapter's `startTransaction` only issues plain `BEGIN` (DEFERRED) and
accepts only `SERIALIZABLE`/null isolation (anything else → P2023 "Invalid isolation level", measured on the
parallel run's harness).

**Consequence:** transactions start DEFERRED — the write lock (RESERVED) is taken at the first write
statement, not at BEGIN. In-process this is irrelevant (the mutex already serializes). Cross-process it
means the first write of each txn is the contention point; that is handled by the adapter busy-timeout +
retry in (d). No upgrade-deadlock hazard on a single connection.

## (d) Retry-on-contention wrapper for `connection.transaction(fn)`

Working implementation measured in `spike/itd89/adapter/h3-semantics.ts` (exported
`isRetriable`/`transactionWithRetry`); against a live process holding a write txn for 3000 ms with adapter
busy-timeout 800 ms: **committed on attempt 3, elapsed 2222 ms** (two ~800 ms busy blocks + backoff).

Design:

- **Retriable** (catch `PrismaClientKnownRequestError`):
  - `code === "P2028"` **and** message contains "Unable to start a transaction" (start/queue timeout —
    pre-commit, so the attempt rolled back and a retry is safe).
  - `meta.driverAdapterError.cause.originalCode` in `{SQLITE_BUSY, SQLITE_LOCKED}` or `cause.kind ===
    "SocketTimeout"` (cross-process contention; surfaces as **P1008** — match on the cause, *not* the
    user-facing message, which is "Invalid `tx.tx.create()` invocation in …").
- **Not retriable:** P2002 / `SQLITE_CONSTRAINT` (unique violation — may mean a *previous* attempt
  committed), P2023 (bad isolation), P2028 with message "Transaction already closed" (use-after-commit
  bug — fail fast).
- **Backoff:** exponential with jitter, base 50–100 ms (measured 50·2^k·(0.5..1.5)), cap per sleep ~1–2 s,
  **max 5 attempts** (≈ ≤5 s total; measured need was 3).
- **Retry safety / id reuse:** Entry generates ObjectIds at construction, so a naive retry re-inserts the
  same ids. Measured: re-insert after a *pre-commit* failure is safe (the rollback already removed the rows —
  reuse committed fine); re-insert after a *commit* → **P2002** ("UNIQUE constraint failed:
  medici_transactions.id"), no duplicate/corruption. **Recommendation: regenerate the entry's and journal's
  ObjectIds inside the txn callback on every attempt** (cheap, kills the ambiguity class). If P2002 ever
  appears *during* a retry, treat it as "previous attempt probably committed" and verify by journal id.

## (e) Does a read inside a write transaction see its own uncommitted writes?

**Yes — measured `visibleInTx=1, visibleOtherPreCommit=0, visibleOtherPostCommit=1`** (`results/h3-adapter.txt`
S6, second client = separate connection). `xacid.spec.ts:249`'s in-txn `balance` check is safe.
One related hazard (parallel run's h5, verified against the adapter source): because there is a single
connection per client, a **background outer-client call fired during an open txn piggybacks on that txn** —
it commits (or is silently rolled back) with it. Discipline: inside the txn callback use only the `tx` client.

## (f) Fallback recommendation if interactive txns prove inadequate

**No fallback is needed for the in-process design.** Mutex-serialized interactive transactions are correct
at N=18 (measured N=128) at ~5 ms/txn — 18-way in 131 ms, 186.6 sequential commits/s at full commit shape
(`results/h6-adapter.txt`). Cross-process write contention (if multiple writer processes are ever deployed)
is handled by the adapter `timeout` (busy_timeout) + the (d) retry wrapper; keep one adapter-backed
PrismaClient per process. Keep "better-sqlite3 driving the transaction boundary with Prisma for the rest"
only as a documented escape hatch — it adds a second query path and id/lock bookkeeping for no benefit in a
single-writer-process deployment. A process-level write mutex is likewise unnecessary (the adapter's mutex
already provides it per process).

## ObjectId storage validation (harness `h4-objectid.ts`, `results/h4-adapter.txt`)

- **Byte-boundary ordering (required case):** ids `…0000000f` vs `…00000010` (share 11 bytes; final byte
  0x0f vs 0x10, where naive numeric intuition about "f < 10" is wrong): SQLite `ORDER BY`, `id > A`,
  `id <= A` on 24-char lowercase-hex **TEXT** all match true byte comparison exactly. (bson 7.x ObjectId has
  no `compare()`; the reference comparison is `Buffer.compare(hex bytes)`.)
- **Number trap:** `parseInt(id,16)`/`Number` on 24 hex chars collides — two distinct same-second ids parse
  to the same float64 (3.30288663210355e+28, low bits lost) while SQLite BINARY collation orders/filters them
  correctly. Never compare ids numerically.
- **In-process monotonicity:** 100,000 rapid `new ObjectId()` → **0 inversions** (27 ms) ⇒
  `_id: {$gt: snapshot.transaction}` pagination (Book.ts:104) is correct **within one writer process**.
- **getTimestamp round-trip (Book.ts:113):** 50/50 ids round-trip hex-exact and timestamp-exact through the
  DB. Note: bson 7.x `getTimestamp()` returns a **Date**, not seconds — use `Math.floor(d.getTime()/1000)`.
- **Cross-process monotonicity failure mode (required case):** within the *same second*, cross-process id
  order is fixed by each process's 5-byte **random** prefix, not creation time. Measured over 10 rounds
  (earlier creator spawns, later creator generated ~0.4–0.7 s later): in **2/10 rounds the later process's
  ids sorted entirely before the earlier process's** (full inversion). ⇒ "bigger id == newer" does **not**
  hold across processes; multi-writer deployments must use the plan's DB-backed
  `medici_id_sequence(seconds, counter, instance)` (single-writer process is fine with bson ids).
- **String vs Bytes:** recommend **String (24-char lowercase hex TEXT)**. Both TEXT (default BINARY
  collation) and BLOB sort byte-wise, but String avoids hex encode/decode at every API/JSON/SQL-literal edge;
  enforce lowercase at write (`ObjectId.toHexString()` is already lowercase).

## NUL round-trip (harness `h5-nulkey.ts`, `results/h5-adapter.txt`)

- 20-byte key with 0x00 at [3] and [12]: Prisma round-trips it **byte-exact through String (latin1), hex
  String, and Bytes/BLOB** — better-sqlite3/SQLite TEXT is not a C string at the bind level.
- **But SQLite string functions truncate at the first NUL:** `length()`=3 (of 20), `substr(1,8)` returns 3
  bytes, while `instr()` finds the NUL at position 4. Any SQL-side string manipulation of a raw key
  (substr/length/like/concat) would silently corrupt it.
- Ordering with NULs: 100 random sha1-shaped keys — `ORDER BY` on raw latin1 TEXT and on hex TEXT both match
  true byte order (NUL=0x00 is the smallest byte).
- P(sha1 digest contains 0x00) = 1 − (255/256)^20 = **7.53%** (parallel run measured 7.68% on 10k).
- **Recommendation (confirms the plan): store `medici_balances.key` hex-encoded TEXT.**

## Sequential throughput (harness `h6-sequential.ts`, `results/h6-adapter.txt`)

- 1000 sequential interactive txns at full commit shape (2 tx inserts + 1 journal + 1 lock upsert):
  **186.6 commits/s, 5.4 ms/commit, final state exact** (2000 tx rows / 1000 journals).
- Contrast: the same 1000 commits inside one big transaction = 0.52 ms/commit-equivalent (20×) — the
  per-commit boundary is the inherent cost; xacid requires per-entry boundaries, so 186.6 commits/s is the
  operative number.
- Parallel run measured: balance aggregate ~0.4–1.1 ms over 120–1200 tx rows — the 10 ms budget in
  `book.spec.ts:391` is comfortable at this scale.
- Related scaffold gotcha (parallel run's h5): Prisma `aggregate` over an **empty** match returns one object
  `{ _sum: { credit: null, debit: null }, _count: 0 }` — Book.ts:129's `if (result)` no-row semantics would
  be FALSE on that shape; the adapter must map `_count === 0` to "no row" (raw SQL `SUM` over empty set is
  NULL, `COUNT` is 0).

## Scaffold checklist (implementation-facing)

1. Pin prisma 7.10.0 / @prisma/adapter-better-sqlite3 7.10.0 / better-sqlite3 13.0.3 (SQLite 3.53.4 ✓) / bson 7.3.3; TS toolchain for the generated client.
2. `new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: "file:...", timeout: 5000 }) })` — busy_timeout is the `timeout` option, nothing else.
3. Bootstrap: `PRAGMA journal_mode=WAL` (persistent); per connect: `PRAGMA synchronous=NORMAL`. No `?pragma=` URLs.
4. Interactive txns: defaults maxWait=2000/timeout=5000 — raise per-call/`transactionOptions` for slow callbacks; wrap with the (d) retry policy; regenerate ObjectIds per attempt.
5. `defaultSafeIntegers` → BigInt in raw SQL results; map empty `_count` aggregate to no-row; tx-client-only discipline inside callbacks (single connection piggybacking).
6. `_id`: 24-char lowercase hex TEXT; DB-backed `medici_id_sequence` for multi-writer; `getTimestamp()` returns a Date.
7. `medici_balances.key`: hex-encoded TEXT.

## Note on a concurrent run

Another concurrent run worked in the same `spike/` directory in parallel (plain-node `.mjs` harnesses at the
spike root; its `results/h1.txt`, `h4.txt`, `h5.txt`). It initially targeted the pre-7 prisma-client-js +
env-URL path, discovered the adapter requirement, and adapted. Its results independently corroborate this
memo's numbers (18-way 2/16 with exact message, P2002 shape, P2023 invalid isolation, no BEGIN IMMEDIATE,
7.68% NUL digests, empty-aggregate shape, shared-connection piggyback, closed-txn P2028). This spike worked
in `spike/itd89/` to avoid file clobbering; this memo is the deliverable at the mandated `spike/FINDINGS.md`
path.

## Recommendation

Prisma 7.10 interactive transactions over SQLite via `@prisma/adapter-better-sqlite3` are **fit for purpose
and need no fallback** for the single-writer-process medici port: the adapter's per-connection async mutex
serializes all in-process transactions on one connection, so N=18 (measured N=128) concurrent
insert→upsert-increment→aggregate-refer txns complete with exact aggregates and zero contention errors, and
the full 18-way xacid double-spend fidelity case reproduces the upstream outcome (2 succeed, 16 roll back,
final balance 0, lock `__v`=2); set `journal_mode=WAL` once at bootstrap, `synchronous=NORMAL` per connect,
and busy-timeout via the adapter `timeout` option (URL pragmas are gone in Prisma 7), keep the default
maxWait/timeout but raise them for slow callbacks since the only in-process failure mode is P2028
start-queue timeout (break point ≈ maxWait/callback-duration), add the measured retry wrapper (retry P2028
"Unable to start" and cause-`SQLITE_BUSY`/`SQLITE_LOCKED`, never constraint errors, exp backoff + jitter,
≤5 attempts, regenerate ObjectIds per attempt), store ObjectIds as 24-char lowercase hex TEXT (byte-order
exact, including the `…000f` vs `…0010` boundary and the float64 Number-collision trap; in-process
monotonicity holds, cross-process it does not within a second — use the DB-backed `medici_id_sequence` if
multi-writer processes are ever deployed), and store balance keys hex-encoded TEXT (NUL round-trips through
Prisma but SQLite string functions truncate at NUL).
