import { journalModel } from "../models/journal";
import { lockModel } from "../models/lock";
import { transactionModel } from "../models/transaction";
import { balanceModel } from "../models/balance";

/**
 * Will execute mongoose model's `syncIndexes()` for all medici models.
 * WARNING! This will erase any custom (non-builtin) indexes you might have added.
 *
 * Prisma port (ITD-94): indexes are owned by the schema at bootstrap, so
 * the compat `Model.syncIndexes()` is a no-op. The name and the
 * `{background}` option signature are kept upstream-compatible, and this
 * helper must not throw (upstream specs call it, e.g.
 * setTransactionSchema.spec.ts and balance.spec.ts).
 * @param [options] {{background: Boolean}}
 */
export async function syncIndexes(options?: { background: boolean }) {
  await journalModel.syncIndexes(options);
  await transactionModel.syncIndexes(options);
  await lockModel.syncIndexes(options);
  await balanceModel.syncIndexes(options);
}
