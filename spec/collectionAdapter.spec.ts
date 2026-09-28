/**
 * ITD-93 — the MongoDB driver-shaped collection adapter over Prisma/SQLite.
 *
 * Every test here drives the RAW adapter (connection.collection(name)), the
 * same object upstream Book.ts / Entry.ts / models call directly, so the
 * hydrated read-side types are asserted on adapter results, not on the
 * compat query layer. Titles are the DoD checklist for the ticket.
 */
import { execFile, execFileSync } from "child_process";
import { expect } from "chai";
import { ObjectId } from "bson";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../src/generated";
import { Types } from "../src/compat/mongoose";
import { disconnectPrisma, getPrismaClient } from "../src/database/client";
import { createSchema, resetDatabase } from "../src/database/schema";
import { connection } from "../src/database/connection";
import { createSqlCollection, SqlCollection } from "../src/database/sqlCollection";
import { ClientSession } from "../src/database/session";
import { UnsupportedMongoOperationError } from "../src/errors/UnsupportedMongoOperationError";
import { IAnyObject } from "../src/IAnyObject";

process.env.MEDICI_SQL_DATABASE_URL = "file::memory:";

const REPO_ROOT = path.join(__dirname, "..");
const FIXTURE = path.join(__dirname, "fixtures", "cross-process-insert.js");

/** The one allowed aggregate pipeline (upstream Book.ts:20-27). */
const GROUP_STAGE: IAnyObject = {
  $group: {
    _id: null,
    balance: { $sum: { $subtract: ["$credit", "$debit"] } },
    notes: { $sum: 1 },
    lastTransactionId: { $max: "$_id" },
  },
};

const TX_MS = Date.UTC(2026, 0, 2, 3, 4, 5, 678);
const BOOK = "adapter-book";
const ACCOUNT = "Assets:Cash";
const FOOD_ACCOUNT = "Expenses:Food";
const META_FROM = "ITD-93";
const EXPECT_UNSUPPORTED = "expected UnsupportedMongoOperationError";
const A_ID_PREFIX = "0000000000000000000000a";
const CONCURRENT_ACCOUNT = "C:Concurrent";
const DELETE_BOOK = "delete-book";
const XCONN_BOOK = "xconn-book";
const LEDGER_BOOK = "ledger-book";
const LEDGER_TIE_BOOK = "ledger-tie-book";
const DISTINCT_BOOK = "distinct-book";

function txDoc(overrides: IAnyObject = {}): IAnyObject {
  return {
    credit: 1,
    debit: 0,
    meta: { from: META_FROM },
    datetime: new Date(TX_MS),
    account_path: ["Assets", "Cash"],
    accounts: ACCOUNT,
    book: BOOK,
    memo: "memo",
    _journal: "000000000000000000000001",
    timestamp: new Date(TX_MS),
    ...overrides,
  };
}

function newId(): string {
  return new ObjectId().toHexString();
}

function strictlyIncreasing(ids: Array<string | { toHexString(): string }>): void {
  const hex = ids.map((id) => (typeof id === "string" ? id : id.toHexString()));
  for (let i = 1; i < hex.length; i += 1) {
    expect(Buffer.compare(Buffer.from(hex[i - 1], "hex"), Buffer.from(hex[i], "hex"))).to.equal(-1);
  }
}

const txCol = () => connection.collection("medici_transactions");
const journalCol = () => connection.collection("medici_journals");
const lockCol = () => connection.collection("medici_locks");
const balCol = () => connection.collection("medici_balances");

