import { ObjectId } from "bson";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../generated/client.ts";

export const DB_URL = "file:./db-adapter.db";

export function makeClient(url = DB_URL, adapterOpts = {}) {
  const adapter = new PrismaBetterSqlite3({ url, ...adapterOpts });
  return new PrismaClient({ adapter });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const DDL = [
  `CREATE TABLE IF NOT EXISTS medici_transactions (
    id TEXT PRIMARY KEY, book TEXT NOT NULL, account TEXT NOT NULL,
    credit REAL NOT NULL DEFAULT 0, debit REAL NOT NULL DEFAULT 0,
    memo TEXT NOT NULL DEFAULT '', datetime DATETIME NOT NULL,
    journal TEXT NOT NULL, timestamp DATETIME NOT NULL,
    voided BOOLEAN, voidReason TEXT, originalJournal TEXT, meta TEXT,
    accountPath0 TEXT, accountPath1 TEXT, accountPath2 TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_tx_ba ON medici_transactions(book, account, datetime)`,
  `CREATE INDEX IF NOT EXISTS idx_tx_j ON medici_transactions(journal)`,
  `CREATE TABLE IF NOT EXISTS medici_journals (
    id TEXT PRIMARY KEY, book TEXT NOT NULL, memo TEXT NOT NULL DEFAULT '',
    datetime DATETIME NOT NULL, txIds TEXT NOT NULL DEFAULT '[]',
    voided BOOLEAN, voidReason TEXT)`,
  `CREATE TABLE IF NOT EXISTS medici_locks (
    id TEXT PRIMARY KEY, book TEXT NOT NULL, account TEXT NOT NULL,
    updatedAt DATETIME NOT NULL, "__v" INTEGER NOT NULL DEFAULT 0,
    UNIQUE(account, book))`,
  `CREATE TABLE IF NOT EXISTS medici_id_sequence (
    id INTEGER PRIMARY KEY DEFAULT 1, seconds INTEGER NOT NULL,
    counter INTEGER NOT NULL DEFAULT 0, instance BLOB NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS nul_probe (
    id TEXT PRIMARY KEY, latin1 TEXT NOT NULL, hex TEXT NOT NULL, raw BLOB NOT NULL)`,
];

export async function initDb(prisma) {
  for (const stmt of DDL) await prisma.$executeRawUnsafe(stmt);
}

export async function wipe(prisma, book) {
  await prisma.$executeRawUnsafe(`DELETE FROM medici_transactions WHERE book = ?`, book);
  await prisma.$executeRawUnsafe(`DELETE FROM medici_journals WHERE book = ?`, book);
  await prisma.$executeRawUnsafe(`DELETE FROM medici_locks WHERE book = ?`, book);
}

export async function balance(prisma, book, account, tx) {
  const q = tx ?? prisma;
  const rows = await q.$queryRawUnsafe(
    `SELECT COALESCE(SUM(credit - debit), 0) AS b FROM medici_transactions WHERE book = ? AND account = ? AND voided IS NULL`,
    book, account,
  );
  return Number(rows[0].b);
}

export function freshId() {
  return new ObjectId().toHexString();
}

export function errInfo(e) {
  return {
    name: e?.name ?? String(e),
    code: e?.code,
    clientVersion: e?.clientVersion,
    meta: e?.meta,
    target: e?.target,
    message: String(e?.message ?? e).split("\n").slice(0, 3).join(" | "),
  };
}

export function report(line = "") {
  console.log(line);
}
