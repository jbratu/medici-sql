import type { ClientSession } from "./database/session";
import type { ReadPreferenceLike, Hint, ReadConcernLike } from "mongodb";

// aggregate of mongoose expects Record<string, unknown> type
//
// ITD-94: `session` is retyped from mongoose's ClientSession to the port's
// real one (src/database/session.ts). readPreference/hint/readConcern stay
// in the type as accepted-and-ignored so consumer code that passes them
// still compiles.
export type IOptions = {
  session?: ClientSession;
  readPreference?: ReadPreferenceLike;
  hint?: Hint;
  readConcern?: ReadConcernLike;
};
