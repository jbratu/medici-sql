import { connectPrisma, currentSingletonUrl, databaseUrl, getPrismaClient } from "../database/client";
import { ensureSchema } from "../database/schema";
import { journalModel } from "../models/journal";
import { transactionModel } from "../models/transaction";
import { lockModel } from "../models/lock";
import { balanceModel } from "../models/balance";

/**
 * Upstream shape: `model.init()` per medici model (mongoose collection
 * bootstrap). In the Prisma port there is no per-model bootstrap work —
 * the compat `Model.init()` is a no-op — so the real preconditions are
 * added: the Prisma client is connected (port pragmas applied) and the
 * medici_% schema exists. The model init calls are kept for API-shape
 * parity.
 */
export async function initModels() {
  // Target the current singleton when one exists (e.g. after
  // initialize({ databaseUrl })), else the default database URL.
  const url = currentSingletonUrl() ?? databaseUrl();
  await connectPrisma(url);
  await ensureSchema(getPrismaClient(url));
  await journalModel.init();
  await transactionModel.init();
  await lockModel.init();
  await balanceModel.init();
}
