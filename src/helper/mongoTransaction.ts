import { connection } from "../database/connection";
import type { ClientSession } from "../database/session";
import type { IAnyObject } from "../IAnyObject";

/**
 * Public alias for `connection.transaction` (ITD-102, compat core C).
 *
 * Upstream exports `mongoTransaction` from the package root and the xacid
 * spec imports it by that name; the port keeps the name (public API is
 * additive-only). Unlike upstream, this file is NOT a verbatim copy — it is
 * part of the compat core and binds the alias to the SQLite-backed
 * connection object (src/database/connection.ts).
 */
export function mongoTransaction<T = unknown>(
  fn: (session: ClientSession) => Promise<T>,
  options?: IAnyObject
): Promise<T> {
  return connection.transaction(fn, options);
}
