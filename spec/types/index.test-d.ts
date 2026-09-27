import { expectAssignable, expectType } from "tsd";
import {
  ClientSession,
  Entry,
  MediciConnection,
  SessionClosedError,
  TransactionIdReuseError,
  connection,
  mongoTransaction,
} from "../../types/index";

// Public surface checks (ITD-97 owns the full API-parity suite; these pin
// the compat-core-C additions from ITD-102).
expectType<typeof Entry>(Entry);

// The transaction boundary surface, exactly as declared.
expectType<MediciConnection>(connection);
expectAssignable<MediciConnection["db"]>(connection.db);

// ClientSession: the session object handed to connection.transaction callbacks.
declare const session: ClientSession;
expectType<ClientSession>(session);
expectType<boolean>(session.closed);
expectType<Promise<string[]>>(session.allocateTransactionIds(3));
expectType<Promise<string>>(session.nextTransactionId());
expectType<void>(session.close());

// connection.transaction / mongoTransaction: generic callback, loose options.
declare const fn: (session: ClientSession) => Promise<number>;
expectType<Promise<number>>(connection.transaction(fn));
expectType<Promise<number>>(connection.transaction(fn, { maxWait: 100, timeout: 5000, retries: 3 }));
expectType<Promise<number>>(mongoTransaction(fn));
expectType<Promise<number>>(mongoTransaction(fn, { retries: 0 }));

// Database-layer errors (src/database/errors.ts; src/errors/ stays verbatim).
const closed = new SessionClosedError();
expectType<InstanceType<typeof SessionClosedError>>(closed);
expectType<string>(closed.message);

const reuse = new TransactionIdReuseError("message", new Error("original"));
expectType<InstanceType<typeof TransactionIdReuseError>>(reuse);
expectType<unknown>(reuse.cause);
expectAssignable<InstanceType<typeof Error>>(reuse);
