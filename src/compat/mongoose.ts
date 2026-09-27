/**
 * Compatibility layer for the "mongoose" module specifier — Compat core A
 * (ITD-91).
 *
 * Upstream business logic (src/Book.ts, src/Entry.ts, src/models/*.ts) is
 * copied verbatim and imports from "mongoose". tsc resolves that specifier
 * to this module via `paths` in the tsconfigs, and the post-build
 * `tsc-alias` step rewrites the emitted require() specifiers to relative
 * paths — so no module named "mongoose" is shipped or depended on (QA M10;
 * see docs/PORTING-NOTES.md).
 *
 * This file is sized to exactly what the verbatim code and the DB-free
 * spec checkpoint touch:
 *
 * - `Types.ObjectId`: a local SUBCLASS of `bson`'s ObjectId carrying the
 *   mongoose 7.x `_id`-returns-self getter (QA M4). mongoose's
 *   Types.ObjectId is not bson's ObjectId — `new mongoose.Types.ObjectId()`
 *   has `_id === self` while bare bson returns `undefined` — and the
 *   vendored specs read `._journal._id` (QA S10: we do NOT patch
 *   bson's prototype, so other bson/mongodb consumers in the process are
 *   unaffected). `instanceof Types.ObjectId` passes because this library
 *   produces the instances; it owns both sides of that comparison.
 * - `Schema` with `.paths` (implicit `_id` included), `.index()` recording,
 *   and `Schema.Types.*` descriptor classes (QA M5: a bare
 *   `Schema.Types.ObjectId` is accepted as a path definition).
 * - `Model`/`Document` in the construction+validation shape only: `new
 *   Model(doc)` yields a Document with `_id` generated immediately (Entry.ts
 *   reads `this.journal._id` before the journal row exists), schema
 *   defaults applied, `validate()` rejecting with the `"<ModelName>
 *   validation failed: <path>: <reason>"` message shape (QA M6), and
 *   `toObject()`. The query surface (find/findOne/sort/lean/hydration) is
 *   ITD-101; `connection.transaction`/retry/ClientSession is ITD-102;
 *   `<model>.collection.*` is ITD-93.
 * - `connection.models` / `connection.deleteModel` / `model()` so the
 *   verbatim setXSchema registration (and deleteModel + re-register
 *   round trips, QA M6) works.
 *
 * Nothing here constructs a Prisma client or touches the filesystem at
 * import time (QA S3).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { ObjectId as BsonObjectId } from "bson";
import type { IAnyObject } from "../IAnyObject";
import { UnsupportedMongoOperationError } from "../errors/UnsupportedMongoOperationError";

// Namespace (not ES module syntax) on purpose: it mirrors mongoose's
// `Types.ObjectId` shape, which the verbatim code references in type positions.
/* eslint-disable-next-line @typescript-eslint/no-namespace */
export namespace Types {
  /**
   * bson ObjectId with the mongoose 7.x `_id`-returns-self getter (QA M4).
   * The inherited constructor accepts no argument, a hex string, or an
   * existing ObjectId instance, exactly like bson's.
   */
  export class ObjectId extends BsonObjectId {
    get _id(): Types.ObjectId {
      return this;
    }
  }
}

/** Base class for path type descriptors (mongoose `Schema.Types.*` stand-ins). */
export class SchemaType {
  path: string;

  /** Schema-declared default, applied to documents that omit the path. */
  default: unknown;

  hasDefault: boolean;

  constructor(path?: string) {
    this.path = path ?? "";
    this.default = undefined;
    this.hasDefault = false;
  }
}

export class SchemaTypeObjectId extends SchemaType {
  ref?: string;

  constructor(path?: string, options?: { ref?: string }) {
    super(path);
    this.ref = options?.ref;
  }
}

export class SchemaTypeMixed extends SchemaType {}

export class SchemaTypeString extends SchemaType {}

export class SchemaTypeNumber extends SchemaType {}

export class SchemaTypeDate extends SchemaType {}

export class SchemaTypeBoolean extends SchemaType {}

export class SchemaTypeArray extends SchemaType {
  element: SchemaType;

  constructor(path: string | undefined, element: SchemaType) {
    super(path);
    this.element = element;
  }
}

/** Error thrown by Document.validate(); message shape is part of the contract (QA M6). */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * Mongoose-shaped schema. Only the surface the verbatim code and the
 * DB-free specs use: `.paths` (with an implicit `_id`), `.index()`
 * recording, and `Schema.Types`. Options such as `{id: false, versionKey:
 * false, timestamps: false}` are accepted and inert.
 */
export class Schema<T = any> {
  /** Phantom member so the generic parameter counts as used (noUnusedLocals). */
  declare readonly __schemaType?: T;

