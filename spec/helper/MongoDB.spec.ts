/*
 * Tier C carve-out — TEST_COMPAT_MATRIX.md row `spec/helper/MongoDB.spec.ts`
 * (content replaced, path preserved, TIER_C_BUDGET).
 *
 * Upstream booted a MongoMemoryReplSet here. The port boots a fresh
 * file-backed SQLite database (one per test process, in the OS temp dir) —
 * the port's production shape (the default MEDICI_SQL_DATABASE_URL is a file).
 * file::memory: cannot host the full suite: Prisma interactive transactions
 * (the vendored xacid spec, via mongoTransaction) open a SEPARATE connection,
 * which for file::memory: is a fresh empty in-memory database with no schema.
 *
 * The path must stay: spec/book.spec.ts:13 does
 * `require("./helper/MongoDB.spec")` and spec/index.spec.ts imports it, and
 * both are vendored byte-identical (QA M1/R5).
 */
import { after, before } from "mocha";
import { rmSync } from "fs";
import * as os from "os";
import * as path from "path";
import { disconnectPrisma } from "../../src/database/client";
import { resetDatabase } from "../../src/database/schema";

// Same per-process file referenced by test/mocha-setup.ts (loaded via
// --require): <tmpdir>/medici-sql-<pid>.db
const TEST_DB_FILE = path.join(os.tmpdir(), `medici-sql-${process.pid}.db`);

// Fresh database for this run: delete any leftover file, point the port at it
// (spec module-load env assignments run before this hook; this re-asserts the
// file URL after all of them), and build the guaranteed-empty schema.
// Truncated exactly once here (QA S1: never between tests — book.spec.ts
// accumulates state across describes). ACID_AVAILABLE is deliberately NOT set
// here (QA M11) — test/mocha-setup.ts (--require) owns that.
before(async function () {
  this.timeout(40000);
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(TEST_DB_FILE + suffix, { force: true });
  }
  process.env.MEDICI_SQL_DATABASE_URL = `file:${TEST_DB_FILE}`;
  await disconnectPrisma();
  await resetDatabase();
});

after(async () => {
  await disconnectPrisma();
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(TEST_DB_FILE + suffix, { force: true });
  }
});
