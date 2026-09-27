// h6: sequential commit throughput (full medici commit shape).
import { makeClient, initDb, freshId, errInfo, report, wipe } from "./lib/helper.mjs";

const book = "H6";

async function fullCommit(prisma: any, account: string) {
  const jid = freshId();
  const now = new Date();
  const t1 = freshId();
  const t2 = freshId();
  await prisma.$transaction(async (tx: any) => {
    await tx.tx.create({ data: { id: t1, book, account, credit: 1, debit: 0, journal: jid, datetime: now, timestamp: now } });
    await tx.tx.create({ data: { id: t2, book, account: "Outcome", credit: 0, debit: 1, journal: jid, datetime: now, timestamp: now } });
    await tx.journal.create({ data: { id: jid, book, datetime: now, txIds: JSON.stringify([t1, t2]) } });
    await tx.lock.upsert({
      where: { account_book: { account, book } },
      update: { updatedAt: new Date(), version: { increment: 1 } },
      create: { id: freshId(), book, account, updatedAt: new Date(), version: 1 },
    });
  });
}

async function main() {
  const prisma = makeClient();
  await initDb(prisma);
  await wipe(prisma, book);

  report("== H6a 1000 sequential interactive transactions (2 tx inserts + 1 journal + 1 lock upsert each) ==");
  const t0 = Date.now();
  for (let i = 0; i < 1000; i++) {
    await fullCommit(prisma, "A" + (i % 5));
  }
  const wall = Date.now() - t0;
  const tcount = await prisma.tx.count({ where: { book } });
  const jcount = await prisma.journal.count({ where: { book } });
  report(`wall=${wall}ms commitsPerSec=${(1000 / (wall / 1000)).toFixed(1)} perCommitAvg=${(wall / 1000).toFixed(1)}ms txRows=${tcount} journals=${jcount} (expect 2000/1000)`);

  report("");
  report("== H6b contrast: 1000 commits in ONE big transaction (no per-commit boundary) ==");
  await wipe(prisma, book);
  const t1 = Date.now();
  await prisma.$transaction(async (tx: any) => {
    for (let i = 0; i < 1000; i++) {
      const jid = freshId();
      const now = new Date();
      const a = freshId();
      const b = freshId();
      await tx.tx.create({ data: { id: a, book, account: "A", credit: 1, debit: 0, journal: jid, datetime: now, timestamp: now } });
      await tx.tx.create({ data: { id: b, book, account: "Outcome", credit: 0, debit: 1, journal: jid, datetime: now, timestamp: now } });
      await tx.journal.create({ data: { id: jid, book, datetime: now, txIds: JSON.stringify([a, b]) } });
    }
  });
  const wall2 = Date.now() - t1;
  report(`wall=${wall2}ms perCommitIfBatched=${(wall2 / 1000).toFixed(2)}ms (baseline for why per-commit boundaries cost; xacid requires per-entry boundaries so H6a is the operative number)`);

  await prisma.$disconnect();
  report("done");
}

main().catch((e) => {
  report("FATAL " + JSON.stringify(errInfo(e)));
  process.exit(1);
});
