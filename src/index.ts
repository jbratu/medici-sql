import { Book } from "./Book";
import { Entry } from "./Entry";
import { connection } from "./database/connection";
import { ensureSchemaLazy } from "./database/schema";

export { setJournalSchema } from "./models/journal";
export { setTransactionSchema } from "./models/transaction";
export { setLockSchema } from "./models/lock";
export { mongoTransaction } from "./helper/mongoTransaction";
export { initModels } from "./helper/initModels";
export { syncIndexes } from "./helper/syncIndexes";

export { MediciError } from "./errors/MediciError";
export { BookConstructorError } from "./errors/BookConstructorError";
export { InvalidAccountPathLengthError } from "./errors/InvalidAccountPathLengthError";
export { JournalAlreadyVoidedError } from "./errors/JournalAlreadyVoidedError";
export { JournalNotFoundError } from "./errors/JournalNotFoundError";
export { TransactionError } from "./errors/TransactionError";
export { UnsupportedMongoOperationError } from "./errors/UnsupportedMongoOperationError";

export { connection };
export type { MediciConnection } from "./database/connection";
export { ClientSession } from "./database/session";
export { SessionClosedError, TransactionIdReuseError } from "./database/errors";

/**
 * Additive (ITD-94): explicit database bootstrap. Upstream medici needs no
 * such call — importing Book and using it works out of the box, so this
 * stays optional. When called, it points the lazy Prisma client at
 * `options.databaseUrl` (falling back to MEDICI_SQL_DATABASE_URL / the
 * default file path), connects with the port pragmas, and ensures the
 * schema exists.
 */
export type InitializeOptions = {
  databaseUrl?: string;
};

export async function initialize(options?: InitializeOptions) {
  // connection.connect() disconnects a pre-existing singleton pointing at a
  // different URL before reconnecting, so a second initialize() with a new
  // URL cannot leak the old connection.
  await connection.connect(options?.databaseUrl);
  await ensureSchemaLazy();
  return connection;
}

export { Book, Entry };
export default Book;
