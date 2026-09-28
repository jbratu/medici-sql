# Supported Mongo Operations — SQLite backend

The compatibility layer's contract: exactly which Mongo-shaped operations the
SQLite backend implements, and what happens with everything else. The layer
sits under the verbatim upstream business logic (`src/Book.ts`,
`src/Entry.ts`, `src/helper/parse/*`) and only has to understand the
operations **Medici itself emits** — nothing more. Anything outside this
surface throws `UnsupportedMongoOperationError` (extends `MediciError`,
`src/errors/UnsupportedMongoOperationError.ts`). We are not reimplementing
MongoDB; this is a deliberate cap, not an oversight.

`SqlCollection` (the object returned by `connection.collection(name)` /
`connection.db.collection(name)`) is the interface the models program
against: `src/database/sqlCollection.ts:101-112`.

## Collection methods

| Method | Supported option keys | Returns |
| --- | --- | --- |
| `insertOne(doc, options?)` | `session`, `writeConcern` (ignored), `forceServerObjectId` (ignored); any other key ignored | `{ acknowledged: true, insertedId }` |
| `insertMany(docs, options?)` | `session`, `ordered` (ignored — the batch is all-or-nothing inside its transaction either way), `forceServerObjectId` (ignored); any other key ignored | `{ acknowledged: true, insertedIds: Record<string, ObjectId>, insertedCount }` |
| `find(filter?, options?)` | `sort`, `skip`, `limit`, `projection` (inclusion of the known fields), `session`, `readPreference`/`readConcern` (ignored) | cursor: `{ toArray() }` |
| `findOne(filter?, options?)` | `sort`, `projection`, `session`, `readPreference`/`readConcern` (ignored) | doc or `null` |
| `countDocuments(filter?, options?)` | `session`, `readPreference`/`readConcern` (ignored) | number |
| `distinct(field, filter?, options?)` | `session`, `readPreference`/`readConcern` (ignored) | `unknown[]` |
| `updateOne(filter, update, options?)` | update operators `$set`, `$setOnInsert`, `$inc`; options `upsert`, `session`, `writeConcern` (ignored) | `{ acknowledged, matchedCount, modifiedCount, upsertedId? }` |
| `updateMany(filter, update, options?)` | update operator `$set` | same shape as `updateOne` |
| `deleteMany(filter, options?)` | `session` | `{ acknowledged: true, deletedCount }` |
| `aggregate(pipeline?, options?)` | see "The single supported aggregation pipeline" | cursor: `{ toArray() }` |

Port-internal extras beyond the upstream call set: `deleteOne`, and `upsert`
(a shorthand for `updateOne` with `{ upsert: true }`).

- `matchedCount` and `modifiedCount` are genuinely distinct counts
  (matched rows vs rows actually changed), as Mongo reports them.
- `sort` values are direction numbers (`1`/`-1`), the same objects upstream
  passes (e.g. `ledger()` sorts `{ datetime: -1, timestamp: -1 }`,
  `src/Book.ts`).