  /** Field name -> path type descriptor. Always includes the implicit `_id`. */
  paths: Record<string, SchemaType> = {};

  /** Recorded .index() calls; index DDL is Prisma's job (ITD-93/101). */
  indexes: Array<{ keys: IAnyObject; options?: IAnyObject }> = [];

  /** Accepted and inert (id / versionKey / timestamps). */
  options: IAnyObject = {};

  /**
   * mongoose `Schema.Types` = the path type descriptor classes. NOTE:
   * `Schema.Types.ObjectId` (this) is distinct from `Types.ObjectId`
   * (the bson subclass value class) — the verbatim code uses both, in
   * different positions.
   */
  static Types: {
    Mixed: typeof SchemaTypeMixed;
    ObjectId: typeof SchemaTypeObjectId;
    String: typeof SchemaTypeString;
    Number: typeof SchemaTypeNumber;
    Date: typeof SchemaTypeDate;
    Boolean: typeof SchemaTypeBoolean;
  } = {
    Mixed: SchemaTypeMixed,
    ObjectId: SchemaTypeObjectId,
    String: SchemaTypeString,
    Number: SchemaTypeNumber,
    Date: SchemaTypeDate,
    Boolean: SchemaTypeBoolean,
  };

  constructor(definition?: IAnyObject, options?: IAnyObject) {
    if (options) {
      this.options = { ...options };
    }

    const defs = definition ?? {};

    // mongoose adds an implicit auto _id path unless the definition
    // provides one; the implicit path is what makes
    // extractObjectIdKeysFromSchema report "_id".
    if (!("_id" in defs)) {
      this.paths["_id"] = new SchemaTypeObjectId("_id");
    }

    for (const [key, def] of Object.entries(defs)) {
      this.paths[key] = key === "_id" ? new SchemaTypeObjectId("_id") : Schema.interpretDefinition(key, def);
    }
  }

  index(spec?: IAnyObject | null, options?: IAnyObject): this {
    if (spec) {
      this.indexes.push({ keys: spec, options });
    }
    return this;
  }

  /**
   * Map a path definition to a descriptor instance. Accepted forms
   * (exhaustive for this codebase):
   * - JS constructors: Number, String, Date, Boolean
   * - `Types.ObjectId` (the bson subclass) or a bson ObjectId class/instance
   * - `Schema.Types.ObjectId` / `Schema.Types.Mixed` classes or instances
   * - `[String]` / `[{ type: Schema.Types.ObjectId, ref: "..." }]` arrays
   * - `{ type: ..., default?: ..., ref?: ... }`
   * - anything else: Mixed
   */
  /**
   * Handle the direct-reference forms (constructors, id classes, descriptor
   * classes/instances, arrays). Returns undefined when the definition needs
   * object-form interpretation.
   */
  private static directDescriptor(key: string, def: unknown): SchemaType | undefined {
    if (Array.isArray(def)) {
      return new SchemaTypeArray(key, Schema.interpretDefinition(key, def[0]));
    }

    switch (def) {
      case Number:
        return new SchemaTypeNumber(key);
      case String:
        return new SchemaTypeString(key);
      case Date:
        return new SchemaTypeDate(key);
      case Boolean:
        return new SchemaTypeBoolean(key);
      case Types.ObjectId:
      case BsonObjectId:
      case SchemaTypeObjectId:
        return new SchemaTypeObjectId(key);
      case SchemaTypeMixed:
        return new SchemaTypeMixed(key);
    }

    if (def instanceof Types.ObjectId || def instanceof BsonObjectId) {
      return new SchemaTypeObjectId(key);
    }

    if (def instanceof SchemaType) {
      return def;
    }

    return undefined;
  }

  /** `{ type: ..., ref?: ..., default?: ... }` object form. */
  private static interpretObjectDefinition(key: string, t: IAnyObject): SchemaType {
    if (t.type === undefined) {
      return new SchemaTypeMixed(key);
    }
    const base = Schema.interpretDefinition(key, t.type);
    if (t.ref !== undefined && base instanceof SchemaTypeObjectId) {
      base.ref = String(t.ref);
    }
    if (t.default !== undefined) {
      base.default = t.default;
      base.hasDefault = true;
    }
    return base;
  }

  private static interpretDefinition(key: string, def: unknown): SchemaType {
    if (def === null || def === undefined) {
      return new SchemaTypeMixed(key);
    }
    const direct = Schema.directDescriptor(key, def);
    if (direct !== undefined) {
      return direct;
    }
    if (typeof def === "object") {
      return Schema.interpretObjectDefinition(key, def as IAnyObject);
    }
    return new SchemaTypeMixed(key);
  }
}

