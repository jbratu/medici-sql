// h2: fidelity to medici xacid.spec.ts 18-way double-spend + rollback semantics.
import {
  makeClient, initDb, wipe, balance, freshId, errInfo, report,
} from "./lib/helper.mjs";

const book = "H2-XACID";

async function seed(prisma: any) {
  await wipe(prisma, book);
  const jid = freshId();
  const now = new Date();
  const t1 = freshId();
  const t2 = freshId();
  await prisma.tx.create({ data: { id: t1, book, account: "Income", credit: 2, debit: 0, journal: jid, datetime: now, timestamp: now } });
  await prisma.tx.create({ data: { id: t2, book, account: "Outcome", credit: 0, debit: 2, journal: jid, datetime: now, timestamp: now } });
  await prisma.journal.create({ data: { id: jid, book, datetime: now, txIds: JSON.stringify([t1, t2]) } });
}

async function spendOne(prisma: any, session: any, name: string, pause: number) {
  const jid = freshId();
  const now = new Date();
  const t1 = freshId();
  const t2 = freshId();
  await session.tx.create({ data: { id: t1, book, account: "Savings", credit: 1, debit: 0, journal: jid, datetime: now, timestamp: now } });
  await session.tx.create({ data: { id: t2, book, account: "Income", credit: 0, debit: 1, journal: jid, datetime: now, timestamp: now } });
  await session.journal.create({ data: { id: jid, book, datetime: now, txIds: JSON.stringify([t1, t2]) } });
  await session.lock.upsert({
    where: { account_book: { account: "Income", book } },
    update: { updatedAt: new Date(), version: { increment: 1 } },
    create: { id: freshId(), book, account: "Income", updatedAt: new Date(), version: 1 },
  });
  if (pause > 0) await new Promise((r) => setTimeout(r, pause));
  const b = await balance(null, book, "Income", session);
  if (b < 0) throw new Error("Not enough Balance in " + name + " transaction.");
}

async function main() {
  const prisma = makeClient();
  await initDb(prisma);

  report("== S5 xacid 18-way double-spend fidelity (seed +2, 18 concurrent spend -1 with in-txn balance check) ==");
  await seed(prisma);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const results = await Promise.allSettled(
    Array.from({ length: 18 }, (_, i) =>
      prisma.$transaction((session: any) => spendOne(prisma, session, "concurrent", 0)),
    ),
  );
  const ok = results.filter((r) => r.status === "fulfilled").length;
  const notEnough = results.filter(
    (r) => r.status === "rejected" && String(r.reason?.message).includes("Not enough Balance"),
  ).length;
  const other = results.length - ok - notEnough;
  const finalB = await balance(prisma, book, "Income");
  const finalSavings = await balance(prisma, book, "Savings");
  const locks = await prisma.lock.findMany({ where: { book } });
  const jcount = await prisma.journal.count({ where: { book } });
  const tcount = await prisma.tx.count({ where: { book } });
  report(`ok=${ok} notEnoughBalance=${notEnough} otherErrors=${other}`);
  report(`finalIncome=${finalB} finalSavings=${finalSavings} lockRows=${locks.length} lockVersion=${locks[0]?.version ?? null} journals=${jcount} txRows=${tcount}`);
  const pass = ok === 2 && notEnough === 16 && other === 0 && finalB === 0 && finalSavings === 2 && locks.length === 1 && locks[0]?.version === 2 && jcount === 3 && tcount === 6;
  report(`S5 PASS=${pass} (expect ok=2, notEnough=16, finalIncome=0, lockVersion=2)`);

  report("");
  report("== S5b throw-inside-txn rolls back everything (spec 84-117) ==");
  await seed(prisma);
  let threw = false;
  try {
    await prisma.$transaction((session: any) =>
      (async () => {
        const jid = freshId();
        const now = new Date();
        const t1 = freshId();
        await session.tx.create({ data: { id: t1, book, account: "Income", credit: 5, debit: 0, journal: jid, datetime: now, timestamp: now } });
        await session.journal.create({ data: { id: jid, book, datetime: now, txIds: JSON.stringify([t1]) } });
        throw new Error("boom-mid-txn");
      })(),
    );
  } catch (e: any) {
    threw = String(e.message).includes("boom-mid-txn") || String(e.message).includes("Transaction was rolled back");
    report(`thrown=${JSON.stringify(errInfo(e))}`);
  }
  const bAfter = await balance(prisma, book, "Income");
  const jAfter = await prisma.journal.count({ where: { book } });
  const tAfter = await prisma.tx.count({ where: { book } });
  report(`after-rollback: Income=${bAfter} journals=${jAfter} txRows=${tAfter} (expect 2 / 1 / 2 = seed only)`);
  report(`S5b PASS=${threw && bAfter === 2 && jAfter === 1 && tAfter === 2}`);

  report("");
  report("== S5c partial commit (validation fail mid-commit) leaves zero rows of that entry ==");
  await seed(prisma);
  const beforeJ = await prisma.journal.count({ where: { book } });
  let threw2 = false;
  try {
    await prisma.$transaction((session: any) =>
      (async () => {
        const jid = freshId();
        const now = new Date();
        const t1 = freshId();
        await session.tx.create({ data: { id: t1, book, account: "Income", credit: 1, debit: 0, journal: jid, datetime: now, timestamp: now } });
        throw new Error("validation failed");
      })(),
    );
  } catch {
    threw2 = true;
  }
  const afterJ = await prisma.journal.count({ where: { book } });
  report(`journals before=${beforeJ} after=${afterJ} (expect equal)`);
  report(`S5c PASS=${threw2 && beforeJ === afterJ}`);

  await prisma.$disconnect();
  report("done");
}

main().catch((e) => {
  report("FATAL " + JSON.stringify(errInfo(e)));
  process.exit(1);
});
