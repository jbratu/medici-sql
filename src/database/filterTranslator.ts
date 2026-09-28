/**
 * ITD-92 — Mongo query object -> SQL predicate translator.
 *
 * Translates the Mongo-shaped filter objects the verbatim medici business
 * layer (helper/parse/*, Book, Entry) emits into a parameterized SQLite
 * WHERE fragment, so the Collection adapter (ITD-93) can execute them
 * against the Prisma/better-sqlite3 backend without re-implementing the
 * filter grammar a second time.
 *
 * Inputs are not arbitrary: they are the outputs of parseFilterQuery and
 * parseBalanceQuery (see spec/parseFilterQuery.spec.ts and
 * spec/parseBalanceQuery.spec.ts), plus the narrow operator set medici
 * itself emits. Anything outside the supported surface throws
 * UnsupportedMongoOperationError. Full surface + rules:
 * docs/SUPPORTED_OPERATIONS.md.
 *
 * Design notes (QA refs):
 * - M13/G7: object-valued `meta.<k>` values (produced by the shallow
 *   flattenObject) are translated to JSON deep-equality with Mongo
 *   subdocument ("contains") semantics. Operator objects are distinguished
 *   by the rule: non-empty plain object whose every key starts with "$".
 *   We never compare against JSON.stringify output (key-order/whitespace
 *   sensitive).
 * - G5: `_id` range filters compare 24-char lowercase hex strings;
 *   lexicographic order == ObjectId byte order == time order.
 * - G6: `account_path.N` for N > 2 falls back to
 *   json_extract(account_path, '$[N]') because only account_path_0..2 are
 *   denormalized (ITD-90).
 * - Prototype-pollution safety: filter keys and meta keys are validated
 *   against a static column registry / strict segment rules and are never
 *   interpolated into SQL; values are always `?` parameters.
 */
import { IAnyObject } from "../IAnyObject";
import { isPrototypeAttribute } from "../helper/isPrototypeAttribute";
import { UnsupportedMongoOperationError } from "../errors/UnsupportedMongoOperationError";

export type CollectionName = "medici_transactions" | "medici_journals" | "medici_locks" | "medici_balances";

export type ColumnKind = "objectId" | "date" | "bool" | "real" | "int" | "text" | "json";

export interface SqlPredicate {
  where: string;
  params: readonly unknown[];
}

export interface TranslateFilterOptions {
  collection?: CollectionName;
}

/**
 * Static per-column kind registry. The keys of the objectId entries must
 * stay in sync with isTransactionObjectIdKey() (asserted in
 * spec/filterTranslator.spec.ts).
 */
export const COLUMN_KINDS: Readonly<Record<CollectionName, Readonly<Record<string, ColumnKind>>>> = {
  medici_transactions: {
    _id: "objectId",
    book: "text",
    accounts: "text",
    credit: "real",
    debit: "real",
    memo: "text",
    voided: "bool",
    void_reason: "text",
    _journal: "objectId",
    _original_journal: "objectId",
    datetime: "date",
    timestamp: "date",
  },
  medici_journals: {
    _id: "objectId",
    datetime: "date",
    memo: "text",
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
    key: "text",
    rawKey: "text",
    book: "text",
    account: "text",
    transaction: "objectId",
    meta: "json",
    balance: "real",
    notes: "int",
    createdAt: "date",
    expireAt: "date",
  },
};

const JSON_ROOTS: Readonly<Record<CollectionName, string | null>> = {
  medici_transactions: "meta",
  medici_journals: null,
  medici_locks: null,
  medici_balances: "meta",
};

const HEX_24 = /^[0-9a-f]{24}$/i;

/**
 * Translate a Mongo-shaped filter into a parameterized SQLite WHERE
 * fragment.
 *
 * @param filter - The filter object, typically the return value of
 *   parseFilterQuery / parseBalanceQuery. null/undefined/empty produce an
 *   empty predicate.
 * @param options - Target collection; defaults to medici_transactions.
 * @returns A WHERE fragment (no leading "WHERE", `?` placeholders, params
 *   in order of appearance) or { where: "", params: [] } for an empty
 *   filter.
 * @throws UnsupportedMongoOperationError for any field, operator, path or
 *   value shape outside the supported surface (docs/SUPPORTED_OPERATIONS.md).
 */
