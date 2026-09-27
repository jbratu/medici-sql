/**
 * Public entry point for medici-sql.
 *
 * Mirrors the upstream medici surface (ITD-88 plan §3: additive-only — no
 * export is renamed or removed; `mongoTransaction` keeps its name) plus the
 * port's additions: `connection`, `ClientSession`, the database-layer errors,
 * and `UnsupportedMongoOperationError`.
 */
import { Book } from "./Book";
import type { Entry } from "./Entry";

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

export { connection } from "./database/connection";
export type { MediciConnection } from "./database/connection";
export { ClientSession } from "./database/session";
export { SessionClosedError, TransactionIdReuseError } from "./database/errors";

export { Book, Entry };
export default Book;
