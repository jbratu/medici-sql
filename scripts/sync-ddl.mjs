#!/usr/bin/env node
/**
 * Regenerates the DDL constant in src/database/schema.ts from
 * prisma/schema.prisma and fails the build if it changed without being
 * synced. Run `npm run db:sync-ddl` after editing prisma/schema.prisma.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const SCHEMA_FILE = "src/database/schema.ts";
const DDL = execFileSync(
  "npx",
  ["prisma", "migrate", "diff", "--from-empty", "--to-schema", "prisma/schema.prisma", "--script"],
  { encoding: "utf8" }
)
  .trim()
  .replace(/\s+$/, "");

const source = readFileSync(SCHEMA_FILE, "utf8");
const pattern = /export const DDL = `[\s\S]*?`;/;
if (!pattern.test(source)) {
  console.error(`db:sync-ddl: could not find the DDL constant in ${SCHEMA_FILE}`);
  process.exit(1);
}

const next = source.replace(pattern, () => `export const DDL = \`${DDL}\`;`);
if (next === source) {
  console.log("db:sync-ddl: DDL in sync with prisma/schema.prisma.");
} else {
  writeFileSync(SCHEMA_FILE, next);
  console.log(`db:sync-ddl: updated DDL constant in ${SCHEMA_FILE}.`);
}
