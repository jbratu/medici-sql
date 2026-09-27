#!/usr/bin/env node
/**
 * Copies the generated Prisma client from src/generated/ into build/generated/.
 *
 * The legacy prisma-client-js generator emits plain CJS JavaScript (plus
 * .d.ts files). tsc does not emit .js inputs, so the build would otherwise
 * ship build/database/client.js with a dangling require("../generated").
 * Everything is copied verbatim (the Node runtime path uses the embedded
 * base64 wasm; the raw .wasm is for edge workers and harmless to ship).
 */
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "src", "generated");
const to = join(root, "build", "generated");

if (!existsSync(from)) {
  console.error("copy-prisma-client: src/generated/ missing — run `npm run prisma:generate` first.");
  process.exit(1);
}
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });
console.log("copy-prisma-client: src/generated -> build/generated");
