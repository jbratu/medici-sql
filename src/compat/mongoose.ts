/**
 * Compatibility layer for the "mongoose" module specifier.
 *
 * Upstream business logic (src/Book.ts, src/Entry.ts, src/models/*.ts) is
 * copied verbatim and imports from "mongoose". tsc resolves that specifier
 * to this module via `paths` in the tsconfigs, and the post-build `tsc-alias`
 * step rewrites the emitted require() specifiers to relative paths — so no
 * module named "mongoose" is shipped or depended on (QA M10/M16; see
 * docs/PORTING-NOTES.md).
 *
 * STATUS: placeholder stub (ITD-90). It exists so the scaffold builds,
 * lints, and can be packed and required with no mongoose present. It is
 * deliberately loose-typed, but its return types are typed enough (not raw
 * `any`) that the verbatim callback parameters in Book.ts/Entry.ts get
 * contextual typing and the strict build passes. ITD-91 replaces this file
 * with the real compat core (ObjectId, Schema, Model/Document, connection,
 * ClientSession) backed by Prisma; ITD-94 re-derives src/models/*.ts.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

// Namespace (not ES module syntax) on purpose: it mirrors mongoose's
// `Types.ObjectId` shape, which the verbatim code references in type positions.
/* eslint-disable-next-line @typescript-eslint/no-namespace */
export namespace Types {
  export class ObjectId {
    private readonly bytes: Buffer;

    constructor(id?: string | number | Buffer) {
      if (id === undefined) {
        this.bytes = Buffer.alloc(12);
      } else if (typeof id === "string") {
        this.bytes = Buffer.from(id, "hex");
      } else if (typeof id === "number") {
        this.bytes = Buffer.alloc(12);
        this.bytes.writeUInt32BE(id >>> 0, 0);
      } else {
        this.bytes = Buffer.from(id);
      }
    }

    toHexString(): string {
      return this.bytes.toString("hex");
    }

    getTimestamp(): Date {
      const seconds = this.bytes.readUInt32BE(0);
      return new Date(seconds * 1000);
    }

    toString(): string {
      return this.toHexString();
    }

    equals(other: ObjectId | string): boolean {
      const oid = other instanceof ObjectId ? other : new ObjectId(String(other));
      return this.bytes.equals(oid.bytes);
    }
  }
}

/** Cursor-like result of find()/aggregate(): the verbatim code awaits toArray(). */
export interface Cursor<T = any> {
  toArray(): Promise<T[]>;
}

/**
 * Native-mongo-collection-shaped surface. Every DB call in the verbatim
 * upstream code goes through `<model>.collection.*`; ITD-91 re-implements
 * this over Prisma.
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
 * Model-shaped surface. The verbatim code only constructs documents
 * (`new transactionModel(tx)`) and uses `.collection`; the index signature
 * is a catch-all for the ITD-91/94 surface.
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

export type ClientSession = any;

export const connection: {
  models: Record<string, any>;
  deleteModel(name: string): void;
} = {
  models: {},
  deleteModel(name) {
    void name;
  },
};

export function model<T = any>(name: string, schema?: unknown, collection?: string): Model<T> {
  void name;
  void schema;
  void collection;
  return {} as Model<T>;
}

export class Schema<T = any> {
  /** Phantom member so the generic parameter counts as used (noUnusedLocals). */
  declare readonly __schemaType?: T;

  paths: Record<string, any> = {};

  constructor(definition?: any, options?: any) {
    void definition;
    void options;
  }

  index(spec?: Record<string, any> | null, options?: any): this {
    void spec;
    void options;
    return this;
  }

  static Types: {
    Mixed: any;
    ObjectId: typeof Types.ObjectId;
    Date: typeof Date;
    Boolean: typeof Boolean;
    String: typeof String;
    Number: typeof Number;
  } = {
    Mixed: class SchemaTypeMixed {},
    ObjectId: Types.ObjectId,
    Date,
    Boolean,
    String,
    Number,
  };
}
