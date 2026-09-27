/**
 * Compatibility types for the "mongodb" module specifier.
 *
 * Upstream src/IOptions.ts is copied verbatim and imports these types from
 * "mongodb" (upstream gets the package transitively through mongoose; the
 * port has no mongoose and no mongodb dependency). tsc resolves the
 * specifier to this module via `paths` in the tsconfigs. The import in
 * IOptions.ts is type-only, so nothing is emitted as a runtime require.
 *
 * STATUS: placeholder (ITD-90). ITD-91 replaces these with the real shapes
 * (or their driver-equivalent stand-ins) once the compat core lands.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

export type ReadPreferenceLike = any;

export type Hint = any;

export type ReadConcernLike = any;
