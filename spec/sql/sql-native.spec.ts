/**
 * ITD-96 — SQL-native tests (QA amendments G1–G9 + the two ticket-listed
 * SQL-native tests), per the QA amendments on the ITD-96 ticket.
 *
 * These are the port's own tests: they exercise SQL/backend-specific
 * guarantees the vendored upstream suite cannot express (cross-process
 * id allocation, NUL-in-key round-trips, tie-break ordering, tx-id range
 * balance, out-of-order _ids). They run on the same per-process file DB
 * the harness uses and must all pass (they are not part of the Tier A/B/C
 * vendored tally — TEST_COMPAT_MATRIX.md classifies upstream files only).
 *
 * G8 (published-artifact smoke wired into CI) is not an `it` here: it is
 * `scripts/smoke-packaged.mjs` (npm pack → install with no mongoose →
 * smoke script → tsc consumer against types/index.d.ts), wired into
 * .github/workflows/ci.yml so the artifact gate runs on every CI run.
 */
import { execFile, execFileSync } from "child_process";
import { expect } from "chai";
import * as os from "os";
import * as path from "path";
import { Book, connection, syncIndexes, JournalAlreadyVoidedError } from "../../src";
import { connection as compatConnection } from "../../src/compat/mongoose";
import { setTransactionSchema, transactionSchema, transactionModel } from "../../src/models/transaction";
import { ConsistencyError } from "../../src/errors/ConsistencyError";
import { getTransactionSchemaTest } from "../helper/transactionSchema";
import type { ITransactionTest } from "../helper/transactionSchema";
import { balanceModel } from "../../src/models/balance";
import { Types } from "../../src/compat/mongoose";
import { connectPrisma, databaseUrl, disconnectPrisma, isInMemoryUrl } from "../../src/database/client";
import { createSchema } from "../../src/database/schema";

const REPO_ROOT = path.join(__dirname, "..", "..");
const G2_FIXTURE = path.join(__dirname, "..", "fixtures", "g2-snapshot-child.js");
// The same per-process file test/mocha-setup.ts computes (pid-scoped).
const SHARED_DB_FILE = path.join(os.tmpdir(), `medici-sql-${process.pid}.db`);

const suffix = () => `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

function runG2Child(dbUrl: string, book: string, account: string): Promise<{ ok: boolean; id: string; atMs: number }> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [G2_FIXTURE, dbUrl, book, account], (err, stdout) => {
      if (err) {
        reject(new Error(`child failed: ${err.message}\n${stdout}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()) as { ok: boolean; id: string; atMs: number });
      } catch (e) {
        reject(e);
      }
    });
  });
}

