/**
 * Read-side type mapping for the Model / query layer — compat core B
 * (ITD-101).
 *
 * Applies, at the Model layer, the same mapping QA M8/G9 (ITD-93) specifies
 * for the raw collection adapter:
 * - `_id` / `_journal` / `_original_journal` (and any schema-declared
 *   ObjectId path) -> `Types.ObjectId`
 * - `account_path` TEXT JSON -> `string[]`
 * - `meta` TEXT JSON -> object (model-aware, see META_AS_STRING_MODELS)
 * - `journal._transactions` TEXT JSON -> `Types.ObjectId[]`
 * - date columns -> `Date`
 * - NULL / undefined columns OMITTED from the returned document, not
 *   returned as `null` (Mongo omits unset fields).
 *
 * The mapping is IDEMPOTENT: rows the raw adapter (ITD-93) has already
 * hydrated pass through unchanged, so it is safe whether or not ITD-93 also
 * applies the mapping. That is what lets `.lean()` return plain objects that
 * still carry hydrated types (xacid.spec.ts:542 calls `.getTime()` through
 * `.lean()`).
 *
 * Module-load purity (S3): bson and type-level imports only — nothing here
 * constructs a Prisma client or touches the filesystem.
 */
import { ObjectId as BsonObjectId } from "bson";
import type { IAnyObject } from "../IAnyObject";
import { Schema, SchemaTypeArray, SchemaTypeDate, SchemaTypeObjectId, SchemaTypeString, Types } from "./mongoose";

type PathKind = "objectid" | "objectid-array" | "string-array" | "date" | "meta" | "plain";

const HEX24 = /^[0-9a-f]{24}$/i;

const OBJECTID: PathKind = "objectid";
const OBJECTID_ARRAY: PathKind = "objectid-array";
const STRING_ARRAY: PathKind = "string-array";
const DATE: PathKind = "date";
const META: PathKind = "meta";
const PLAIN: PathKind = "plain";

/**
 * Upstream stores `medici_balances.meta` as a JSON STRING (models/balance.ts
 * explicitly `JSON.stringify`s it before insert) and the vendored spec pins
 * that shape: book.spec.ts:350/374 assert string equality on a Model-level
 * `balanceModel.find`. `medici_transactions.meta` is stored as an OBJECT
 * (Entry.commit inserts the meta object as-is) and the ledger specs read it
 * back as an object (book.spec.ts:224, balance.spec.ts:203). Both schemas
 * declare `Schema.Types.Mixed`, so the read-side rule is model-aware.
 */
const META_AS_STRING_MODELS = new Set(["Medici_Balance"]);

function toObjectId(value: unknown): unknown {
  if (value instanceof BsonObjectId) {
    return value instanceof Types.ObjectId ? value : new Types.ObjectId(value.toHexString());
  }
  if (typeof value === "string" && HEX24.test(value)) {
    return new Types.ObjectId(value.toLowerCase());
  }
  return value;
}

function toObjectIdArray(value: unknown): unknown {
  let elements: unknown[];
  if (Array.isArray(value)) {
    elements = value;
  } else if (typeof value === "string" && value.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      elements = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return value;
    }
  } else {
    return value;
  }
  return elements.map((element) => toObjectId(element));
}

function toStringArray(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      /* not JSON: leave as-is */
    }
  }
  return value;
}

function toDate(value: unknown): unknown {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) {
    return new Date(value);
  }
  return value;
}

/** Model-aware `meta` rule — see META_AS_STRING_MODELS. */
function toMeta(modelName: string, value: unknown): unknown {
  if (typeof value === "string" && !META_AS_STRING_MODELS.has(modelName)) {
    try {
      const parsed = JSON.parse(value);
      if (parsed !== null && typeof parsed === "object") {
        return parsed;
      }
    } catch {
      /* not JSON: leave as-is */
    }
  }
  return value;
}

/**
 * Resolve how a row key is typed. Schema descriptors win; the name-based
 * fallbacks cover the implicit `_id` and the degenerate case of a model
 * registered with a bare `new Schema()`.
 */
function pathKind(schema: Schema | undefined, key: string): PathKind {
  if (key === "_id") {
    return OBJECTID;
  }

  const descriptor = schema?.paths?.[key];
  if (descriptor instanceof SchemaTypeObjectId) {
    return OBJECTID;
  }
  if (descriptor instanceof SchemaTypeArray) {
    if (descriptor.element instanceof SchemaTypeObjectId) {
      return OBJECTID_ARRAY;
    }
    if (descriptor.element instanceof SchemaTypeString) {
      return STRING_ARRAY;
    }
    return PLAIN;
  }
  if (descriptor instanceof SchemaTypeDate) {
    return DATE;
  }

  switch (key) {
    case "_journal":
    case "_original_journal":
    case "transaction":
      return OBJECTID;
    case "_transactions":
      return OBJECTID_ARRAY;
    case "account_path":
      return STRING_ARRAY;
    case "meta":
      return META;
    default:
      return PLAIN;
  }
}

/**
 * Map one raw row (as the collection adapter returns it) to Mongo-shaped
 * values. NULL / undefined columns are omitted; every conversion is
 * idempotent, so already-hydrated rows pass through unchanged.
 */
export function hydrateRow(schema: Schema | undefined, modelName: string, row: IAnyObject): IAnyObject {
  const out: IAnyObject = {};

  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === undefined) {
      continue;
    }

    switch (pathKind(schema, key)) {
      case OBJECTID:
        out[key] = toObjectId(value);
        break;
      case OBJECTID_ARRAY:
        out[key] = toObjectIdArray(value);
        break;
      case STRING_ARRAY:
        out[key] = toStringArray(value);
        break;
      case DATE:
        out[key] = toDate(value);
        break;
      case META:
        out[key] = toMeta(modelName, value);
        break;
      default:
        out[key] = value;
        break;
    }
  }

  return out;
}
