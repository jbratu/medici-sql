/**
 * Public entry point for medici-sql.
 *
 * Grows additively per compat-core ticket: the scaffold (ITD-90) re-exported
 * only Entry (the verbatim helper src/helper/addReversedTransactions.ts
 * imports it from the package root); compat core C (ITD-102) adds the
 * transaction boundary surface — `connection`, `mongoTransaction`,
 * `ClientSession`, and the database-layer errors. The remaining upstream
 * surface (Book, models, set*Schema, initModels, syncIndexes) is wired up in
 * ITD-94.
 */
export { Entry } from "./Entry";
export { connection } from "./database/connection";
export type { MediciConnection } from "./database/connection";
export { ClientSession } from "./database/session";
export { SessionClosedError, TransactionIdReuseError } from "./database/errors";
export { mongoTransaction } from "./helper/mongoTransaction";
