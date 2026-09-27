/**
 * ITD-92 — unit suite for the Mongo filter translator.
 *
 * Table-driven: one row per assertion in the vendored upstream specs
 * spec/parseFilterQuery.spec.ts and spec/parseBalanceQuery.spec.ts. Every
 * row runs the real (verbatim) parser, anchors the parser output against
 * the upstream expected-output literal, and then asserts the exact SQL
 * predicate the translator produces for it.
 */
import { expect } from "chai";
import * as sinon from "sinon";
import { Types } from "mongoose";
import { IAnyObject } from "../src/IAnyObject";
import { parseFilterQuery } from "../src/helper/parse/parseFilterQuery";
import { parseBalanceQuery } from "../src/helper/parse/parseBalanceQuery";
import * as Transaction from "../src/models/transaction";
import { isTransactionObjectIdKey } from "../src/models/transaction";
import { translateFilter, COLUMN_KINDS, CollectionName, SqlPredicate } from "../src/database/filterTranslator";
import { UnsupportedMongoOperationError } from "../src/errors/UnsupportedMongoOperationError";

interface BookLike {
  name: string;
  maxAccountPath?: number;
}

interface ParserRow {
  name: string;
  parser: "filter" | "balance";
  query: IAnyObject;
  book: BookLike;
  stubIsValidTransactionKey?: (value: unknown) => boolean;
  expectedOutput: IAnyObject;
  expected: SqlPredicate | { error: string };
}

const CLIENT_ID = "619af485cd56547936847584";
const JOURNAL_STR = new Types.ObjectId().toString();
const JOURNAL_OID = new Types.ObjectId();
const JOURNAL_OID_HEX = JOURNAL_OID.toHexString();
const START_TX_ID = new Types.ObjectId();
const END_TX_ID = new Types.ObjectId();
const START_TX_HEX = START_TX_ID.toHexString();
const END_TX_HEX = END_TX_ID.toHexString();
// Date params use the exact TEXT format Prisma stores DateTime values as
// (verified: `+00:00` suffix, not `Z`), so lexicographic == chronological.
const ISO_666 = "1970-01-01T00:00:00.666+00:00";
const ISO_999 = "1970-01-01T00:00:00.999+00:00";
const BOOK = "MyBook";

const ACCOUNTS_GOLD = "Assets:Gold";
const ACCOUNTS_GOLD_SWISS = "Assets:Gold:Swiss";
const ACCOUNTS_EXPENSES_GOLD_SWISS = "Expenses:Gold:Swiss";
const WHERE_ACCT0_1 = "book = ? AND account_path_0 = ? AND account_path_1 = ?";
const WHERE_ACCOUNTS = "book = ? AND accounts = ?";

const META_CLIENT_ID = `json_extract(meta, '$.clientId')`;
const META_BOOKMARKED = `json_extract(meta, '$.bookmarked')`;
const META_OTHER_ID = `json_extract(meta, '$._someOtherDatabaseId')`;
const META_JOURNAL = `json_extract(meta, '$._journal')`;
const META_X_EXPR = `json_extract(meta, '$.x')`;
const META_TAGS_EXPR = `json_extract(meta, '$.tags')`;
const META_TAGS_0_EXPR = `json_extract(meta, '$.tags[0]')`;
const META_TAGS_1_EXPR = `json_extract(meta, '$.tags[1]')`;

