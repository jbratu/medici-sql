import { expect } from "chai";
import { ObjectId } from "bson";
import { getPrismaClient, disconnectPrisma, databaseUrl, isInMemoryUrl } from "../src/database/client";
import { resetDatabase, TABLES } from "../src/database/schema";

/**
 * Scaffold smoke tests (ITD-90). Prove the SQLite bootstrap: the programmatic
 * reset path (no Prisma CLI) creates all tables + indexes on an in-memory
 * database (QA S1: the harness starts from a guaranteed-empty database) and
 * round-trips rows through the generated client.
 */

// Must be set before the first client is constructed.
process.env.MEDICI_SQL_DATABASE_URL = "file::memory:";

const BOOK = "scaffold-book";
const META_JSON = '{"clientId":"12345"}';

describe("scaffold (ITD-90)", () => {
  before(async () => {
    // This suite pins in-memory (it asserts the URL); re-assert it here
    // because the vendored-suite bootstrap (spec/helper/MongoDB.spec.ts,
    // ITD-95) re-asserts the file-backed URL in the root before().
    process.env.MEDICI_SQL_DATABASE_URL = "file::memory:";
    await disconnectPrisma();
    await resetDatabase();
  });

  after(async () => {
    await disconnectPrisma();
  });

  it("selects the in-memory database from the environment", () => {
    expect(isInMemoryUrl(databaseUrl())).to.equal(true);
  });

  it("resetDatabase creates all five tables", async () => {
    const prisma = getPrismaClient();
    const rows = await prisma.$queryRawUnsafe<{ name: string }[]>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
    );
    const names = rows.map((row) => row.name);
    expect(names).to.deep.equal([...TABLES].sort());
    expect(names).to.include.members([
      "medici_transactions",
      "medici_journals",
      "medici_locks",
      "medici_balances",
      "medici_id_sequence",
    ]);
  });

  it("resetDatabase creates the mirrored upstream indexes", async () => {
    const prisma = getPrismaClient();
    const rows = await prisma.$queryRawUnsafe<{ name: string }[]>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name`
    );
    const names = rows.map((row) => row.name);
    expect(names).to.include("medici_transactions__journal_idx");
    expect(names).to.include("medici_transactions_book_accounts_datetime_idx");
    expect(names).to.include("medici_transactions_book_account_path_0_account_path_1_account_path_2_datetime_idx");
    expect(names).to.include("medici_locks_account_book_key");
    expect(names).to.include("medici_balances_key_idx");
  });

  it("seeds the single-row id sequence with a 5-byte instance", async () => {
    const prisma = getPrismaClient();
    const rows = await prisma.$queryRawUnsafe<{ id: number; seconds: number; counter: number; len: number }[]>(
      `SELECT id, seconds, counter, length(instance) AS len FROM medici_id_sequence`
    );
    expect(rows).to.have.length(1);
    expect(Number(rows[0].id)).to.equal(1);
    expect(Number(rows[0].seconds)).to.equal(0);
    expect(Number(rows[0].counter)).to.equal(0);
    expect(Number(rows[0].len)).to.equal(5);
  });

  it("round-trips a transaction row with ObjectId-shaped ids and denormalized account path", async () => {
    const prisma = getPrismaClient();
    const txId = new ObjectId().toHexString();
    const journalId = new ObjectId().toHexString();
    const now = new Date();

    await prisma.transaction.create({
      data: {
        id: txId,
        credit: 10,
        debit: 0,
        meta: META_JSON,
        datetime: now,
        accountPath: JSON.stringify(["Assets", "Cash", "USD"]),
        accounts: "Assets:Cash:USD",
        book: BOOK,
        memo: "scaffold",
        journal: journalId,
        timestamp: now,
        voided: null,
        voidReason: null,
        originalJournal: null,
        accountPath0: "Assets",
        accountPath1: "Cash",
        accountPath2: "USD",
      },
    });

    const row = await prisma.transaction.findUnique({ where: { id: txId } });
    expect(row).to.not.equal(null);
    expect(row!.credit).to.equal(10);
    expect(row!.debit).to.equal(0);
    expect(row!.meta).to.equal(META_JSON);
    expect(row!.journal).to.equal(journalId);
    expect(row!.accountPath0).to.equal("Assets");
    expect(row!.accountPath2).to.equal("USD");
    expect(row!.voided).to.equal(null);
  });

  it("keeps journal _transactions as a TEXT JSON array defaulting to []", async () => {
    const prisma = getPrismaClient();
    await prisma.journal.create({
      data: {
        id: new ObjectId().toHexString(),
        datetime: new Date(),
        book: BOOK,
      },
    });
    const row = await prisma.journal.findFirst({ where: { book: BOOK } });
    expect(row!.memo).to.equal("");
    expect(row!.transactions).to.equal("[]");
  });

  it("enforces the (account, book) unique lock key", async () => {
    const prisma = getPrismaClient();
    const id = () => new ObjectId().toHexString();
    await prisma.lock.create({
      data: { id: id(), book: "b", account: "Income", updatedAt: new Date(), version: 0 },
    });
    let threw = false;
    try {
      await prisma.lock.create({
        data: { id: id(), book: "b", account: "Income", updatedAt: new Date(), version: 0 },
      });
    } catch {
      threw = true;
    }
    expect(threw).to.equal(true);
  });

  it("stores balance meta as the exact JSON string (book.spec.ts:373 semantics)", async () => {
    const prisma = getPrismaClient();
    const txId = new ObjectId().toHexString();
    await prisma.balance.create({
      data: {
        id: new ObjectId().toHexString(),
        // 40-char hex-encoded sha1-shaped key (M9): no NUL bytes, indexable.
        key: "0123456789abcdef0123456789abcdef01234567",
        rawKey: "scaffold-book;Income;clientId:12345",
        book: BOOK,
        account: "Income",
        transaction: txId,
        meta: META_JSON,
        balance: 10,
        notes: 1,
        createdAt: new Date(),
        expireAt: new Date(Date.now() + 86400000),
      },
    });
    const row = await prisma.balance.findFirst({ where: { account: "Income" } });
    expect(row!.meta).to.equal(META_JSON);
    expect(row!.balance).to.equal(10);
  });

  it("returns raw SQL integers as BigInt (defaultSafeIntegers) — map with Number()", async () => {
    const prisma = getPrismaClient();
    const rows = await prisma.$queryRawUnsafe<{ c: number }[]>(`SELECT COUNT(*) AS c FROM medici_transactions`);
    expect(typeof rows[0].c).to.equal("bigint");
    expect(Number(rows[0].c)).to.equal(1);
  });

  it("is idempotent: a second resetDatabase leaves the schema intact", async () => {
    const prisma = getPrismaClient();
    await resetDatabase(prisma);
    const rows = await prisma.$queryRawUnsafe<{ name: string }[]>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
    );
    expect(rows.map((row) => row.name)).to.deep.equal([...TABLES].sort());
    const seq = await prisma.$queryRawUnsafe<{ len: number }[]>(
      `SELECT length(instance) AS len FROM medici_id_sequence`
    );
    expect(Number(seq[0].len)).to.equal(5);
  });
});
