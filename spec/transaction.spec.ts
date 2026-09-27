import { expect } from "chai";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ObjectId } from "bson";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../src/generated";
import { currentSingletonUrl, disconnectPrisma, getPrismaClient } from "../src/database/client";
import { resetDatabase } from "../src/database/schema";
import { connection } from "../src/database/connection";
import { ClientSession } from "../src/database/session";
import { allocateTransactionIds } from "../src/database/idSequence";
import {
  DEFAULT_MAX_ATTEMPTS,
  isRetriable,
  isUniqueConstraintError,
  parseTransactionOptions,
  runWithRetry,
} from "../src/database/transaction";
import { SessionClosedError, TransactionIdReuseError } from "../src/database/errors";
import { mongoTransaction } from "../src/helper/mongoTransaction";
import { MediciError } from "../src/errors/MediciError";

/**
 * Compat core C (ITD-102): the transaction boundary.
 *
 * Tests the required surface against a real SQLite database (temp file —
 * cross-connection contention tests need two connections to the SAME file,
 * which file::memory: cannot provide):
 *
 * - commit on resolve / rollback on throw / rollback on validation failure
 * - retry-then-succeed under induced contention (P2028 start-queue timeout)
 * - retry-exhausted re-throws the original error
 * - read-your-own-writes inside a write transaction
 * - closed session rejects cleanly (QA S4) — the Book.ts:165-186 shape
 * - outside-constructed Entry id reuse on retry -> named error (QA S6)
 * - id allocation from medici_id_sequence inside the write tx (QA M3)
 * - the xacid.spec.ts:260-315 double-spend shape at N=18, three runs
 * - module-load purity (QA S3)
 */

const TMP_DB = path.join(os.tmpdir(), `medici-itd102-${process.pid}-${Date.now()}.db`);
const FILE_URL = `file:${TMP_DB}`;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const newId = (): string => new ObjectId().toHexString();

const INCOME_BALANCE_SQL =
  "SELECT COALESCE(SUM(credit - debit), 0) AS b FROM medici_transactions WHERE book = ? AND accounts = ?";
const COMMIT_BOOK = "commit-book";

function txDoc(
  book: string,
  accounts: string,
  credit: number,
  debit: number,
  journalId: string
): Record<string, unknown> {
  const now = new Date();
  return {
    credit,
    debit,
    account_path: accounts.split(":"),
    accounts,
    book,
    memo: "itd102",
    datetime: now,
    timestamp: now,
    _journal: journalId,
  };
}

async function incomeBalance(prisma: PrismaClient, book: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ b: number }[]>(INCOME_BALANCE_SQL, book, "Income");
  return Number(rows[0].b);
}

function fakeP2028Start(): Error {
  const err = new Error("Transaction API error: Unable to start a transaction in the given time.") as Error & {
    code: string;
    meta: Record<string, unknown>;
  };
  err.code = "P2028";
  err.meta = {};
  return err;
}

function fakeP2028Closed(): Error {
  const err = new Error("Transaction API error: Transaction already closed.") as Error & {
    code: string;
    meta: Record<string, unknown>;
  };
  err.code = "P2028";
  err.meta = {};
  return err;
}

function fakeBusy(code: string, originalCode: string | undefined, kind: string | undefined): Error {
  const err = new Error("Raw query failed.") as Error & { code: string; meta: Record<string, unknown> };
  err.code = code;
  err.meta = { driverAdapterError: { cause: { originalCode, kind } } };
  return err;
}

function fakeUnique(): Error {
  const err = new Error("Unique constraint failed") as Error & { code: string; meta: Record<string, unknown> };
  err.code = "P2002";
  err.meta = {};
  return err;
}