const parserRows: ParserRow[] = [
  // --- parseFilterQuery.spec.ts (17 its) ---
  {
    name: "filter: empty object",
    parser: "filter",
    query: {},
    book: { name: BOOK },
    expectedOutput: { book: BOOK },
    expected: { where: "book = ?", params: [BOOK] },
  },
  {
    name: "filter: _journal string",
    parser: "filter",
    query: { _journal: JOURNAL_STR },
    book: { name: BOOK },
    expectedOutput: { book: BOOK, _journal: new Types.ObjectId(JOURNAL_STR) },
    expected: { where: "book = ? AND _journal = ?", params: [BOOK, JOURNAL_STR] },
  },
  {
    name: "filter: _journal ObjectId",
    parser: "filter",
    query: { _journal: JOURNAL_OID },
    book: { name: BOOK },
    expectedOutput: { book: BOOK, _journal: new Types.ObjectId(JOURNAL_OID) },
    expected: { where: "book = ? AND _journal = ?", params: [BOOK, JOURNAL_OID_HEX] },
  },
  {
    name: "filter: start_date",
    parser: "filter",
    query: { start_date: new Date(666) },
    book: { name: BOOK },
    expectedOutput: { book: BOOK, datetime: { $gte: new Date(666) } },
    expected: { where: "book = ? AND datetime >= ?", params: [BOOK, ISO_666] },
  },
  {
    name: "filter: end_date",
    parser: "filter",
    query: { end_date: new Date(999) },
    book: { name: BOOK },
    expectedOutput: { book: BOOK, datetime: { $lte: new Date(999) } },
    expected: { where: "book = ? AND datetime <= ?", params: [BOOK, ISO_999] },
  },
  {
    name: "filter: start_date and end_date",
    parser: "filter",
    query: { start_date: new Date(666), end_date: new Date(999) },
    book: { name: BOOK },
    expectedOutput: { book: BOOK, datetime: { $gte: new Date(666), $lte: new Date(999) } },
    expected: { where: "book = ? AND (datetime >= ? AND datetime <= ?)", params: [BOOK, ISO_666, ISO_999] },
  },
  {
    // upstream: parseBalanceQuery({ clientId, bookmarked }) inside the filter spec
    name: "filter spec: meta via balance (clientId, bookmarked)",
    parser: "balance",
    query: { clientId: CLIENT_ID, bookmarked: true },
    book: { name: BOOK },
    expectedOutput: {
      book: BOOK,
      "meta.bookmarked": true,
      "meta.clientId": CLIENT_ID,
      meta: { clientId: CLIENT_ID, bookmarked: true },
    },
    expected: {
      where: `book = ? AND ${META_CLIENT_ID} = ? AND ${META_BOOKMARKED} = 1`,
      params: [BOOK, CLIENT_ID],
    },
  },
  {
    // upstream: parseFilterQuery({ _someOtherDatabaseId, bookmarked: false })
    name: "filter: meta with false value (null bucket)",
    parser: "filter",
    query: { _someOtherDatabaseId: CLIENT_ID, bookmarked: false },
    book: { name: BOOK },
    expectedOutput: {
      book: BOOK,
      "meta._someOtherDatabaseId": CLIENT_ID,
      "meta.bookmarked": false,
    },
    expected: {
      where: `book = ? AND ${META_OTHER_ID} = ? AND (${META_BOOKMARKED} IS NULL OR ${META_BOOKMARKED} = 0)`,
      params: [BOOK, CLIENT_ID],
    },
  },
  {
    name: "filter: account one path part",
    parser: "filter",
    query: { account: "Assets" },
    book: { name: BOOK },
    expectedOutput: { book: BOOK, "account_path.0": "Assets" },
    expected: { where: "book = ? AND account_path_0 = ?", params: [BOOK, "Assets"] },
  },
  {
    name: "filter: account two path parts",
    parser: "filter",
    query: { account: ACCOUNTS_GOLD },
    book: { name: BOOK },
    expectedOutput: { book: BOOK, "account_path.0": "Assets", "account_path.1": "Gold" },
    expected: { where: WHERE_ACCT0_1, params: [BOOK, "Assets", "Gold"] },
  },
  {
    name: "filter: account two path parts maxAccountPath 2",
    parser: "filter",
    query: { account: ACCOUNTS_GOLD },
    book: { name: BOOK, maxAccountPath: 2 },
    expectedOutput: { book: BOOK, accounts: ACCOUNTS_GOLD },
    expected: { where: WHERE_ACCOUNTS, params: [BOOK, ACCOUNTS_GOLD] },
  },
  {
    name: "filter: account three path parts",
    parser: "filter",
    query: { account: ACCOUNTS_GOLD_SWISS },
    book: { name: BOOK },
    expectedOutput: { book: BOOK, accounts: ACCOUNTS_GOLD_SWISS },
    expected: { where: WHERE_ACCOUNTS, params: [BOOK, ACCOUNTS_GOLD_SWISS] },
  },
  {
    name: "filter: account array one path part",
    parser: "filter",
    query: { account: ["Assets", "Expenses"] },
    book: { name: BOOK },
    expectedOutput: {
      book: BOOK,
      $or: [{ "account_path.0": "Assets" }, { "account_path.0": "Expenses" }],
    },
    expected: {
      where: "book = ? AND (account_path_0 = ? OR account_path_0 = ?)",
      params: [BOOK, "Assets", "Expenses"],
    },
  },
  {
    name: "filter: account array two path parts",
    parser: "filter",
    query: { account: [ACCOUNTS_GOLD, "Expenses:Gold"] },
    book: { name: BOOK },
    expectedOutput: {
      book: BOOK,
      $or: [
        { "account_path.0": "Assets", "account_path.1": "Gold" },
        { "account_path.0": "Expenses", "account_path.1": "Gold" },
      ],
    },
    expected: {
      where:
        "book = ? AND ((account_path_0 = ? AND account_path_1 = ?) OR (account_path_0 = ? AND account_path_1 = ?))",
      params: [BOOK, "Assets", "Gold", "Expenses", "Gold"],
    },
  },
  {
    name: "filter: account array three path parts",
    parser: "filter",
    query: { account: [ACCOUNTS_GOLD_SWISS, ACCOUNTS_EXPENSES_GOLD_SWISS] },
    book: { name: BOOK },
    expectedOutput: {
      book: BOOK,
      $or: [{ accounts: ACCOUNTS_GOLD_SWISS }, { accounts: ACCOUNTS_EXPENSES_GOLD_SWISS }],
    },
    expected: {
      where: "book = ? AND (accounts = ? OR accounts = ?)",
      params: [BOOK, ACCOUNTS_GOLD_SWISS, ACCOUNTS_EXPENSES_GOLD_SWISS],
    },
  },
  {
    name: "filter: account array one item two path parts",
    parser: "filter",
    query: { account: [ACCOUNTS_GOLD] },
    book: { name: BOOK },
    expectedOutput: { book: BOOK, "account_path.0": "Assets", "account_path.1": "Gold" },
    expected: { where: WHERE_ACCT0_1, params: [BOOK, "Assets", "Gold"] },
  },
  {
    name: "filter: account array one item three path parts",
    parser: "filter",
    query: { account: [ACCOUNTS_GOLD_SWISS] },
    book: { name: BOOK },
    expectedOutput: { book: BOOK, accounts: ACCOUNTS_GOLD_SWISS },
    expected: { where: WHERE_ACCOUNTS, params: [BOOK, ACCOUNTS_GOLD_SWISS] },
  },
  {
    name: "filter: prototype injection",
    parser: "filter",
    query: { toString: "a" },
    book: { name: BOOK },
    expectedOutput: { book: BOOK },
    expected: { where: "book = ?", params: [BOOK] },
  },

  // --- parseBalanceQuery.spec.ts (22 its) ---
  {
    name: "balance: empty object",
    parser: "balance",
    query: {},
    book: { name: BOOK },
    expectedOutput: { book: BOOK },
    expected: { where: "book = ?", params: [BOOK] },
  },
  {
    name: "balance: _journal string in meta",
    parser: "balance",
    query: { _journal: JOURNAL_STR },
    book: { name: BOOK },
    expectedOutput: { book: BOOK, _journal: new Types.ObjectId(JOURNAL_STR), meta: { _journal: JOURNAL_STR } },
    expected: {
      where: `book = ? AND ${META_JOURNAL} = ? AND _journal = ?`,
      params: [BOOK, JOURNAL_STR, JOURNAL_STR],
    },
  },
  {
    name: "balance: _journal ObjectId in meta",
    parser: "balance",
    query: { _journal: JOURNAL_OID },
    book: { name: BOOK },
    expectedOutput: {
      book: BOOK,
      _journal: new Types.ObjectId(JOURNAL_OID),
      meta: { _journal: new Types.ObjectId(JOURNAL_OID) },
    },
    expected: {
      where: `book = ? AND ${META_JOURNAL} = ? AND _journal = ?`,
      params: [BOOK, JOURNAL_OID_HEX, JOURNAL_OID_HEX],
    },
  },
  {
    name: "balance: start_date",
    parser: "balance",
    query: { start_date: new Date(666) },
    book: { name: BOOK },
    expectedOutput: { book: BOOK, datetime: { $gte: new Date(666) } },
    expected: { where: "book = ? AND datetime >= ?", params: [BOOK, ISO_666] },
  },
  {
    name: "balance: end_date",
    parser: "balance",
    query: { end_date: new Date(999) },
    book: { name: BOOK },
    expectedOutput: { book: BOOK, datetime: { $lte: new Date(999) } },
    expected: { where: "book = ? AND datetime <= ?", params: [BOOK, ISO_999] },
  },
  {
    name: "balance: start_date and end_date",
    parser: "balance",
    query: { start_date: new Date(666), end_date: new Date(999) },
    book: { name: BOOK },
    expectedOutput: { book: BOOK, datetime: { $gte: new Date(666), $lte: new Date(999) } },
    expected: { where: "book = ? AND (datetime >= ? AND datetime <= ?)", params: [BOOK, ISO_666, ISO_999] },
  },
  {
    name: "balance: start_tx_id (_id $gt)",
    parser: "balance",
    query: { start_tx_id: START_TX_ID },
    book: { name: BOOK },
    expectedOutput: { book: BOOK, _id: { $gt: START_TX_ID } },
    expected: { where: "book = ? AND _id > ?", params: [BOOK, START_TX_HEX] },
  },
  {
    name: "balance: end_tx_id (_id $lte)",
    parser: "balance",
    query: { end_tx_id: END_TX_ID },
    book: { name: BOOK },
    expectedOutput: { book: BOOK, _id: { $lte: END_TX_ID } },
    expected: { where: "book = ? AND _id <= ?", params: [BOOK, END_TX_HEX] },
  },
  {
    name: "balance: start_tx_id and end_tx_id",
    parser: "balance",
    query: { start_tx_id: START_TX_ID, end_tx_id: END_TX_ID },
    book: { name: BOOK },
    expectedOutput: { book: BOOK, _id: { $gt: START_TX_ID, $lte: END_TX_ID } },
    expected: { where: "book = ? AND (_id > ? AND _id <= ?)", params: [BOOK, START_TX_HEX, END_TX_HEX] },
  },
  {
    name: "balance: tx range with date range",
    parser: "balance",
    query: { start_tx_id: START_TX_ID, end_tx_id: END_TX_ID, start_date: new Date(666), end_date: new Date(999) },
    book: { name: BOOK },
    expectedOutput: {
      book: BOOK,
      datetime: { $gte: new Date(666), $lte: new Date(999) },
      _id: { $gt: START_TX_ID, $lte: END_TX_ID },
    },
    expected: {
      where: "book = ? AND (datetime >= ? AND datetime <= ?) AND (_id > ? AND _id <= ?)",
      params: [BOOK, ISO_666, ISO_999, START_TX_HEX, END_TX_HEX],
    },
  },
  {
    name: "balance: no _id without tx ids",
    parser: "balance",
    query: {},
    book: { name: BOOK },
    expectedOutput: { book: BOOK },
    expected: { where: "book = ?", params: [BOOK] },
  },
  {
    name: "balance: meta (clientId, bookmarked)",
    parser: "balance",
    query: { clientId: CLIENT_ID, bookmarked: true },
    book: { name: BOOK },
    expectedOutput: {
      book: BOOK,
      "meta.clientId": CLIENT_ID,
      "meta.bookmarked": true,
      meta: { clientId: CLIENT_ID, bookmarked: true },
    },
    expected: {
      where: `book = ? AND ${META_CLIENT_ID} = ? AND ${META_BOOKMARKED} = 1`,
      params: [BOOK, CLIENT_ID],
    },
  },
  {
    // sinon-stubbed upstream case: "clientId" is a fake valid transaction
    // key. With the real schema it is NOT a column (it routes to meta), so
    // the translator must reject it — the real routing is covered by the
    // non-stubbed meta rows.
    name: "balance: meta with stubbed valid clientId (throws)",
    parser: "balance",
    query: { clientId: CLIENT_ID, bookmarked: true },
    book: { name: BOOK },
    stubIsValidTransactionKey: (value) => value === "clientId",
    expectedOutput: {
      book: BOOK,
      clientId: CLIENT_ID,
      "meta.bookmarked": true,
      meta: { clientId: CLIENT_ID, bookmarked: true },
    },
    expected: { error: 'unknown field "clientId"' },
  },
  {
    name: "balance: meta three keys with false value",
    parser: "balance",
    query: { clientId: CLIENT_ID, _someOtherDatabaseId: CLIENT_ID, bookmarked: false },
    book: { name: BOOK },
    expectedOutput: {
      book: BOOK,
      "meta.clientId": CLIENT_ID,
      "meta.bookmarked": false,
      "meta._someOtherDatabaseId": CLIENT_ID,
      meta: { clientId: CLIENT_ID, bookmarked: false, _someOtherDatabaseId: CLIENT_ID },
    },
    expected: {
      where: `book = ? AND ${META_CLIENT_ID} = ? AND ${META_OTHER_ID} = ? AND (${META_BOOKMARKED} IS NULL OR ${META_BOOKMARKED} = 0)`,
      params: [BOOK, CLIENT_ID, CLIENT_ID],
    },
  },
  {
    name: "balance: account one path part",
    parser: "balance",
    query: { account: "Assets" },
    book: { name: BOOK },
    expectedOutput: { book: BOOK, "account_path.0": "Assets" },
    expected: { where: "book = ? AND account_path_0 = ?", params: [BOOK, "Assets"] },
  },
  {
    name: "balance: account two path parts",
    parser: "balance",
    query: { account: ACCOUNTS_GOLD },
    book: { name: BOOK },
    expectedOutput: { book: BOOK, "account_path.0": "Assets", "account_path.1": "Gold" },
    expected: { where: WHERE_ACCT0_1, params: [BOOK, "Assets", "Gold"] },
  },
  {
    name: "balance: account two path parts maxAccountPath 2",
    parser: "balance",
    query: { account: ACCOUNTS_GOLD },
    book: { name: BOOK, maxAccountPath: 2 },
    expectedOutput: { book: BOOK, accounts: ACCOUNTS_GOLD },
    expected: { where: WHERE_ACCOUNTS, params: [BOOK, ACCOUNTS_GOLD] },
  },
  {
    name: "balance: account three path parts",
    parser: "balance",
    query: { account: ACCOUNTS_GOLD_SWISS },
    book: { name: BOOK },
    expectedOutput: { book: BOOK, accounts: ACCOUNTS_GOLD_SWISS },
    expected: { where: WHERE_ACCOUNTS, params: [BOOK, ACCOUNTS_GOLD_SWISS] },
  },
  {
    name: "balance: account array one path part",
    parser: "balance",
    query: { account: ["Assets", "Expenses"] },
    book: { name: BOOK },
    expectedOutput: {
      book: BOOK,
      $or: [{ "account_path.0": "Assets" }, { "account_path.0": "Expenses" }],
    },
    expected: {
      where: "book = ? AND (account_path_0 = ? OR account_path_0 = ?)",
      params: [BOOK, "Assets", "Expenses"],
    },
  },
  {
    name: "balance: account array two path parts",
    parser: "balance",
    query: { account: [ACCOUNTS_GOLD, "Expenses:Gold"] },
    book: { name: BOOK },
    expectedOutput: {
      book: BOOK,
      $or: [
        { "account_path.0": "Assets", "account_path.1": "Gold" },
        { "account_path.0": "Expenses", "account_path.1": "Gold" },
      ],
    },
    expected: {
      where:
        "book = ? AND ((account_path_0 = ? AND account_path_1 = ?) OR (account_path_0 = ? AND account_path_1 = ?))",
      params: [BOOK, "Assets", "Gold", "Expenses", "Gold"],
    },
  },
  {
    name: "balance: account array three path parts",
    parser: "balance",
    query: { account: [ACCOUNTS_GOLD_SWISS, ACCOUNTS_EXPENSES_GOLD_SWISS] },
    book: { name: BOOK },
    expectedOutput: {
      book: BOOK,
      $or: [{ accounts: ACCOUNTS_GOLD_SWISS }, { accounts: ACCOUNTS_EXPENSES_GOLD_SWISS }],
    },
    expected: {
      where: "book = ? AND (accounts = ? OR accounts = ?)",
      params: [BOOK, ACCOUNTS_GOLD_SWISS, ACCOUNTS_EXPENSES_GOLD_SWISS],
    },
  },
  {
    name: "balance: account array one item two path parts",
    parser: "balance",
    query: { account: [ACCOUNTS_GOLD] },
    book: { name: BOOK },
    expectedOutput: { book: BOOK, "account_path.0": "Assets", "account_path.1": "Gold" },
    expected: { where: WHERE_ACCT0_1, params: [BOOK, "Assets", "Gold"] },
  },
  {
    name: "balance: account array one item three path parts",
    parser: "balance",
    query: { account: [ACCOUNTS_GOLD_SWISS] },
    book: { name: BOOK },
    expectedOutput: { book: BOOK, accounts: ACCOUNTS_GOLD_SWISS },
    expected: { where: WHERE_ACCOUNTS, params: [BOOK, ACCOUNTS_GOLD_SWISS] },
  },
  {
    name: "balance: prototype injection",
    parser: "balance",
    query: { toString: "a" },
    book: { name: BOOK },
    expectedOutput: { book: BOOK },
    expected: { where: "book = ?", params: [BOOK] },
  },
];

