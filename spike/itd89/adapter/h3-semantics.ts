// h3: transaction semantics — read-your-writes, BEGIN IMMEDIATE probe,
// cross-process contention + retry wrapper + id-reuse hazard, pragma/URL probes.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import {
  makeClient, initDb, freshId, sleep, errInfo, report, DB_URL,
} from "./lib/helper.mjs";

const book = "H3";

// ---------- retry wrapper (the design under test) ----------
function causeOf(e: any) {
  return e?.meta?.driverAdapterError?.cause ?? null;
}

export function isRetriable(e: any): boolean {
  const code = e?.code ?? "";
  const cause = causeOf(e);
  const original = String(cause?.originalCode ?? "");
  const kind = String(cause?.kind ?? "");
  if (code === "P2002" || original.includes("SQLITE_CONSTRAINT")) return false; // unique/constraint = not contention; retrying duplicates
  if (code === "P2028") return true; // transaction start timeout (in-process queue/contention)
  if (original === "SQLITE_BUSY" || original === "SQLITE_LOCKED" || kind === "SocketTimeout") return true;
  if (/database is locked|Unable to start a transaction|Transaction already closed/i.test(String(e?.message ?? ""))) return true;
  return false;
}

export async function transactionWithRetry(
  prisma: any,
  fn: (tx: any) => Promise<unknown>,
  opts: { maxAttempts?: number; baseMs?: number } = {},
): Promise<unknown> {
  const { maxAttempts = 5, baseMs = 50 } = opts;
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      return await prisma.$transaction(fn);
    } catch (e: any) {
      if (!isRetriable(e) || attempt >= maxAttempts) throw e;
      const backoff = baseMs * 2 ** (attempt - 1) * (0.5 + Math.random());
      await sleep(backoff);
    }
  }
}

function runChild(holdMs: number): { proc: any; onLine: (fn: (l: string) => void) => void; close: () => void } {
  const tsx = new URL("./node_modules/tsx/dist/cli.mjs", import.meta.url).pathname;
  const child = new URL("./h3-child.ts", import.meta.url).pathname;
  const proc = spawn(process.execPath, [tsx, child, String(holdMs)], {
    cwd: import.meta.dirname,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const listeners: Array<(l: string) => void> = [];
  let buf = "";
  proc.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) for (const l of listeners) l(line);
    }
  });
  return { proc, onLine: (fn) => listeners.push(fn), close: () => proc.kill() };
}

const waitFor = (child: any, needle: string, timeoutMs: number) =>
  new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), timeoutMs);
    child.onLine((l: string) => {
      if (l.includes(needle)) {
        clearTimeout(t);
        resolve(true);
      }
    });
  });

