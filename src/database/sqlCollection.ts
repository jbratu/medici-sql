/**
 * ITD-93 — Collection adapter: MongoDB driver-shaped operations over Prisma.
 *
 * Implements exactly the operations the verbatim medici business layer
 * (Book.ts, Entry.ts, models/*) emits against `model.collection`:
 * insertOne/insertMany, find/findOne (sort/skip/limit/projection),
 * countDocuments, distinct, updateOne/updateMany (incl. upsert with
 * genuinely distinct matchedCount/modifiedCount), deleteOne/deleteMany, and
 * the one fixed aggregate pipeline (Book.balance's GROUP). Anything outside
 * that surface throws UnsupportedMongoOperationError — we are not
 * reimplementing MongoDB.
 *
 * Everything runs as raw parameterized SQL ($queryRawUnsafe /
 * $executeRawUnsafe) on the Prisma/better-sqlite3 client; WHERE
 * construction is delegated to the filter translator (ITD-92). The Prisma
 * model delegates are NOT used for reads: their result shape (camelCase
 * fields, always-present nulls) is not the driver's document shape.
 *
 * Session routing (spike discipline): when `options.session` is present,
 * every query runs on the session's interactive-transaction client and
 * commits/rolls back with the caller's transaction; otherwise the singleton
 * client is used. After the transaction ends, queries on the session client
 * REJECT (P2028) — never throw synchronously — which is what the unawaited
 * background re-snapshot in Book.ts:165-186 relies on (QA S4).
 *
 * `_id` rules (QA M3/G2):
 * - Transaction `_id`s are client-side bson ObjectIds (monotonic within one
 *   process, in array order) UNLESS `forceServerObjectId: true` is passed —
 *   then they are allocated from the database-backed `medici_id_sequence`
 *   (ITD-89 section A, table added in ITD-90) INSIDE the write transaction.
 *   Client-side ids are monotonic only within one process: two writer
 *   processes in the same second can emit out-of-order ids, which
 *   Book.balance's snapshot cursor (`_id: { $gt: ... }`, Book.ts:104) then
 *   silently excludes for up to 48 h with no error. Journal/lock/balance
 *   `_id`s stay client-side.
 * - An explicit `_id` in the document always wins and is never overwritten.
 *
 * Read-side type mapping (QA M8/G9): `_id` / `_journal` / `_original_journal`
 * / `transaction` -> Types.ObjectId; `_transactions` -> ObjectId[];
 * `account_path` -> string[]; `meta` -> object (except medici_balances.meta,
 * which stays the JSON string models/balance.ts writes and the specs assert
 * string equality on); date columns -> Date; `medici_balances.key` is
 * hex-DECODED back to the raw latin1 digest (stored hex-encoded because raw
 * sha1 digests contain NUL bytes that truncate SQLite string handling —
 * ITD-90 item 1). NULL columns are OMITTED from the returned document, not
 * returned as `null` (Mongo omits unset fields).
 *
 * Ordering (QA M7): every find/findOne terminates its ORDER BY with an `_id`
 * ASC tiebreak. Six transactions in one entry share journal.datetime AND
 * entry.timestamp (Entry.ts:87 stamps one timestamp on every row), so
 * `ORDER BY datetime DESC, timestamp DESC` is a total tie — and
 * balance.spec.ts:201-204 pins `results[2]` to the THIRD inserted row.
 * SQLite guarantees nothing for a full tie; book.spec.ts:395-397 reads
 * `snapshots[0]` as the older snapshot, so the no-sort default is `_id` ASC
 * (insertion order) as well.
 */
import { ObjectId } from "bson";
import { IAnyObject } from "../IAnyObject";
import { Types } from "../compat/mongoose";
import { UnsupportedMongoOperationError } from "../errors/UnsupportedMongoOperationError";
import { connectPrisma } from "./client";
import { COLUMN_KINDS, CollectionName, SqlPredicate, translateFilter } from "./filterTranslator";
import { storedDateTime } from "./filterTranslator";
import { allocateTransactionIds } from "./idSequence";
import { ClientSession, ItxClient, PrismaClientView } from "./session";

export interface SqlCollectionOptions {
  session?: ClientSession;
  [key: string]: unknown;
}

export interface InsertOneResult {
  acknowledged: true;
  insertedId: Types.ObjectId;
}

export interface InsertManyResult {
  acknowledged: true;
  insertedIds: Record<string, Types.ObjectId>;
  insertedCount: number;
}

export interface UpdateResult {
  acknowledged: true;
  matchedCount: number;
  modifiedCount: number;
  upsertedId?: Types.ObjectId;
}

export interface DeleteResult {
  acknowledged: true;
  deletedCount: number;
}

