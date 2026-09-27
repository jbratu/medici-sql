import * as path from "path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../generated";

/**
 * Lazily-constructed singleton Prisma client for the SQLite backend.
 *
 * Purity (QA S3): importing this module constructs nothing and touches no
 * file system. The client (and its single better-sqlite3 connection) is
 * created on the first getPrismaClient() call; pragmas are applied on
 * connect via connectPrisma().
 *
 * URL selection: env MEDICI_SQL_DATABASE_URL wins; the default is a file
 * under the repo root. Tests select an in-memory database by setting
 * MEDICI_SQL_DATABASE_URL (e.g. "file::memory:") before the first client
 * is created (QA S1: the harness must start from a guaranteed-empty
 * database).
 *
 * Pragmas (ITD-89 spike, spike/FINDINGS.md):
 *  - journal_mode=WAL   — set once at bootstrap; persistent on the file.
 *  - synchronous=NORMAL — per-connection, so re-applied on every connect.
 *  - busy_timeout       — the adapter `timeout` option below. In Prisma 7
 *    there is no SQL path to it and `?pragma=` URLs are gone.
 */

/** Adapter busy_timeout (ms); the only knob in Prisma 7 (spike section b). */
export const ADAPTER_TIMEOUT_MS = 5000;

/**
 * Resolve the database URL: MEDICI_SQL_DATABASE_URL, defaulting to a file
 * under the repo root. The default resolves from this module's location so
 * it is the same path from src/ (ts-mocha) and build/ (published package).
 */
export function databaseUrl(): string {
  const fromEnv = process.env.MEDICI_SQL_DATABASE_URL;
  if (fromEnv) {
    return fromEnv;
  }
  return "file:" + path.join(__dirname, "..", "..", "medici-sql.db");
}

export function isInMemoryUrl(url: string): boolean {
  return url.includes(":memory:");
}

let client: PrismaClient | undefined;
let clientUrl: string | undefined;
let connectPromise: Promise<PrismaClient> | undefined;

/** The url the current singleton client was built for; undefined when no client exists yet. */
export function currentSingletonUrl(): string | undefined {
  return clientUrl;
}

/**
 * Return the singleton client, constructing it lazily. Construction opens
 * no connection and performs no I/O (the better-sqlite3 adapter defers
 * opening until the first query). An explicit `url` (from
 * connection.connect(url)) overrides the env/default; passing a different
 * url than the existing client silently rebuilds the singleton, so callers
 * that must not leak the old connection should disconnectPrisma() first
 * (connection.connect does).
 */
export function getPrismaClient(url?: string): PrismaClient {
  const target = url ?? databaseUrl();
  if (!client || clientUrl !== target) {
    const adapter = new PrismaBetterSqlite3({ url: target, timeout: ADAPTER_TIMEOUT_MS });
    client = new PrismaClient({ adapter });
    clientUrl = target;
  }
  return client;
}

/**
 * Ensure the client is connected and the port's pragmas are applied.
 * Idempotent: the pragma sequence runs once per process per client.
 */
export function connectPrisma(url?: string): Promise<PrismaClient> {
  const targetUrl = url ?? databaseUrl();
  const prisma = getPrismaClient(targetUrl);
  if (!connectPromise) {
    connectPromise = (async () => {
      await prisma.$connect();
      // WAL is a no-op on in-memory databases (journal_mode stays
      // "memory"); skip it there so the call is meaningful everywhere.
      if (!isInMemoryUrl(targetUrl)) {
        await prisma.$executeRawUnsafe("PRAGMA journal_mode=WAL");
      }
      await prisma.$executeRawUnsafe("PRAGMA synchronous=NORMAL");
      return prisma;
    })();
    // A failed connect must not poison subsequent attempts.
    connectPromise.catch(() => {
      connectPromise = undefined;
      if (client) {
        client.$disconnect().catch(() => undefined);
        client = undefined;
        clientUrl = undefined;
      }
    });
  }
  return connectPromise;
}

/** Disconnect and forget the singleton (test teardown). */
export async function disconnectPrisma(): Promise<void> {
  if (connectPromise) {
    await connectPromise.catch(() => undefined);
    connectPromise = undefined;
  }
  if (client) {
    await client.$disconnect();
    client = undefined;
    clientUrl = undefined;
  }
}
