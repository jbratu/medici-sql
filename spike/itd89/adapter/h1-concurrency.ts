// h1: N-way concurrent interactive transactions over the better-sqlite3 adapter.
import {
  makeClient, initDb, wipe, balance, freshId, sleep, errInfo, report,
} from "./lib/helper.mjs";

const book = "H1";

async function unitCommit(tx: any, n: number, delayMs = 0) {
  const id = freshId();
  const now = new Date();
  await tx.tx.create({
    data: {
      id, book, account: "A", credit: 1, debit: 0, memo: `u${n}`,
      datetime: now, journal: `j${id}`, timestamp: now,
    },
  });
  if (delayMs > 0) await sleep(delayMs);
  await tx.lock.upsert({
    where: { account_book: { account: "A", book } },
    update: { updatedAt: new Date(), version: { increment: 1 } },
    create: { id: freshId(), book, account: "A", updatedAt: new Date(), version: 1 },
  });
  const b = await balance(null, book, "A", tx);
  return b;
}

async function s1_vanilla(prisma: any, N: number) {
  await wipe(prisma, book);
  const t0 = Date.now();
  const results = await Promise.allSettled(
    Array.from({ length: N }, (_, i) =>
      prisma.$transaction((tx: any) => unitCommit(tx, i)),
    ),
  );
  const wall = Date.now() - t0;
  const ok = results.filter((r) => r.status === "fulfilled").length;
  const errors = results
    .map((r) => (r.status === "rejected" ? errInfo(r.reason) : null))
    .filter(Boolean);
  const finalB = await balance(prisma, book, "A");
  const lock = await prisma.lock.findFirst({ where: { book } });
  return { N, wall, ok, rejected: N - ok, finalB, lockVersion: lock?.version ?? null, errors: errors.slice(0, 3), errorCount: errors.length };
}

async function main() {
  const prisma = makeClient();
  await initDb(prisma);

  report("== S1 vanilla N=18 (insert -> upsert-increment -> aggregate read) ==");
  const s1 = await s1_vanilla(prisma, 18);
  report(JSON.stringify(s1));
  const pass = s1.ok === 18 && s1.rejected === 0 && s1.finalB === 18 && s1.lockVersion === 18;
  report(`S1 PASS=${pass} (ok=${s1.ok}/18, finalB=${s1.finalB}, lockVersion=${s1.lockVersion}, wall=${s1.wall}ms)`);

  report("");
  report("== S4a N ladder, fast txns ==");
  for (const N of [1, 2, 4, 8, 18, 32, 64, 128]) {
    const r = await s1_vanilla(prisma, N);
    report(`N=${String(N).padStart(3)} ok=${String(r.ok).padStart(3)} rejected=${String(r.rejected).padStart(3)} wall=${String(r.wall).padStart(6)}ms perTxn=${(r.wall / N).toFixed(1)}ms finalB=${r.finalB} lockVersion=${r.lockVersion} errCount=${r.errorCount}${r.errorCount ? " first=" + JSON.stringify(r.errors[0]) : ""}`);
  }

  report("");
  report("== S4b slow-writer ladder N=18 (in-txn delay), defaults maxWait=2000ms timeout=5000ms ==");
  for (const d of [100, 250, 400, 700]) {
    await wipe(prisma, book);
    const t0 = Date.now();
    const results = await Promise.allSettled(
      Array.from({ length: 18 }, (_, i) =>
        prisma.$transaction((tx: any) => unitCommit(tx, i, d)),
      ),
    );
    const wall = Date.now() - t0;
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const errors = results
      .map((r) => (r.status === "rejected" ? errInfo(r.reason) : null))
      .filter(Boolean) as any[];
    const uniq = new Map<string, number>();
    for (const e of errors) {
      const k = `${e.name}/${e.code}`;
      uniq.set(k, (uniq.get(k) ?? 0) + 1);
    }
    const finalB = await balance(prisma, book, "A");
    const lock = await prisma.lock.findFirst({ where: { book } });
    report(`delay=${d}ms ok=${ok}/18 rejected=${18 - ok} wall=${wall}ms finalB=${finalB} lockVersion=${lock?.version ?? null} errors=${JSON.stringify([...uniq])}${errors.length ? " first=" + JSON.stringify(errors[0]) : ""}`);
  }

  report("");
  report("== S4c slow-writer with explicit {maxWait, timeout} options ==");
  for (const opts of [{ maxWait: 60000, timeout: 60000 }]) {
    await wipe(prisma, book);
    const t0 = Date.now();
    const results = await Promise.allSettled(
      Array.from({ length: 18 }, (_, i) =>
        prisma.$transaction((tx: any) => unitCommit(tx, i, 400), opts),
      ),
    );
    const wall = Date.now() - t0;
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const errors = results
      .map((r) => (r.status === "rejected" ? errInfo(r.reason) : null))
      .filter(Boolean) as any[];
    const finalB = await balance(prisma, book, "A");
    report(`opts=${JSON.stringify(opts)} delay=400ms ok=${ok}/18 rejected=${18 - ok} wall=${wall}ms finalB=${finalB} errors=${errors.length ? JSON.stringify(errors[0]) : "none"}`);
  }

  await prisma.$disconnect();
  report("done");
}

main().catch((e) => {
  report("FATAL " + JSON.stringify(errInfo(e)));
  process.exit(1);
});