- `session` is the port's `ClientSession` (`src/database/session.ts`). Every
  method that receives one routes through the transaction's Prisma client,
  which is also what makes read-your-own-writes inside a transaction work
  (`spec/transaction.spec.ts` "reads its own uncommitted writes inside a
  write transaction (xacid.spec.ts:249)").
- Option keys upstream emits that are not in the "supported" column
  (`readPreference`, `readConcern`, `hint`, `writeConcern`,
  `forceServerObjectId`) are structurally accepted by
  `SqlCollectionOptions` (`src/database/sqlCollection.ts:71`, `session` plus
  an index signature) and ignored. `spec/collectionAdapter.spec.ts` pins the
  method/option surface.

## The single supported aggregation pipeline

`aggregate()` accepts exactly one pipeline shape — the one
`Book.balance()` emits (`src/Book.ts:20-26`, call sites at `src/Book.ts:119`
and `src/Book.ts:166`):

```js
[
  { $match: <filter> },
  {
    $group: {
      _id: null,
      balance: { $sum: { $subtract: ["$credit", "$debit"] } },
      notes: { $sum: 1 },
      lastTransactionId: { $max: "$_id" },
    },
  },
]
```

- `$match` is translated by the same filter rules below (any field the
  balance/ledger queries use).
- The `$group` is the fixed accumulator above, verbatim. Empty match sets
  map to "no row" (`{ _count: 0 }` → no result), matching the
  `if (result)` semantics at `src/Book.ts:129` (`spike/FINDINGS.md`,
  sequential-throughput note).
- Anything else — other `$group` accumulators, other pipeline stages,
  multiple `$match`es, `$project`, `$sort` stages — throws
  `UnsupportedMongoOperationError`.

## Filter operators

Scope of the filter translator (`src/database/filterTranslator.ts`,
ITD-92). Inputs are the Mongo-shaped filter objects Medici itself emits via
`parseFilterQuery` / `parseBalanceQuery`; the translator converts them into
parameterized SQLite `WHERE` fragments
(`translateFilter(filter, { collection }) → { where, params }`) that
ITD-93 executes.

| Operator | Meaning | SQL mapping (`E` = target expression) |
| --- | --- | --- |
| `field: v` | equality | `E = ?` (see null bucket below) |
| `$gt`, `$gte`, `$lt`, `$lte` | comparison | `E > ?` / `E >= ?` / `E < ?` / `E <= ?` |
| `$in` | membership | `E IN (?, ...)`; empty array → `0 = 1` (no match) |
| `$ne` | inequality | `E IS NULL OR E <> ?` |
| `$or` | top-level disjunction only | sub-filters `OR`-joined, parenthesized |

Multiple operators on one field are ANDed and grouped:
`{_id: {$gt: a, $lte: b}}` → `(_id > ? AND _id <= ?)`.

Dotted paths: `meta.<k>[.<k>…]` (JSON paths, all-digit segments become array
indexes) and `account_path.<0|1|2>` (denormalized columns). `spec/filterTranslator.spec.ts`
and `spec/filterTranslator.sqlite.spec.ts` pin the operator matrix end to
end.

### Equality null bucket (Mongo semantics)

Mongo equality with `null` or `false` also matches documents where the field
is missing. The translator reproduces this on both plain columns and `meta`
JSON paths (a missing JSON key extracts to `NULL`):

| Filter | SQL |
| --- | --- |
| `field: null`, `field: false` | `(E IS NULL OR E = 0)` |
| `field: true` | `E = 1` |
| `$ne: null` | `E IS NOT NULL` |
| `$ne: false` | `(E IS NOT NULL AND E <> 0)` |
| `$ne: true` | `(E IS NULL OR E <> 1)` |
| `$ne: <scalar>` | `(E IS NULL OR E <> ?)` |

`$gt`/`$gte`/`$lt`/`$lte` never match `NULL` (missing), matching Mongo.

## Field forms

Column registries per collection (static, no dynamic names):

- **medici_transactions**: `_id`, `_journal`, `_original_journal`
  (ObjectId), `book`, `accounts`, `memo`, `void_reason` (text), `credit`,
  `debit` (real), `voided` (boolean), `datetime`, `timestamp` (date),
  `account_path.N`, `meta...`
- **medici_journals**: `_id` (ObjectId), `datetime` (date), `memo`, `book`
  (text), `voided` (boolean), `void_reason` (text)
- **medici_locks**: `_id` (ObjectId), `book`, `account` (text), `updatedAt`
  (date), `__v` (int)
- **medici_balances**: `_id`, `transaction` (ObjectId), `key`, `rawKey`,
  `book`, `account` (text), `balance` (real), `notes` (int),
  `createdAt`, `expireAt` (date), `meta` (json)

Any other top-level key throws `unknown field "<key>" for collection
"<collection>"`.

### `_id` ranges (QA G5)

24-char lowercase-hex strings. Lexicographic order == byte order == time
order, so `>`/`>=`/`<`/`<=` on the TEXT column give the monotonic semantics
`Book.balance` depends on (verified across a byte boundary, e.g. `…0ff`
sorts before `…100`; `spike/FINDINGS.md` "ObjectId storage validation";
pinned by `spec/filterTranslator.sqlite.spec.ts` "_id range across a byte
boundary (QA G5)").

### `account_path.N`

- `N = 0..2` → denormalized column `account_path_N` (indexed).
- `N >= 3` → `json_extract(account_path, '$[N]')` — unindexed JSON fallback
  (QA G6; no upstream test exercises this, the round-trip suite does).

### `meta` paths

- `meta.<k>.<k2>...` → `json_extract(meta, '<path>')`. All-digit path
  segments become array indexes (`$.tags[0]`); other segments join with dots
  (`$.address.city`).
- A segment containing `[` or an empty segment throws (naming the full
  path) — such keys cannot be expressed as SQLite JSON paths.
- A `meta: {...}` object value expands per key, except keys already covered
  by a dotted `meta.<k>` top-level sibling (dotted keys win — this mirrors
  `Book.balance`, which deletes `parsedQuery.meta` before querying).

## Object-valued `meta.<k>` — JSON deep equality (QA M13/G7)

`ledger({ address: { city: "Berlin" } })` produces
`{ "meta.address": { city: "Berlin" } }` — a key whose value is a plain
object with no `$` operator. **The translator implements JSON deep
equality** (the choice required by QA; the alternative was throwing):

- Mongo subdocument matching is _contains_ semantics: every specified leaf
  must match; extra keys in the stored document are allowed.
- Arrays match by exact length and element-wise, order-sensitive recursion.
- Empty objects/arrays match exactly (`json(E) = '{}'`, length 0).
- Scalar leaves use the same null-bucket equality as plain fields.

**Distinguishing rule (binding):** a value object is an _operator object_
iff it is a non-empty plain object in which **every** key starts with `$`
(and is in the supported operator set). Any other object value is a _value
object_ → deep equality. `$`-prefixed keys at deeper positions inside a
value object are literal keys, not operators. Mixed objects (some `$`-keys,
some not) are value objects.

**Never compare against `JSON.stringify(value)`** — that is key-order and
whitespace sensitive and silently returns zero rows.

## Value coercion

- **ObjectId fields** (`_id`, `_journal`, `_original_journal`, and
  balances' `transaction`): `ObjectId` instances (bson or compat
  `Types.ObjectId`) → lowercase hex; 24-hex strings → lowercased;
  Document-like values (`{_id: ...}`) → cast to their `_id` (upstream
  `balance.spec.ts:141` passes a journal document to `findOne({_journal})`
  and Mongoose casts silently — we must too). Anything else throws.
- **Dates**: stored as `YYYY-MM-DDTHH:MM:SS.mmm+00:00` TEXT; the translator
  emits query parameters in that exact format so lexicographic comparison
  equals chronological comparison.
- **Booleans** → `1`/`0`; numbers and strings pass through for their
  column kind (kind mismatch throws).

## Everything else

The following throw `UnsupportedMongoOperationError` (naming the operator or
path): `$regex`, `$exists`, `$elemMatch`, `$and`, `$nor`, `$expr`,
aggregation operators, any unknown `$foo`, `$or` items that are not filter
objects, array/object values on non-JSON columns, non-object `meta` values,
`meta` paths containing `[` or empty segments, any `update` operator other
than the listed ones, and any `aggregate` pipeline other than the one above.

**This is a deliberate cap.** The layer exists to run Medici's own
operations, not to be a general Mongo engine. If your application (not
Medici) needs an operation that is not here, the request path is: a failing
test against `SqlCollection` plus a real use case, filed on the port. We do
not add operations on speculation.

## Documented limitations

- All-digit meta path segments are treated as array indexes; a stored object
  with a numeric-string key at that position is not reachable through the
  dotted path form.
- A `null` element in `$in` never matches (SQL `NULL` semantics differ from
  Mongo's); use equality/`$ne` null-bucket forms instead.
- A stored **string** meta value that happens to be valid JSON text can be
  traversed by deep-equality paths (e.g. `meta.a = "{\"b\":1}"` matches
  `{"meta.a": { b: 1 }}`); Mongo treats the string as an opaque scalar.
- `account_path` beyond index 2 uses an unindexed `json_extract`.
- The `meta` root value must be an object or `null`.

## Prototype-pollution safety

The translator iterates own enumerable keys only and skips reserved
prototype names (`isPrototypeAttribute`) at every level it walks: top-level
filter keys, `meta` root entries, and object values in deep equality. Field
names and JSON path segments go through a strict registry / segment
validation and are never interpolated raw into SQL — every value is a `?`
parameter.
