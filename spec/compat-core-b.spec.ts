/* eslint sonarjs/no-duplicate-string: off */
import { expect } from "chai";
import { ObjectId as BsonObjectId } from "bson";
import { Schema, Types, ValidationError, connection, model } from "mongoose";
import type { Collection, Cursor } from "mongoose";
import { UnsupportedMongoOperationError } from "../src/errors";
import type { IAnyObject } from "../src/IAnyObject";

/**
 * compat core B (ITD-101): Model / Document / query-object / hydration
 * behaviour, DB-free. The fakes below stand in for the ITD-93 raw
 * collection adapter: they store rows exactly as given (raw
 * Prisma-shaped values) and apply equality filters plus the `sort`
 * option — which the real adapter implements in SQL.
 */

function eq(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown => (v instanceof BsonObjectId ? v.toHexString() : v);
  const an = norm(a);
  const bn = norm(b);
  if (an === bn) {
    return true;
  }
  if (an instanceof Date && bn instanceof Date) {
    return an.getTime() === bn.getTime();
  }
  if (an !== null && bn !== null && typeof an === "object" && typeof bn === "object") {
    return JSON.stringify(an) === JSON.stringify(bn);
  }
  return false;
}

class FakeCollection {
  rows: IAnyObject[] = [];

  private matches(row: IAnyObject, filter: IAnyObject): boolean {
    return Object.entries(filter).every(([k, v]) => {
      if (v !== null && typeof v === "object" && !(v instanceof Date) && !(v instanceof BsonObjectId)) {
        return Object.entries(v as IAnyObject).every(([op, operand]) => {
          if (op === "$in") {
            return (operand as unknown[]).some((c) => eq(row[k], c));
          }
          if (op === "$gt") {
            return row[k] !== undefined && String(row[k]) > String(operand);
          }
          return eq(row[k], operand);
        });
      }
      return eq(row[k], v);
    });
  }

  private sorted(filter: IAnyObject, options: IAnyObject): IAnyObject[] {
    let rows = this.rows.filter((r) => this.matches(r, filter));
    const sort = options.sort;
    if (sort) {
      const fields: Array<[string, 1 | -1]> =
        typeof sort === "string"
          ? [[sort.replace(/^-/, ""), (sort.startsWith("-") ? -1 : 1) as 1 | -1]]
          : Object.entries(sort).map(([k, d]) => [k, d as 1 | -1]);
      rows = [...rows].sort((a, b) => {
        for (const [k, dir] of fields) {
          const av = String(a[k] ?? "");
          const bv = String(b[k] ?? "");
          if (av !== bv) {
            return av < bv ? -dir : dir;
          }
        }
        return 0;
      });
    }
    return rows;
  }

  insertOne(doc: IAnyObject, options?: IAnyObject): Promise<{ acknowledged: true; insertedId: unknown }> {
    void options;
    this.rows.push({ ...doc });
    return Promise.resolve({ acknowledged: true, insertedId: doc._id });
  }

  insertMany(docs: IAnyObject[], options?: IAnyObject): Promise<{ acknowledged: true; insertedIds: IAnyObject }> {
    void options;
    const insertedIds: IAnyObject = {};
    docs.forEach((d, i) => {
      this.rows.push({ ...d });
      insertedIds[String(i)] = d._id;
    });
    return Promise.resolve({ acknowledged: true, insertedIds });
  }

  find(filter: IAnyObject = {}, options: IAnyObject = {}): Cursor<any> {
    return {
      toArray: () => Promise.resolve(this.sorted(filter, options).map((r) => ({ ...r }))),
    };
  }

  findOne(filter: IAnyObject = {}, options: IAnyObject = {}): Promise<IAnyObject | null> {
    const rows = this.sorted(filter, options);
    return Promise.resolve(rows[0] ? { ...rows[0] } : null);
  }