describe("sqlCollection (ITD-93)", function () {
  this.timeout(30000);

  before(async () => {
    await resetDatabase();
  });

  after(async () => {
    await disconnectPrisma();
  });

  it("insertMany returns monotonically increasing _ids in array order (forceServerObjectId, write tx)", async () => {
    const docs = [0, 1, 2, 3].map((i) => txDoc({ memo: `m${i}` }));
    const insertedIds = await connection.transaction(async (session) => {
      const result = await txCol().insertMany(docs, { forceServerObjectId: true, session });
      return result.insertedIds;
    });
    const ids = Object.values(insertedIds);
    expect(ids.length).to.equal(4);
    for (const id of ids) {
      expect(id).to.be.instanceOf(Types.ObjectId);
    }
    strictlyIncreasing(ids);
    expect(await txCol().countDocuments({ _journal: "000000000000000000000001" })).to.equal(4);
  });

  it("insertMany assigns client-side _ids in array order without forceServerObjectId", async () => {
    const docs = [0, 1, 2].map((i) => txDoc({ memo: `cs${i}` }));
    const result = await txCol().insertMany(docs, {});
    const ids = Object.values(result.insertedIds);
    expect(ids.length).to.equal(3);
    for (const id of ids) {
      expect(id).to.be.instanceOf(Types.ObjectId);
    }
    strictlyIncreasing(ids);
    expect(result.insertedCount).to.equal(3);
  });

  it("insertMany rejects mixed explicit/missing _id under forceServerObjectId", async () => {
    try {
      await txCol().insertMany([txDoc({ _id: newId() }), txDoc()], { forceServerObjectId: true });
      throw new Error(EXPECT_UNSUPPORTED);
    } catch (err) {
      expect(err).to.be.instanceOf(UnsupportedMongoOperationError);
    }
  });

  it("insertOne returns acknowledged true and an ObjectId insertedId (journal shape)", async () => {
    const jid = newId();
    const t1 = new ObjectId();
    const t2 = new ObjectId();
    const result = await journalCol().insertOne(
      { _id: jid, datetime: new Date(TX_MS), memo: "j", book: BOOK, _transactions: [t1, t2] },
      {}
    );
    expect(result.acknowledged).to.equal(true);
    expect(result.insertedId).to.be.instanceOf(Types.ObjectId);
    expect(result.insertedId.toHexString()).to.equal(jid);
    const doc = await journalCol().findOne({ _id: jid });
    expect(doc?._id).to.be.instanceOf(Types.ObjectId);
    expect(doc?._transactions).to.be.an("array").with.lengthOf(2);
    for (const t of doc!._transactions as IAnyObject[]) {
      expect(t).to.be.instanceOf(Types.ObjectId);
    }
  });

  it("read results hydrate Mongo types off the raw adapter (QA M8)", async () => {
    const id = newId();
    const jid = newId();
    await txCol().insertOne(txDoc({ _id: id, _journal: jid, meta: { from: META_FROM, n: 7 } }), {});
    const doc = (await txCol().findOne({ _id: id }))!;
    expect(doc._id).to.be.instanceOf(Types.ObjectId);
    expect(doc._journal).to.be.instanceOf(Types.ObjectId);
    expect(doc.datetime).to.be.instanceOf(Date);
    expect(doc.datetime.getTime()).to.equal(TX_MS);
    expect(doc.timestamp).to.be.instanceOf(Date);
    expect(doc.account_path).to.deep.equal(["Assets", "Cash"]);
    expect(doc.meta).to.deep.equal({ from: META_FROM, n: 7 });
    expect(doc.book).to.equal(BOOK);
    expect(doc.credit).to.equal(1);
  });

  it("find omits unset nullable columns instead of returning null (QA M8/G9)", async () => {
    const id = newId();
    await txCol().insertOne({ ...txDoc({ _id: id }), meta: undefined } as IAnyObject, {});
    const doc = (await txCol().findOne({ _id: id }))!;
    expect(doc).to.not.have.property("meta");
    expect(doc).to.not.have.property("voided");
    expect(doc).to.not.have.property("void_reason");
    expect(doc).to.not.have.property("_original_journal");
    for (const value of Object.values(doc)) {
      expect(value, `no null column may be returned, got: ${JSON.stringify(doc)}`).to.not.equal(null);
    }
  });

  it("find with ledger-shaped sort over one entry's rows sharing datetime and timestamp returns insertion order (QA M7, balance.spec.ts:201-204)", async () => {
    // One _journal: the real balance.spec.ts:201-204 case is six transactions
    // in ONE entry (shared journal.datetime AND entry.timestamp). Within one
    // entry the tiebreak is _id ASC (insertion order). The cross-entry
    // same-millisecond tie is pinned by the next test.
    const journal = newId();
    const ids = [0, 1, 2, 3, 4, 5].map((i) => `${A_ID_PREFIX}${i}`);
    const docs = ids.map((id, i) => txDoc({ _id: id, book: LEDGER_BOOK, memo: `row ${i}`, _journal: journal }));
    await txCol().insertMany(docs, {});
    const rows = await txCol()
      .find({ book: LEDGER_BOOK }, { sort: { datetime: -1, timestamp: -1 } })
      .toArray();
    expect(rows.length).to.equal(6);
    for (let i = 0; i < rows.length; i += 1) {
      expect(rows[i]._id.toHexString()).to.equal(ids[i]);
    }
    expect(rows[2].memo).to.equal("row 2");
  });

  it("find honors skip/limit pagination (Book.ledger shape)", async () => {
    const rows = await txCol()
      .find({ book: LEDGER_BOOK }, { sort: { datetime: -1, timestamp: -1 }, skip: 1, limit: 2 })
      .toArray();
    expect(rows.length).to.equal(2);
    expect(rows[0]._id.toHexString()).to.equal(`${A_ID_PREFIX}1`);
    expect(rows[1]._id.toHexString()).to.equal(`${A_ID_PREFIX}2`);
  });

  it("find with ledger-shaped sort over DISTINCT entries sharing datetime and timestamp orders by commit order (book.spec.ts pagination)", async () => {
    // Two entries constructed in the same millisecond: their rows tie on BOTH
    // sort keys. A descending sort must present the LATER-committed entry
    // first; _journal is time-ordered (ObjectId), so the tiebreak is
    // _journal DESC (book.spec.ts:794-815 — vendored, unmodifiable). Under a
    // plain _id ASC tiebreak the earlier entry's rows would win and that
    // vendored test flakes whenever two commits land in one millisecond.
    const jEarly = "0000000000000000000000c1";
    const jLate = "0000000000000000000000c2";
    const rEarly = "0000000000000000000000d1";
    const rLate = "0000000000000000000000d2";
    await txCol().insertMany(
      [
        txDoc({ _id: rEarly, book: LEDGER_TIE_BOOK, memo: "early", _journal: jEarly }),
        txDoc({ _id: rLate, book: LEDGER_TIE_BOOK, memo: "late", _journal: jLate }),
      ],
      {}
    );
    const rows = await txCol()
      .find({ book: LEDGER_TIE_BOOK }, { sort: { datetime: -1, timestamp: -1 } })
      .toArray();
    expect(rows.length).to.equal(2);
    expect(rows[0]._id.toHexString()).to.equal(rLate);
    expect(rows[0]._journal.toHexString()).to.equal(jLate);
    expect(rows[1]._id.toHexString()).to.equal(rEarly);
  });

  it("findOne with {sort: {_id: -1}} returns the newest snapshot (getBestBalanceSnapshot shape)", async () => {
    const ids = [0, 1, 2].map((i) => `0000000000000000000000b${i}`);
    const tIds = [new ObjectId(), new ObjectId(), new ObjectId()];
    for (let i = 0; i < ids.length; i += 1) {
      await balCol().insertOne(
        {
          _id: ids[i],
          key: "k",
          rawKey: "raw-k",
          book: BOOK,
          account: "B:Snap",
          transaction: tIds[i],
          meta: JSON.stringify({ i }),
          balance: i,
          notes: 1,
          createdAt: new Date(TX_MS + i),
          expireAt: new Date(TX_MS + i),
        },
        {}
      );
    }
    const doc = (await balCol().findOne({ key: "k" }, { sort: { _id: -1 } }))!;
    expect(doc._id.toHexString()).to.equal("0000000000000000000000b2");
    expect(doc.transaction).to.be.instanceOf(Types.ObjectId);
    expect(doc.createdAt).to.be.instanceOf(Date);
    expect(doc.meta).to.equal(JSON.stringify({ i: 2 }));
  });

  it("find supports inclusion projection (Book.void journal field set)", async () => {
    const jid = newId();
    await journalCol().insertOne(
      {
        _id: jid,
        datetime: new Date(TX_MS),
        memo: "proj",
        book: BOOK,
        _transactions: [new ObjectId()],
        voided: true,
        void_reason: "because",
      },
      {}
    );
    const doc = (await journalCol().findOne(
      { _id: jid },
      {
        projection: { _id: true, _transactions: true, memo: true, void_reason: true, voided: true, datetime: true },
      }
    ))!;
    expect(doc._id).to.be.instanceOf(Types.ObjectId);
    expect(doc._transactions).to.be.an("array").with.lengthOf(1);
    expect(doc.memo).to.equal("proj");
    expect(doc.voided).to.equal(true);
    expect(doc.void_reason).to.equal("because");
    expect(doc).to.not.have.property("book");
  });

  it("countDocuments counts matching rows (Book.ledger total)", async () => {
    expect(await txCol().countDocuments({ book: LEDGER_BOOK })).to.equal(6);
    expect(await txCol().countDocuments({ book: "no-such-book" })).to.equal(0);
  });

  it("distinct returns distinct account values (Book.listAccounts shape)", async () => {
    const jid = newId();
    const docs = [ACCOUNT, FOOD_ACCOUNT, ACCOUNT].map((accounts, i) =>
      txDoc({
        _id: newId(),
        book: DISTINCT_BOOK,
        accounts,
        account_path: accounts.split(":"),
        memo: `d${i}`,
        _journal: jid,
      })
    );
    await txCol().insertMany(docs, {});
    const values = (await txCol().distinct("accounts", { book: DISTINCT_BOOK })) as string[];
    expect(values.slice().sort()).to.deep.equal([ACCOUNT, FOOD_ACCOUNT]);
  });

  it("distinct rejects an unknown field (UnsupportedMongoOperationError)", async () => {
    try {
      await txCol().distinct("not_a_column", { book: DISTINCT_BOOK });
      throw new Error(EXPECT_UNSUPPORTED);
    } catch (err) {
      expect(err).to.be.instanceOf(UnsupportedMongoOperationError);
    }
  });

  it("aggregate returns [] when no rows match (Book.ts:129 falsy guard)", async () => {
    const rows = await txCol()
      .aggregate([{ $match: { book: "no-such-book" } }, GROUP_STAGE])
      .toArray();
    expect(rows).to.deep.equal([]);
  });

  it("aggregate returns the fixed GROUP result without pre-rounding (lastTransactionId is a real ObjectId)", async () => {
    const id = newId();
    await txCol().insertOne(txDoc({ _id: id, book: "float-book", credit: 0.1, debit: 0.3 }), {});
    const rows = await txCol()
      .aggregate([{ $match: { book: "float-book" } }, GROUP_STAGE])
      .toArray();
    expect(rows.length).to.equal(1);
    expect(rows[0]._id).to.equal(null);
    expect(rows[0].balance).to.equal(0.1 - 0.3);
    expect(rows[0].notes).to.equal(1);
    expect(rows[0].lastTransactionId).to.be.instanceOf(Types.ObjectId);
    expect(rows[0].lastTransactionId.toHexString()).to.equal(id);

    const total = await txCol().countDocuments({});
    const whole = await txCol().aggregate([GROUP_STAGE]).toArray();
    expect(whole.length).to.equal(1);
    expect(whole[0].notes).to.equal(total);
  });

  it("aggregate rejects non-matching pipelines (UnsupportedMongoOperationError)", () => {
    const badPipelines: IAnyObject[][] = [
      [{ $match: {} }],
      [
        { $match: { book: "x" } },
        {
          $group: { _id: null, balance: { $max: "$credit" }, notes: { $sum: 1 }, lastTransactionId: { $max: "$_id" } },
        },
      ],
      [{ $match: {} }, GROUP_STAGE, GROUP_STAGE],
      [],
    ];
    for (const pipeline of badPipelines) {
      try {
        txCol().aggregate(pipeline);
        throw new Error(EXPECT_UNSUPPORTED);
      } catch (err) {
        expect(err, `pipeline ${JSON.stringify(pipeline)}`).to.be.instanceOf(UnsupportedMongoOperationError);
      }
    }
  });

  it("updateOne reports matchedCount 1 / modifiedCount 0 for a matched-but-unchanged update (QA M12)", async () => {
    const d1 = new Date(TX_MS);
    await lockCol().insertOne({ _id: newId(), book: BOOK, account: "M:12", updatedAt: d1, __v: 0 }, {});
    const result = await lockCol().updateOne({ account: "M:12", book: BOOK }, { $set: { updatedAt: d1 } }, {});
    expect(result.matchedCount).to.equal(1);
    expect(result.modifiedCount).to.equal(0);
    expect(result).to.not.have.property("upsertedId");
  });

  it("updateMany reports matchedCount N / modifiedCount 0 for matched-but-unchanged rows (QA M12)", async () => {
    const ids = [0, 1, 2].map((i) => newId());
    await txCol().insertMany(
      ids.map((id, i) => txDoc({ _id: id, book: "void-book", memo: `v${i}`, voided: true })),
      {}
    );
    const result = await txCol().updateMany({ book: "void-book" }, { $set: { voided: true } }, {});
    expect(result.matchedCount).to.equal(3);
    expect(result.modifiedCount).to.equal(0);
  });

  it("updateOne upsert: fresh row gets $setOnInsert + $inc, second call matches (Book.writelockAccounts shape)", async () => {
    const d1 = new Date(TX_MS);
    const d2 = new Date(TX_MS + 1);
    const r1 = await lockCol().updateOne(
      { account: "A:B", book: BOOK },
      { $set: { updatedAt: d1 }, $setOnInsert: { book: BOOK, account: "A:B" }, $inc: { __v: 1 } },
      { upsert: true }
    );
    expect(r1.matchedCount).to.equal(0);
    expect(r1.modifiedCount).to.equal(0);
    expect(r1.upsertedId).to.be.instanceOf(Types.ObjectId);
    const row1 = (await lockCol().findOne({ account: "A:B", book: BOOK }))!;
    expect(row1.__v).to.equal(1);

    const r2 = await lockCol().updateOne(
      { account: "A:B", book: BOOK },
      { $set: { updatedAt: d2 }, $setOnInsert: { book: BOOK, account: "A:B" }, $inc: { __v: 1 } },
      { upsert: true }
    );
    expect(r2.matchedCount).to.equal(1);
    expect(r2.modifiedCount).to.equal(1);
    expect(r2).to.not.have.property("upsertedId");
    const row2 = (await lockCol().findOne({ account: "A:B", book: BOOK }))!;
    expect(row2.__v).to.equal(2);
  });

  it("concurrent updateOne upserts produce exactly one row with __v incremented (writelockAccounts under writers)", async () => {
    const upsert = () =>
      connection.transaction((session) =>
        lockCol().updateOne(
          { account: CONCURRENT_ACCOUNT, book: BOOK },
          {
            $set: { updatedAt: new Date() },
            $setOnInsert: { book: BOOK, account: CONCURRENT_ACCOUNT },
            $inc: { __v: 1 },
          },
          { upsert: true, session }
        )
      );
    await Promise.all([upsert(), upsert(), upsert(), upsert(), upsert()]);
    expect(await lockCol().countDocuments({ account: CONCURRENT_ACCOUNT, book: BOOK })).to.equal(1);
    const row = (await lockCol().findOne({ account: CONCURRENT_ACCOUNT, book: BOOK }))!;
    expect(row.__v).to.equal(5);
  });

  it("updateOne rejects unknown update operators (UnsupportedMongoOperationError)", async () => {
    try {
      await lockCol().updateOne({ account: "A:B", book: BOOK }, { $push: { tags: ["x"] } }, {});
      throw new Error(EXPECT_UNSUPPORTED);
    } catch (err) {
      expect(err).to.be.instanceOf(UnsupportedMongoOperationError);
    }
  });

  it("balances key round-trips a NUL-bearing latin1 digest through hex storage (QA M9)", async () => {
    const raw = String.fromCharCode(0x00, 0x41, 0xff, 0x0b, 0x00, 0x7f, 0x10, 0x00);
    const tId = new ObjectId();
    await balCol().insertOne(
      {
        key: raw,
        rawKey: "rk",
        book: BOOK,
        account: "N:Key",
        transaction: tId,
        balance: 1.5,
        notes: 2,
        meta: JSON.stringify({ x: 1 }),
      },
      { forceServerObjectId: true }
    );
    const stored = (await getPrismaClient().$queryRawUnsafe('SELECT key FROM "medici_balances"')) as Array<{
      key: string;
    }>;
    expect(stored[0].key).to.match(/^[0-9a-f]{16}$/);
    const doc = (await balCol().findOne({ key: raw }))!;
    expect(doc.key).to.equal(raw);
    expect(doc.meta).to.equal(JSON.stringify({ x: 1 }));
    expect(doc.transaction).to.be.instanceOf(Types.ObjectId);
    expect(doc.createdAt).to.be.instanceOf(Date);
  });

  it("deleteOne deletes exactly one matching row; deleteMany deletes all (balance.spec.ts:149 shape)", async () => {
    const ids = [0, 1, 2].map((i) => newId());
    await txCol().insertMany(
      ids.map((id, i) => txDoc({ _id: id, book: DELETE_BOOK, memo: `del${i}` })),
      {}
    );
    expect(await txCol().countDocuments({ book: DELETE_BOOK })).to.equal(3);
    const one = await txCol().deleteOne({ book: DELETE_BOOK }, {});
    expect(one.deletedCount).to.equal(1);
    expect(await txCol().countDocuments({ book: DELETE_BOOK })).to.equal(2);
    const many = await txCol().deleteMany({ book: DELETE_BOOK }, {});
    expect(many.deletedCount).to.equal(2);
    expect(await txCol().countDocuments({ book: DELETE_BOOK })).to.equal(0);
  });

  it("a query on a closed session rejects (P2028) and never throws synchronously (QA S4, Book.ts:165-186)", async () => {
    let captured: ClientSession | undefined;
    await connection.transaction((session) => {
      captured = session;
      return Promise.resolve();
    });
    expect(captured?.closed).to.equal(true);
    let cursor: { toArray(): Promise<IAnyObject[]> } | undefined;
    try {
      cursor = txCol().aggregate([GROUP_STAGE], { session: captured! });
    } catch {
      throw new Error("querying a closed session must not throw synchronously");
    }
    let rejected = false;
    try {
      await cursor!.toArray();
    } catch {
      rejected = true;
    }
    expect(rejected).to.equal(true);
  });
});