function castObjectId(value: unknown): { value: unknown; error?: string } {
  if (value instanceof BsonObjectId) {
    return { value };
  }
  if (typeof value === "string" && /^[0-9a-f]{24}$/.test(value)) {
    return { value: new Types.ObjectId(value) };
  }
  return { value, error: `Cast to ObjectId failed for value ${JSON.stringify(value)}` };
}

function castDate(value: unknown): { value: unknown; error?: string } {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return { value };
  }
  if (typeof value === "number") {
    return { value: new Date(value) };
  }
  if (typeof value === "string") {
    const d = new Date(value);
    if (!isNaN(d.getTime())) {
      return { value: d };
    }
  }
  return { value, error: `Cast to Date failed for value ${JSON.stringify(value)}` };
}

function castArray(key: string, value: unknown, type: SchemaTypeArray): { value: unknown; error?: string } {
  if (!Array.isArray(value)) {
    return { value, error: `Cast to Array failed for value ${JSON.stringify(value)}` };
  }
  const out: unknown[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const element = castValue(`${key}.${i}`, value[i], type.element);
    if (element.error) {
      return { value, error: element.error };
    }
    out.push(element.value);
  }
  return { value: out };
}

function castValue(key: string, value: unknown, type: SchemaType): { value: unknown; error?: string } {
  if (type instanceof SchemaTypeObjectId) {
    return castObjectId(value);
  }
  if (type instanceof SchemaTypeNumber) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return { value };
    }
    return { value, error: `Cast to Number failed for value ${JSON.stringify(value)}` };
  }
  if (type instanceof SchemaTypeString) {
    if (typeof value === "string") {
      return { value };
    }
    return { value, error: `Cast to String failed for value ${JSON.stringify(value)}` };
  }
  if (type instanceof SchemaTypeBoolean) {
    if (typeof value === "boolean") {
      return { value };
    }
    return { value, error: `Cast to Boolean failed for value ${JSON.stringify(value)}` };
  }
  if (type instanceof SchemaTypeDate) {
    return castDate(value);
  }
  if (type instanceof SchemaTypeArray) {
    return castArray(key, value, type);
  }
  return { value };
}

function makeUnwiredCollection(modelName: string): Collection<any> {
  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      if (typeof prop === "string" && !Object.prototype.hasOwnProperty.call(Object.prototype, prop)) {
        return () => {
          throw new UnsupportedMongoOperationError(`${modelName}.collection.${prop} (collection adapter, ITD-93)`);
        };
      }
      return undefined;
    },
  };
  return new Proxy({}, handler) as unknown as Collection<any>;
}

/**
 * Register (or re-register) a model on `connection.models`. The returned
 * value is the mongoose-shaped model constructor: `new M(doc)` builds a
 * Document (schema defaults applied, `_id` generated immediately), while
 * `M.collection` / `M.modelName` / `M.schema` / `M.diffIndexes()` are
 * statics. Re-registration replaces any previous model under the name; the
 * verbatim setXSchema functions always deleteModel first.
 */
export function model<T = any>(name: string, schema?: Schema, collection?: string): Model<T> {
  const s = schema ?? new Schema();
  let collectionCache: Collection<any> | undefined;

  class CompatModelConstructor {
    static readonly modelName = name;

    static readonly schema = s;

    static readonly collectionName = collection;

    static get collection(): Collection<any> {
      if (!collectionCache) {
        collectionCache = makeUnwiredCollection(name);
      }
      return collectionCache;
    }

    /**
     * Sanctioned minimal diff (QA R4): index DDL is Prisma's job and the
     * upstream test asserting specific diff contents is a Tier C carve-out.
     */
    static diffIndexes(): { toDrop: string[]; toCreate: string[] } {
      return { toDrop: [], toCreate: [] };
    }

    static syncIndexes(): Promise<void> {
      throw new UnsupportedMongoOperationError(`${name}.syncIndexes (index synchronization, ITD-101)`);
    }

    constructor(doc?: IAnyObject) {
      if (!(this instanceof CompatModelConstructor)) {
        return new CompatModelConstructor(doc);
      }

      for (const [key, type] of Object.entries(CompatModelConstructor.schema.paths)) {
        if (type.hasDefault && !(doc && key in doc)) {
          (this as any)[key] = type.default;
        }
      }

      if (doc) {
        for (const [key, value] of Object.entries(doc)) {
          if (value !== undefined) {
            (this as any)[key] = value;
          }
        }
      }

      const id = (this as any)._id;
      if (!id) {
        (this as any)._id = new Types.ObjectId();
      } else if (typeof id === "string" && /^[0-9a-f]{24}$/.test(id)) {
        (this as any)._id = new Types.ObjectId(id);
      }
    }

    /**
     * Type-checks the document against the schema. Casts where possible
     * (e.g. numeric/parseable-string dates, hex-string ObjectIds) and
     * rejects with `"<ModelName> validation failed: <path>: <reason>"`
     * (QA M6; the model name comes from the static, so it survives a
     * deleteModel + re-register round trip).
     */
    validate(): Promise<this> {
      const problems: string[] = [];

      for (const [key, type] of Object.entries(CompatModelConstructor.schema.paths)) {
        const value = (this as any)[key];
        if (!(key in this) || value === undefined) {
          continue;
        }
        const cast = castValue(key, value, type);
        if (cast.error) {
          problems.push(`${key}: ${cast.error}`);
        } else {
          (this as any)[key] = cast.value;
        }
      }

      if (problems.length > 0) {
        return Promise.reject(
          new ValidationError(`${CompatModelConstructor.modelName} validation failed: ${problems.join(", ")}`)
        );
      }

      return Promise.resolve(this);
    }

    toObject(): IAnyObject {
      const out: IAnyObject = {};
      for (const [key, value] of Object.entries(this)) {
        if (typeof value !== "function") {
          out[key] = value;
        }
      }
      return out;
    }

    save(): Promise<never> {
      return Promise.reject(new UnsupportedMongoOperationError("Document.save (collection adapter, ITD-93)"));
    }

    deleteOne(): Promise<never> {
      return Promise.reject(new UnsupportedMongoOperationError("Document.deleteOne (collection adapter, ITD-93)"));
    }
  }

  connection.models[name] = CompatModelConstructor as unknown as Model<T>;
  return CompatModelConstructor as unknown as Model<T>;
}