describe("connection.transaction (ITD-102, compat core C)", function () {
  before(async function () {
    process.env.MEDICI_SQL_DATABASE_URL = FILE_URL;
    await disconnectPrisma();
    await resetDatabase();
  });

  after(async function () {
    await disconnectPrisma();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.unlinkSync(TMP_DB + suffix);
      } catch {
        // not created
      }
    }
  });

  it("commits the callback's writes on resolve", async function () {
    const journalId = newId();
    const txCol = connection.db.collection("medici_transactions");
    const journalCol = connection.db.collection("medici_journals");

    const result = await connection.transaction(async (session) => {
      const { insertedIds } = await txCol.insertMany(
        [txDoc(COMMIT_BOOK, "Income", 5, 0, journalId), txDoc(COMMIT_BOOK, "Outcome", 0, 5, journalId)],
        { session }
      );
      await journalCol.insertOne(
        {
          _id: journalId,
          datetime: new Date(),
          memo: "commit",
          book: COMMIT_BOOK,
          _transactions: Object.values(insertedIds),
        },
        { session }
      );
      return "committed";
    });

    expect(result).to.equal("committed");

    const journal = await journalCol.findOne({ _id: journalId });
    expect(journal).to.not.equal(null);
    expect(journal!.book).to.equal(COMMIT_BOOK);
    const txCount = await txCol.countDocuments({ _journal: journalId });
    expect(txCount).to.equal(2);
  });

  it("rolls back everything when the callback throws (xacid.spec.ts:84-117 shape)", async function () {
    const journalId = newId();
    const txCol = connection.db.collection("medici_transactions");
    const journalCol = connection.db.collection("medici_journals");

    let caught: unknown;
    try {
      await connection.transaction(async (session) => {
        await txCol.insertMany([txDoc("rb-book", "Income", 5, 0, journalId)], { session });
        await journalCol.insertOne({ _id: journalId, datetime: new Date(), memo: "rb", book: "rb-book" }, { session });
        throw new Error("Not enough Balance.");
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).to.be.instanceOf(Error);
    expect((caught as Error).message).to.equal("Not enough Balance.");
    expect(await journalCol.countDocuments({ _id: journalId })).to.equal(0);
    expect(await txCol.countDocuments({ _journal: journalId })).to.equal(0);
  });

  it("rolls back on validation failure and rethrows the validation error (xacid.spec.ts:33/:58 message contract)", async function () {
    const journalId = newId();
    const txCol = connection.db.collection("medici_transactions");

    let caught: unknown;
    try {
      await connection.transaction(async (session) => {
        await txCol.insertMany([txDoc("val-book", "Income", 5, 0, journalId)], { session });
        // The shape Document.validate() rejects with (QA M6): "<ModelName> validation failed: <path>: <reason>".
        throw new Error('Medici_Transaction validation failed: datetime: Cast to Date failed for value "invalid"');
      });
    } catch (err) {
      caught = err;
    }

    expect((caught as Error).message).to.match(/Medici_Transaction validation failed/);
    expect(await txCol.countDocuments({ _journal: journalId })).to.equal(0);
  });

  it("reads its own uncommitted writes inside a write transaction (xacid.spec.ts:249)", async function () {
    let visibleInTx: number | undefined;

    await (async () => {
      try {
        await connection.transaction(async (session) => {
          const txCol = connection.db.collection("medici_transactions");
          const jid = newId();
          await txCol.insertMany([txDoc("ryw-book", "Income", 5, 0, jid), txDoc("ryw-book", "Income", 0, 2, jid)], {
            session,
          });
          const rows = await session.client.$queryRawUnsafe<{ b: number }[]>(INCOME_BALANCE_SQL, "ryw-book", "Income");
          visibleInTx = Number(rows[0].b);
          throw new Error("rollback after the read");
        });
      } catch (err) {
        expect((err as Error).message).to.equal("rollback after the read");
      }
    })();

    expect(visibleInTx).to.equal(3); // 5 - 2, seen inside the tx before commit
    expect(await incomeBalance(getPrismaClient(), "ryw-book")).to.equal(0); // rolled back
  });

  it("retries a P2028 start-queue timeout and succeeds (retry-then-succeed under induced contention)", async function () {
    this.timeout(10000);
    const prisma = getPrismaClient();
    const gate = prisma.$transaction(async () => {
      await sleep(600);
    });
    await sleep(50);

    let callbackRuns = 0;
    const t0 = Date.now();
    const result = await connection.transaction(
      () => {
        callbackRuns += 1;
        return Promise.resolve(42);
      },
      { maxWait: 100 }
    );
    const wall = Date.now() - t0;

    await gate;
    expect(result).to.equal(42);
    expect(callbackRuns).to.equal(1); // the failed attempt never started
    expect(wall).to.be.at.least(500); // waited out the gate on a retry, not the first try
  });

  it("rethrows the original error after exhausting retries", async function () {
    this.timeout(10000);
    const prisma = getPrismaClient();
    const gate = prisma.$transaction(async () => {
      await sleep(1200);
    });
    await sleep(50);

    let callbackRuns = 0;
    let caught: unknown;
    try {
      await connection.transaction(
        () => {
          callbackRuns += 1;
          return Promise.resolve();
        },
        { maxWait: 100, retries: 3, retryBaseDelayMs: 20, retryMaxDelayMs: 40 }
      );
    } catch (err) {
      caught = err;
    }

    await gate;
    expect(caught).to.be.instanceOf(Error);
    expect((caught as { code?: string }).code).to.equal("P2028");
    expect((caught as Error).message).to.include("Unable to start a transaction");
    expect(callbackRuns).to.equal(0);
  });

  it("a closed session rejects cleanly, never synchronously (QA S4, Book.ts:165-186 shape)", async function () {
    let sessionRef: ClientSession | undefined;
    await connection.transaction(async (session) => {
      sessionRef = session;
      const txCol = connection.db.collection("medici_transactions");
      await txCol.insertMany([txDoc("s4-book", "Income", 1, 0, newId())], { session });
    });
    expect(sessionRef).to.not.equal(undefined);
    expect(sessionRef!.closed).to.equal(true);

    // (a) a query on the closed session's client returns a REJECTING promise, no sync throw.
    let threwSynchronously = false;
    let query: Promise<unknown>;
    try {
      query = sessionRef!.client.transaction.findMany();
    } catch {
      threwSynchronously = true;
    }
    expect(threwSynchronously).to.equal(false);

    let rejected = false;
    let code: string | undefined;
    let message = "";
    try {
      await query;
    } catch (err) {
      rejected = true;
      code = (err as { code?: string }).code;
      message = String((err as Error).message);
    }
    expect(rejected).to.equal(true);
    expect(code).to.equal("P2028");
    expect(message).to.include("Transaction already closed");

    // (b) the Book.ts:165-186 shape: an UNAWAITED promise carrying the closed
    // session, inside .then().catch() — must not produce an unhandled
    // rejection within the book.spec.ts:391 10 ms margin.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    void sessionRef!.client.transaction
      .findMany()
      .then(() => {
        throw new Error("background re-snapshot");
      })
      .catch(() => {
        // swallowed exactly like Book.ts:183-185
      });
    await sleep(10);
    process.removeListener("unhandledRejection", onUnhandled);
    expect(unhandled).to.have.length(0);

    // (c) the M3 primitive on a closed session rejects with SessionClosedError.
    let closedReject: unknown;
    try {
      await sessionRef!.allocateTransactionIds(1);
    } catch (err) {
      closedReject = err;
    }
    expect(closedReject).to.be.instanceOf(SessionClosedError);
  });

  it("surfaces a named error when an outside-constructed id is reinserted on retry (QA S6)", async function () {
    this.timeout(10000);
    // The Entry (and its journal _id) is constructed OUTSIDE the callback.
    const journalId = newId();
    const book = "s6-book";

    // A rival connection commits that journal id — the observable shape of
    // "a previous attempt committed" (which a pre-commit retriable failure
    // plus a retry then collides with).
    const rival = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: FILE_URL, timeout: 300 }) });
    await rival.$connect();
    await rival.journal.create({ data: { id: journalId, datetime: new Date(), memo: "outside", book } });

    // Induce a retriable failure (P2028 start timeout) on attempt 1: the
    // gate holds the in-process transaction mutex until ~230 ms, after
    // attempt 1's start deadline (~180 ms, 50 ms pre-sleep + 100 ms
    // maxWait) but before attempt 2's deadline (~290 ms), so attempt 1
    // times out pre-commit and the retry collides with the rival's row.
    // The window is deliberately wide: a 150 ms gate made attempt 1's
    // deadline and the gate release land in the same millisecond, so a
    // fast clock let attempt 1 itself hit the constraint (raw P2002).
    const gate = getPrismaClient().$transaction(async () => {
      await sleep(200);
    });
    await sleep(50);

    let caught: unknown;
    try {
      await connection.transaction(
        async (session) => {
          const journalCol = connection.db.collection("medici_journals");
          await journalCol.insertOne({ _id: journalId, datetime: new Date(), memo: "outside", book }, { session });
        },
        { maxWait: 100, retries: 3, retryBaseDelayMs: 20, retryMaxDelayMs: 40 }
      );
    } catch (err) {
      caught = err;
    }

    await gate;
    await rival.$disconnect();

    expect(caught).to.be.instanceOf(TransactionIdReuseError);
    expect(caught).to.be.instanceOf(MediciError);
    expect((caught as { name?: string }).name).to.equal("TransactionIdReuseError");
    expect((caught as Error).message).to.match(/outside the transaction callback/i);
    const cause = (caught as TransactionIdReuseError).cause as { code?: string };
    expect(cause?.code).to.equal("P2002"); // the raw constraint violation is attached, not thrown raw
  });

  it("allocates transaction ids from medici_id_sequence inside the write tx (QA M3)", async function () {
    const prisma = getPrismaClient();
    const rowBefore = (await prisma.idSequence.findUnique({ where: { id: 1 } }))!;
    const instanceHex = Buffer.from(rowBefore.instance).toString("hex");

    const five = await connection.transaction((session) => session.allocateTransactionIds(5));
    const rowAfter = (await prisma.idSequence.findUnique({ where: { id: 1 } }))!;

    expect(five).to.have.length(5);
    for (const id of five) {
      expect(id).to.match(/^[0-9a-f]{24}$/);
      // ObjectId layout: 4-byte seconds BE | 5-byte instance | 3-byte counter BE.
      expect(id.slice(8, 18)).to.equal(instanceHex);
      expect(id.slice(0, 8)).to.equal(rowAfter.seconds.toString(16).padStart(8, "0"));
    }
    for (let i = 1; i < five.length; i++) {
      expect(Buffer.compare(Buffer.from(five[i - 1], "hex"), Buffer.from(five[i], "hex"))).to.equal(-1);
    }
    if (Number(rowAfter.seconds) === Number(rowBefore.seconds)) {
      expect(Number(rowAfter.counter) - Number(rowBefore.counter)).to.equal(5);
    } else {
      // The clock ticked mid-allocation: the row rolled to the current
      // second with a fresh 0-based counter (ids 0..4).
      expect(Number(rowAfter.counter)).to.equal(4);
    }

    // A later transaction continues the sequence (allocation order == id order).
    const two = await connection.transaction((session) => session.allocateTransactionIds(2));
    expect(Buffer.compare(Buffer.from(five[4], "hex"), Buffer.from(two[0], "hex"))).to.equal(-1);

    // A rolled-back allocation leaves the sequence unchanged (the advance
    // commits/rolls back with the transaction).
    const beforeProbe = (await prisma.idSequence.findUnique({ where: { id: 1 } }))!;
    try {
      await connection.transaction(async (session) => {
        await session.allocateTransactionIds(3);
        throw new Error("rollback probe");
      });
    } catch (err) {
      expect((err as Error).message).to.equal("rollback probe");
    }
    const afterProbe = (await prisma.idSequence.findUnique({ where: { id: 1 } }))!;
    expect(Number(afterProbe.seconds)).to.equal(Number(beforeProbe.seconds));
    expect(Number(afterProbe.counter)).to.equal(Number(beforeProbe.counter));

    // The no-session insertMany path allocates in an ad-hoc write transaction.
    const journalId = newId();
    const txCol = connection.db.collection("medici_transactions");
    const beforeSeed = (await prisma.idSequence.findUnique({ where: { id: 1 } }))!;
    const { insertedIds, insertedCount } = await txCol.insertMany([
      txDoc("m3-book", "Income", 1, 0, journalId),
      txDoc("m3-book", "Outcome", 0, 1, journalId),
    ]);
    expect(insertedCount).to.equal(2);
    const seedIds = Object.values(insertedIds);
    for (const id of seedIds) {
      expect(id).to.match(/^[0-9a-f]{24}$/);
    }
    expect(Buffer.compare(Buffer.from(seedIds[0], "hex"), Buffer.from(seedIds[1], "hex"))).to.equal(-1);
    const afterSeed = (await prisma.idSequence.findUnique({ where: { id: 1 } }))!;
    if (Number(afterSeed.seconds) === Number(beforeSeed.seconds)) {
      expect(Number(afterSeed.counter) - Number(beforeSeed.counter)).to.equal(2);
    } else {
      expect(Number(afterSeed.counter)).to.equal(1);
    }
    expect(await txCol.countDocuments({ _journal: journalId })).to.equal(2);
  });

  it("reproduces the xacid.spec.ts:260-315 double-spend shape at N=18, three runs", async function () {
    this.timeout(60000);
    const timings: number[] = [];

    for (let run = 1; run <= 3; run++) {
      const book = `xacid-itd102-${run}-${Date.now()}`;
      const txCol = connection.db.collection("medici_transactions");
      const journalCol = connection.db.collection("medici_journals");
      const lockCol = connection.db.collection("medici_locks");

      // Seed: Income +2 (the xacid.spec.ts:238 seed), committed no-session.
      const seedJournalId = newId();
      const seed = await txCol.insertMany([
        txDoc(book, "Income", 2, 0, seedJournalId),
        txDoc(book, "Outcome", 0, 2, seedJournalId),
      ]);
      await journalCol.insertOne({
        _id: seedJournalId,
        datetime: new Date(),
        memo: "seed",
        book,
        _transactions: Object.values(seed.insertedIds),
      });

      const t0 = Date.now();
      const results = await Promise.allSettled(
        Array.from({ length: 18 }, () =>
          connection.transaction(async (session) => {
            const spendJournalId = newId(); // journal _id stays client-side (M3)
            const spend = await txCol.insertMany(
              [txDoc(book, "Savings", 1, 0, spendJournalId), txDoc(book, "Income", 0, 1, spendJournalId)],
              { session }
            );
            await journalCol.insertOne(
              {
                _id: newId(),
                datetime: new Date(),
                memo: "spend",
                book,
                _transactions: Object.values(spend.insertedIds),
              },
              { session }
            );
            await lockCol.updateOne(
              { account: "Income", book },
              { $set: { updatedAt: new Date() }, $setOnInsert: { book, account: "Income" }, $inc: { __v: 1 } },
              { upsert: true, session }
            );
            // In-txn balance read (read-your-own-writes): a spend that drives
            // Income negative throws and rolls back — xacid.spec.ts:249-257.
            const rows = await session.client.$queryRawUnsafe<{ b: number }[]>(INCOME_BALANCE_SQL, book, "Income");
            if (Number(rows[0].b) < 0) {
              throw new Error(`Not enough Balance in concurrent transaction (run ${run}).`);
            }
          })
        )
      );
      const wall = Date.now() - t0;
      timings.push(wall);

      const fulfilled = results.filter((r) => r.status === "fulfilled").length;
      const rejected = results.filter((r) => r.status === "rejected").length;
      expect(fulfilled, `run ${run}: exactly 2 of 18 spends commit (seed +2, spend -1 each)`).to.equal(2);
      expect(rejected, `run ${run}: the other 16 roll back on the in-txn balance check`).to.equal(16);
      for (const r of results) {
        if (r.status === "rejected") {
          expect(String((r.reason as Error).message)).to.match(/Not enough Balance/);
        }
      }
      expect(await incomeBalance(getPrismaClient(), book), `run ${run}: final Income balance is exactly 0`).to.equal(0);

      const lockRow = await lockCol.findOne({ book, account: "Income" });
      expect(lockRow, `run ${run}: one lock row for Income`).to.not.equal(null);
      // Prisma field `version` maps to Mongo's `__v`; the compat boundary
      // (ITD-94) re-exposes the Mongo field name.
      expect((lockRow as { version?: number }).version, `run ${run}: __v counts only the committed spends`).to.equal(2);

      console.log(`xacid shape N=18 run ${run}: ${wall} ms wall (spike ITD-89 baseline: 131 ms at N=18)`);
    }

    console.log(`xacid shape N=18 timings: ${timings.join(", ")} ms`);
  });

  it("mongoTransaction is the kept-name alias of connection.transaction", async function () {
    const journalId = newId();
    const txCol = connection.db.collection("medici_transactions");

    const result = await mongoTransaction(async (session) => {
      await txCol.insertMany([txDoc("alias-book", "Income", 1, 0, journalId)], { session });
      return "aliased";
    }, {});

    expect(result).to.equal("aliased");
    expect(await txCol.countDocuments({ _journal: journalId })).to.equal(1);
  });

  it("retry core: named error on retry-time unique violation, original error on exhaustion (QA S6 unit)", async function () {
    // attempt 1 retriable, attempt 2 unique -> TransactionIdReuseError with the cause attached.
    let calls = 0;
    const uniqueErr = fakeUnique();
    let caught: unknown;
    try {
      await runWithRetry(
        () => {
          calls += 1;
          if (calls === 1) {
            throw fakeP2028Start();
          }
          throw uniqueErr;
        },
        { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 2 }
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).to.be.instanceOf(TransactionIdReuseError);
    expect((caught as TransactionIdReuseError).cause).to.equal(uniqueErr);
    expect(calls).to.equal(2);

    // A unique violation on the FIRST attempt is the consumer's own double
    // write: re-thrown raw, not converted.
    let rawCaught: unknown;
    try {
      await runWithRetry(
        () => {
          throw uniqueErr;
        },
        { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 2 }
      );
    } catch (err) {
      rawCaught = err;
    }
    expect(rawCaught).to.equal(uniqueErr);

    // Retriable errors exhaust to the ORIGINAL (last) error, unwrapped.
    const lastErr = fakeP2028Start();
    let n = 0;
    let exhausted: unknown;
    try {
      await runWithRetry(
        () => {
          n += 1;
          if (n < 3) {
            throw fakeP2028Start();
          }
          throw lastErr;
        },
        { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 }
      );
    } catch (err) {
      exhausted = err;
    }
    expect(exhausted).to.equal(lastErr);
    expect(n).to.equal(3);
  });

  it("classifies the spike's measured error shapes (isRetriable / isUniqueConstraintError)", function () {
    expect(isRetriable(fakeP2028Start())).to.equal(true);
    expect(isRetriable(fakeP2028Closed())).to.equal(false); // use-after-commit: fail fast
    expect(isRetriable(fakeBusy("P2010", "SQLITE_BUSY", "SocketTimeout"))).to.equal(true);
    expect(isRetriable(fakeBusy("P1008", "SQLITE_LOCKED", undefined))).to.equal(true);
    expect(isRetriable(fakeBusy("P2010", "SQLITE_ERROR", "SocketTimeout"))).to.equal(true); // kind match
    expect(isRetriable(fakeBusy("P2010", "SQLITE_ERROR", undefined))).to.equal(false);
    expect(isRetriable(new Error("boom"))).to.equal(false);
    expect(isRetriable({ code: "P2023", message: "Invalid isolation level" })).to.equal(false);

    expect(isUniqueConstraintError(fakeUnique())).to.equal(true);
    expect(isUniqueConstraintError(fakeBusy("P2010", "SQLITE_CONSTRAINT_UNIQUE", undefined))).to.equal(true);
    expect(isUniqueConstraintError(fakeP2028Start())).to.equal(false);
  });

  it("parses the loose IAnyObject transaction options", function () {
    expect(parseTransactionOptions(undefined).maxAttempts).to.equal(DEFAULT_MAX_ATTEMPTS);
    expect(parseTransactionOptions({}).maxWait).to.equal(undefined);
    expect(
      parseTransactionOptions({ maxWait: 123, timeout: 456, retries: 2, retryBaseDelayMs: 7, retryMaxDelayMs: 8 })
    ).to.deep.equal({
      maxWait: 123,
      timeout: 456,
      maxAttempts: 2,
      baseDelayMs: 7,
      maxDelayMs: 8,
    });
    expect(parseTransactionOptions({ retries: 0 }).maxAttempts).to.equal(1); // retries: 0 disables retrying
    expect(parseTransactionOptions({ maxWait: -5, retries: "x" }).maxWait).to.equal(undefined); // junk ignored
  });

  it("exposes the required surface (connect/disconnect/transaction/db.collection)", function () {
    expect(typeof connection.connect).to.equal("function");
    expect(typeof connection.disconnect).to.equal("function");
    expect(typeof connection.transaction).to.equal("function");
    expect(typeof connection.collection).to.equal("function");
    expect(connection.db).to.not.equal(undefined);
    expect(typeof connection.db.collection).to.equal("function");

    const col = connection.db.collection("medici_journals");
    for (const method of [
      "insertOne",
      "insertMany",
      "updateOne",
      "find",
      "findOne",
      "countDocuments",
      "deleteOne",
      "deleteMany",
      "aggregate",
      "distinct",
    ]) {
      expect(typeof (col as unknown as Record<string, unknown>)[method], method).to.equal("function");
    }
    expect(col.find({ book: "x" }).toArray()).to.be.instanceOf(Promise);

    expect(new SessionClosedError()).to.be.instanceOf(MediciError);
    expect(new TransactionIdReuseError("m", new Error("c"))).to.be.instanceOf(MediciError);
  });

  it("connect(url?) is idempotent; disconnect() forgets the singleton (run last)", async function () {
    expect(currentSingletonUrl()).to.equal(FILE_URL);

    await connection.connect(); // same url: idempotent no-op
    expect(currentSingletonUrl()).to.equal(FILE_URL);
    expect(currentSingletonUrl()).to.equal(FILE_URL);

    await connection.connect(FILE_URL); // explicit same url: still the same singleton
    expect(currentSingletonUrl()).to.equal(FILE_URL);

    await connection.disconnect();
    expect(currentSingletonUrl()).to.equal(undefined);

    await connection.connect(); // re-establish for any later suites
    expect(currentSingletonUrl()).to.equal(FILE_URL);
  });

  it("importing the module is pure: no client, no file (QA S3)", function () {
    this.timeout(30000);
    const purityDb = path.join(os.tmpdir(), `medici-purity-${process.pid}-${Date.now()}.db`);
    const purityUrl = `file:${purityDb}`;
    const script =
      `process.env.MEDICI_SQL_DATABASE_URL = ${JSON.stringify(purityUrl)}; ` +
      `require("./src/index"); console.log("pure-ok");`;
    const out = execFileSync(
      process.execPath,
      ["-r", "ts-node/register", "-r", "tsconfig-paths/register", "-e", script],
      {
        cwd: path.resolve(__dirname, ".."),
        encoding: "utf8",
        env: process.env,
      }
    );
    expect(out).to.include("pure-ok");
    expect(fs.existsSync(purityDb)).to.equal(false);
    expect(fs.existsSync(purityDb + "-wal")).to.equal(false);
  });
});
