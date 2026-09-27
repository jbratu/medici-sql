import type { PrismaClient } from "../generated";
import { SessionClosedError } from "./errors";
import { allocateTransactionIds as allocateOnClient } from "./idSequence";

/**
 * The Prisma interactive-transaction client type: what `prisma.$transaction`
 * passes to its callback (the full client minus the lifecycle methods).
 * A full PrismaClient is assignable to it, so both the session's tx client
 * and the singleton client satisfy every method in this layer.
 */
export type ItxClient = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$use" | "$extends">;

/**
 * The structural view of the Prisma client this package's public types are
 * allowed to name. Deliberately NOT `PrismaClient`/`ItxClient`: dts-bundle-
 * generator cannot bundle the generated multi-file Prisma client d.ts into
 * `types/index.d.ts` (unresolvable $Utils/$Extensions/$Result/$Public/
 * runtime namespaces, and a `ClientSession` identifier clash with Prisma's
 * own type). The model delegates are `any` here — the per-collection
 * argument/result shapes are enforced at runtime by the adapter layer, the
 * same trade-off the compat layer documents for Prisma delegate unions.
 */
export interface PrismaClientView {
  transaction: any;
  journal: any;
  lock: any;
  balance: any;
  idSequence: any;
  $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

/**
 * The ClientSession handed to `connection.transaction` callbacks (ITD-102,
 * compat core C). Wraps the Prisma interactive-transaction client.
 *
 * - `client` is the tx client: every query routed through it runs inside the
 *   open transaction and commits/rolls back with it. Adapter methods
 *   (ITD-93) take an optional session and use `session.client` when present,
 *   the singleton client when absent.
 * - After the transaction ends the session is `closed` and every query on
 *   `client` REJECTS (never throws synchronously) with P2028 "Transaction
 *   already closed" — that is what the unawaited background re-snapshot in
 *   Book.ts:165-186 relies on (QA S4): it sits in `.then().catch()`, must
 *   reject, and must not leave an unhandled rejection.
 */
export class ClientSession {
  private _client: PrismaClientView | undefined;
  private _closed = false;

  get closed(): boolean {
    return this._closed;
  }

  /** Bind the interactive-tx client. Called by connection.transaction immediately before the callback runs. */
  attach(client: PrismaClientView): void {
    if (this._closed) {
      throw new SessionClosedError("Cannot attach a client to a closed session.");
    }
    this._client = client;
  }

  /**
   * The interactive-transaction Prisma client. After close this still
   * returns the (closed) client — queries on it reject cleanly instead of
   * throwing synchronously (QA S4).
   */
  get client(): PrismaClientView {
    if (!this._client) {
      // Only reachable from code that holds the session before the callback
      // ran (a programming error, not a runtime failure path).
      throw new SessionClosedError("The session is not bound to a transaction yet.");
    }
    return this._client;
  }

  /** Mark the session closed. Idempotent; called by connection.transaction after commit or rollback. */
  close(): void {
    this._closed = true;
  }

  /**
   * Allocate `count` transaction `_id`s from `medici_id_sequence` (QA M3)
   * on the session's tx client, so the allocation commits/rolls back with
   * the transaction. Journal/lock/balance `_id`s stay client-side.
   * Rejects with SessionClosedError on a closed session.
   */
  allocateTransactionIds(count: number): Promise<string[]> {
    if (this._closed || !this._client) {
      return Promise.reject(new SessionClosedError("Cannot allocate transaction ids on a closed session."));
    }
    return allocateOnClient(this._client, count);
  }

  /** Allocate a single transaction `_id` (the primitive ITD-93's insertMany uses). */
  nextTransactionId(): Promise<string> {
    return this.allocateTransactionIds(1).then((ids) => ids[0]);
  }
}
