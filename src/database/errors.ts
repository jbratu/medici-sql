import { MediciError } from "../errors/MediciError";

/**
 * Database-layer errors (ITD-102, compat core C).
 *
 * Lived in their own module on purpose: src/errors/ is a VERBATIM copy of
 * upstream (upstream/VERBATIM_FILES.txt) and must stay byte-identical, so
 * port-specific error classes cannot be added there.
 */

/**
 * Raised (always as a promise rejection, never synchronously) when a
 * ClientSession is used after its transaction has committed or rolled back
 * (QA S4). The upstream Book.balance background re-snapshot
 * (Book.ts:165-186) fires an unawaited promise that carries the caller's
 * closed session; it must reject into its .catch() and must not leave an
 * unhandled rejection.
 */
export class SessionClosedError extends MediciError {
  constructor(message = "The transaction session is closed; the transaction has already committed or rolled back.") {
    super(message);
    this.name = "SessionClosedError";
  }
}

/**
 * Raised when a RETRIED transaction attempt hits a unique/PK constraint
 * violation (QA S6): an identifier constructed outside the transaction
 * callback (e.g. the journal `_id` of an Entry built before
 * `connection.transaction(...)` ran) was re-inserted on the retry.
 *
 * `connection.transaction` only retries when the whole previous attempt
 * rolled back, so a duplicate key on attempt >= 2 means either a previous
 * attempt actually committed despite reporting a failure, or the fixed id
 * collided with an external writer — in both cases the consumer must be
 * told, with the original constraint violation attached as `cause`,
 * instead of seeing a raw P2002/SQLITE_CONSTRAINT.
 */
export class TransactionIdReuseError extends MediciError {
  public cause: unknown;

  constructor(message: string, originalError: unknown) {
    super(message);
    this.name = "TransactionIdReuseError";
    this.cause = originalError;
  }
}