function parseRow(row: ParserRow): IAnyObject {
  const stub = row.stubIsValidTransactionKey
    ? sinon.stub(Transaction, "isValidTransactionKey").callsFake(row.stubIsValidTransactionKey)
    : undefined;
  try {
    const book = row.book;
    return row.parser === "filter" ? parseFilterQuery(row.query, book) : parseBalanceQuery(row.query, book);
  } finally {
    stub?.restore();
  }
}

describe("translateFilter — upstream parser output table (ITD-92)", () => {
  for (const row of parserRows) {
    it(row.name, () => {
      const filter = parseRow(row);
      expect(filter).to.deep.equal(row.expectedOutput);
      if ("error" in row.expected) {
        let threw: unknown;
        try {
          translateFilter(filter);
        } catch (err) {
          threw = err;
        }
        expect(threw, "translateFilter should have thrown").to.instanceOf(UnsupportedMongoOperationError);
        expect((threw as Error).message).to.include(row.expected.error);
        return;
      }
      expect(translateFilter(filter)).to.deep.equal(row.expected);
    });
  }
});

interface EdgeRow {
  name: string;
  filter: IAnyObject | null;
  collection?: CollectionName;
  expected: SqlPredicate | { error: string };
}

const edgeRows: EdgeRow[] = [
  { name: "empty object", filter: {}, expected: { where: "", params: [] } },
  { name: "null filter", filter: null, expected: { where: "", params: [] } },
  {
    name: "prototype attribute keys are skipped, not applied",
    filter: { constructor: "x", book: "B" },
    expected: { where: "book = ?", params: ["B"] },
  },
  {
    name: "prototype attribute keys inside meta are skipped",
    filter: { book: "B", meta: { toString: 1, clientId: "1" } },
    expected: { where: `book = ? AND ${META_CLIENT_ID} = ?`, params: ["B", "1"] },
  },
  {
    name: "empty $in matches nothing",
    filter: { book: "B", "meta.clientId": { $in: [] } },
    expected: { where: "book = ? AND 0 = 1", params: ["B"] },
  },
  {
    name: "multiple range operators are grouped",
    filter: { _id: { $gt: "000000000000000000000001", $lt: "ffffffffffffffffffffffff" } },
    expected: { where: "(_id > ? AND _id < ?)", params: ["000000000000000000000001", "ffffffffffffffffffffffff"] },
  },
  {
    name: "meta path with a bracket segment throws",
    filter: { "meta.a[b": 1 },
    expected: { error: 'meta path "meta.a[b"' },
  },
  {
    name: "meta path with an empty segment throws",
    filter: { "meta.a..b": 1 },
    expected: { error: 'meta path "meta.a..b"' },
  },
  {
    name: "account_path beyond 2 uses json_extract (QA G6)",
    filter: { "account_path.3": "Home" },
    expected: { where: "json_extract(account_path, '$[3]') = ?", params: ["Home"] },
  },
  {
    name: "account_path high index uses json_extract",
    filter: { "account_path.99": "x" },
    expected: { where: "json_extract(account_path, '$[99]') = ?", params: ["x"] },
  },
  {
    name: "object-valued meta deep equality (QA M13/G7)",
    filter: { "meta.address": { city: "Berlin" } },
    expected: { where: "json_extract(meta, '$.address.city') = ?", params: ["Berlin"] },
  },
  {
    name: "object-valued meta single leaf",
    filter: { "meta.a": { b: 1 } },
    expected: { where: "json_extract(meta, '$.a.b') = ?", params: [1] },
  },
  {
    name: "empty object meta value is exact",
    filter: { "meta.x": {} },
    expected: { where: `json(${META_X_EXPR}) = '{}'`, params: [] },
  },
  {
    name: "array meta value matches length and elements",
    filter: { "meta.tags": ["x", "y"] },
    expected: {
      where: `json_type(${META_TAGS_EXPR}) = 'array' AND json_array_length(${META_TAGS_EXPR}) = ? AND ${META_TAGS_0_EXPR} = ? AND ${META_TAGS_1_EXPR} = ?`,
      params: [2, "x", "y"],
    },
  },
  {
    name: "empty array meta value is exact",
    filter: { "meta.tags": [] },
    expected: {
      where: `json_type(${META_TAGS_EXPR}) = 'array' AND json_array_length(${META_TAGS_EXPR}) = 0`,
      params: [],
    },
  },
  {
    name: "document value casts to _id",
    filter: { _journal: { _id: JOURNAL_STR } },
    expected: { where: "_journal = ?", params: [JOURNAL_STR] },
  },
  {
    name: "object value without _id throws",
    filter: { _journal: { memo: "x" } },
    expected: { error: "cannot be coerced to an ObjectId" },
  },
  {
    name: "non-hex string for ObjectId field throws",
    filter: { _journal: "xyz" },
    expected: { error: "cannot be coerced to an ObjectId" },
  },
  {
    name: "voided false equality uses the null bucket",
    filter: { voided: false },
    expected: { where: "(voided IS NULL OR voided = 0)", params: [] },
  },
  {
    name: "voided null equality uses the null bucket",
    filter: { voided: null },
    expected: { where: "(voided IS NULL OR voided = 0)", params: [] },
  },
  {
    name: "voided $ne true matches missing",
    filter: { voided: { $ne: true } },
    expected: { where: "(voided IS NULL OR voided <> 1)", params: [] },
  },
  {
    name: "voided $ne false excludes the null bucket",
    filter: { voided: { $ne: false } },
    expected: { where: "(voided IS NOT NULL AND voided <> 0)", params: [] },
  },
  {
    name: "meta $ne matches missing",
    filter: { "meta.clientId": { $ne: "1" } },
    expected: {
      where: `(${META_CLIENT_ID} IS NULL OR ${META_CLIENT_ID} <> ?)`,
      params: ["1"],
    },
  },
  {
    name: "date operator emits an ISO string param",
    filter: { datetime: { $gte: new Date(666) } },
    expected: { where: "datetime >= ?", params: [ISO_666] },
  },
  {
    name: "balances collection: plain column",
    filter: { key: "abc" },
    collection: "medici_balances",
    expected: { where: "key = ?", params: ["abc"] },
  },
  {
    name: "locks collection: plain columns",
    filter: { account: "Income", book: "B" },
    collection: "medici_locks",
    expected: { where: "account = ? AND book = ?", params: ["Income", "B"] },
  },
  {
    name: "journals collection: unknown column throws",
    filter: { account: "x" },
    collection: "medici_journals",
    expected: { error: 'unknown field "account"' },
  },
  {
    name: "locks collection: meta path throws",
    filter: { "meta.x": 1 },
    collection: "medici_locks",
    expected: { error: 'unknown field "meta.x"' },
  },
  {
    name: "meta null",
    filter: { meta: null },
    expected: { where: "meta IS NULL", params: [] },
  },
  {
    name: "meta non-object throws",
    filter: { meta: "x" },
    expected: { error: 'value for field "meta" must be an object or null' },
  },
  {
    name: "object value on a text column throws",
    filter: { book: { a: 1 } },
    expected: { error: 'object value is not supported for field "book"' },
  },
  {
    name: "array value on a text column throws",
    filter: { book: ["a"] },
    expected: { error: 'array value is not supported for field "book"' },
  },
  {
    name: "$or with a non-object item throws",
    filter: { $or: ["x"] },
    expected: { error: '"$or" item 0 must be a filter object' },
  },
  {
    name: "empty $or matches nothing",
    filter: { $or: [] },
    expected: { where: "0 = 1", params: [] },
  },
  {
    name: "$or with deep-equality sub-filter",
    filter: { $or: [{ "meta.address": { city: "Berlin" } }, { book: "X" }] },
    expected: { where: "(json_extract(meta, '$.address.city') = ? OR book = ?)", params: ["Berlin", "X"] },
  },
  {
    name: "top-level $and throws (scope cap)",
    filter: { $and: [{}] },
    expected: { error: 'unknown field "$and"' },
  },
];