  updateOne(
    filter: IAnyObject,
    update: IAnyObject,
    options?: IAnyObject
  ): Promise<{ matchedCount: number; modifiedCount: number }> {
    void options;
    const i = this.rows.findIndex((r) => this.matches(r, filter));
    if (i === -1) {
      return Promise.resolve({ matchedCount: 0, modifiedCount: 0 });
    }
    const set = (update.$set ?? {}) as IAnyObject;
    this.rows[i] = { ...this.rows[i], ...set };
    return Promise.resolve({ matchedCount: 1, modifiedCount: Object.keys(set).length });
  }

  updateMany(
    filter: IAnyObject,
    update: IAnyObject,
    options?: IAnyObject
  ): Promise<{ matchedCount: number; modifiedCount: number }> {
    void options;
    const set = (update.$set ?? {}) as IAnyObject;
    let matched = 0;
    this.rows = this.rows.map((r) => {
      if (this.matches(r, filter)) {
        matched += 1;
        return { ...r, ...set };
      }
      return r;
    });
    return Promise.resolve({ matchedCount: matched, modifiedCount: matched });
  }

  upsert(filter: IAnyObject, update: IAnyObject, options?: IAnyObject): Promise<any> {
    void filter;
    void update;
    void options;
    throw new Error("FakeCollection.upsert not used in the compat core B specs");
  }

  deleteOne(filter: IAnyObject, options?: IAnyObject): Promise<{ deletedCount: number }> {
    void options;
    const i = this.rows.findIndex((r) => this.matches(r, filter));
    if (i === -1) {
      return Promise.resolve({ deletedCount: 0 });
    }
    this.rows.splice(i, 1);
    return Promise.resolve({ deletedCount: 1 });
  }

  deleteMany(filter: IAnyObject = {}, options?: IAnyObject): Promise<{ deletedCount: number }> {
    void options;
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !this.matches(r, filter));
    return Promise.resolve({ deletedCount: before - this.rows.length });
  }

  countDocuments(filter: IAnyObject = {}, options?: IAnyObject): Promise<number> {
    void options;
    return Promise.resolve(this.rows.filter((r) => this.matches(r, filter)).length);
  }

  distinct(field: string, filter: IAnyObject = {}, options?: IAnyObject): Promise<unknown[]> {
    void options;
    const seen = new Set<string>();
    this.rows.filter((r) => this.matches(r, filter)).forEach((r) => seen.add(String(r[field])));
    return Promise.resolve([...seen]);
  }

  aggregate(pipeline?: any, options?: any): Cursor<any> {
    void pipeline;
    void options;
    throw new Error("FakeCollection.aggregate not used in the compat core B specs");
  }
}

const H1 = "000000000000000000000001";
const H2 = "000000000000000000000002";
const H3 = "000000000000000000000003";
// Exactly 24 hex chars — ObjectIds are 12 bytes.
const JOURNAL = "aaaaaaaaaaaaaaaaaaaaaaaa";

function txRow(id: string, journal: string, extra: IAnyObject = {}): IAnyObject {
  return {
    _id: id,
    book: "B",
    accounts: "A",
    memo: "m",
    credit: 1,
    debit: 2,
    account_path: JSON.stringify(["A"]),
    meta: JSON.stringify({}),
    _journal: journal,
    datetime: new Date("2026-01-01T00:00:00.000Z"),
    timestamp: new Date("2026-01-01T00:00:00.000Z"),
    voided: null,
    void_reason: null,
    _original_journal: null,
    ...extra,
  };
}

