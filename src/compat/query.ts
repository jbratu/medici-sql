/**
 * Chainable, awaitable query objects for the Model layer — compat core B
 * (ITD-101).
 *
 * `M.find(filter)`, `M.findOne(filter)` and `M.deleteMany(filter)` return a
 * Query supporting both `.sort()` forms the vendored specs use (".sort
 * (\"-_id\")" in balance.spec.ts:141, ".sort({_id: -1})" in general),
 * `.lean()`, `.exec()`, and direct await without `.exec()` (book.spec.ts:307).
 *
 * `find` / `findOne` return hydrated Documents by default and plain objects
 * under `.lean()` — the plain objects still carry hydrated types, since the
 * mapping (ITD-101/hydration) runs before the Document wrapping is skipped
 * (xacid.spec.ts:542 calls `.getTime()` on a date read through `.lean()`).
 *
 * `sort` is delegated to the collection adapter (ITD-93), which implements
 * it in SQL; with no sort, `find` preserves the adapter's natural (insertion)
 * order — book.spec.ts:395-397 reads `snapshots[0]` as the older snapshot.
 *
 * Module-load purity (S3): this file imports hydration and type-level
 * helpers only; nothing here constructs a Prisma client or touches the
 * filesystem.
 */
import type { IAnyObject } from "../IAnyObject";
import { hydrateRow } from "./hydration";
import type { Collection, Schema } from "./mongoose";

/**
 * The Model-constructor surface Query needs, taken by value. Declared here
 * (and imported as a type from mongoose.ts) to keep the runtime import graph
 * one-directional: mongoose.ts -> query.ts -> hydration.ts.
 */
export interface QueryHost {
  modelName: string;

  schema: Schema;

  collection: Collection<any>;

  new (doc?: IAnyObject): any;
}

type SortSpec = string | IAnyObject;

export class Query<T = any> {
  private _sortSpec?: SortSpec;

  private _lean = false;

  constructor(
    private host: QueryHost,
    private op: "find" | "findOne" | "deleteMany",
    private filter: IAnyObject
  ) {}

  sort(spec: SortSpec): this {
    this._sortSpec = spec;
    return this;
  }

  lean(): this {
    this._lean = true;
    return this;
  }

  /**
   * `any` on purpose: the result shape depends on the operation (row array,
   * single row / null, delete result); the facade is untyped at this seam.
   */
  exec(): Promise<any> {
    const options: IAnyObject = {};
    if (this._sortSpec !== undefined) {
      options.sort = this._sortSpec;
    }

    if (this.op === "deleteMany") {
      return this.host.collection.deleteMany(this.filter, options) as Promise<T>;
    }

    if (this.op === "findOne") {
      return this.host.collection
        .findOne(this.filter, options)
        .then((row: any) => (row === null || row === undefined ? null : this.materialize(row)));
    }

    return this.host.collection
      .find(this.filter, options)
      .toArray()
      .then((rows: any[]) => rows.map((row) => this.materialize(row)));
  }

  /**
   * Apply the (idempotent) hydration mapping, then either wrap the row in a
   * Document (default) or return it as a plain object (`.lean()`).
   */
  private materialize(row: any): any {
    const hydrated = hydrateRow(this.host.schema, this.host.modelName, row);
    if (this._lean) {
      return hydrated;
    }
    return new this.host(hydrated);
  }

  /**
   * Thenable: `await M.find(...)` works without `.exec()` (book.spec.ts:307).
   */
  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.exec().then(onfulfilled, onrejected);
  }

  catch<TResult = never>(onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | null): Promise<T | TResult> {
    return this.exec().catch(onrejected);
  }
}