describe("sqlCollection cross-connection (ITD-93, P2002 upsert fallback)", function () {
  this.timeout(30000);

  const TMP_DB = path.join(os.tmpdir(), `medici-itd93-xconn-${process.pid}-${Date.now()}.db`);
  const FILE_URL = `file:${TMP_DB}`;
  let rival: PrismaClient | undefined;

  before(async () => {
    process.env.MEDICI_SQL_DATABASE_URL = FILE_URL;
    await disconnectPrisma();
    await resetDatabase();
    rival = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: FILE_URL, timeout: 5000 }) });
    await rival.$connect();
  });

  after(async () => {
    await rival?.$disconnect().catch(() => undefined);
    process.env.MEDICI_SQL_DATABASE_URL = "file::memory:";
    await disconnectPrisma();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.unlinkSync(TMP_DB + suffix);
      } catch {
        // best-effort cleanup
      }
    }
  });

  it("concurrent upserts from two connections converge to one row (P2002 fallback)", async () => {
    const a: SqlCollection = createSqlCollection(getPrismaClient(), "medici_locks");
    const b: SqlCollection = createSqlCollection(rival!, "medici_locks");
    const upsert = (col: SqlCollection) => () =>
      col.updateOne(
        { account: "X:Income", book: XCONN_BOOK },
        { $set: { updatedAt: new Date() }, $setOnInsert: { book: XCONN_BOOK, account: "X:Income" }, $inc: { __v: 1 } },
        { upsert: true }
      );
    await Promise.all([upsert(a)(), upsert(b)(), upsert(a)(), upsert(b)(), upsert(a)(), upsert(b)()]);
    const rows = await a.find({ book: XCONN_BOOK }).toArray();
    expect(rows.length).to.equal(1);
    expect(rows[0].__v).to.equal(6);
  });
});

