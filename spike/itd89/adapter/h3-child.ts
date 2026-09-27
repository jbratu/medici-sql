// h3 child: hold a write transaction open for N ms.
import { makeClient, initDb, freshId, sleep, report } from "./lib/helper.mjs";

declare const __dirname: string;

async function main() {
  const holdMs = Number(process.argv[2] ?? 1000);
  const prisma = makeClient();
  await initDb(prisma);
  console.log("child-started");
  await prisma.$transaction(async (tx: any) => {
    await tx.tx.create({
      data: { id: freshId(), book: "H3-child", account: "A", credit: 1, debit: 0, journal: "j", datetime: new Date(), timestamp: new Date() },
    });
    console.log("READY");
    await sleep(holdMs);
  });
  console.log("child-committed");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.log("child-error " + String(e?.message ?? e));
  process.exit(1);
});
