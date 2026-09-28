import type { IAnyObject } from "../IAnyObject";
import type { Types } from "../compat/mongoose";
import type { ClientSession } from "./session";

// Type-only contract module (ITD-97): the public connection/collection
// surface types live here so that modules in the tsd type-test program
// (the "mongoose" compat alias, spec/types/*) can name them WITHOUT importing
// src/database/connection.ts — whose value-level imports pull the generated
// Prisma client d.ts into the program, and that multi-file d.ts does not
// type-check under the older TypeScript that tsd bundles (see also the note
// in ./session.ts). Runtime modules (connection.ts, sqlCollection.ts) keep
// importing these types from here, so the public bundle is unchanged.

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

/**
 * The connection object — the port's transaction boundary (ITD-102, compat
 * core C). Mirrors the client-facing `mongoose.connection` surface the
 * upstream specs and Book/Entry flows use:
 *
 *   connection.transaction(fn, options?)  — retrying interactive transaction
 *   connection.connect(url?) / .disconnect()
 *   connection.db.collection(name)        — collection accessor
 *
 * `transaction` opens a Prisma interactive transaction on the singleton
 * client, passes a ClientSession to `fn`, commits on resolve, rolls back on
 * throw, and retries on SQLite write contention per the ITD-89 spike
 * (spike/FINDINGS.md section d): retriable errors only (P2028 start timeout,
 * cause-SQLITE_BUSY/LOCKED), exponential backoff with jitter, max 5
 * attempts, and the original error is re-thrown when retries are exhausted.
 */
export interface MediciConnection {
  /** Connect the singleton client, applying the port pragmas (WAL once, synchronous=NORMAL per connect). A different url rebuilds the singleton. */
  connect(url?: string): Promise<void>;
  /** Disconnect and forget the singleton (test teardown). */
  disconnect(): Promise<void>;
  /**
   * Run `fn` inside an interactive transaction. `fn` receives the
   * ClientSession (route writes through `session.client` / pass the session
   * to adapter methods). Commits on resolve, rolls back on throw, retries
   * per the spike's policy (options: maxWait, timeout, retries,
   * retryBaseDelayMs, retryMaxDelayMs — loose IAnyObject, unknown keys ignored).
   */
  transaction<T>(fn: (session: ClientSession) => Promise<T>, options?: IAnyObject): Promise<T>;
  /** Collection accessor for the four medici collections (interim adapter, ITD-92/93 extend it). */
  collection(name: string): SqlCollection;
  /** Mongoose-shaped `connection.db` handle. */
  readonly db: { name: string; collection(name: string): SqlCollection };
}
