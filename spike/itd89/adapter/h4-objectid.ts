// h4: ObjectId storage validation — ordering, monotonicity, cross-process, getTimestamp, String vs Bytes.
import { spawn } from "node:child_process";
import { ObjectId } from "bson";
import { makeClient, initDb, freshId, errInfo, report } from "./lib/helper.mjs";

const book = "H4";

function runChild(t0: number, n = 300): Promise<{ ids: string[]; startMs: number }> {
  const tsx = new URL("./node_modules/tsx/dist/cli.mjs", import.meta.url).pathname;
  const child = new URL("./h4-child.ts", import.meta.url).pathname;
  const proc = spawn(process.execPath, [tsx, child, String(t0), String(n)], { cwd: import.meta.dirname, stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    let buf = "";
    proc.stdout.on("data", (d) => (buf += d.toString()));
    proc.stderr.on("data", (d) => (buf += d.toString()));
    proc.on("close", (code) => {
      if (code === 0) {
        try { resolve(JSON.parse(buf.trim().split("\n").pop())); } catch (e) { reject(e); }
      } else reject(new Error("child exit " + code + " " + buf.slice(0, 300)));
    });
  });
}

async function main() {
  const prisma = makeClient();
  await initDb(prisma);
  await prisma.$executeRawUnsafe(`DELETE FROM medici_transactions WHERE book = ?`, book);

  report("== H4a string ordering: SQLite ORDER BY + > / <= vs ObjectId comparison ==");
  const prefix22 = "0".repeat(22); // 11 shared bytes; final byte differs
  const idA = prefix22 + "0f"; // boundary byte 0x0f
  const idB = prefix22 + "10"; // boundary byte 0x10 — naive "0f vs 10" intuition and hex-string/byte order must agree
  const now = new Date();
  await prisma.tx.create({ data: { id: idA, book, account: "O", credit: 1, debit: 0, journal: "j", datetime: now, timestamp: now } });
  await prisma.tx.create({ data: { id: idB, book, account: "O", credit: 1, debit: 0, journal: "j", datetime: now, timestamp: now } });
  const ordered = await prisma.$queryRawUnsafe(
    `SELECT id FROM medici_transactions WHERE book = ? AND account = 'O' ORDER BY id ASC`, book,
  );
  const gt = await prisma.$queryRawUnsafe(
    `SELECT id FROM medici_transactions WHERE book = ? AND account = 'O' AND id > ? ORDER BY id ASC`, book, idA,
  );
  const lte = await prisma.$queryRawUnsafe(
    `SELECT id FROM medici_transactions WHERE book = ? AND account = 'O' AND id <= ? ORDER BY id ASC`, book, idA,
  );
  const bsonA = new ObjectId(idA);
  const bsonB = new ObjectId(idB);
  // ObjectId natural order = 12-byte order (bson 7.x exposes no compare(); equals + byte compare is the definition)
  const byteOrder = Buffer.compare(Buffer.from(idA, "hex"), Buffer.from(idB, "hex"));
  report(`order=[${ordered.map((r: any) => r.id).join(", ")}] (expect ${idA}, ${idB})`);
  report(`gt(A)=[${gt.map((r: any) => r.id)}] (expect [${idB}])  lte(A)=[${lte.map((r: any) => r.id)}] (expect [${idA}])`);
  report(`bson: A.equals(B)=${bsonA.equals(bsonB)} byteCompare(A,B)=${byteOrder} A.getTimestamp()=${Math.floor(bsonA.getTimestamp().getTime() / 1000)}s B.getTimestamp()=${Math.floor(bsonB.getTimestamp().getTime() / 1000)}s`);
  const orderPass = ordered[0].id === idA && ordered[1].id === idB && gt.length === 1 && gt[0].id === idB && lte.length === 1 && lte[0].id === idA;
  report(`H4a boundary PASS=${orderPass}`);

  report("");
  report("== H4b Number()/parseInt trap: ids sharing the first 8 hex chars (same second) ==");
  // getTimestamp() returns a Date in bson 7.x — derive the 8-hex-char big-endian second count
  const T = Math.floor(Date.now() / 1000).toString(16).padStart(8, "0");
  // 24 hex chars each: same 8-char timestamp, 15 shared zero chars, differ only in the final char.
  // parseInt/Number (float64) truncates the low bits -> both parse equal; string compare distinguishes.
  const idC = T + "0".repeat(15) + "1";
  const idD = T + "0".repeat(15) + "2";
  await prisma.tx.create({ data: { id: idC, book, account: "N", credit: 1, debit: 0, journal: "j", datetime: now, timestamp: now } });
  await prisma.tx.create({ data: { id: idD, book, account: "N", credit: 1, debit: 0, journal: "j", datetime: now, timestamp: now } });
  const orderedN = await prisma.$queryRawUnsafe(
    `SELECT id FROM medici_transactions WHERE book = ? AND account = 'N' ORDER BY id ASC`, book,
  );
  const numC = Number.parseInt(idC, 16);
  const numD = Number.parseInt(idD, 16);
  report(`sqliteOrder=[${orderedN.map((r: any) => r.id).join(", ")}] (expect ${idC}, ${idD})`);
  report(`parseInt(C,16)=${numC} parseInt(D,16)=${numD} equalAsNumbers=${numC === numD} (naive numeric comparison CANNOT distinguish them)`);
  const gtN = await prisma.$queryRawUnsafe(
    `SELECT id FROM medici_transactions WHERE book = ? AND account = 'N' AND id > ?`, book, idC,
  );
  report(`sqlite id>C => [${gtN.map((r: any) => r.id)}] (expect [${idD}]) — string BINARY collation is correct where numeric is blind`);
  report(`H4b PASS=${orderedN[0].id === idC && orderedN[1].id === idD && numC === numD && gtN.length === 1 && gtN[0].id === idD}`);

  report("");
  report("== H4c in-process monotonicity (100k rapid successive ObjectIds) ==");
  const N = 100000;
  let inversions = 0;
  let prev = "";
  const tGen = Date.now();
  for (let i = 0; i < N; i++) {
    const h = new ObjectId().toHexString();
    if (i > 0 && h <= prev) inversions++;
    prev = h;
  }
  report(`generated=${N} in ${Date.now() - tGen}ms inversions=${inversions} (expect 0 — bson counter is monotonic within a process)`);
  report(`H4c PASS=${inversions === 0}`);

  report("");
  report("== H4d getTimestamp round-trip through the DB (Book.ts:113) ==");
  const samples: Array<{ hex: string; ts: number }> = [];
  for (let i = 0; i < 50; i++) {
    const o = new ObjectId();
    samples.push({ hex: o.toHexString(), ts: Math.floor(o.getTimestamp().getTime() / 1000) });
  }
  for (const s of samples) {
    await prisma.tx.create({ data: { id: s.hex, book, account: "T", credit: 0, debit: 0, journal: "j", datetime: new Date(s.ts * 1000), timestamp: new Date(s.ts * 1000) } });
  }
  const rows = await prisma.$queryRawUnsafe(`SELECT id FROM medici_transactions WHERE book = ? AND account = 'T'`, book);
  let rtFail = 0;
  for (const s of samples) {
    const found = rows.find((r: any) => r.id === s.hex);
    if (!found) { rtFail++; continue; }
    const back = new ObjectId(String(found.id));
    if (Math.floor(back.getTimestamp().getTime() / 1000) !== s.ts) rtFail++;
    if (back.toHexString() !== s.hex) rtFail++;
  }
  report(`roundTripFailures=${rtFail}/50 (expect 0); sample: ${samples[0].hex} ts=${samples[0].ts}s (getTimestamp() returns a Date in bson 7.x)`);
  report(`H4d PASS=${rtFail === 0}`);

  report("");
  report("== H4e $gt snapshot filter (Book.ts:104 pattern) over String ids ==");
  const snapIds: string[] = [];
  for (let i = 0; i < 100; i++) snapIds.push(freshId());
  for (const s of snapIds) {
    await prisma.tx.create({ data: { id: s, book, account: "S", credit: 1, debit: 0, journal: "j", datetime: now, timestamp: now } });
  }
  let filterPass = true;
  for (const idx of [0, 1, 37, 50, 99]) {
    const snap = snapIds[idx];
    const cnt = Number(
      (await prisma.$queryRawUnsafe(`SELECT COUNT(*) AS c FROM medici_transactions WHERE book = ? AND account = 'S' AND id > ?`, book, snap))[0].c,
    );
    const expect = 100 - idx - 1;
    if (cnt !== expect) filterPass = false;
  }
  report(`snapshotFilter mismatches=${filterPass ? "none" : "PRESENT"} (id > snapshot returned exactly the later ids for idx 0,1,37,50,99)`);
  report(`H4e PASS=${filterPass}`);

  report("");
  report("== H4f cross-process ordering within a second (10 rounds; earlier vs later creator) ==");
  report("ObjectId same-second layout = [4B second][5B per-process random][3B counter].");
  report("Cross-process order is fixed by the 5-byte random prefix, NOT creation time.");
  let inversionRounds = 0;
  for (let r = 1; r <= 10; r++) {
    const t0x = Date.now() + 400 + Math.floor(Math.random() * 300);
    const childPromise = runChild(t0x, 40);
    // parent = EARLIER creator: generate before the child is even spawned
    const earlier: string[] = [];
    for (let i = 0; i < 40; i++) earlier.push(new ObjectId().toHexString());
    await new Promise((res) => setTimeout(res, t0x - Date.now()));
    const later = (await childPromise).ids; // LATER creator
    const sameSec = earlier[0].slice(0, 8) === later[0].slice(0, 8);
    const earlierMin = [...earlier].sort()[0];
    const laterMin = [...later].sort()[0];
    const laterMax = [...later].sort().at(-1)!;
    const earlierMax = [...earlier].sort().at(-1)!;
    // inversion = later-created ids sort BEFORE earlier-created ids
    const inverted = sameSec && laterMin < earlierMin;
    const fullyInverted = sameSec && laterMax < earlierMin; // all later ids < all earlier ids
    if (inverted) inversionRounds++;
    report(`round ${r}: sameSec=${sameSec} earlierMin=${earlierMin} laterMin=${laterMin} laterMax=${laterMax} earlierMax=${earlierMax} inverted=${inverted} fullyInverted=${fullyInverted}`);
  }
  report(`inversionRounds=${inversionRounds}/10 (later-created process sorts before earlier-created process)`);
  report(`=> within the same second, cross-process _id order is decided by each process's random prefix, so "bigger id == newer" does NOT hold across processes. This is why multi-writer deployments need a DB-backed medici_id_sequence (seconds+counter+instance) rather than per-process bson ids, else _id>$gt snapshot pagination silently mis-orders across writers.`);
  report(`H4f DEMONSTRATED=${inversionRounds > 0}`);

  report("");
  report("== H4g String vs Bytes recommendation ==");
  report(`ids stored as 24-char lowercase hex TEXT; SQLite default BINARY collation on TEXT = byte-wise = ObjectId order (proven H4a/H4b/H4e).`);
  report(`Bytes(BLOB) would also sort byte-wise but: API JSON must hex-encode/decode at every boundary, $gt snapshot filters need Buffer->hex at the SQL edge, and indexes hold raw bytes.`);
  report(`RECOMMENDATION: String (24-char lowercase hex), enforced lowercase at write (ObjectId.toHexString is already lowercase).`);

  await prisma.$disconnect();
  report("done");
}

main().catch((e) => {
  report("FATAL " + JSON.stringify(errInfo(e)));
  process.exit(1);
});