describe("compat core B (ITD-101)", () => {
  const txSchema = new Schema(
    {
      credit: Number,
      debit: Number,
      meta: Schema.Types.Mixed,
      datetime: Date,
      account_path: [String],
      accounts: String,
      book: String,
      memo: String,
      _journal: { type: Schema.Types.ObjectId, ref: "Medici_Journal" },
      timestamp: Date,
      voided: Boolean,
      void_reason: String,
      _original_journal: { type: Schema.Types.ObjectId, ref: "Medici_Journal" },
    },
    { id: false, versionKey: false, timestamps: false }
  );

  const balanceSchema = new Schema(
    {
      key: String,
      rawKey: String,
      book: String,
      account: String,
      transaction: Types.ObjectId,
      meta: Schema.Types.Mixed,
      balance: Number,
      notes: Number,
      createdAt: Date,
      expireAt: Date,
    },
    { id: false, versionKey: false, timestamps: false }
  );

  const journalSchema = new Schema(
    {
      datetime: Date,
      memo: { type: String, default: "" },
      _transactions: [{ type: Schema.Types.ObjectId, ref: "Medici_Transaction" }],
      book: String,
      voided: Boolean,
      void_reason: String,
    },
    { id: false, versionKey: false, timestamps: false }
  );

  const txFake = new FakeCollection();
  const balFake = new FakeCollection();
  const journalFake = new FakeCollection();

  let tx: any;
  let balance: any;
  let journal: any;
  let previousBalance: any;

  before(() => {
    tx = model("ITD101_Tx", txSchema);
    // Registered under the UPSTREAM name on purpose: the model-aware meta
    // rule (hydration.ts META_AS_STRING_MODELS) keys on "Medici_Balance",
    // because that is the name the verbatim models/balance.ts registers.
    previousBalance = connection.models["Medici_Balance"];
    balance = model("Medici_Balance", balanceSchema);
    journal = model("ITD101_Journal", journalSchema);
    tx.collection = txFake as unknown as Collection<any>;
    balance.collection = balFake as unknown as Collection<any>;
    journal.collection = journalFake as unknown as Collection<any>;
  });

  after(() => {
    connection.deleteModel("ITD101_Tx");
    connection.deleteModel("ITD101_Journal");
    connection.deleteModel("ITD101_Unwired");
    connection.deleteModel("Medici_Balance");
    if (previousBalance) {
      connection.models["Medici_Balance"] = previousBalance;
    }
  });

  it("generates _id at construction, before any insert", () => {
    const d: any = new tx({ book: "B", credit: 1, debit: 2 });
    expect(d._id).to.be.instanceof(Types.ObjectId);
    expect(d._id._id).to.equal(d._id);
    expect(txFake.rows).to.have.length(0);
  });

  it("rejects validate() with the exact message shape for a bad datetime", async () => {
    const d: any = new tx({ book: "B", datetime: "not-a-date" });
    let error: unknown;
    try {
      await d.validate();
    } catch (err) {
      error = err;
    }
    expect(error).to.be.instanceof(ValidationError);
    expect((error as Error).message).to.match(/^ITD101_Tx validation failed: datetime: /);
  });

  it("find() defaults to insertion order (no sort)", async () => {
    txFake.rows = [txRow(H1, JOURNAL), txRow(H2, JOURNAL), txRow(H3, JOURNAL)];
    const rows = await tx.find({});
    expect(rows.map((r: any) => r._id.toHexString())).to.deep.equal([H1, H2, H3]);
  });

  it("supports both .sort() forms (string and object)", async () => {
    txFake.rows = [txRow(H1, JOURNAL), txRow(H2, JOURNAL), txRow(H3, JOURNAL)];
    const byString: any[] = await tx.find({}).sort("-_id");
    expect(byString.map((r) => r._id.toHexString())).to.deep.equal([H3, H2, H1]);

    const byObject: any[] = await tx.find({}).sort({ _id: -1 });
    expect(byObject.map((r) => r._id.toHexString())).to.deep.equal([H3, H2, H1]);

    const ascending: any[] = await tx.find({}).sort({ _id: 1 });
    expect(ascending.map((r) => r._id.toHexString())).to.deep.equal([H1, H2, H3]);
  });

  it(".lean() returns plain objects that still hydrate types (xacid.spec.ts:542 shape)", async () => {
    txFake.rows = [txRow(H1, JOURNAL)];
    const hydrated: any = (await tx.find({}))[0];
    expect(hydrated.save).to.be.a("function");
    expect(hydrated.toObject).to.be.a("function");

    const lean: any = (await tx.find({}).lean())[0];
    expect(Object.getPrototypeOf(lean)).to.equal(Object.prototype);
    expect(lean).to.not.have.property("save");
    expect(lean).to.not.have.property("toObject");
    expect(lean._id).to.be.instanceof(Types.ObjectId);
    expect(lean.datetime).to.be.instanceof(Date);
    expect(lean.datetime.getTime()).to.be.a("number");

    const oneLean: any = await tx.findOne({ _id: H1 }).lean();
    expect(Object.getPrototypeOf(oneLean)).to.equal(Object.prototype);
    expect(oneLean._id.toHexString()).to.equal(H1);
  });

  it("hydrates ObjectId / ObjectId[] / string[] / Date / meta columns (M8 mapping)", async () => {
    txFake.rows = [
      txRow(H1, JOURNAL, {
        account_path: JSON.stringify(["A", "B"]),
        meta: JSON.stringify({ clientId: "1" }),
      }),
    ];
    const d: any = (await tx.find({}))[0];
    expect(d._id).to.be.instanceof(Types.ObjectId);
    expect(d._id.toHexString()).to.equal(H1);
    expect(d._journal).to.be.instanceof(Types.ObjectId);
    expect(d._journal.toHexString()).to.equal(JOURNAL);
    expect(d.account_path).to.deep.equal(["A", "B"]);
    expect(d.meta).to.deep.equal({ clientId: "1" });
    expect(d.datetime).to.be.instanceof(Date);
    expect(d.timestamp).to.be.instanceof(Date);
  });

  it("keeps balance meta a JSON string (model-aware mapping; book.spec.ts:350/374)", async () => {
    balFake.rows = [
      {
        _id: "000000000000000000000009",
        key: "k",
        rawKey: "r",
        book: "B",
        account: "Assets",
        transaction: "cccccccccccccccccccccccc",
        meta: '{"clientId":"12345"}',
        balance: -500,
        notes: 1,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        expireAt: new Date("2026-02-01T00:00:00.000Z"),
      },
    ];
    const s: any = (await balance.find({ book: "B" }))[0];
    expect(s.meta).to.equal('{"clientId":"12345"}');
    expect(s.transaction).to.be.instanceof(Types.ObjectId);
    expect(s.transaction.toHexString()).to.equal("cccccccccccccccccccccccc");
    expect(s.createdAt).to.be.instanceof(Date);
  });

  it("hydrates journal _transactions to ObjectId[] (book.spec.ts:114 shape)", async () => {
    journalFake.rows = [
      {
        _id: "dddddddddddddddddddddddd",
        book: "B",
        memo: "m",
        datetime: new Date("2026-01-01T00:00:00.000Z"),
        _transactions: JSON.stringify(["111111111111111111111111", "222222222222222222222222"]),
        voided: null,
        void_reason: null,
      },
    ];
    const j: any = (await journal.find({}))[0];
    expect(j._transactions).to.have.lengthOf(2);
    expect(j._transactions[0]).to.be.instanceof(Types.ObjectId);
    expect(j._transactions[0].toHexString()).to.equal("111111111111111111111111");
    expect(j._transactions[1].toHexString()).to.equal("222222222222222222222222");
  });

  it("omits NULL/undefined columns instead of returning null", async () => {
    txFake.rows = [txRow(H1, JOURNAL)];
    const d: any = (await tx.find({}))[0];
    expect(d).to.not.have.property("voided");
    expect(d).to.not.have.property("void_reason");
    expect(d).to.not.have.property("_original_journal");

    const lean: any = (await tx.find({}).lean())[0];
    expect(lean).to.not.have.property("voided");
    expect(lean).to.not.have.property("_original_journal");

    // explicitly absent (undefined) rows keys are omitted too
    txFake.rows = [{ _id: H2, book: "B", credit: 1, debit: 2 }];
    const bare: any = (await tx.find({}))[0];
    expect(bare).to.not.have.property("memo");
    expect(bare).to.not.have.property("_journal");
  });

  it("Document.save() persists changed fields (book.spec.ts:331 shape)", async () => {
    balFake.rows = [
      {
        _id: "000000000000000000000009",
        key: "k",
        rawKey: "r",
        book: "B",
        account: "Assets",
        transaction: "cccccccccccccccccccccccc",
        meta: "{}",
        balance: -500,
        notes: 1,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        expireAt: new Date("2026-02-01T00:00:00.000Z"),
      },
    ];
    const snapshots: any[] = await balance.find({ book: "B" });
    expect(snapshots).to.have.length(1);
    snapshots[0].balance = 999;
    await snapshots[0].save();

    const after: any = (await balance.find({ book: "B" }))[0];
    expect(after.balance).to.equal(999);
  });

  it("Document.deleteOne() + Model.create() round-trip (balance.spec.ts:141-159 shape)", async () => {
    txFake.rows = [txRow(H1, JOURNAL), txRow(H2, JOURNAL)];

    const t1: any = await tx.findOne({ _journal: JOURNAL }).sort("-_id").exec(); // last transaction
    expect(t1).to.exist;
    expect(t1._id.toHexString()).to.equal(H2);

    const t1Object = t1.toObject();
    expect(Object.getPrototypeOf(t1Object)).to.equal(Object.prototype);
    await t1.deleteOne();
    expect(txFake.rows).to.have.length(1);

    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete t1Object._id;
    const created: any = await tx.create(t1Object);
    expect(created._id).to.be.instanceof(Types.ObjectId);
    expect(created._id.toHexString()).to.not.equal(H2);
    expect(txFake.rows).to.have.length(2);
    expect(txFake.rows.some((r) => r.book === "B")).to.be.true;
  });

  it("deleteMany is directly awaitable and supports .exec() (book.spec.ts:615 / xacid.spec.ts:494)", async () => {
    balFake.rows = [
      { _id: "000000000000000000000009", book: "B", key: "k", rawKey: "r", balance: 1, notes: 1 },
      { _id: "00000000000000000000000a", book: "C", key: "k2", rawKey: "r2", balance: 2, notes: 1 },
    ];
    await balance.deleteMany({ book: "B" });
    expect(balFake.rows).to.have.length(1);

    const result: any = await balance.deleteMany({}).exec();
    expect(result.deletedCount).to.equal(1);
    expect(balFake.rows).to.have.length(0);
  });

  it("init() and syncIndexes() resolve as no-ops (index DDL is Prisma's, ITD-90)", async () => {
    await tx.init();
    await balance.syncIndexes({ background: false });
    await journal.init();
  });

  it("an unwired model still fails loudly, naming ITD-93", async () => {
    const unwired: any = model("ITD101_Unwired", new Schema({ x: String }));
    let error: unknown;
    try {
      await unwired.find({});
    } catch (err) {
      error = err;
    }
    expect(error).to.be.instanceof(UnsupportedMongoOperationError);
    expect((error as Error).message).to.match(/ITD-93/);

    let saveError: unknown;
    const doc: any = new unwired({ x: "y" });
    try {
      await doc.save();
    } catch (err) {
      saveError = err;
    }
    expect(saveError).to.be.instanceof(UnsupportedMongoOperationError);
    expect((saveError as Error).message).to.match(/ITD-93/);
  });

  it("findOne with no match resolves null, hydrated and lean", async () => {
    txFake.rows = [txRow(H1, JOURNAL)];
    const missing = "ffffffffffffffffffffffff";
    expect(await tx.findOne({ _id: missing })).to.equal(null);
    expect(await tx.findOne({ _id: missing }).lean()).to.equal(null);
    expect(await tx.find({ book: "nope" })).to.deep.equal([]);
  });

  it("keeps the model name in the validation message across deleteModel + re-register", async () => {
    connection.deleteModel("ITD101_Tx");
    tx = model("ITD101_Tx", txSchema);
    tx.collection = txFake as unknown as Collection<any>;

    const d: any = new tx({ book: "B", datetime: "still invalid" });
    let error: unknown;
    try {
      await d.validate();
    } catch (err) {
      error = err;
    }
    expect(error).to.be.instanceof(ValidationError);
    expect((error as Error).message).to.match(/^ITD101_Tx validation failed: datetime: /);
    expect(connection.models["ITD101_Tx"]).to.equal(tx);
  });
});
