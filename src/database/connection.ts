import { IAnyObject } from "../IAnyObject";
import { connectPrisma, currentSingletonUrl, databaseUrl, disconnectPrisma, getPrismaClient } from "./client";
import { ClientSession } from "./session";
import { parseTransactionOptions, runWithRetry } from "./transaction";
import { createSqlCollection, SqlCollection } from "./sqlCollection";
import { ensureSchemaLazy } from "./schema";

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
 *
 * Module-load purity (QA S3): constructing this object does no I/O; the
 * Prisma client (and its SQLite file) are created lazily on the first
 * connect()/transaction() call.
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

class Connection implements MediciConnection {
  private _db: { name: string; collection: (name: string) => SqlCollection } | undefined;

  async connect(url?: string): Promise<void> {
    const target = url ?? databaseUrl();
    const existing = currentSingletonUrl();
    if (existing !== undefined && existing !== target) {
      // A different url means a different database: rebuild the singleton.
      await disconnectPrisma();
    }
    await connectPrisma(target);
  }

  async disconnect(): Promise<void> {
    await disconnectPrisma();
  }

  async transaction<T>(fn: (session: ClientSession) => Promise<T>, options?: IAnyObject): Promise<T> {
    // initialize() is optional: bootstrap (connect + schema) on first use.
    await ensureSchemaLazy();
    const prisma = getPrismaClient();
    const opts = parseTransactionOptions(options);
    const txOpts: { maxWait?: number; timeout?: number } = {};
    if (opts.maxWait !== undefined) {
      txOpts.maxWait = opts.maxWait;
    }
    if (opts.timeout !== undefined) {
      txOpts.timeout = opts.timeout;
    }

    return runWithRetry<T>(
      async (): Promise<T> => {
        const session = new ClientSession();
        try {
          // The await is load-bearing: a bare `return promise` would let the
          // rejection escape as this function's rejection without the
          // session-close ordering the await guarantees, and runWithRetry's
          // catch relies on observing the settlement. no-return-await
          // conflicts with sonarjs/prefer-immediate-return here (a temp var
          // is what the latter rejects), so the await stays inline.
          // eslint-disable-next-line no-return-await -- see comment above
          return await prisma.$transaction((tx) => {
            session.attach(tx);
            return fn(session);
          }, txOpts);
        } finally {
          session.close();
        }
      },
      { maxAttempts: opts.maxAttempts, baseDelayMs: opts.baseDelayMs, maxDelayMs: opts.maxDelayMs }
    );
  }

  collection(name: string): SqlCollection {
    // Follow the current singleton (see the model collection getter): a
    // bare getPrismaClient() would rebuild it for the default URL after an
    // explicit initialize({ databaseUrl }).
    return createSqlCollection(getPrismaClient(currentSingletonUrl()), name);
  }

  get db(): { name: string; collection(name: string): SqlCollection } {
    if (!this._db) {
      this._db = {
        name: "medici-sql",
        collection: (name: string) => this.collection(name),
      };
    }
    return this._db;
  }
}

/** The singleton connection. Importing this module constructs nothing (QA S3). */
export const connection: MediciConnection = new Connection();

export default connection;
