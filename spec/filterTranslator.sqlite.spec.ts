/**
 * ITD-92 — round-trip tests for the Mongo filter translator against a real
 * SQLite database with seeded rows (QA G5/G6/M13).
 *
 * Each case translates a Mongo-shaped filter and asserts the exact set of
 * selected `_id` values, proving that each operator selects the right rows
 * end to end: `$in` on a meta JSON path, nested meta paths, object-valued
 * meta deep-equality, `$or` over account_path shapes, `_id` hex-string
 * ranges across a byte boundary, and the `account_path.3` JSON fallback.
 */
import { expect } from "chai";
import { Types } from "mongoose";
import { IAnyObject } from "../src/IAnyObject";
import { getPrismaClient, disconnectPrisma } from "../src/database/client";
import { resetDatabase } from "../src/database/schema";
import { translateFilter } from "../src/database/filterTranslator";
import { parseFilterQuery } from "../src/helper/parse/parseFilterQuery";
import { parseBalanceQuery } from "../src/helper/parse/parseBalanceQuery";
import { UnsupportedMongoOperationError } from "../src/errors/UnsupportedMongoOperationError";

// Must be set before the first client is constructed.
process.env.MEDICI_SQL_DATABASE_URL = "file::memory:";

const BOOK = "RT";
const OTHER = "Other";
const J1 = "aaaaaaaaaaaaaaaaaaaaaaaa";
const J2 = "bbbbbbbbbbbbbbbbbbbbbbbb";

const T10 = "000000000000000000000010";
const T9F = "00000000000000000000009f";
const TFF = "0000000000000000000000ff";
const T100 = "000000000000000000000100";
const TA0 = "0000000000000000000000a0";
const TA1 = "0000000000000000000000a1";
const TA2 = "0000000000000000000000a2";
const TA3 = "0000000000000000000000a3";

// True byte (== lexicographic == time) order of the seeded ids. Note the QA
// G5 boundary pair: TFF (0xff = 255) sorts BEFORE T100 (0x100 = 256), which
// a naive decimal reading of the trailing digits would invert.
const ALL_IDS = [T10, T9F, TA0, TA1, TA2, TA3, TFF, T100];
const BOOK_IDS = [T10, T9F, TA1, TA2, TA3, TFF, T100];

const D = (i: number) => new Date(Date.UTC(2026, 0, 1 + i, 12));

interface SeedRow {
  id: string;
  book: string;
  path: string[];
  meta: IAnyObject;
  datetime: Date;
  voided: boolean | null;
  journal: string;
}

const SEED: SeedRow[] = [
  {
    id: T10,
    book: BOOK,
    path: ["Assets"],
    meta: { clientId: "12345", bookmarked: true, a: { b: 1 }, address: { city: "Berlin" } },
    datetime: D(0),
    voided: null,
    journal: J1,
  },
  {
    id: TFF,
    book: BOOK,
    path: ["Assets", "Gold"],
    meta: { clientId: "67890", bookmarked: false },
    datetime: D(1),
    voided: false,
    journal: J1,
  },
  {
    id: T100,
    book: BOOK,
    path: ["Expenses"],
    meta: { clientId: "12345", bookmarked: false, a: { b: 2 }, tags: ["x", "y"] },
    datetime: D(2),
    voided: true,
    journal: J2,
  },
  {
    id: T9F,
    book: BOOK,
    path: ["Assets", "Gold", "Swiss"],
    meta: { bookmarked: true, address: { city: "Hamburg" }, empty: {}, emptyArr: [] },
    datetime: D(3),
    voided: null,
    journal: J2,
  },
  { id: TA0, book: OTHER, path: ["Assets"], meta: { clientId: "12345" }, datetime: D(4), voided: null, journal: J1 },
  {
    id: TA1,
    book: BOOK,
    path: ["Liab", "Debt", "Loans", "Home"],
    meta: { clientId: "12345", bookmarked: true },
    datetime: D(5),
    voided: null,
    journal: J1,
  },
  {
    id: TA2,
    book: BOOK,
    path: ["Assets", "Gold"],
    meta: { clientId: "67890", bookmarked: true, address: { city: "Berlin", country: "DE" } },
    datetime: D(6),
    voided: false,
    journal: J2,
  },
  {
    id: TA3,
    book: BOOK,
    path: ["Assets"],
    meta: { bookmarked: true, a: "notanobject" },
    datetime: D(7),
    voided: null,
    journal: J1,
  },
];