export function translateFilter(filter: IAnyObject | null | undefined, options?: TranslateFilterOptions): SqlPredicate {
  const collection = options?.collection ?? "medici_transactions";
  if (filter === null || filter === undefined || Object.keys(filter).length === 0) {
    return { where: "", params: [] };
  }
  return translateFields(filter, collection, []);
}

function translateFields(filter: IAnyObject, collection: CollectionName, params: unknown[]): SqlPredicate {
  const root = JSON_ROOTS[collection];
  const kinds = COLUMN_KINDS[collection];
  const clauses: string[] = [];
  for (const key of Object.keys(filter)) {
    if (isPrototypeAttribute(key)) continue;
    if (key === "$or") {
      clauses.push(translateOr(filter[key], collection, params));
      continue;
    }
    if (root !== null && key === root) {
      clauses.push(...translateJsonRoot(filter, root, kinds, params));
      continue;
    }
    if (root !== null && key.startsWith(`${root}.`)) {
      clauses.push(translateValue(jsonPathExpr(key), key, filter[key], "json", params));
      continue;
    }
    const accountPath = collection === "medici_transactions" ? /^account_path\.(\d+)$/.exec(key) : null;
    if (accountPath) {
      const n = Number(accountPath[1]);
      let expr: string;
      if (n < 3) {
        expr = `account_path_${n}`;
      } else {
        // QA G6: beyond the denormalized columns, fall back to the JSON
        // array stored in `account_path`.
        const path = `$[${n}]`;
        expr = `json_extract(account_path, ${sqlLiteral(path)})`;
      }
      clauses.push(translateValue(expr, key, filter[key], "text", params));
      continue;
    }
    const kind = kinds[key];
    if (kind === undefined) {
      // $-prefixed keys are operators, not fields — they stay out of scope
      // (only $or is supported, handled above).
      if (key.startsWith("$")) {
        throw new UnsupportedMongoOperationError(`unknown field "${key}" for collection "${collection}"`);
      }
      // QA R4: a top-level key that is not a column (a custom schema field,
      // e.g. `clientId`) can only ever be stored inside the JSON `meta`
      // column — the write path merges non-column fields there (ITD-94).
      // Translate it as a meta path; Mongo itself matches nothing for a
      // field no document has, and never errors, so no throw. Collections
      // without a JSON root still throw.
      if (root !== null) {
        clauses.push(translateValue(jsonPathExpr(`${root}.${key}`), key, filter[key], "json", params));
      } else {
        throw new UnsupportedMongoOperationError(`unknown field "${key}" for collection "${collection}"`);
      }
      continue;
    }
    clauses.push(translateValue(key, key, filter[key], kind, params));
  }
  return { where: clauses.join(" AND "), params };
}

/**
 * Expand a raw `meta` object (only produced by parseBalanceQuery;
 * Book.balance deletes it before the $match, but the translator must
 * handle it because its unit suite feeds raw parser output). Entries that
 * are already covered by a dotted top-level sibling (`meta.<k>` or
 * `meta.<k>....`) are skipped — the dotted keys win, matching how
 * Book.balance treats the raw object.
 */
function translateJsonRoot(
  filter: IAnyObject,
  root: string,
  kinds: Readonly<Record<string, ColumnKind>>,
  params: unknown[]
): string[] {
  const value = filter[root];
  if (value === null || value === undefined) return [`${root} IS NULL`];
  if (typeof value === "string") {
    // Exact match against the stored raw JSON text (book.spec.ts:346/370
    // query `meta: JSON.stringify({...})` — the column stores exactly that
    // string, so a raw comparison is the faithful Mongo equality).
    params.push(value);
    return [`${root} = ?`];
  }
  if (!isPlainObject(value)) {
    throw new UnsupportedMongoOperationError(`value for field "${root}" must be an object or null`);
  }
  const clauses: string[] = [];
  for (const k of Object.keys(value)) {
    if (isPrototypeAttribute(k)) continue;
    if (isCoveredByDottedSibling(filter, root, k, kinds)) continue;
    clauses.push(translateValue(jsonPathExpr(`${root}.${k}`), `${root}.${k}`, value[k], "json", params));
  }
  return clauses;
}

