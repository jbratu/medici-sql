import * as crypto from "crypto";
import type { PrismaClientView } from "./session";

const SEQUENCE_ROW_ID = 1;
/** ObjectId counter field is 3 bytes: >16.7M ids in one second overflows (documented bound). */
const MAX_IDS_PER_CALL = 0xfffff;

function toIdHex(seconds: number, instance: Buffer, counter: number): string {
  const buf = Buffer.alloc(12);
  buf.writeUInt32BE(seconds, 0);
  instance.copy(buf, 4);
  buf.writeUIntBE(counter, 9, 3);
  return buf.toString("hex");
}

/**
 * Allocate `count` transaction `_id`s from the DB-backed monotonic source
 * `medici_id_sequence` (ITD-89 amendment A / QA M3), and return them as
 * 24-char lowercase-hex strings.
 *
 * The id layout mirrors the ObjectId byte layout — 4-byte seconds BE, the
 * row's fixed 5-byte `instance`, 3-byte counter BE — so lexicographic order
 * of the hex strings equals allocation order within the database.
 *
 * MUST be called on the write transaction's client (the session's tx client
 * from `connection.transaction`, or an ad-hoc `prisma.$transaction` when
 * committing without a session): the sequence row read/advance then commits
 * or rolls back atomically with the transaction's writes. Journal, lock,
 * and balance `_id`s stay client-side (upstream generates those too).
 */
export async function allocateTransactionIds(prisma: PrismaClientView, count: number): Promise<string[]> {
  if (!Number.isInteger(count) || count <= 0 || count > MAX_IDS_PER_CALL) {
    throw new RangeError(`allocateTransactionIds: count must be an integer in 1..${MAX_IDS_PER_CALL}, got ${count}`);
  }

  const nowSec = Math.floor(Date.now() / 1000);

  let row = await prisma.idSequence.findUnique({ where: { id: SEQUENCE_ROW_ID } });
  if (!row) {
    // Defensive: createSchema() seeds the row; a missing row (external DDL)
    // still must not break allocation.
    const instance = new Uint8Array(crypto.randomBytes(5));
    row = await prisma.idSequence.create({ data: { id: SEQUENCE_ROW_ID, seconds: nowSec, counter: -1, instance } });
  }

  const instance = Buffer.from(row.instance);
  const rolledToNow = nowSec > row.seconds;
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const sec = rolledToNow ? nowSec : row.seconds;
    const counter = rolledToNow ? i : row.counter + i + 1;
    ids.push(toIdHex(sec, instance, counter));
  }

  await prisma.idSequence.update({
    where: { id: SEQUENCE_ROW_ID },
    data: {
      seconds: rolledToNow ? nowSec : row.seconds,
      counter: rolledToNow ? count - 1 : row.counter + count,
    },
  });

  return ids;
}

/** Allocate a single transaction `_id` (the M3 primitive ITD-93's insertMany uses). */
export async function nextTransactionId(prisma: PrismaClientView): Promise<string> {
  const [id] = await allocateTransactionIds(prisma, 1);
  return id;
}