describe("translateFilter — SQLite round-trip (ITD-92)", function () {
  this.timeout(20000);

  before(async () => {
    await resetDatabase();
    const prisma = getPrismaClient();
    for (const row of SEED) {
      await prisma.transaction.create({
        data: {
          id: row.id,
          credit: 0,
          debit: 0,
          meta: JSON.stringify(row.meta),
          datetime: row.datetime,
          accountPath: JSON.stringify(row.path),
          accounts: row.path.join(":"),
          book: row.book,
          memo: "",
          journal: row.journal,
          timestamp: row.datetime,
          voided: row.voided,
          voidReason: null,
          originalJournal: null,
          accountPath0: row.path[0] ?? null,
          accountPath1: row.path[1] ?? null,
          accountPath2: row.path[2] ?? null,
        },
      });
    }
  });

  after(async () => {
    await disconnectPrisma();
  });

  async function selectIds(filter: IAnyObject): Promise<string[]> {
    const prisma = getPrismaClient();
    const { where, params } = translateFilter(filter);
    const sql =
      where === ""
        ? "SELECT _id FROM medici_transactions ORDER BY _id"
        : `SELECT _id FROM medici_transactions WHERE ${where} ORDER BY _id`;
    const rows = await prisma.$queryRawUnsafe<{ _id: string }[]>(sql, ...params);
    return rows.map((row) => row._id);
  }

  it("empty filter selects every row", async () => {
    expect(await selectIds({})).to.deep.equal(ALL_IDS);
  });

  it("equality on book", async () => {
    expect(await selectIds({ book: BOOK })).to.deep.equal(BOOK_IDS);
  });

  it("$in on a meta JSON path (balance.spec.ts:120 shape)", async () => {
    expect(await selectIds({ book: BOOK, "meta.clientId": { $in: ["12345", "67890"] } })).to.deep.equal([
      T10,
      TA1,
      TA2,
      TFF,
      T100,
    ]);
  });

  it("empty $in selects nothing", async () => {
    expect(await selectIds({ book: BOOK, "meta.clientId": { $in: [] } })).to.deep.equal([]);
  });

  it("nested meta path meta.a.b", async () => {
    expect(await selectIds({ book: BOOK, "meta.a.b": 1 })).to.deep.equal([T10]);
  });

  it("object-valued meta deep equality, contains semantics (QA M13/G7)", async () => {
    expect(await selectIds({ book: BOOK, "meta.address": { city: "Berlin" } })).to.deep.equal([T10, TA2]);
  });

  it("object-valued meta with all keys", async () => {
    expect(await selectIds({ book: BOOK, "meta.address": { city: "Berlin", country: "DE" } })).to.deep.equal([TA2]);
  });

  it("object-valued meta with no match", async () => {
    expect(await selectIds({ "meta.address": { city: "Paris" } })).to.deep.equal([]);
  });

  it("object-valued meta vs a scalar-stored value", async () => {
    expect(await selectIds({ "meta.a": { b: 1 } })).to.deep.equal([T10]);
  });

  it("array meta value matches length and elements", async () => {
    expect(await selectIds({ book: BOOK, "meta.tags": ["x", "y"] })).to.deep.equal([T100]);
    expect(await selectIds({ book: BOOK, "meta.tags": ["y", "x"] })).to.deep.equal([]);
    expect(await selectIds({ book: BOOK, "meta.tags": ["x"] })).to.deep.equal([]);
  });

  it("empty object and empty array meta values are exact", async () => {
    expect(await selectIds({ book: BOOK, "meta.empty": {} })).to.deep.equal([T9F]);
    expect(await selectIds({ book: BOOK, "meta.emptyArr": [] })).to.deep.equal([T9F]);
    expect(await selectIds({ book: BOOK, "meta.empty": { a: 1 } })).to.deep.equal([]);
    expect(await selectIds({ book: BOOK, "meta.emptyArr": [1] })).to.deep.equal([]);
  });

  it("account_path beyond index 2 uses the JSON fallback (QA G6)", async () => {
    expect(await selectIds({ book: BOOK, "account_path.3": "Home" })).to.deep.equal([TA1]);
    expect(await selectIds({ book: BOOK, accounts: "Liab:Debt:Loans:Home" })).to.deep.equal([TA1]);
  });

  it("$or over account_path shapes via parseFilterQuery", async () => {
    const orAssetsOrFood = parseFilterQuery({ account: ["Assets", "Expenses:Food"] }, { name: BOOK });
    expect(await selectIds(orAssetsOrFood)).to.deep.equal([T10, T9F, TA2, TA3, TFF]);
    const orSwissOrGold = parseFilterQuery({ account: ["Assets:Gold:Swiss", "Assets:Gold"] }, { name: BOOK });
    expect(await selectIds(orSwissOrGold)).to.deep.equal([T9F, TA2, TFF]);
  });

  it("_id range across a byte boundary (QA G5)", async () => {
    expect(await selectIds({ _id: { $gt: TFF, $lte: T100 } })).to.deep.equal([T100]);
    expect(await selectIds({ _id: { $gte: T9F, $lt: T100 } })).to.deep.equal([T9F, TA0, TA1, TA2, TA3, TFF]);
    expect(await selectIds({ _id: { $gt: TFF } })).to.deep.equal([T100]);
    expect(await selectIds({ _id: { $lte: T9F } })).to.deep.equal([T10, T9F]);
  });

  it("start_tx_id/end_tx_id via parseBalanceQuery", async () => {
    const filter = parseBalanceQuery(
      { start_tx_id: new Types.ObjectId(T10), end_tx_id: new Types.ObjectId(T100) },
      { name: BOOK }
    );
    expect(await selectIds(filter)).to.deep.equal([T9F, TA1, TA2, TA3, TFF, T100]);
  });

  it("datetime range", async () => {
    expect(await selectIds({ datetime: { $gte: D(1), $lte: D(2) } })).to.deep.equal([TFF, T100]);
  });

  it("voided null bucket (null/false equality)", async () => {
    // Mongo null bucket: `voided: false` (and `voided: null`) match rows whose
    // voided is missing (NULL) as well as rows with 0.
    expect(await selectIds({ book: BOOK, voided: false })).to.deep.equal([T10, T9F, TA1, TA2, TA3, TFF]);
    expect(await selectIds({ book: BOOK, voided: true })).to.deep.equal([T100]);
    expect(await selectIds({ book: BOOK, voided: null })).to.deep.equal([T10, T9F, TA1, TA2, TA3, TFF]);
  });

  it("voided $ne true matches missing", async () => {
    expect(await selectIds({ book: BOOK, voided: { $ne: true } })).to.deep.equal([T10, T9F, TA1, TA2, TA3, TFF]);
  });

  it("_journal equality (string, ObjectId, and document cast)", async () => {
    expect(await selectIds({ _journal: J1 })).to.deep.equal([T10, TA0, TA1, TA3, TFF]);
    expect(await selectIds({ _journal: new Types.ObjectId(J1) })).to.deep.equal([T10, TA0, TA1, TA3, TFF]);
    expect(await selectIds({ _journal: { _id: J1, memo: "doc" } })).to.deep.equal([T10, TA0, TA1, TA3, TFF]);
  });

  it("meta $ne matches missing values", async () => {
    expect(await selectIds({ book: BOOK, "meta.clientId": { $ne: "12345" } })).to.deep.equal([T9F, TA2, TA3, TFF]);
  });

  it("rejects a meta path that cannot be expressed as a JSON path", async () => {
    // Contains "[", which cannot be expressed in a SQLite JSON path, so the
    // translator must reject it before any SQL is built.
    const hostile = { ['meta.x[1"]; DROP TABLE medici_transactions; --']: 1 };
    let threw: unknown;
    try {
      translateFilter(hostile);
    } catch (err) {
      threw = err;
    }
    expect(threw).to.instanceOf(UnsupportedMongoOperationError);

    const prisma = getPrismaClient();
    const rows = await prisma.$queryRawUnsafe<{ c: number }[]>(`SELECT COUNT(*) AS c FROM medici_transactions`);
    expect(Number(rows[0].c)).to.equal(SEED.length);
  });

  it("queries with quote characters in the meta key", async () => {
    expect(await selectIds({ ['meta.drop"quote']: 1 })).to.deep.equal([]);
  });
});