function isCoveredByDottedSibling(
  filter: IAnyObject,
  root: string,
  k: string,
  kinds: Readonly<Record<string, ColumnKind>>
): boolean {
  const dotted = `${root}.${k}`;
  for (const key of Object.keys(filter)) {
    if (key === dotted || key.startsWith(`${dotted}.`)) return true;
  }
  // QA R4: a top-level key of the same name that is NOT a real column
  // translates to the very same meta path, so the raw-meta entry would only
  // add a duplicate clause. Real columns (e.g. `_journal`) keep both clauses.
  return k in filter && kinds[k] === undefined;
}

/**
 * Build a SQLite JSON path from a dotted meta path (or a deep-equality
 * value key). Per segment: empty or containing "[" is not expressible and
 * throws; all-digit segments use bracket indexing (array semantics, QA G6
 * convention); anything else uses dot notation.
 */
function metaPath(key: string, rest: string): string {
  let path = "$";
  for (const segment of rest.split(".")) {
    if (segment === "") {
      throw new UnsupportedMongoOperationError(`meta path "${key}" has an empty segment`);
    }
    if (segment.includes("[")) {
      throw new UnsupportedMongoOperationError(
        `meta path "${key}" cannot be expressed as a JSON path (segment "${segment}")`
      );
    }
    if (/^\d+$/.test(segment)) {
      path += `[${segment}]`;
    } else {
      path += `.${segment}`;
    }
  }
  return path;
}

/** Quote a string literal for embedding in the SQL text (JSON paths). */
function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Build the json_extract expression for a full dotted meta key
 * (e.g. "meta.address.city" -> json_extract(meta, '$.address.city')).
 * Every json_* function this module emits operates on the output of such an
 * expression, which is always valid JSON text or NULL — never a bare string
 * — so SQLite's strict JSON functions cannot raise "malformed JSON" here
 * (probed on the bundled SQLite 3.53.4; see docs/PORTING-NOTES.md).
 */
function jsonPathExpr(key: string): string {
  const dot = key.indexOf(".");
  const column = key.slice(0, dot);
  return `json_extract(${column}, ${sqlLiteral(metaPath(key, key.slice(dot + 1)))})`;
}

/**
 * Translate a field value (or meta path value) into a clause for `expr`.
 * Implements the Mongo null bucket: equality with null/false also matches
 * NULL (missing) values.
 */
function translateValue(expr: string, key: string, value: unknown, kind: ColumnKind, params: unknown[]): string {
  if (value === null || value === undefined || value === false) {
    return `(${expr} IS NULL OR ${expr} = 0)`;
  }
  if (value === true) return `${expr} = 1`;
  if (isOperatorObject(value)) return translateOperators(expr, key, value, kind, params);
  if (Array.isArray(value)) {
    if (kind !== "json") {
      throw new UnsupportedMongoOperationError(`array value is not supported for field "${key}"`);
    }
    return deepEquality(key, value, params);
  }
  if (isPlainObject(value)) {
    if (kind === "json") return deepEquality(key, value, params);
    if (kind === "objectId") return objectClause(expr, key, value, params);
    throw new UnsupportedMongoOperationError(`object value is not supported for field "${key}"`);
  }
  if (
    kind === "objectId" &&
    value !== null &&
    typeof value === "object" &&
    !(value instanceof Date)
  ) {
    // Class instances (a hydrated Document, or an ObjectId subclass) are
    // not "plain" objects but still cast to their hex id here.
    return objectClause(expr, key, value as IAnyObject, params);
  }
  params.push(coerceScalar(value, key, kind));
  return `${expr} = ?`;
}

/**
 * A Document passed as a field value (e.g. balance.spec.ts:141
 * `transactionModel.findOne({_journal: journal})`) casts to its `_id`,
 * mirroring mongoose's silent cast.
 */
function objectClause(expr: string, key: string, value: IAnyObject, params: unknown[]): string {
  // An ObjectId (or subclass) passed by value: our compat subclass carries
  // `_id` === self, but a bare bson ObjectId has no `_id` at all — when the
  // value itself renders hex, prefer that over the `_id` indirection.
  if (typeof (value as { toHexString?: unknown }).toHexString === "function") {
    params.push(coerceObjectIdScalar(value, key));
    return `${expr} = ?`;
  }
  const id = value._id;
  if (id === null || id === undefined) {
    throw new UnsupportedMongoOperationError(
      `value ${describeValue(value)} cannot be coerced to an ObjectId for field "${key}"`
    );
  }
  params.push(coerceObjectIdScalar(id, key));
  return `${expr} = ?`;
}

