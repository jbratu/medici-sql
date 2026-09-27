/* eslint-env node */
/* eslint-disable @typescript-eslint/no-var-requires */
"use strict";
/**
 * ITD-93 cross-process fixture.
 *
 * Child writer process: opens the medici-sql database named in argv[2],
 * runs one write transaction through the real connection/adapter stack
 * (build/ output), inserts five transactions with forceServerObjectId so
 * the _ids come from the DB-backed medici_id_sequence inside the write
 * transaction, and prints { ok, ids } as JSON on stdout.
 */
const path = require("path");

process.env.MEDICI_SQL_DATABASE_URL = process.argv[2];

const { connection } = require(path.join(__dirname, "..", "..", "build", "database", "connection.js"));

const runId = process.argv[3];
const now = new Date();
const docs = [0, 1, 2, 3, 4].map((i) => ({
  credit: 1,
  debit: 0,
  account_path: ["Assets", "Cash"],
  accounts: "Assets:Cash",
  book: `cross-${runId}`,
  memo: `cross ${runId} ${i}`,
  datetime: now,
  timestamp: now,
  _journal: "0123456789abcdef01234567",
}));

(async () => {
  await connection.connect();
  const insertedIds = await connection.transaction(async (session) => {
    const result = await connection.collection("medici_transactions").insertMany(docs, {
      forceServerObjectId: true,
      session,
    });
    return result.insertedIds;
  });
  const ids = Object.keys(insertedIds)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => insertedIds[k].toHexString());
  process.stdout.write(JSON.stringify({ ok: true, ids }) + "\n");
  await connection.disconnect();
})().catch((err) => {
  process.stderr.write(String((err && err.stack) || err) + "\n");
  process.exit(1);
});