describe("sqlCollection cross-process (ITD-93, QA M3/G2 DoD)", function () {
  this.timeout(180000);

  const TMP_DB = path.join(os.tmpdir(), `medici-itd93-xproc-${process.pid}-${Date.now()}.db`);
  const FILE_URL = `file:${TMP_DB}`;
  const runId = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  let childClient: PrismaClient | undefined;

  before(async () => {
    execFileSync("npm", ["run", "build"], { cwd: REPO_ROOT, stdio: "pipe" });
    childClient = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: FILE_URL, timeout: 5000 }) });
    await childClient.$connect();
    await createSchema(childClient);
  });

  after(async () => {
    await childClient?.$disconnect().catch(() => undefined);
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.unlinkSync(TMP_DB + suffix);
      } catch {
        // best-effort cleanup
      }
    }
  });

  function runChild(): Promise<string[]> {
    return new Promise((resolve, reject) => {
      execFile(process.execPath, [FIXTURE, FILE_URL, runId], (err, stdout) => {
        if (err) {
          reject(new Error(`child failed: ${err.message}\n${stdout}`));
          return;
        }
        try {
          const parsed = JSON.parse(stdout.trim()) as { ok: boolean; ids: string[] };
          if (!parsed.ok) {
            reject(new Error(`child not ok: ${stdout}`));
            return;
          }
          resolve(parsed.ids);
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  it("insertMany across two writer processes yields strictly increasing _ids (QA M3/G2 DoD)", async () => {
    const batchA = await runChild();
    const batchB = await runChild();
    expect(batchA.length).to.equal(5);
    expect(batchB.length).to.equal(5);
    strictlyIncreasing(batchA);
    strictlyIncreasing(batchB);
    expect(Buffer.compare(Buffer.from(batchA[4], "hex"), Buffer.from(batchB[0], "hex"))).to.equal(-1);
  });
});
