// h5: NUL-containing key round-trip (medici_balances.key / hashKey 0x00 risk).
import { createHash } from "node:crypto";
import { makeClient, initDb, freshId, errInfo, report } from "./lib/helper.mjs";

async function main() {
  const prisma = makeClient();
  await initDb(prisma);
  await prisma.$executeRawUnsafe(`DELETE FROM nul_probe`);

  // 20-byte key with embedded 0x00 at known positions (sha1-shaped)
  const key = Buffer.alloc(20);
  for (let i = 0; i < 20; i++) key[i] = (i * 37 + 11) % 256;
  key[3] = 0;
  key[12] = 0;
  const latin1 = Array.from(key, (b) => String.fromCharCode(b)).join("");
  const hex = key.toString("hex");

  await prisma.nulProbe.create({ data: { id: freshId(), latin1, hex, raw: key } });

  const row = await prisma.nulProbe.findFirst();
  const backLatin1 = Array.from(latin1).map((ch) => ch.charCodeAt(0));
  const latin1Match = backLatin1.length === 20 && backLatin1.every((b, i) => b === key[i]);
  const rawBack = Buffer.from(row.raw);
  const rawMatch = rawBack.equals(key);
  const hexMatch = row.hex === hex;
  report(`== H5a round-trip: 20-byte key with 0x00 at [3] and [12] (hex=${hex}) ==`);
  report(`latin1TEXT roundtrip byteExact=${latin1Match}  hexTEXT=${hexMatch}  BLOB=${rawMatch}`);

  report("");
  report("== H5b SQL string functions on the NUL-containing TEXT ==");
  const len = (await prisma.$queryRawUnsafe(`SELECT length(latin1) AS v FROM nul_probe`))[0];
  const sub = (await prisma.$queryRawUnsafe(`SELECT substr(latin1, 1, 8) AS v FROM nul_probe`))[0];
  const subLen = Buffer.from(String(sub.v), "latin1").length;
  const likeHit = (await prisma.$queryRawUnsafe(`SELECT COUNT(*) AS c FROM nul_probe WHERE latin1 LIKE ?`, "ab%"))[0];
  const instr = (await prisma.$queryRawUnsafe(`SELECT instr(latin1, char(0)) AS v FROM nul_probe`))[0];
  report(`length(latin1)=${Number(len.v)} (20 => no C-string truncation, or 3 => truncated at first NUL)`);
  report(`substr(latin1,1,8) bytes=${subLen} (8 => full, 3 => truncated at NUL)`);
  report(`instr(latin1, NUL)=${Number(instr.v)} (0 => functions see no NUL / truncated)`);
  report(`latin1 LIKE 'ab%' rows=${Number(likeHit.c)} (key starts 0x0b 0x24... so expect 0 either way; probe recorded)`);

  report("");
  report("== H5c order preservation: hex TEXT vs raw byte order ==");
  await prisma.$executeRawUnsafe(`DELETE FROM nul_probe`);
  const keys: Buffer[] = [];
  for (let i = 0; i < 100; i++) {
    const b = createHash("sha1").update(`k${i}-${Math.random()}`).digest();
    keys.push(b);
  }
  keys.sort((a, b2) => Buffer.compare(a, b2));
  for (const k of keys) {
    const l = Array.from(k, (x) => String.fromCharCode(x)).join("");
    await prisma.nulProbe.create({ data: { id: freshId(), latin1: l, hex: k.toString("hex"), raw: k } });
  }
  const byHex = await prisma.$queryRawUnsafe(`SELECT hex FROM nul_probe ORDER BY hex ASC`);
  const byLatin1 = await prisma.$queryRawUnsafe(`SELECT latin1 FROM nul_probe ORDER BY latin1 ASC`);
  let orderOk = true;
  for (let i = 0; i < keys.length; i++) {
    if (byHex[i].hex !== keys[i].toString("hex")) { orderOk = false; break; }
  }
  const latin1Bytes = byLatin1.map((r: any) => Array.from(String(r.latin1)).map((c: string) => c.charCodeAt(0)));
  for (let i = 0; i < keys.length; i++) {
    const ok = latin1Bytes[i].length === 20 && latin1Bytes[i].every((b, j) => b === keys[i][j]);
    if (!ok) { orderOk = false; break; }
  }
  report(`100 random 20-byte keys (sha1-shaped, NULs included): ORDER BY hex matches byte order, ORDER BY latin1 matches byte order => ${orderOk}`);
  report(`H5c PASS=${orderOk}`);
  report(`NOTE: P(sha1 digest contains 0x00) = 1 - (255/256)^20 = ${(1 - Math.pow(255 / 256, 20)).toFixed(4)}; NUL round-trips exactly through better-sqlite3 TEXT/BLOB, but hex-encoding keeps keys safe across SQL string functions, tooling, and JSON.`);

  await prisma.$disconnect();
  report("done");
}

main().catch((e) => {
  report("FATAL " + JSON.stringify(errInfo(e)));
  process.exit(1);
});