describe("translateFilter — edge cases (ITD-92)", () => {
  for (const row of edgeRows) {
    it(row.name, () => {
      let threw: unknown;
      try {
        const result = translateFilter(row.filter, row.collection ? { collection: row.collection } : undefined);
        if ("error" in row.expected) {
          throw new Error(`expected UnsupportedMongoOperationError, got ${JSON.stringify(result)}`);
        }
        expect(result).to.deep.equal(row.expected);
      } catch (err) {
        threw = err;
      }
      if ("error" in row.expected) {
        expect(threw).to.instanceOf(UnsupportedMongoOperationError);
        expect((threw as Error).message).to.include(row.expected.error);
      } else if (threw) {
        throw threw;
      }
    });
  }

  it("objectId registry keys are exactly the schema ObjectId keys", () => {
    const registryKeys = Object.keys(COLUMN_KINDS.medici_transactions).filter(
      (key) => COLUMN_KINDS.medici_transactions[key] === "objectId"
    );
    for (const key of registryKeys) {
      expect(isTransactionObjectIdKey(key), `registry key ${key} must be a schema ObjectId key`).to.equal(true);
    }
    expect(registryKeys).to.deep.equal(["_id", "_journal", "_original_journal"]);
  });

  it("unsupported operators throw naming the operator (scope cap)", () => {
    for (const op of ["$regex", "$exists", "$foo", "$elemMatch", "$nor", "$expr"]) {
      let threw: unknown;
      try {
        translateFilter({ memo: { [op]: "x" } });
      } catch (err) {
        threw = err;
      }
      expect(threw, `expected a throw for ${op}`).to.instanceOf(UnsupportedMongoOperationError);
      expect((threw as Error).message).to.include(`operator "${op}" is not supported for field "memo"`);
    }
  });
});