/** Non-empty plain object whose every key starts with "$". */
function isOperatorObject(value: unknown): value is IAnyObject {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 0) return false;
  return keys.every((k) => k.startsWith("$"));
}

function translateOperators(expr: string, key: string, ops: IAnyObject, kind: ColumnKind, params: unknown[]): string {
  const clauses: string[] = [];
  for (const op of Object.keys(ops)) {
    const value = ops[op];
    switch (op) {
      case "$gt":
      case "$gte":
      case "$lt":
      case "$lte": {
        const sqlOp = op === "$gt" ? ">" : op === "$gte" ? ">=" : op === "$lt" ? "<" : "<=";
        if (
          value === null ||
          value === undefined ||
          value === true ||
          value === false ||
          isPlainObject(value) ||
          Array.isArray(value)
        ) {
          throw new UnsupportedMongoOperationError(`unsupported operand for operator "${op}" on field "${key}"`);
        }
        params.push(coerceScalar(value, key, kind));
        clauses.push(`${expr} ${sqlOp} ?`);
        break;
      }
      case "$in": {
        if (!Array.isArray(value)) {
          throw new UnsupportedMongoOperationError(`"$in" value for field "${key}" must be an array`);
        }
        if (value.length === 0) {
          clauses.push("0 = 1");
          break;
        }
        const placeholders = value.map(() => "?").join(", ");
        value.forEach((item) => params.push(coerceScalar(item, key, kind)));
        clauses.push(`${expr} IN (${placeholders})`);
        break;
      }
      case "$ne": {
        if (value === null || value === undefined) {
          clauses.push(`${expr} IS NOT NULL`);
        } else if (value === false) {
          clauses.push(`(${expr} IS NOT NULL AND ${expr} <> 0)`);
        } else if (value === true) {
          clauses.push(`(${expr} IS NULL OR ${expr} <> 1)`);
        } else if (isPlainObject(value) || Array.isArray(value)) {
          throw new UnsupportedMongoOperationError(`unsupported $ne operand for field "${key}"`);
        } else {
          params.push(coerceScalar(value, key, kind));
          clauses.push(`(${expr} IS NULL OR ${expr} <> ?)`);
        }
        break;
      }
      default:
        throw new UnsupportedMongoOperationError(`operator "${op}" is not supported for field "${key}"`);
    }
  }
  if (clauses.length === 0) return "";
  if (clauses.length === 1) return clauses[0];
  return `(${clauses.join(" AND ")})`;
}

/**
 * JSON deep-equality with Mongo subdocument ("contains") semantics: every
 * specified leaf must match; extra keys on the stored value are allowed.
 * Arrays match by exact length and element-wise equality. $-prefixed keys
 * inside the value are literal keys (operators are only recognized at
 * field-value top level).
 *
 * `key` is the full dotted meta path (e.g. "meta.address.city"); each
 * level builds one flat json_extract expression on the root column, so
 * every json_* call sees only json_extract output (valid JSON text or
 * NULL) and the clauses stay flat and index-friendly.
 */
function deepEquality(key: string, value: unknown, params: unknown[]): string {
  const expr = jsonPathExpr(key);
  if (value === null || value === undefined || value === false) {
    return `(${expr} IS NULL OR ${expr} = 0)`;
  }
  if (value === true) return `${expr} = 1`;
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return `json_type(${expr}) = 'array' AND json_array_length(${expr}) = 0`;
    }
    params.push(value.length);
    const elementClauses = value.map((item, i) => deepEquality(`${key}.${i}`, item, params));
    return `json_type(${expr}) = 'array' AND json_array_length(${expr}) = ? AND ${elementClauses.join(" AND ")}`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).filter((k) => !isPrototypeAttribute(k));
    if (keys.length === 0) {
      return `json(${expr}) = '{}'`;
    }
    const childClauses = keys.map((k) => deepEquality(`${key}.${k}`, value[k], params));
    if (childClauses.length === 1) return childClauses[0];
    return `(${childClauses.join(" AND ")})`;
  }
  if (typeof value === "string" || typeof value === "number") {
    params.push(value);
    return `${expr} = ?`;
  }
  if (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { toHexString?: unknown }).toHexString === "function"
  ) {
    // Mongo stores ObjectIds natively inside meta documents; the SQLite
    // backend stores them as 24-char lowercase hex strings.
    params.push((value as { toHexString(): string }).toHexString().toLowerCase());
    return `${expr} = ?`;
  }
  throw new UnsupportedMongoOperationError(`unsupported value ${describeValue(value)} for meta path "${key}"`);
}

