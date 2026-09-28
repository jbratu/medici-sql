import { IAnyObject } from "../IAnyObject";
import { connectPrisma, currentSingletonUrl, databaseUrl, disconnectPrisma, getPrismaClient } from "./client";
import { ClientSession } from "./session";
import { parseTransactionOptions, runWithRetry } from "./transaction";
import { createSqlCollection } from "./sqlCollection";
import { ensureSchemaLazy } from "./schema";
import type { MediciConnection, SqlCollection } from "./connectionTypes";
export type { MediciConnection } from "./connectionTypes";

/**
 * The connection object — the port's transaction boundary (ITD-102, compat
 * core C). `MediciConnection` (the public contract) lives in
 * ./connectionTypes — a type-only module — so the tsd type-test program can
 * name it without pulling the generated Prisma client d.ts in (ITD-97).
 *
 * Module-load purity (QA S3): constructing this object does no I/O; the
 * Prisma client (and its SQLite file) are created lazily on the first
 * connect()/transaction() call.
 */

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
