/* eslint-env node */
/* eslint-disable @typescript-eslint/no-var-requires */
"use strict";
/**
 * ITD-96 G2 child writer process (QA amendment G2: "two writer PROCESSES
 * same second, snapshot by A row by B, balance must include B's row").
 *
 * argv: [dbUrl, book, account]
 *
 * Opens the database named in argv[1] through the BUILT port
 * (build/ output — the published-artifact path, same discipline as
 * cross-process-insert.js) and inserts ONE credit transaction for
 * `book`/`account` inside a real write transaction, so the _id comes from
 * the DB-backed medici_id_sequence. Prints { ok, id, atMs } as JSON.
 */
const path = require("path");

const dbUrl = process.argv[2];
const book = process.argv[3];
const account = process.argv[4];
if (!dbUrl || !book || !account) {
  process.stderr.write("usage: g2-snapshot-child.js <dbUrl> <book> <account>\n");
  process.exit(2);
}

process.env.MEDICI_SQL_DATABASE_URL = dbUrl;

const { connection } = require(path.join(__dirname, "..", "..", "build", "database", "connection.js"));

const now = new Date();
const doc = {
  credit: 1,
  debit: 0,
  account_path: account.split(":"),
  accounts: account,
  book,
  memo: "g2 child row",
  datetime: now,
  timestamp: now,
  _journal: "0123456789abcdef01234567",
};

(async () => {
  await connection.connect();
  const inserted = await connection.transaction(async (session) => {
    const result = await connection.collection("medici_transactions").insertMany([doc], {
      forceServerObjectId: true,
      session,
    });
    return Object.values(result.insertedIds)[0];
  });
  process.stdout.write(JSON.stringify({ ok: true, id: inserted.toHexString(), atMs: Date.now() }) + "\n");
  await connection.disconnect();
})().catch((err) => {
  process.stderr.write(String((err && err.stack) || err) + "\n");
  process.exit(1);
});
