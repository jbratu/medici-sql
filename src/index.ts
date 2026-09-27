/**
 * Public entry point for medici-sql.
 *
 * Minimal at the scaffold stage (ITD-90): the repo builds, lints, and can
 * create/reset a SQLite database, but ships no Medici logic yet. The single
 * re-export exists because the verbatim helper
 * src/helper/addReversedTransactions.ts imports Entry from the package
 * root. The full public surface (Book, Entry, models, errors, helpers) is
 * wired up in ITD-94.
 */
export { Entry } from "./Entry";