describe("spec/sql SQL-native (ITD-96 QA amendments)", function () {
  before(async function () {
    this.timeout(60000);
    // Port-owned suites may have left the env pointing at an in-memory DB;
    // re-assert the shared per-process file DB (schema is created idempotently).
    const fileUrl = `file:${SHARED_DB_FILE}`;
    if (process.env.MEDICI_SQL_DATABASE_URL !== fileUrl || isInMemoryUrl(databaseUrl())) {
      process.env.MEDICI_SQL_DATABASE_URL = fileUrl;
      await disconnectPrisma();
    }
    await connectPrisma();
    const { getPrismaClient } = require("../../src/database/client") as typeof import("../../src/database/client");
    const prisma = getPrismaClient();
    const rows = await prisma.$queryRawUnsafe(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'medici_id_sequence'"
    );
    if (Array.isArray(rows) && rows.length === 0) {
      await createSchema(prisma);
    }
  });

  it("G1: concurrent double-void — exactly one wins, loser rejected by a double-void guard, one reversal journal", async () => {
    const book = new Book(`g1-${suffix()}`);
    const journal = await book.entry("g1").debit("Assets:Cash", 5).credit("Income", 5).commit();

    const results = await Promise.allSettled([
      connection.transaction((session) => book.void(journal._id, null, { session })),
      connection.transaction((session) => book.void(journal._id, null, { session })),
    ]);

    const resolved = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(resolved).to.have.length(1);
    expect(rejected).to.have.length(1);
    // The loser trips one of upstream's two double-void guards, depending on
    // whether its out-of-session journal read (Book.ts:~246) lands before or
    // after the winner's commit:
    //  - read guard: voided already true -> JournalAlreadyVoidedError (code 400)
    //  - modifiedCount guard (Book.ts:312): updateOne matched the journal but
    //    changed nothing -> ConsistencyError "Already voided ...".
    // Both abort before any reversal is written. Which guard fires is a
    // timing outcome of the race, not part of the client contract; the
    // contract is: exactly one winner, one rejection, one reversal journal.
    const err = (rejected[0] as PromiseRejectedResult).reason;
    const readGuard =
      err instanceof JournalAlreadyVoidedError &&
      err.message === "Journal already voided." &&
      (err as { code?: number }).code === 400;
    const modifiedGuard =
      err instanceof ConsistencyError && /^Already voided .* journal on book /.test((err as Error).message);
    expect(
      readGuard || modifiedGuard,
      `unexpected loser error: ${err?.constructor?.name}: ${err?.message}`
    ).to.equal(true);

    // The winner's reversal is the only reversal journal in the book:
    // one reversal entry with both original transactions reversed (2 rows),
    // all belonging to a single reversal journal.
    const reversals = await book.ledger({ _original_journal: journal._id });
    expect(reversals.results).to.have.length(2);
    // _journal comes back as ObjectId instances (upstream contract) —
    // stringify before set membership.
    const reversalJournalIds = new Set(
      reversals.results.map((t) => String((t as Record<string, unknown>)._journal))
    );
    expect(reversalJournalIds).to.have.length(1);
    for (const t of reversals.results as Array<Record<string, unknown>>) {
      expect(t.memo).to.equal("[VOID] g1");
      expect("voided" in t).to.equal(false);
      expect("void_reason" in t).to.equal(false);
    }

    const original = await book.ledger({ _journal: journal._id });
    expect(original.results).to.have.length(2);
    for (const t of original.results as Array<Record<string, unknown>>) {
      expect(t.voided).to.equal(true);
      expect(t.void_reason).to.equal("[VOID] g1");
    }

    const bal = await book.balance({ account: "Assets:Cash" });
    expect(bal.balance).to.equal(0);
  });

  describe("G2: two writer processes, same second, snapshot by A row by B", function () {
    this.timeout(300000);

    before(() => {
      // The child runs the BUILT port (published-artifact path).
      execFileSync("npm", ["run", "build"], { cwd: REPO_ROOT, stdio: "pipe" });
    });

    it("balance includes B's row (child process) after A's snapshot", async () => {
      const bookName = `g2-${suffix()}`;
      const book = new Book(bookName);

      // Process A (this process): one row + the balance that snapshots it.
      await book.entry("g2 seed").credit("Assets", 1).debit("Liabilities", 1).commit();
      const b1 = await book.balance({ account: "Assets" });
      expect(b1).to.deep.equal({ balance: 1, notes: 1 });

      const snapshots = (await balanceModel.find({ book: bookName, account: "Assets" })) as Array<
        Record<string, unknown> & { transaction: Types.ObjectId }
      >;
      expect(snapshots).to.have.length(1);
      const snapshotTx = snapshots[0].transaction.toString();

      // Process B (child): one more row for the same book/account.
      const child = await runG2Child(`file:${SHARED_DB_FILE}`, bookName, "Assets");
      expect(child.ok).to.equal(true);
      // B's id (global per-second sequence) must sort after A's snapshot txn id.
      expect(Buffer.compare(Buffer.from(child.id, "hex"), Buffer.from(snapshotTx, "hex"))).to.equal(1);

      // A reads again: the snapshot path (_id > snapshot.transaction) must
      // include B's row.
      const b2 = await book.balance({ account: "Assets" });
      expect(b2).to.deep.equal({ balance: 2, notes: 2 });
    });
  });

  describe("G3: NUL-in-sha1 snapshot keys", () => {
    // Precomputed fixtures (QA G3): sha1(constructKey(book, "Assets")) =
    // sha1("<book>;Assets") carries exactly one NUL byte at the stated
    // position. The port stores the key hex-encoded, so the raw NUL never
    // reaches a SQLite string function.
    const fixtures = [
      { book: "MyBook-nul-35", sha1: "e1f42266f3b15b33f093871e0034378478377ed4", nul: 12 },
      { book: "MyBook-nul-38", sha1: "14f44b9ef12eaf6647b49883eb3a73851c160097", nul: 18 },
      { book: "MyBook-nul-106", sha1: "e873885dd8035c3490d54ba52a620c3800291d21", nul: 16 },
    ];

    for (const fx of fixtures) {
      it(`${fx.book}: balance twice, second reuses the snapshot (NUL @ byte ${fx.nul})`, async () => {
        const book = new Book(fx.book);
        await book.entry("g3").debit("Assets", 1).credit("Income", 1).commit();

        const b1 = await book.balance({ account: "Assets" });
        expect(b1).to.deep.equal({ balance: -1, notes: 1 });

        const rows = (await balanceModel.find({ book: fx.book, account: "Assets" })) as Array<
          Record<string, unknown> & { key: string; balance: number }
        >;
        expect(rows).to.have.length(1);

        // The stored key decodes to the fixture sha1 with the NUL in place.
        const raw = Buffer.from(rows[0].key, "binary");
        expect(raw.toString("hex")).to.equal(fx.sha1);
        expect(raw[fx.nul]).to.equal(0);
        expect(raw.filter((b) => b === 0)).to.have.length(1);

        // Prove the second call reuses this snapshot: mutate it, read again.
        rows[0].balance = 42;
        await rows[0].save();
        const b2 = await book.balance({ account: "Assets" });
        expect(b2.balance).to.equal(42);
      });
    }
  });

  it("G4: ledger keeps insertion order when datetime+timestamp tie (3 txns)", async () => {
    const book = new Book(`g4-${suffix()}`);
    // One entry: one datetime, one timestamp — the three credits tie on both.
    await book
      .entry("g4")
      .credit("A:B", 1, { n: 1 })
      .credit("A:B", 2, { n: 2 })
      .credit("A:B", 3, { n: 3 })
      .debit("Z:W", 6)
      .commit();

    const { results } = await book.ledger({ account: "A:B" });
    expect(results).to.have.length(3);
    expect((results as Array<Record<string, any>>).map((t) => t.meta.n)).to.deep.equal([1, 2, 3]);
  });

  it("G5: balance({start_tx_id, end_tx_id}) bounds the aggregate", async () => {
    // balanceSnapshotSec: 0 — Book.ts:104 overwrites parsedQuery._id with the
    // snapshot cursor once a snapshot exists, so a snapshot on this account
    // would shadow the very range path under test.
    const book = new Book(`g5-${suffix()}`, { balanceSnapshotSec: 0 });
    await book.entry("g5-1").credit("A:B", 10).debit("C:D", 10).commit();
    await book.entry("g5-2").credit("A:B", 5).debit("C:D", 5).commit();

    const all = await book.ledger({});
    const ids = (all.results as Array<{ _id: Types.ObjectId }>)
      .map((t) => t._id.toString())
      .sort();
    expect(ids).to.have.length(4);
    // ids: [c1, d1, c2, d2] — c1/c2 the A:B credits, d1/d2 the C:D debits.
    const d1 = ids[1];
    const c2 = ids[2];

    const r1 = await book.balance({ account: "A:B", start_tx_id: new Types.ObjectId(d1), end_tx_id: new Types.ObjectId(c2) });
    expect(r1).to.deep.equal({ balance: 5, notes: 1 });

    const r2 = await book.balance({ account: "A:B", start_tx_id: new Types.ObjectId(d1), end_tx_id: new Types.ObjectId(d1) });
    expect(r2).to.deep.equal({ balance: 0, notes: 0 });
  });

  it("G6: maxAccountPath 5 — 4-deep account in balance/ledger/listAccounts", async () => {
    const book = new Book(`g6-${suffix()}`, { maxAccountPath: 5 });
    await book.entry("g6").credit("A:B:C:D", 1).debit("E:F", 1).commit();

    expect((await book.balance({ account: "A:B:C:D" })).balance).to.equal(1);
    expect((await book.balance({ account: "A:B:C" })).balance).to.equal(1);

    const { results } = await book.ledger({ account: "A:B:C:D" });
    expect(results).to.have.length(1);
    expect((results[0] as Record<string, any>).account_path).to.deep.equal(["A", "B", "C", "D"]);

    const accounts = await book.listAccounts();
    expect(accounts).to.deep.equal(["A", "A:B", "A:B:C", "A:B:C:D", "E", "E:F"]);
  });

  it("G7: ledger({address:{city:'Berlin'}}) — object-valued meta path matches", async () => {
    const book = new Book(`g7-${suffix()}`);
    await book
      .entry("g7")
      .credit("A:B", 1, { address: { city: "Berlin" } })
      .debit("A:B", 1, { address: { city: "Rome" } })
      .commit();

    const { results, total } = await book.ledger({ address: { city: "Berlin" } } as never);
    expect(total).to.equal(1);
    expect(results).to.have.length(1);
    expect((results[0] as Record<string, any>).meta.address).to.deep.equal({ city: "Berlin" });
  });

  it("G9: unset voided/void_reason come back ABSENT, not null", async () => {
    const book = new Book(`g9-${suffix()}`);
    const journal = await book.entry("g9").credit("A:B", 1).debit("C:D", 1).commit();

    const { results } = await book.ledger({ _journal: journal._id });
    expect(results).to.have.length(2);
    for (const t of results as Array<Record<string, unknown>>) {
      expect(t).to.not.have.property("voided");
      expect(t).to.not.have.property("void_reason");
    }

    const raw = await transactionModel.collection.find({ _journal: journal._id }).toArray();
    expect(raw).to.have.length(2);
    for (const t of raw) {
      expect(t).to.not.have.property("voided");
      expect(t).to.not.have.property("void_reason");
    }
  });

  it("SQL-native insertedIds replacement: bulk insert ids strictly increasing, concurrent writers partition, balance 0", async () => {
    const book = new Book(`ga-${suffix()}`);
    await book
      .entry("bulk")
      .credit("A:B", 1, { n: 1 })
      .credit("A:B", 1, { n: 2 })
      .credit("A:B", 1, { n: 3 })
      .debit("A:B", 1, { n: 4 })
      .debit("A:B", 1, { n: 5 })
      .debit("A:B", 1, { n: 6 })
      .commit();

    const { results } = await book.ledger({ account: "A:B" });
    const byId = [...(results as Array<Record<string, any>>)].sort((x, y) =>
      x._id.toString().localeCompare(y._id.toString())
    );
    // Insertion order (meta.n) must equal _id order for the whole bulk.
    expect(byId.map((t) => t.meta.n)).to.deep.equal([1, 2, 3, 4, 5, 6]);
    for (let i = 1; i < byId.length; i++) {
      expect(byId[i - 1]._id.toString() < byId[i]._id.toString(), "bulk ids must be strictly increasing").to.equal(true);
    }
    expect((await book.balance({ account: "A:B" })).balance).to.equal(0);

    // Concurrent writers (no session): each journal's ids form a strictly
    // increasing block, and the blocks partition the global sequence.
    const book2 = new Book(`ga2-${suffix()}`);
    const journals = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => book2.entry(`cc-${n}`).credit("A:C", 1, { n }).debit("A:C", 1, { n }).commit())
    );
    const blocks: string[][] = [];
    for (const j of journals as Array<Record<string, any>>) {
      const res = await book2.ledger({ _journal: j._id });
      const ids = (res.results as Array<Record<string, any>>).map((t) => t._id.toString()).sort();
      expect(ids).to.have.length(2);
      expect(ids[0] < ids[1], "per-journal ids must be strictly increasing").to.equal(true);
      blocks.push(ids);
    }
    const allIds = blocks.flat();
    expect(new Set(allIds).size).to.equal(10);
    const ordered = [...blocks].sort((a, b) => a[0].localeCompare(b[0])).flat();
    for (let i = 1; i < ordered.length; i++) {
      expect(ordered[i - 1] < ordered[i], "cross-writer ids must be globally ordered").to.equal(true);
    }
    expect((await book2.balance({ account: "A:C" })).balance).to.equal(0);
  });

  it("SQL-native 'ignore order of doc insertion': hand-picked LOWER ObjectId, balance still correct", async () => {
    const book = new Book(`gb-${suffix()}`);
    const journal = await book.entry("low").credit("Assets:Receivable", 1).debit("Income:Rent", 1).commit();

    const { results } = await book.ledger({ account: "Assets:Receivable" });
    const existing = (results[0] as Record<string, any>)._id.toString();
    const low = "000000000000000000000042";
    expect(low < existing).to.equal(true);

    const now = new Date();
    await transactionModel.collection.insertOne({
      _id: low,
      book: book.name,
      account_path: ["Assets", "Receivable"],
      accounts: "Assets:Receivable",
      memo: "low id row",
      credit: 1,
      debit: 0,
      datetime: now,
      timestamp: now,
      _journal: journal._id,
    });

    // Full-aggregate path (snapshots removed, like the vendored Tier B test).
    await balanceModel.collection.deleteMany({ book: book.name });
    const b1 = await book.balance({ account: "Assets:Receivable" });
    expect(b1).to.deep.equal({ balance: 2, notes: 2 });

    // The fresh snapshot pins lastTransactionId to the MAX id (the normal
    // row, not the hand-picked lower one).
    const rows = (await balanceModel.find({ book: book.name, account: "Assets:Receivable" })) as Array<
      Record<string, unknown> & { transaction: Types.ObjectId }
    >;
    expect(rows).to.have.length(1);
    expect(rows[0].transaction.toString()).to.equal(existing);

    // Second call reuses the snapshot and still counts both rows.
    const b2 = await book.balance({ account: "Assets:Receivable" });
    expect(b2).to.deep.equal({ balance: 2, notes: 2 });
  });

  // SQL-native replacement for the Tier C vendored test
  // spec/setTransactionSchema.spec.ts :: "should return full ledger with
  // _journal2" (TEST_COMPAT_MATRIX.md). Reproduces everything except the
  // Mongoose `diffIndexes` assertions (a Mongo physical-index internal the
  // port makes a no-op by design, plan r2): (a) deleteModel + re-register
  // preserves the model name, (b) the custom `_journal2` ObjectId field
  // round-trips through `ledger`, (c) `_journal2._id` is a real ObjectId
  // equal to the journal id.
  it("SQL-native setTransactionSchema replacement: custom _journal2 ObjectId round-trips through ledger", async function () {
    this.timeout(15000);
    await syncIndexes({ background: false });

    try {
      setTransactionSchema(getTransactionSchemaTest(), undefined, { defaultIndexes: false });

      // (a) deleteModel + re-register preserves the model name: the
      // validation error prefix stays "Medici_Transaction". (The model
      // registry lives on the compat "mongoose" connection, not the port's
      // ../src connection export.)
      compatConnection.deleteModel("Medici_Transaction");
      setTransactionSchema(getTransactionSchemaTest(), undefined, { defaultIndexes: false });
      expect(compatConnection.models["Medici_Transaction"]).to.exist;
      const doc: any = new (transactionModel as any)({
        credit: 1,
        debit: 2,
        datetime: "still invalid",
        account_path: ["A"],
        accounts: "A",
        book: "B",
        memo: "m",
        _journal: new Types.ObjectId(),
        timestamp: new Date(),
      });
      try {
        await doc.validate();
        expect.fail("validate() should have rejected");
      } catch (err) {
        expect((err as Error).message).to.match(/^Medici_Transaction validation failed: datetime: /);
      }

      // (b)+(c) the custom `_journal2` ObjectId field, written in meta like
      // any client extra, comes back through `ledger` hydrated as an
      // ObjectId whose `_id` is itself (QA M4).
      const book = new Book<ITransactionTest>("MyBook-TransactionSchemaSQL");
      const journal = await book
        .entry("Test")
        .credit("Assets:Receivable", 1)
        .credit("Assets:Receivable", 2)
        .debit("Income:Rent", 1)
        .debit("Income:Rent", 2)
        .commit();

      await book
        .entry("Test fp")
        .credit("Cars", 1, { _journal2: journal._id })
        .debit("Cars", 1, { _journal2: journal._id })
        .commit();

      const res = await book.ledger({ account: "Cars" });
      expect(res.results).to.have.lengthOf(2);
      expect(res.results[0]._journal2._id).to.be.instanceof(Types.ObjectId);
      expect(res.results[1]._journal2._id).to.be.instanceof(Types.ObjectId);
      expect(res.results[0]._journal2._id.toString()).to.equal(journal._id.toString());
      expect(res.results[1]._journal2._id.toString()).to.equal(journal._id.toString());
    } finally {
      setTransactionSchema(transactionSchema);
      await syncIndexes({ background: false });
    }
  });
});
