import { ObjectId } from "bson";
import { IAnyObject } from "../IAnyObject";
import { connectPrisma } from "./client";
import { allocateTransactionIds } from "./idSequence";
import { ClientSession, ItxClient, PrismaClientView } from "./session";

/**
 * Minimal native-mongo-shaped collection adapter (ITD-102, compat core C —
 * interim stage; the full query/update operators land with ITD-92/ITD-93).
 *
 * Session routing: when `options.session` is present, every query runs on
 * the session's interactive-transaction client and commits/rolls back with
 * the open transaction; otherwise the singleton client is used. (Discipline
 * from the spike: inside a transaction callback use the session's client —
 * the single connection makes outer-client calls piggyback on the open txn.)
 *
 * id rules (QA M3): transaction `_id`s without an explicit `_id` are
 * allocated from `medici_id_sequence` ON the write transaction's client
 * (session tx client, or an ad-hoc `prisma.$transaction` when committing
 * without a session). Journal/lock/balance `_id`s stay client-side.
 *
 * id shapes at this stage: hex strings (24-char lowercase). Upstream returns
 * ObjectId instances; the compat core (ITD-93/ITD-94) normalizes at the
 * model boundary.
 */

export interface SqlCollectionOptions {
  session?: ClientSession;
  [key: string]: unknown;
}

/** Public surface of the collection (kept interface-typed so the bundled d.ts stays small). */
export interface SqlCollection {
  insertOne(doc: IAnyObject, options?: SqlCollectionOptions): Promise<{ insertedId: string }>;
  insertMany(
    docs: IAnyObject | IAnyObject[],
    options?: SqlCollectionOptions
  ): Promise<{ insertedIds: Record<string, string>; insertedCount: number }>;
  updateOne(
    filter: IAnyObject,
    update: IAnyObject,
    options?: SqlCollectionOptions
  ): Promise<{ matchedCount: number; modifiedCount: number; upsertedId?: string }>;
  find(filter?: IAnyObject, options?: SqlCollectionOptions): { toArray(): Promise<IAnyObject[]> };
  findOne(filter?: IAnyObject, options?: SqlCollectionOptions): Promise<IAnyObject | null>;
  countDocuments(filter?: IAnyObject, options?: SqlCollectionOptions): Promise<number>;
  deleteOne(filter: IAnyObject, options?: SqlCollectionOptions): Promise<{ deletedCount: number }>;
  deleteMany(filter: IAnyObject, options?: SqlCollectionOptions): Promise<{ deletedCount: number }>;
  aggregate(pipeline?: IAnyObject[], options?: SqlCollectionOptions): { toArray(): Promise<IAnyObject[]> };
  distinct(field: string, filter?: IAnyObject, options?: SqlCollectionOptions): Promise<IAnyObject[]>;
}

const notYetImplemented = (what: string): Error =>
  new Error(`SqlCollection.${what} is not implemented at this stage (ITD-92/ITD-93 own the full adapter).`);

function toHex(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object" && typeof (value as { toHexString?: unknown }).toHexString === "function") {
    return (value as { toHexString(): string }).toHexString();
  }
  return String(value);
}

function newId(): string {
  return new ObjectId().toHexString();
}

const isDate = (value: unknown): value is Date => value instanceof Date;

/** Mongo field name -> Prisma field name. */
function fieldKey(key: string): string {
  switch (key) {
    case "_id":
      return "id";
    case "_journal":
      return "journal";
    case "_original_journal":
      return "originalJournal";
    case "_transactions":
      return "transactions";
    case "void_reason":
      return "voidReason";
    case "__v":
      return "version";
    case "account_path":
      return "accountPath";
    default:
      return key;
  }
}

function toWhere(filter: IAnyObject | undefined): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filter ?? {})) {
    if (
      value != null &&
      typeof value === "object" &&
      !isDate(value) &&
      typeof (value as { toHexString?: unknown }).toHexString !== "function"
    ) {
      // Operator object (e.g. { _id: { $gt: ... } }) — pass through.
      where[fieldKey(key)] = value;
    } else {
      where[fieldKey(key)] = toHex(value) ?? value;
    }
  }
  return where;
}

interface TransactionRow {
  id: string;
  credit: number;
  debit: number;
  meta: string | null;
  datetime: Date;
  accountPath: string;
  accounts: string;
  book: string;
  memo: string;
  journal: string;
  timestamp: Date;
  voided: boolean | null;
  voidReason: string | null;
  originalJournal: string | null;
  accountPath0: string | null;
  accountPath1: string | null;
  accountPath2: string | null;
}