function translateOr(value: unknown, collection: CollectionName, params: unknown[]): string {
  if (!Array.isArray(value)) {
    throw new UnsupportedMongoOperationError(`"$or" value must be an array of filter objects`);
  }
  if (value.length === 0) return "0 = 1";
  const subs: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (!isPlainObject(item)) {
      throw new UnsupportedMongoOperationError(`"$or" item ${i} must be a filter object`);
    }
    const sub = translateFields(item, collection, params).where;
    if (sub === "") subs.push("1 = 1");
    else if (sub.includes(" AND ")) subs.push(`(${sub})`);
    else subs.push(sub);
  }
  if (subs.length === 1) return subs[0];
  return `(${subs.join(" OR ")})`;
}

function isPlainObject(value: unknown): value is IAnyObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function coerceScalar(value: unknown, key: string, kind: ColumnKind): unknown {
  if (value === null || value === undefined) return null;
  switch (kind) {
    case "objectId":
      return coerceObjectIdScalar(value, key);
    case "date": {
      if (value instanceof Date) return storedDateTime(value);
      if (typeof value === "number" || typeof value === "string") {
        const d = new Date(value);
        if (!Number.isNaN(d.getTime())) return storedDateTime(d);
      }
      throw new UnsupportedMongoOperationError(
        `value ${describeValue(value)} cannot be coerced to a date for field "${key}"`
      );
    }
    case "bool": {
      if (value === true) return 1;
      if (value === false) return 0;
      throw new UnsupportedMongoOperationError(`value ${describeValue(value)} is not a boolean for field "${key}"`);
    }
    case "real":
    case "int": {
      if (typeof value === "number") return value;
      throw new UnsupportedMongoOperationError(`value ${describeValue(value)} is not a number for field "${key}"`);
    }
    case "text":
    case "json": {
      if (typeof value === "string" || typeof value === "number") return value;
      // ObjectId-valued meta fields (e.g. parseBalanceQuery puts the raw
      // _journal ObjectId into meta) compare against the stored hex string.
      if (
        value !== null &&
        typeof value === "object" &&
        typeof (value as { toHexString?: unknown }).toHexString === "function"
      ) {
        return (value as { toHexString(): string }).toHexString().toLowerCase();
      }
      throw new UnsupportedMongoOperationError(`value ${describeValue(value)} is not a string for field "${key}"`);
    }
  }
}

function coerceObjectIdScalar(value: unknown, key: string): string {
  if (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { toHexString?: unknown }).toHexString === "function"
  ) {
    return (value as { toHexString(): string }).toHexString().toLowerCase();
  }
  if (typeof value === "string" && HEX_24.test(value)) return value.toLowerCase();
  throw new UnsupportedMongoOperationError(
    `value ${describeValue(value)} cannot be coerced to an ObjectId for field "${key}"`
  );
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

/**
 * Formats a date in exactly the TEXT format the Prisma/better-sqlite3 adapter
 * stores DateTime values as (`YYYY-MM-DDTHH:MM:SS.mmm+00:00` — verified
 * empirically against rows written through `prisma.transaction.create`).
 * Date comparisons on the SQLite backend are lexicographic text comparisons,
 * so the query parameter must be byte-compatible with the stored text;
 * `Date.toISOString()`'s `Z` suffix would break boundary comparisons
 * (`"…+00:00" < "…Z"` in lex order at the same instant).
 */
export function storedDateTime(date: Date): string {
  return date.toISOString().replace(/Z$/, "+00:00");
}