export const connection: {
  models: Record<string, any>;
  deleteModel(name: string): any;
  model: typeof model;
} = {
  models: {},
  deleteModel(name) {
    const m = connection.models[name];
    delete connection.models[name];
    return m;
  },
  model,
};

/**
 * Connection lifecycle is Prisma-backed and lands with ITD-102
 * (connection.transaction / ClientSession); until then these fail loudly
 * instead of pretending.
 */
export function connect(url?: string): Promise<typeof connection> {
  void url;
  return Promise.reject(
    new UnsupportedMongoOperationError("connection.connect (Prisma-backed connection lifecycle, ITD-102)")
  );
}

export function disconnect(): Promise<void> {
  return Promise.reject(
    new UnsupportedMongoOperationError("connection.disconnect (Prisma-backed connection lifecycle, ITD-102)")
  );
}

/** Cursor-like result of find()/aggregate(): the verbatim code awaits toArray(). */
export interface Cursor<T = any> {
  toArray(): Promise<T[]>;
}

/**
 * Native-mongo-collection-shaped surface. Every DB call in the verbatim
 * upstream code goes through `<model>.collection.*`; the collection adapter
 * (ITD-93) implements it over Prisma. `find` is load-bearing for the type
 * IFilter (src/helper/parse/IFilter.ts derives IFilter from it).
 */
export interface Collection<T = any> {
  // Result type is `any` (not T): the verbatim code treats aggregate/find
  // results as untyped projection documents (mirrors mongoose's
  // `aggregate<T = any>` / `find<ResultDoc = any>`), and casts at the use
  // site (e.g. Book.ts `as T[]`). Returning T here would reject those casts.
  aggregate(pipeline?: any, options?: any): Cursor<any>;
  find(query?: any, options?: any): Cursor<any>;
  findOne(query?: any, options?: any): Promise<T | null>;
  insertOne(doc: any, options?: any): Promise<any>;
  insertMany(docs: any, options?: any): Promise<any>;
  updateOne(filter: any, update: any, options?: any): Promise<any>;
  updateMany(filter: any, update: any, options?: any): Promise<any>;
  upsert(filter: any, update: any, options?: any): Promise<any>;
  deleteOne(filter: any, options?: any): Promise<any>;
  deleteMany(filter: any, options?: any): Promise<any>;
  countDocuments(filter?: any, options?: any): Promise<number>;
  distinct(field: any, filter?: any, options?: any): Promise<any[]>;
  [key: string]: any;
}

/**
 * Model-shaped surface. The verbatim code constructs documents
 * (`new transactionModel(tx)`) and uses `.collection`; the index signature
 * is a catch-all for the ITD-101/93 surface.
 */
export interface Model<T = any> {
  new (doc?: any): any;
  collection: Collection<T>;
  [key: string]: any;
}

export interface Document {
  validate(options?: any): Promise<any>;
  toObject(options?: any): any;
  [key: string]: any;
}

export type FilterQuery<T> = { [K in keyof T]?: any } & Record<string, any>;

/** Prisma-interactive-transaction-backed ClientSession lands in ITD-102. */
export type ClientSession = any;