function mapTransactionRow(doc: IAnyObject, id: string): TransactionRow {
  const accountPath = Array.isArray(doc.account_path)
    ? doc.account_path.map((segment: unknown) => String(segment))
    : [];
  return {
    id,
    credit: Number(doc.credit),
    debit: Number(doc.debit),
    meta: doc.meta != null ? (typeof doc.meta === "string" ? doc.meta : JSON.stringify(doc.meta)) : null,
    datetime: doc.datetime as Date,
    accountPath: JSON.stringify(accountPath),
    accounts: String(doc.accounts ?? accountPath.join(":")),
    book: String(doc.book),
    memo: String(doc.memo ?? ""),
    journal: toHex(doc._journal) as string,
    timestamp: (doc.timestamp as Date) ?? new Date(),
    voided: doc.voided == null ? null : Boolean(doc.voided),
    voidReason: doc.voidReason == null ? null : String(doc.voidReason),
    originalJournal: toHex(doc._original_journal),
    accountPath0: accountPath[0] ?? null,
    accountPath1: accountPath[1] ?? null,
    accountPath2: accountPath[2] ?? null,
  };
}

class SqlCollectionImpl implements SqlCollection {
  constructor(private readonly singleton: ItxClient, private readonly name: string) {}

  private clientFor(options?: SqlCollectionOptions): PrismaClientView {
    return options?.session ? options.session.client : this.singleton;
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  // The four Prisma model delegates form a union type whose method
  // signatures are mutually incompatible, so the branch result is
  // `any`-typed (the per-collection argument types are checked by the
  // mapInsertDoc/toWhere shapes, as in the compat layer).
  private delegate(prisma: PrismaClientView): any {
    switch (this.name) {
      case "medici_transactions":
        return prisma.transaction;
      case "medici_journals":
        return prisma.journal;
      case "medici_locks":
        return prisma.lock;
      case "medici_balances":
        return prisma.balance;
      default:
        throw new Error(`SqlCollection: unknown collection "${this.name}"`);
    }
  }

  private mapInsertDoc(doc: IAnyObject, id: string): IAnyObject {
    switch (this.name) {
      case "medici_transactions":
        return mapTransactionRow(doc, id) as unknown as IAnyObject;
      case "medici_journals":
        return {
          id,
          datetime: doc.datetime as Date,
          memo: String(doc.memo ?? ""),
          transactions: JSON.stringify(doc._transactions ?? []),
          book: String(doc.book),
          voided: doc.voided == null ? null : Boolean(doc.voided),
          voidReason: doc.void_reason == null ? null : String(doc.void_reason),
        };
      case "medici_locks":
        return {
          id,
          book: String(doc.book),
          account: String(doc.account),
          updatedAt: (doc.updatedAt as Date) ?? new Date(),
          version: Number(doc.__v ?? 0),
        };
      case "medici_balances":
        return {
          id,
          key: String(doc.key),
          rawKey: String(doc.rawKey ?? ""),
          book: String(doc.book),
          account: doc.account == null ? null : String(doc.account),
          transaction: toHex(doc.transaction) as string,
          meta: typeof doc.meta === "string" ? doc.meta : JSON.stringify(doc.meta ?? {}),
          balance: Number(doc.balance),
          notes: Number(doc.notes ?? 0),
          createdAt: (doc.createdAt as Date) ?? new Date(),
          expireAt: (doc.expireAt as Date) ?? new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
        };
      default:
        throw new Error(`SqlCollection: unknown collection "${this.name}"`);
    }
  }

  async insertOne(doc: IAnyObject, options?: SqlCollectionOptions): Promise<{ insertedId: string }> {
    await connectPrisma();
    const prisma = this.clientFor(options);
    const id = toHex(doc._id) ?? newId();
    const created = await this.delegate(prisma).create({ data: this.mapInsertDoc(doc, id) });
    return { insertedId: String(created.id) };
  }

  async insertMany(
    docs: IAnyObject | IAnyObject[],
    options?: SqlCollectionOptions
  ): Promise<{ insertedIds: Record<string, string>; insertedCount: number }> {
    await connectPrisma();
    const list: IAnyObject[] = Array.isArray(docs) ? docs : [docs];
    const prisma = this.clientFor(options);

    const run = async (client: PrismaClientView): Promise<string[]> => {
      let allocated: string[] | undefined;
      if (this.name === "medici_transactions" && list.some((doc) => toHex(doc._id) == null)) {
        const missing = list.filter((doc) => toHex(doc._id) == null);
        if (missing.length !== list.length) {
          throw new Error("SqlCollection.insertMany: either all or none of the transaction docs may carry _id");
        }
        // M3: allocate on the write transaction's client so the sequence
        // advance commits/rolls back with the inserts.
        allocated = await allocateTransactionIds(client, list.length);
      }
      const ids: string[] = [];
      for (let i = 0; i < list.length; i++) {
        const id = toHex(list[i]._id) ?? (allocated ? allocated[i] : newId());
        ids.push(id);
        await this.delegate(client).create({ data: this.mapInsertDoc(list[i], id) });
      }
      return ids;
    };

    const ids = options?.session ? await run(prisma) : await this.singleton.$transaction((tx) => run(tx));

    const insertedIds: Record<string, string> = {};
    ids.forEach((id, i) => {
      insertedIds[String(i)] = id;
    });
    return { insertedIds, insertedCount: ids.length };
  }

  /**
   * Implements the lock upsert shape used by Book.writelockAccounts:
   * `{ $set: { updatedAt }, $setOnInsert: { book, account }, $inc: { __v: 1 } }`
   * with `{ upsert: true }`. Generic update operators are ITD-92/ITD-93.
   */
  async updateOne(
    filter: IAnyObject,
    update: IAnyObject,
    options?: SqlCollectionOptions
  ): Promise<{ matchedCount: number; modifiedCount: number; upsertedId?: string }> {
    await connectPrisma();
    if (this.name !== "medici_locks") {
      throw notYetImplemented("updateOne (only the medici_locks upsert shape is implemented at this stage)");
    }
    const book = String(filter.book);
    const account = String(filter.account);
    const updatedAt: Date = isDate(update.$set?.updatedAt) ? (update.$set.updatedAt as Date) : new Date();
    const increment = Number((update.$inc && update.$inc.__v) || 1);

    const prisma = this.clientFor(options);
    const lock = prisma.lock;
    try {
      await lock.update({
        where: { account_book: { account, book } },
        data: { updatedAt, version: { increment } },
      });
      return { matchedCount: 1, modifiedCount: 1 };
    } catch (err) {
      if (err && typeof err === "object" && (err as { code?: unknown }).code === "P2025" && options?.upsert) {
        const created = await lock.create({
          data: { id: newId(), book, account, updatedAt, version: increment },
        });
        return { matchedCount: 0, modifiedCount: 0, upsertedId: String(created.id) };
      }
      throw err;
    }
  }

  find(filter?: IAnyObject, options?: SqlCollectionOptions): { toArray(): Promise<IAnyObject[]> } {
    const where = toWhere(filter);
    return {
      toArray: async () => {
        await connectPrisma();
        const prisma = this.clientFor(options);
        const rows = await this.delegate(prisma).findMany({ where });
        return rows as IAnyObject[];
      },
    };
  }

  async findOne(filter?: IAnyObject, options?: SqlCollectionOptions): Promise<IAnyObject | null> {
    await connectPrisma();
    const prisma = this.clientFor(options);
    const row = await this.delegate(prisma).findFirst({ where: toWhere(filter) });
    return (row ?? null) as IAnyObject | null;
  }

  async countDocuments(filter?: IAnyObject, options?: SqlCollectionOptions): Promise<number> {
    await connectPrisma();
    const prisma = this.clientFor(options);
    return this.delegate(prisma).count({ where: toWhere(filter) });
  }

  async deleteOne(filter: IAnyObject, options?: SqlCollectionOptions): Promise<{ deletedCount: number }> {
    await connectPrisma();
    const prisma = this.clientFor(options);
    const delegate = this.delegate(prisma);
    const row = await delegate.findFirst({ where: toWhere(filter) });
    if (!row) {
      return { deletedCount: 0 };
    }
    await delegate.delete({ where: { id: String(row.id) } });
    return { deletedCount: 1 };
  }

  async deleteMany(filter: IAnyObject, options?: SqlCollectionOptions): Promise<{ deletedCount: number }> {
    await connectPrisma();
    const prisma = this.clientFor(options);
    const result = await this.delegate(prisma).deleteMany({ where: toWhere(filter) });
    return { deletedCount: result.count };
  }

  aggregate(_pipeline?: IAnyObject[], _options?: SqlCollectionOptions): { toArray(): Promise<IAnyObject[]> } {
    throw notYetImplemented("aggregate");
  }

  distinct(_field: string, _filter?: IAnyObject, _options?: SqlCollectionOptions): Promise<IAnyObject[]> {
    throw notYetImplemented("distinct");
  }
}

export function createSqlCollection(singleton: ItxClient, name: string): SqlCollection {
  return new SqlCollectionImpl(singleton, name);
}