/** Public surface of the collection (kept interface-typed so the bundled d.ts stays small). */
export interface SqlCollection {
  insertOne(doc: IAnyObject, options?: SqlCollectionOptions): Promise<InsertOneResult>;
  insertMany(docs: IAnyObject | IAnyObject[], options?: SqlCollectionOptions): Promise<InsertManyResult>;
  updateOne(filter: IAnyObject, update: IAnyObject, options?: SqlCollectionOptions): Promise<UpdateResult>;
  updateMany(filter: IAnyObject, update: IAnyObject, options?: SqlCollectionOptions): Promise<UpdateResult>;
  upsert(filter: IAnyObject, update: IAnyObject, options?: SqlCollectionOptions): Promise<UpdateResult>;
  find(filter?: IAnyObject, options?: SqlCollectionOptions): { toArray(): Promise<IAnyObject[]> };
  findOne(filter?: IAnyObject, options?: SqlCollectionOptions): Promise<IAnyObject | null>;
  countDocuments(filter?: IAnyObject, options?: SqlCollectionOptions): Promise<number>;
  deleteOne(filter: IAnyObject, options?: SqlCollectionOptions): Promise<DeleteResult>;
  deleteMany(filter: IAnyObject, options?: SqlCollectionOptions): Promise<DeleteResult>;
  aggregate(pipeline?: IAnyObject[], options?: SqlCollectionOptions): { toArray(): Promise<IAnyObject[]> };
  distinct(field: string, filter?: IAnyObject, options?: SqlCollectionOptions): Promise<unknown[]>;
}

/** Document-visible columns per table (in DDL order). The denormalized account_path_N columns are filter-only (QA G6) and never appear in documents. */
const TABLE_COLUMNS: Record<CollectionName, string[]> = {
  medici_transactions: [
    "_id",
    "credit",
    "debit",
    "meta",
    "datetime",
    "account_path",
    "accounts",
    "book",
    "memo",
    "_journal",
    "timestamp",
    "voided",
    "void_reason",
    "_original_journal",
  ],
  medici_journals: ["_id", "datetime", "memo", "_transactions", "book", "voided", "void_reason"],
  medici_locks: ["_id", "book", "account", "updatedAt", "__v"],
  medici_balances: [
    "_id",
    "key",
    "rawKey",
    "book",
    "account",
    "transaction",
    "meta",
    "balance",
    "notes",
    "createdAt",
    "expireAt",
  ],
};

/** Every SQL column of the table (incl. denormalized ones) — what inserts/sorts/projections may touch. */
const FULL_COLUMNS: Record<CollectionName, string[]> = {
  medici_transactions: [...TABLE_COLUMNS.medici_transactions, "account_path_0", "account_path_1", "account_path_2"],
  medici_journals: TABLE_COLUMNS.medici_journals,
  medici_locks: TABLE_COLUMNS.medici_locks,
  medici_balances: TABLE_COLUMNS.medici_balances,
};

type ReadKind =
  | "objectId"
  | "objectIdArray"
  | "date"
  | "bool"
  | "real"
  | "int"
  | "text"
  | "jsonObject"
  | "jsonStringArray"
  | "hexText";

/** Read-side kind per document-visible column (QA M8). */
const READ_KINDS: Record<CollectionName, Record<string, ReadKind>> = {
  medici_transactions: {
    _id: "objectId",
    credit: "real",
    debit: "real",
    meta: "jsonObject",
    datetime: "date",
    account_path: "jsonStringArray",
    accounts: "text",
    book: "text",
    memo: "text",
    _journal: "objectId",
    timestamp: "date",
    voided: "bool",
    void_reason: "text",
    _original_journal: "objectId",
  },
  medici_journals: {
    _id: "objectId",
    datetime: "date",
    memo: "text",
    _transactions: "objectIdArray",
    book: "text",
    voided: "bool",
    void_reason: "text",
  },
  medici_locks: {
    _id: "objectId",
    book: "text",
    account: "text",
    updatedAt: "date",
    __v: "int",
  },
  medici_balances: {
    _id: "objectId",
    key: "hexText",
    rawKey: "text",
    book: "text",
    account: "text",
    transaction: "objectId",
    meta: "text",
    balance: "real",
    notes: "int",
    createdAt: "date",
    expireAt: "date",
  },
};

/** The one allowed aggregate pipeline (Book.ts:20-27). */
const GROUP_STAGE: IAnyObject = {
  $group: {
    _id: null,
    balance: { $sum: { $subtract: ["$credit", "$debit"] } },
    notes: { $sum: 1 },
    lastTransactionId: { $max: "$_id" },
  },
};

function toHex(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object" && typeof (value as { toHexString?: unknown }).toHexString === "function") {
    return (value as { toHexString(): string }).toHexString().toLowerCase();
  }
  return String(value);
}

const isDate = (value: unknown): value is Date => value instanceof Date;

function encDate(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  if (isDate(value)) {
    return storedDateTime(value);
  }
  if (typeof value === "string") {
    return value;
  }
  return null;
}

function encBool(value: unknown): number | null {
  if (value == null) {
    return null;
  }
  return value ? 1 : 0;
}

