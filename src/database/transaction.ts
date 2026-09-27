import { IAnyObject } from "../IAnyObject";
import { TransactionIdReuseError } from "./errors";

/**
 * Retry-on-contention policy for `connection.transaction` (ITD-102, compat
 * core C). Design is settled by the ITD-89 spike (spike/FINDINGS.md,
 * sections a and d) — measured, not inferred:
 *
 * - In-process, the adapter serializes interactive transactions behind an
 *   async mutex on one connection, so the only in-process failure mode is
 *   P2028 "Unable to start a transaction in the given time." (start/queue
 *   timeout; break point ~ maxWait / callback-duration).
 * - Cross-connection (cross-process) write contention surfaces as P2010 /
 *   P1008 whose `meta.driverAdapterError.cause` carries SQLITE_BUSY /
 *   SQLITE_LOCKED / SocketTimeout — match the CAUSE, never the user-facing
 *   message.
 * - Constraint violations are NEVER retriable: a duplicate key may mean a
 *   previous attempt already committed.
 * - Backoff: exponential with jitter (base 50 ms, cap 2 s), max 5 attempts
 *   (~<=5 s total; the spike's measured worst case needed 3).
 */

/** Spike section d: max 5 attempts. */
export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_RETRY_BASE_DELAY_MS = 50;
export const DEFAULT_RETRY_MAX_DELAY_MS = 2000;

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

interface PrismaKnownErrorShape {
  code: string;
  message?: string;
  meta?: { driverAdapterError?: { cause?: { originalCode?: string; kind?: string } } };
}

function isPrismaKnownError(err: unknown): err is PrismaKnownErrorShape {
  return !!err && typeof err === "object" && typeof (err as { code?: unknown }).code === "string";
}

/** True when the failed attempt fully rolled back and re-running it is safe (spike section d). */
export function isRetriable(err: unknown): boolean {
  if (!isPrismaKnownError(err)) {
    return false;
  }
  if (err.code === "P2028") {
    // Only the start/queue timeout is pre-commit. The other P2028 message
    // ("Transaction already closed") is a use-after-commit code bug — fail
    // fast, never retry it.
    return typeof err.message === "string" && err.message.includes("Unable to start a transaction");
  }
  const cause = err.meta?.driverAdapterError?.cause;
  if (!cause) {
    return false;
  }
  return (
    cause.originalCode === "SQLITE_BUSY" || cause.originalCode === "SQLITE_LOCKED" || cause.kind === "SocketTimeout"
  );
}

/** True for unique/PK constraint violations (P2002 / SQLITE_CONSTRAINT). */
export function isUniqueConstraintError(err: unknown): boolean {
  if (!isPrismaKnownError(err)) {
    return false;
  }
  if (err.code === "P2002") {
    return true;
  }
  const cause = err.meta?.driverAdapterError?.cause;
  return !!cause && typeof cause.originalCode === "string" && cause.originalCode.startsWith("SQLITE_CONSTRAINT");
}

function backoffDelay(attempt: number, policy: RetryPolicy): number {
  const exponential = policy.baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(exponential, policy.maxDelayMs);
  // Jitter in 0.5..1.5 (spike section d).
  return Math.round(capped * (0.5 + Math.random()));
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Run `doAttempt` with the retry policy. Re-throws the original (last)
 * error when retries are exhausted or the error is not retriable.
 *
 * QA S6: a unique/PK violation on attempt >= 2 is converted into a named
 * TransactionIdReuseError (cause = the original constraint violation) —
 * that shape means an identifier built outside the callback was reused.
 */
export async function runWithRetry<T>(doAttempt: (attempt: number) => Promise<T>, policy: RetryPolicy): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      // The await is load-bearing: without it the catch would never see the
      // attempt's rejection (a bare `return promise` bypasses try/catch).
      // no-return-await conflicts with sonarjs/prefer-immediate-return here
      // (a temp var is what the latter rejects), so the await stays inline.
      // eslint-disable-next-line no-return-await -- see comment above
      return await doAttempt(attempt);
    } catch (err) {
      if (attempt > 1 && isUniqueConstraintError(err)) {
        throw new TransactionIdReuseError(
          `Transaction retry (attempt ${attempt}) hit a unique constraint violation: an identifier constructed outside the transaction callback was reused. Build the Entry inside connection.transaction() so its ObjectIds are regenerated on every attempt, or pass { retries: 0 } to disable retrying.`,
          err
        );
      }
      if (attempt >= policy.maxAttempts || !isRetriable(err)) {
        throw err;
      }
      await sleep(backoffDelay(attempt, policy));
    }
  }
}

export interface TransactionOptions extends RetryPolicy {
  maxWait?: number;
  timeout?: number;
}

/**
 * Parse the loose IAnyObject options the client-facing
 * `connection.transaction(fn, options?)` accepts. Unrecognized keys are
 * ignored (upstream passes IAnyObject through).
 *
 * Recognized: maxWait, timeout (ms, passed to the Prisma interactive
 * transaction), retries / maxAttempts (0 disables retrying),
 * retryBaseDelayMs, retryMaxDelayMs.
 */
export function parseTransactionOptions(options: IAnyObject | undefined): TransactionOptions {
  const o = options ?? {};
  const positiveNumber = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;

  let maxAttempts = DEFAULT_MAX_ATTEMPTS;
  const rawAttempts = o.retries !== undefined ? o.retries : o.maxAttempts;
  if (rawAttempts === 0) {
    maxAttempts = 1;
  } else if (typeof rawAttempts === "number" && Number.isInteger(rawAttempts) && rawAttempts >= 1) {
    maxAttempts = rawAttempts;
  }

  return {
    maxWait: positiveNumber(o.maxWait),
    timeout: positiveNumber(o.timeout),
    maxAttempts,
    baseDelayMs: positiveNumber(o.retryBaseDelayMs) ?? DEFAULT_RETRY_BASE_DELAY_MS,
    maxDelayMs: positiveNumber(o.retryMaxDelayMs) ?? DEFAULT_RETRY_MAX_DELAY_MS,
  };
}