async function main() {
  const prisma = makeClient();
  await initDb(prisma);

  report("== S6 read-your-writes + cross-connection invisibility ==");
  const prismaB = makeClient();
  await initDb(prismaB);
  const rid = freshId();
  const now = new Date();
  await prisma.$executeRawUnsafe(`DELETE FROM medici_transactions WHERE book = ?`, book);
  let visibleInTx = -1;
  let visibleOtherPre = -1;
  const otherRead = (async () => {
    await sleep(300);
    const rows = await prismaB.$queryRawUnsafe(
      `SELECT COUNT(*) AS c FROM medici_transactions WHERE book = ? AND id = ?`, book, rid,
    );
    return Number(rows[0].c);
  })();
  await prisma.$transaction(async (tx: any) => {
    await tx.tx.create({ data: { id: rid, book, account: "A", credit: 1, debit: 0, journal: "j", datetime: now, timestamp: now } });
    const rows = await tx.$queryRawUnsafe(
      `SELECT COUNT(*) AS c FROM medici_transactions WHERE book = ? AND id = ?`, book, rid,
    );
    visibleInTx = Number(rows[0].c);
    await sleep(600); // hold txn open while B reads
  });
  const visibleOtherPost = Number(
    (await prismaB.$queryRawUnsafe(`SELECT COUNT(*) AS c FROM medici_transactions WHERE book = ? AND id = ?`, book, rid))[0].c,
  );
  const visibleOther = await otherRead;
  report(`visibleInTx=${visibleInTx} visibleOtherPreCommit=${visibleOther} visibleOtherPostCommit=${visibleOtherPost} (expect 1 / 0 / 1)`);
  report(`S6 PASS=${visibleInTx === 1 && visibleOther === 0 && visibleOtherPost === 1}`);

  report("");
  report("== S8 BEGIN IMMEDIATE probe inside $transaction ==");
  for (const sql of ["BEGIN IMMEDIATE", "BEGIN EXCLUSIVE", "BEGIN"]) {
    try {
      await prisma.$transaction(async (tx: any) => {
        await tx.$queryRawUnsafe(sql);
        report(`${sql}: NO ERROR (unexpected)`);
      });
    } catch (e: any) {
      report(`${sql}: ${JSON.stringify(errInfo(e))}`);
    }
  }

  report("");
  report("== S3 cross-process contention (child holds write txn 3000ms; parent adapter busy timeout=800ms) ==");
  const prismaBusy = makeClient(DB_URL, { timeout: 800 });
  const child = runChild(3000);
  const ready = await waitFor(child, "READY", 15000);
  report(`childReady=${ready}`);
  let busyErr: any = null;
  let busyMs = 0;
  if (ready) {
    const t0 = Date.now();
    try {
      await prismaBusy.$transaction(async (tx: any) => {
        await tx.tx.create({ data: { id: freshId(), book, account: "A", credit: 1, debit: 0, journal: "j", datetime: new Date(), timestamp: new Date() } });
      });
    } catch (e: any) {
      busyErr = e;
    }
    busyMs = Date.now() - t0;
    report(`parentWriteError: elapsed=${busyMs}ms err=${JSON.stringify(errInfo(busyErr))}`);
  }

  report("");
  report("== S7 retry wrapper against live contention (starts while child still holds lock) ==");
  let retries = 0;
  const t0 = Date.now();
  try {
    const out = await transactionWithRetry(prismaBusy, async (tx: any) => {
      retries++;
      await tx.tx.create({ data: { id: freshId(), book, account: "A", credit: 1, debit: 0, journal: "j", datetime: new Date(), timestamp: new Date() } });
      return "committed";
    }, { maxAttempts: 6, baseMs: 100 });
    report(`retryResult=${out} attempts=${retries} elapsed=${Date.now() - t0}ms (expect success after child releases at ~2500ms)`);
  } catch (e: any) {
    report(`retryResult=THREW attempts=${retries} elapsed=${Date.now() - t0}ms err=${JSON.stringify(errInfo(e))}`);
  }
  const childDone = await waitFor(child, "child-committed", 15000);
  report(`childCommitted=${childDone}`);

  report("");
  report("== S7b id-reuse hazard: P2002 must NOT be retried; regenerated ids ARE safe ==");
  const fixedId = freshId();
  const now2 = new Date();
  await prisma.$transaction(async (tx: any) => {
    await tx.tx.create({ data: { id: fixedId, book, account: "A", credit: 1, debit: 0, journal: "j", datetime: now2, timestamp: now2 } });
  });
  let p2002: any = null;
  try {
    await transactionWithRetry(prisma, async (tx: any) => {
      await tx.tx.create({ data: { id: fixedId, book, account: "A", credit: 1, debit: 0, journal: "j", datetime: now2, timestamp: now2 } });
      return "ok";
    });
  } catch (e: any) {
    p2002 = e;
  }
  report(`fixedIdReinsert: ${JSON.stringify(errInfo(p2002))} (expect P2002, no retry loop)`);
  const dupCount = Number(
    (await prisma.$queryRawUnsafe(`SELECT COUNT(*) AS c FROM medici_transactions WHERE id = ?`, fixedId))[0].c,
  );
  report(`rowsWithFixedId=${dupCount} (expect 1 — no duplicate corruption)`);
  const regenerated = await transactionWithRetry(prisma, async (tx: any) => {
    const id = freshId();
    await tx.tx.create({ data: { id, book, account: "A", credit: 1, debit: 0, journal: "j", datetime: new Date(), timestamp: new Date() } });
    return id;
  });
  report(`regeneratedIdPerAttempt: committed=${String(regenerated).length === 24} (id generated inside fn per attempt)`);

  report("");
  report("== S7c rollback safety: id reuse after pre-commit failure is safe ==");
  let reused = "no";
  try {
    const reuseId = freshId();
    try {
      await prisma.$transaction(async (tx: any) => {
        await tx.tx.create({ data: { id: reuseId, book, account: "A", credit: 1, debit: 0, journal: "j", datetime: new Date(), timestamp: new Date() } });
        throw new Error("force-rollback");
      });
    } catch { /* expected rollback */ }
    await prisma.$transaction(async (tx: any) => {
      await tx.tx.create({ data: { id: reuseId, book, account: "A", credit: 1, debit: 0, journal: "j", datetime: new Date(), timestamp: new Date() } });
    });
    reused = "yes";
  } catch (e: any) {
    reused = "threw:" + JSON.stringify(errInfo(e));
  }
  report(`idReuseAfterRollback committed=${reused} (expect yes — SQLite rolled back the first insert)`);

  report("");
  report("== S2 pragma-in-URL probe (adapter path) ==");
  const weirdUrl = "file:./db-pragma-test.db?pragma=journal_mode(WAL)";
  const filesBefore = readdirSync(".").filter((f) => f.includes("db-pragma-test"));
  const prismaW = makeClient(weirdUrl);
  await prismaW.$queryRawUnsafe(`SELECT 1`);
  await prismaW.$disconnect();
  const filesAfter = readdirSync(".").filter((f) => f.includes("db-pragma-test"));
  const newFiles = filesAfter.filter((f) => !filesBefore.includes(f));
  report(`url=${weirdUrl}`);
  report(`filesBefore=${JSON.stringify(filesBefore)} filesAfter=${JSON.stringify(filesAfter)} newFiles=${JSON.stringify(newFiles)}`);
  if (newFiles.length) {
    for (const f of newFiles) report(`  "${f}" size=${statSync(f).size}`);
  }
  report(`normalDbStillExists=${existsSync("db-adapter.db")}`);

  report("");
  report("== S3b journal_mode persistence + synchronous per-connection ==");
  const jm1 = await prisma.$queryRawUnsafe(`PRAGMA journal_mode`);
  report(`journal_mode initial=${JSON.stringify(jm1)}`);
  await prisma.$executeRawUnsafe(`PRAGMA journal_mode = WAL`);
  const jm2 = await prisma.$queryRawUnsafe(`PRAGMA journal_mode`);
  report(`journal_mode after set (same client)=${JSON.stringify(jm2)}`);
  const prismaC = makeClient();
  const jm3 = await prismaC.$queryRawUnsafe(`PRAGMA journal_mode`);
  report(`journal_mode new client (persistent?)=${JSON.stringify(jm3)}`);
  await prismaC.$executeRawUnsafe(`PRAGMA journal_mode = DELETE`);
  const jm4 = await prisma.$queryRawUnsafe(`PRAGMA journal_mode`);
  report(`journal_mode back to DELETE, old client sees=${JSON.stringify(jm4)} (per-connection? )`);
  await prisma.$executeRawUnsafe(`PRAGMA synchronous = NORMAL`);
  const synA = (await prisma.$queryRawUnsafe(`PRAGMA synchronous`))[0];
  const synB = (await prismaC.$queryRawUnsafe(`PRAGMA synchronous`))[0];
  report(`synchronous A=${Number(synA[synA ? Object.keys(synA)[0] : "synchronous"])} B(new)=${Number(synB[Object.keys(synB)[0]])} (expect A=1, B=2 => per-connection)`);
  const bigintProbe = (await prisma.$queryRawUnsafe(`SELECT 5 AS n`))[0];
  report(`bigintProbe typeof=${typeof bigintProbe.n} value=${String(bigintProbe.n)} (adapter sets defaultSafeIntegers(true))`);

  await prisma.$disconnect();
  await prismaB.$disconnect();
  await prismaBusy.$disconnect();
  await prismaC.$disconnect();
  child.close();
  report("done");
}

main().catch((e) => {
  report("FATAL " + JSON.stringify(errInfo(e)));
  process.exit(1);
});