/**
 * Normalize a raw stored value (as the driver adapter type-maps it) into the
 * same storage encoding `encodeValue` produces, so no-op update detection is
 * value-based rather than type-based. The driver returns Date objects for
 * DateTime columns, booleans for Boolean, numbers/BigInt for Int/Real, and
 * strings otherwise.
 */
function driverToStored(value: unknown): unknown {
  if (value == null) {
    return null;
  }
  if (isDate(value)) {
    return storedDateTime(value);
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  return value;
}

function encNumber(value: unknown): number | null {
  if (value == null) {
    return null;
  }
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

function encText(value: unknown): string | null {
  return value == null ? null : String(value);
}

function encJson(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

function describe(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  return String(value);
}

/** Key-order-insensitive structural equality for the fixed-pipeline check. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (
    a === null ||
    b === null ||
    typeof a !== "object" ||
    typeof b !== "object" ||
    Array.isArray(a) !== Array.isArray(b)
  ) {
    return false;
  }
  const ka = Object.keys(a as IAnyObject);
  const kb = Object.keys(b as IAnyObject);
  if (ka.length !== kb.length) {
    return false;
  }
  return ka.every(
    (k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual((a as IAnyObject)[k], (b as IAnyObject)[k])
  );
}

function isUniqueViolation(err: unknown): boolean {
  if (err && typeof err === "object") {
    const e = err as { code?: unknown; message?: unknown };
    if (e.code === "P2002") {
      return true;
    }
    if (typeof e.message === "string" && e.message.includes("UNIQUE constraint failed")) {
      return true;
    }
  }
  return false;
}

class SqlCollectionImpl implements SqlCollection {
  /** The known medici table, validated in the constructor. */
  private readonly table: CollectionName;

  constructor(private readonly singleton: ItxClient, private readonly name: string) {
    if (!(this.name in TABLE_COLUMNS)) {
      throw new UnsupportedMongoOperationError(`SqlCollection: unknown collection "${this.name}"`);
    }
    this.table = this.name as CollectionName;
  }

  private clientFor(options?: SqlCollectionOptions): PrismaClientView {
    return options?.session ? options.session.client : this.singleton;
  }

  /**
   * Filter -> WHERE fragment via the filter translator (ITD-92). Pre-pass:
   * a plain-string `key` filter on medici_balances is the raw latin1 sha1
   * digest, which is stored hex-encoded (ITD-90 item 1) — encode it here so
   * the comparison matches the stored bytes.
   */
  private predicate(filter?: IAnyObject): SqlPredicate {
    let f = filter;
    if (this.name === "medici_balances" && f != null && typeof f.key === "string") {
      f = { ...f, key: Buffer.from(f.key, "latin1").toString("hex") };
    }
    return translateFilter(f, { collection: this.table });
  }

  private assertColumn(col: string, what: string): void {
    if (!(col in COLUMN_KINDS[this.table]) && !(col in READ_KINDS[this.table])) {
      throw new UnsupportedMongoOperationError(`${what} field "${col}" is not a column of ${this.name}`);
    }
  }

  private validateCount(value: unknown, what: string): number | null {
    if (value == null) {
      return null;
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new UnsupportedMongoOperationError(`${what} must be a non-negative integer (got ${describe(value)})`);
    }
    return value;
  }

  /** ORDER BY parts; always terminated by the `_id` ASC tiebreak (QA M7). */
  private orderByFor(sort: unknown): string[] {
    const allCols = new Set(FULL_COLUMNS[this.table]);
    const parts: string[] = [];
    if (sort != null) {
      const specs: Array<[string, boolean]> = [];
      if (typeof sort === "string") {
        for (const token of sort.split(/\s+/).filter(Boolean)) {
          const desc = token.startsWith("-");
          specs.push([desc ? token.slice(1) : token, desc]);
        }
      } else if (Array.isArray(sort)) {
        for (const entry of sort) {
          for (const [field, dir] of Object.entries(entry as IAnyObject)) {
            specs.push([field, !(dir === 1 || dir === true)]);
          }
        }
      } else if (typeof sort === "object") {
        for (const [field, dir] of Object.entries(sort as IAnyObject)) {
          specs.push([field, !(dir === 1 || dir === true)]);
        }
      } else {
        throw new UnsupportedMongoOperationError(`sort must be a string, object or array (got ${describe(sort)})`);
      }
      for (const [field, desc] of specs) {
        if (!allCols.has(field)) {
          throw new UnsupportedMongoOperationError(`sort field "${field}" is not a column of ${this.name}`);
        }
        parts.push(`"${field}" ${desc ? "DESC" : "ASC"}`);
      }
    }
    if (!parts.some((p) => p.startsWith(`"_id"`))) {
      parts.push(`"_id" ASC`);
    }
    return parts;
  }

  private projectColumns(projection: unknown): string[] {
    const visible = TABLE_COLUMNS[this.table];
    if (projection == null) {
      return visible;
    }
    if (typeof projection !== "object" || Array.isArray(projection)) {
      throw new UnsupportedMongoOperationError(`projection must be an object (got ${describe(projection)})`);
    }
    const entries = Object.entries(projection);
    if (entries.length === 0) {
      return visible;
    }
    const include = entries.filter(([, v]) => v === 1 || v === true);
    const exclude = entries.filter(([, v]) => v === 0 || v === false);
    if (include.length > 0 && exclude.length > 0) {
      throw new UnsupportedMongoOperationError("projection mixes inclusion and exclusion fields");
    }
    const allCols = new Set(FULL_COLUMNS[this.table]);
    const fields = (include.length > 0 ? include : exclude).map(([f]) => f);
    for (const f of fields) {
      if (!allCols.has(f)) {
        throw new UnsupportedMongoOperationError(`projection field "${f}" is not a column of ${this.name}`);
      }
    }
    if (include.length > 0) {
      return fields;
    }
    return visible.filter((f) => !exclude.some(([k]) => k === f));
  }

  private selectSql(
    filter: IAnyObject | undefined,
    cols: string[],
    orderBy: string[],
    limit: number | null,
    skip: number | null
  ): { sql: string; params: unknown[] } {
    const pred = this.predicate(filter);
    const params: unknown[] = [];
    const colList = cols.map((c) => `"${c}"`).join(", ");
    let sql = `SELECT ${colList} FROM "${this.name}"`;
    if (pred.where) {
      sql += ` WHERE ${pred.where}`;
      params.push(...pred.params);
    }
    if (orderBy.length > 0) {
      sql += ` ORDER BY ${orderBy.join(", ")}`;
    }
    if (limit != null) {
      sql += " LIMIT ?";
      params.push(limit);
    }
    if (skip != null) {
      sql += " OFFSET ?";
      params.push(skip);
    }
    return { sql, params };
  }

  /**
   * Raw row -> driver-shaped document (QA M8). NULL columns are omitted,
   * not returned as null. Idempotent for columns already in their target
   * shape (the compat query layer re-applies its own mapping safely).
   */
  private rowToDoc(row: Record<string, unknown>): IAnyObject {
    const doc: IAnyObject = {};
    for (const [col, raw] of Object.entries(row)) {
      if (raw == null) {
        continue;
      }
      const kind: ReadKind | undefined = READ_KINDS[this.table][col];
      switch (kind) {
        case "objectId":
          doc[col] = new Types.ObjectId(String(raw));
          break;
        case "objectIdArray":
          doc[col] = (JSON.parse(String(raw)) as unknown[]).map((v) => new Types.ObjectId(String(v)));
          break;
        case "date":
          // The driver adapter type-maps DateTime columns to Date objects in
          // $queryRawUnsafe results; only strings need parsing (String(date)
          // drops sub-second precision).
          doc[col] = raw instanceof Date ? raw : new Date(String(raw));
          break;
        case "bool":
          doc[col] = raw === 1 || raw === true;
          break;
        case "real":
        case "int":
          // defaultSafeIntegers(true): raw integers come back as BigInt.
          doc[col] = typeof raw === "bigint" ? Number(raw) : (raw as number);
          break;
        case "jsonObject":
        case "jsonStringArray":
          doc[col] = JSON.parse(String(raw));
          break;
        case "hexText":
          // medici_balances.key: hex-encoded storage (NUL-safe) -> raw digest.
          doc[col] = Buffer.from(String(raw), "hex").toString("latin1");
          break;
        case "text":
        default:
          doc[col] = String(raw);
          break;
      }
    }
    return doc;
  }

  /** Encode one value for storage in `col` (write side of QA M8). */
  private encodeValue(col: string, value: unknown): unknown {
    const kind: ReadKind | undefined = READ_KINDS[this.table][col];
    switch (kind) {
      case "objectId":
        return toHex(value);
      case "objectIdArray":
        if (Array.isArray(value)) {
          return JSON.stringify(value.map((v) => toHex(v)));
        }
        return typeof value === "string" ? value : null;
      case "date":
        return encDate(value);
      case "bool":
        return encBool(value);
      case "real":
      case "int":
        return encNumber(value);
      case "jsonObject":
      case "jsonStringArray":
        return encJson(value);
      case "hexText":
        return value == null ? null : Buffer.from(String(value), "latin1").toString("hex");
      case "text":
      default:
        return encText(value);
    }
  }

  /** Mongo-shaped doc -> stored row (all FULL_COLUMNS present; defaults for optional ones). */
  private encodeInsertRow(doc: IAnyObject): Record<string, unknown> {
    switch (this.name) {
      case "medici_transactions": {
        const accountPath: string[] = Array.isArray(doc.account_path)
          ? doc.account_path.map((segment: unknown) => String(segment))
          : typeof doc.account_path === "string"
          ? (JSON.parse(doc.account_path) as unknown[]).map((segment: unknown) => String(segment))
          : [];
        const row: Record<string, unknown> = {
          _id: "",
          credit: encNumber(doc.credit),
          debit: encNumber(doc.debit),
          meta: encJson(doc.meta),
          datetime: encDate(doc.datetime) ?? storedDateTime(new Date()),
          account_path: JSON.stringify(accountPath),
          accounts: doc.accounts != null ? String(doc.accounts) : accountPath.join(":"),
          book: encText(doc.book) ?? "",
          memo: doc.memo != null ? String(doc.memo) : "",
          _journal: toHex(doc._journal) ?? "",
          timestamp: encDate(doc.timestamp) ?? storedDateTime(new Date()),
          voided: encBool(doc.voided),
          void_reason: encText(doc.void_reason),
          _original_journal: toHex(doc._original_journal),
          account_path_0: accountPath[0] ?? null,
          account_path_1: accountPath[1] ?? null,
          account_path_2: accountPath[2] ?? null,
        };
        return row;
      }
      case "medici_journals": {
        const transactions: unknown[] = Array.isArray(doc._transactions)
          ? doc._transactions
          : typeof doc._transactions === "string"
          ? (JSON.parse(doc._transactions) as unknown[])
          : [];
        return {
          _id: "",
          datetime: encDate(doc.datetime) ?? storedDateTime(new Date()),
          memo: doc.memo != null ? String(doc.memo) : "",
          _transactions: JSON.stringify(transactions.map((t) => toHex(t) ?? "")),
          book: encText(doc.book) ?? "",
          voided: encBool(doc.voided),
          void_reason: encText(doc.void_reason),
        };
      }
      case "medici_locks":
        return {
          _id: "",
          book: encText(doc.book) ?? "",
          account: encText(doc.account) ?? "",
          updatedAt: encDate(doc.updatedAt) ?? storedDateTime(new Date()),
          __v: encNumber(doc.__v) ?? 0,
        };
      case "medici_balances": {
        const keyRaw = doc.key == null ? "" : String(doc.key);
        return {
          _id: "",
          key: Buffer.from(keyRaw, "latin1").toString("hex"),
          rawKey: encText(doc.rawKey) ?? "",
          book: encText(doc.book) ?? "",
          account: encText(doc.account),
          transaction: toHex(doc.transaction) ?? "",
          meta: typeof doc.meta === "string" ? doc.meta : JSON.stringify(doc.meta ?? {}),
          balance: encNumber(doc.balance),
          notes: encNumber(doc.notes) ?? 0,
          createdAt: encDate(doc.createdAt) ?? storedDateTime(new Date()),
          expireAt: encDate(doc.expireAt) ?? storedDateTime(new Date(Date.now() + 2 * 24 * 60 * 60 * 1000)),
        };
      }
      default:
        throw new UnsupportedMongoOperationError(`SqlCollection: unknown collection "${this.name}"`);
    }
  }

  private insertSql(list: IAnyObject[], ids: string[]): { sql: string; values: unknown[] } {
    const cols = FULL_COLUMNS[this.table];
    const rows: unknown[][] = list.map((doc, i) => {
      const row = this.encodeInsertRow(doc);
      row._id = ids[i];
      return cols.map((c) => row[c] ?? null);
    });
    const placeholders = cols.map(() => "?").join(", ");
    const colList = cols.map((c) => `"${c}"`).join(", ");
    const tuple = rows.map(() => `(${placeholders})`).join(", ");
    return {
      sql: `INSERT INTO "${this.name}" (${colList}) VALUES ${tuple}`,
      values: rows.flat(),
    };
  }

  async insertOne(doc: IAnyObject, options?: SqlCollectionOptions): Promise<InsertOneResult> {
    const result = await this.insertMany([doc], options);
    return { acknowledged: true, insertedId: result.insertedIds["0"] };
  }

  async insertMany(docs: IAnyObject | IAnyObject[], options?: SqlCollectionOptions): Promise<InsertManyResult> {
    await connectPrisma();
    const list: IAnyObject[] = Array.isArray(docs) ? docs : [docs];
    if (list.length === 0) {
      return { acknowledged: true, insertedIds: {}, insertedCount: 0 };
    }

    // QA M3/G2: with forceServerObjectId the (absent) transaction _ids come
    // from the DB-backed sequence, allocated on the write transaction's
    // client so the advance commits/rolls back with the inserts.
    const useSequence =
      this.name === "medici_transactions" &&
      options?.forceServerObjectId === true &&
      list.some((doc) => toHex(doc._id) == null);

    const run = async (client: PrismaClientView): Promise<string[]> => {
      let allocated: string[] | undefined;
      if (useSequence) {
        if (list.some((doc) => toHex(doc._id) != null)) {
          throw new UnsupportedMongoOperationError(
            "insertMany: with forceServerObjectId either all or none of the transaction docs may carry an explicit _id"
          );
        }
        allocated = await allocateTransactionIds(client, list.length);
      }
      // Client-side ids are generated in array order so the _id sequence is
      // monotonically increasing across the batch (Entry.ts:135-142).
      const ids = list.map((doc, i) => toHex(doc._id) ?? (allocated ? allocated[i] : new ObjectId().toHexString()));
      const { sql, values } = this.insertSql(list, ids);
      await client.$executeRawUnsafe(sql, ...values);
      return ids;
    };

    const ids = options?.session
      ? await run(this.clientFor(options))
      : useSequence
      ? await this.singleton.$transaction((tx) => run(tx))
      : await run(this.singleton);

    const insertedIds: Record<string, Types.ObjectId> = {};
    ids.forEach((id, i) => {
      insertedIds[String(i)] = new Types.ObjectId(id);
    });
    return { acknowledged: true, insertedIds, insertedCount: ids.length };
  }

  private parseUpdate(update: IAnyObject): { $set: IAnyObject; $setOnInsert: IAnyObject; $inc: IAnyObject } {
    if (update == null || typeof update !== "object" || Array.isArray(update)) {
      throw new UnsupportedMongoOperationError("update must be an object of $ operators");
    }
    for (const op of Object.keys(update)) {
      if (op !== "$set" && op !== "$setOnInsert" && op !== "$inc") {
        throw new UnsupportedMongoOperationError(
          `update operator "${op}" is not supported (supported: $set, $setOnInsert, $inc)`
        );
      }
    }
    return {
      $set: (update.$set ?? {}) as IAnyObject,
      $setOnInsert: (update.$setOnInsert ?? {}) as IAnyObject,
      $inc: (update.$inc ?? {}) as IAnyObject,
    };
  }

  private async update(
    filter: IAnyObject,
    update: IAnyObject,
    options: SqlCollectionOptions | undefined
  ): Promise<UpdateResult> {
    await connectPrisma();
    const { $set, $setOnInsert, $inc } = this.parseUpdate(update);
    const targetCols = Array.from(new Set([...Object.keys($set), ...Object.keys($inc), ...Object.keys($setOnInsert)]));
    for (const col of targetCols) {
      this.assertColumn(col, "update");
    }
    // $inc is applied atomically in SQL (see applyExisting): the increment
    // executes on the storage side, so concurrent upserts from different
    // connections cannot lose each other's increments — the writelockAccounts
    // __v counter stays exact under real contention.
    const incCols = Object.keys($inc);
    for (const col of incCols) {
      const kind = COLUMN_KINDS[this.table][col] ?? READ_KINDS[this.table][col];
      if (kind !== "int" && kind !== "real") {
        throw new UnsupportedMongoOperationError(
          `$inc field "${col}" must be an integer or real column of ${this.name}`
        );
      }
      const delta = $inc[col];
      if (typeof delta !== "number" || !Number.isFinite(delta)) {
        throw new UnsupportedMongoOperationError(
          `$inc value for "${col}" must be a finite number (got ${describe(delta)})`
        );
      }
    }
    const setCols = Object.keys($set).filter((col) => !Object.prototype.hasOwnProperty.call($inc, col));
    const prisma = this.clientFor(options);

    /**
     * QA M12: matchedCount and modifiedCount must be genuinely distinct —
     * Book.void (Book.ts:307-331) raises four different ConsistencyErrors
     * off them (double-void race protection), and no upstream test
     * exercises any of them, so a `count`-based implementation would make
     * both guards silently dead. Select the matching rows first, compute
     * the target values per row, and only UPDATE the rows whose stored
     * values actually differ.
     */
    const applyExisting = async (): Promise<UpdateResult> => {
      const pred = this.predicate(filter);
      const selCols = ["_id", ...setCols].map((c) => `"${c}"`).join(", ");
      let sql = `SELECT ${selCols} FROM "${this.name}"`;
      const params: unknown[] = [];
      if (pred.where) {
        sql += ` WHERE ${pred.where}`;
        params.push(...pred.params);
      }
      const rows = (await prisma.$queryRawUnsafe(sql, ...params)) as Record<string, unknown>[];
      const matchedCount = rows.length;
      if (matchedCount === 0) {
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
      }

      // $set values are computed per row and only the changed rows are
      // written; $inc columns are written with a SQL-side increment
      // (`col = COALESCE(col, 0) + ?`) so concurrent writers never lose an
      // increment.
      const groups = new Map<string, { ids: string[]; values: Record<string, unknown> }>();
      let modifiedCount = 0;
      for (const row of rows) {
        const values: Record<string, unknown> = {};
        let changed = false;
        for (const col of setCols) {
          const target = this.encodeValue(col, $set[col]);
          values[col] = target;
          // Compare against the driver-normalized stored form: raw rows are
          // type-mapped by the driver adapter (Date objects, booleans,
          // numbers/BigInt) while targets are storage encodings (ISO text,
          // 0/1) — comparing across those types would make every update
          // look modified (QA M12).
          if (target !== driverToStored(row[col])) {
            changed = true;
          }
        }
        if (incCols.length > 0) {
          changed = true;
        }
        if (!changed) {
          continue;
        }
        modifiedCount += 1;
        const key = JSON.stringify(values);
        const group = groups.get(key);
        if (group) {
          group.ids.push(String(row._id));
        } else {
          groups.set(key, { ids: [String(row._id)], values });
        }
      }

      for (const { ids, values } of groups.values()) {
        const setClauses: string[] = [];
        const setValues: unknown[] = [];
        for (const [col, value] of Object.entries(values)) {
          setClauses.push(`"${col}" = ?`);
          setValues.push(value);
        }
        for (const col of incCols) {
          if (Object.prototype.hasOwnProperty.call($set, col)) {
            setClauses.push(`"${col}" = ? + ?`);
            setValues.push(this.encodeValue(col, $set[col]), Number($inc[col]));
          } else {
            setClauses.push(`"${col}" = COALESCE("${col}", 0) + ?`);
            setValues.push(Number($inc[col]));
          }
        }
        const inSql = ids.map(() => "?").join(", ");
        await prisma.$executeRawUnsafe(
          `UPDATE "${this.name}" SET ${setClauses.join(", ")} WHERE "_id" IN (${inSql})`,
          ...setValues,
          ...ids
        );
      }
      return { acknowledged: true, matchedCount, modifiedCount };
    };

    const result = await applyExisting();
    if (result.matchedCount > 0 || !options?.upsert) {
      return result;
    }

    // Upsert with no match: insert the new row. The UNIQUE violation
    // fallback resolves the read-modify-write race — if a concurrent writer
    // inserted the same unique row in between, we re-run the update path and
    // increment the winner's row instead (exactly one row, __v incremented
    // once per upsert).
    const doc: IAnyObject = {};
    for (const [col, value] of Object.entries($setOnInsert)) {
      doc[col] = value;
    }
    for (const [col, value] of Object.entries($set)) {
      doc[col] = value;
    }
    for (const [col, value] of Object.entries($inc)) {
      doc[col] = (doc[col] == null ? 0 : Number(doc[col])) + Number(value);
    }
    const id = new ObjectId().toHexString();
    try {
      const { sql, values } = this.insertSql([doc], [id]);
      await prisma.$executeRawUnsafe(sql, ...values);
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedId: new Types.ObjectId(id) };
    } catch (err) {
      if (isUniqueViolation(err)) {
        return applyExisting();
      }
      throw err;
    }
  }

  updateOne(filter: IAnyObject, update: IAnyObject, options?: SqlCollectionOptions): Promise<UpdateResult> {
    return this.update(filter, update, options);
  }

  updateMany(filter: IAnyObject, update: IAnyObject, options?: SqlCollectionOptions): Promise<UpdateResult> {
    return this.update(filter, update, options);
  }

  upsert(filter: IAnyObject, update: IAnyObject, options?: SqlCollectionOptions): Promise<UpdateResult> {
    return this.update(filter, update, { ...options, upsert: true });
  }

  find(filter?: IAnyObject, options?: SqlCollectionOptions): { toArray(): Promise<IAnyObject[]> } {
    const cols = this.projectColumns(options?.projection);
    const orderBy = this.orderByFor(options?.sort);
    const limit = this.validateCount(options?.limit, "limit");
    const skip = this.validateCount(options?.skip, "skip");
    return {
      toArray: async () => {
        await connectPrisma();
        const prisma = this.clientFor(options);
        const { sql, params } = this.selectSql(filter, cols, orderBy, limit, skip);
        const rows = (await prisma.$queryRawUnsafe(sql, ...params)) as Record<string, unknown>[];
        return rows.map((row) => this.rowToDoc(row));
      },
    };
  }

  async findOne(filter?: IAnyObject, options?: SqlCollectionOptions): Promise<IAnyObject | null> {
    const cols = this.projectColumns(options?.projection);
    const orderBy = this.orderByFor(options?.sort);
    const { sql, params } = this.selectSql(filter, cols, orderBy, 1, this.validateCount(options?.skip, "skip"));
    await connectPrisma();
    const prisma = this.clientFor(options);
    const rows = (await prisma.$queryRawUnsafe(sql, ...params)) as Record<string, unknown>[];
    return rows.length > 0 ? this.rowToDoc(rows[0]) : null;
  }

  async countDocuments(filter?: IAnyObject, options?: SqlCollectionOptions): Promise<number> {
    await connectPrisma();
    const prisma = this.clientFor(options);
    const pred = this.predicate(filter);
    let sql = `SELECT COUNT(*) AS "count" FROM "${this.name}"`;
    const params: unknown[] = [];
    if (pred.where) {
      sql += ` WHERE ${pred.where}`;
      params.push(...pred.params);
    }
    const rows = (await prisma.$queryRawUnsafe(sql, ...params)) as Array<{ count: unknown }>;
    return Number(rows[0]?.count ?? 0);
  }

  async deleteOne(filter: IAnyObject, options?: SqlCollectionOptions): Promise<DeleteResult> {
    await connectPrisma();
    const prisma = this.clientFor(options);
    const pred = this.predicate(filter);
    const where = pred.where ? ` WHERE ${pred.where}` : "";
    const deleted = await prisma.$executeRawUnsafe(
      `DELETE FROM "${this.name}" WHERE "_id" = (SELECT "_id" FROM "${this.name}"${where} ORDER BY "_id" ASC LIMIT 1)`,
      ...pred.params
    );
    return { acknowledged: true, deletedCount: Number(deleted) };
  }

  async deleteMany(filter: IAnyObject, options?: SqlCollectionOptions): Promise<DeleteResult> {
    await connectPrisma();
    const prisma = this.clientFor(options);
    const pred = this.predicate(filter);
    const where = pred.where ? ` WHERE ${pred.where}` : "";
    const deleted = await prisma.$executeRawUnsafe(`DELETE FROM "${this.name}"${where}`, ...pred.params);
    return { acknowledged: true, deletedCount: Number(deleted) };
  }

  /**
   * The one fixed pipeline (Book.ts:20-27), hand-written as a single SQL
   * aggregate. Rounding stays in the upstream JS (Book.ts:130 toFixed);
   * SUM is done in SQL without pre-rounding (fpPrecision.spec.ts pins the
   * behaviour). Empty match -> [] (Book.ts:119 indexes [0], Book.ts:129
   * guards on falsiness).
   */
  aggregate(pipeline?: IAnyObject[], options?: SqlCollectionOptions): { toArray(): Promise<IAnyObject[]> } {
    const stages: IAnyObject[] = pipeline ?? [];
    if (stages.length !== 1 && stages.length !== 2) {
      throw new UnsupportedMongoOperationError(
        `aggregate: pipeline must be [{$group}] or [{$match}, {$group}] (got ${stages.length} stages)`
      );
    }
    if (!deepEqual(stages[stages.length - 1], GROUP_STAGE)) {
      throw new UnsupportedMongoOperationError("aggregate: only the fixed Book.balance GROUP pipeline is supported");
    }
    let match: IAnyObject | undefined;
    if (stages.length === 2) {
      const first = stages[0];
      const keys = Object.keys(first);
      if (keys.length !== 1 || keys[0] !== "$match" || first.$match == null || typeof first.$match !== "object") {
        throw new UnsupportedMongoOperationError("aggregate: the stage before {$group} must be {$match: <filter>}");
      }
      match = first.$match as IAnyObject;
    }
    return {
      toArray: async () => {
        if (this.name !== "medici_transactions") {
          throw new UnsupportedMongoOperationError(
            `aggregate: the fixed GROUP pipeline only applies to medici_transactions (got ${this.name})`
          );
        }
        await connectPrisma();
        const prisma = this.clientFor(options);
        const pred = this.predicate(match);
        let sql =
          'SELECT SUM(credit - debit) AS "balance", COUNT(*) AS "notes", MAX("_id") AS "lastTransactionId" FROM "medici_transactions"';
        const params: unknown[] = [];
        if (pred.where) {
          sql += ` WHERE ${pred.where}`;
          params.push(...pred.params);
        }
        const rows = (await prisma.$queryRawUnsafe(sql, ...params)) as Array<{
          balance: unknown;
          notes: unknown;
          lastTransactionId: unknown;
        }>;
        const row = rows[0];
        const notes = Number(row?.notes ?? 0);
        if (notes === 0) {
          return [];
        }
        return [
          {
            _id: null,
            balance: Number(row?.balance ?? 0),
            notes,
            lastTransactionId: new Types.ObjectId(String(row?.lastTransactionId)),
          },
        ];
      },
    };
  }

  async distinct(field: string, filter?: IAnyObject, options?: SqlCollectionOptions): Promise<unknown[]> {
    await connectPrisma();
    const allCols = new Set(FULL_COLUMNS[this.table]);
    if (!allCols.has(field)) {
      throw new UnsupportedMongoOperationError(`distinct: field "${field}" is not a column of ${this.name}`);
    }
    const prisma = this.clientFor(options);
    const pred = this.predicate(filter);
    let sql = `SELECT DISTINCT "${field}" AS "value" FROM "${this.name}"`;
    const params: unknown[] = [];
    if (pred.where) {
      sql += ` WHERE ${pred.where}`;
      params.push(...pred.params);
    }
    const rows = (await prisma.$queryRawUnsafe(sql, ...params)) as Array<{ value: unknown }>;
    return rows.map((r) => (typeof r.value === "bigint" ? Number(r.value) : r.value));
  }
}

export function createSqlCollection(singleton: ItxClient, name: string): SqlCollection {
  return new SqlCollectionImpl(singleton, name);
}
