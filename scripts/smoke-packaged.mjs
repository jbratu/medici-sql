#!/usr/bin/env node
/**
 * G8 (QA amendment, delivered as ITD-94 item 2, wired into CI by ITD-96) —
 * published-artifact packaging smoke. Proves the consumer contract on the
 * PACKED package, not on src/:
 *
 *   1. `npm pack`
 *   2. install the tarball into a scratch directory containing only the
 *      port's production dependencies, with NO mongoose installed
 *   3. run the smoke script against `build/index.js` — create a Book, commit
 *      a balanced entry, read balance/ledger/listAccounts, void the journal
 *   4. `tsc` a two-line consumer file against the emitted `types/index.d.ts`
 *   5. `grep -r "mongoose" build/ types/` — no unresolvable specifier may
 *      remain (tsc-alias rewrites the JS, dts-bundle inlines the types)
 *
 * Run locally: `npm run smoke:packaged`. CI: .github/workflows/ci.yml.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TSC = path.join(REPO_ROOT, "node_modules", ".bin", "tsc");

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "pipe", cwd: REPO_ROOT, ...opts }).toString();

const step = (name) => console.log(`[smoke] ${name}`);

const scratch = mkdtempSync(path.join(tmpdir(), "medici-sql-pack-"));
let exitCode = 1;

try {
  // 1. npm pack
  step("npm pack");
  const packOut = run("npm", ["pack", "--silent"]);
  const tarball = packOut
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.endsWith(".tgz"));
  if (!tarball) throw new Error(`npm pack produced no tarball:\n${packOut}`);
  console.log(`[smoke] tarball: ${tarball}`);

  // 2. Install the tarball into a scratch dir (production deps only — the
  //    package's "dependencies" are prisma + better-sqlite3 + bson; mongoose
  //    is NOT among them, so a successful install is the no-mongoose proof).
  step("npm install (scratch, no mongoose)");
  writeFileSync(path.join(scratch, "package.json"), JSON.stringify({ name: "smoke-scratch", private: true }, null, 2));
  execFileSync("npm", ["install", path.join(REPO_ROOT, tarball), "--no-audit", "--no-fund", "--silent"], {
    stdio: "pipe",
    cwd: scratch,
  });
  const pkgDir = path.join(scratch, "node_modules", "medici-sql");
  if (!existsSync(path.join(pkgDir, "build", "index.js")) || !existsSync(path.join(pkgDir, "types", "index.d.ts"))) {
    throw new Error("packed package is missing build/index.js or types/index.d.ts");
  }
  if (existsSync(path.join(scratch, "node_modules", "mongoose"))) {
    throw new Error("mongoose was installed into the scratch dir — the port must not depend on it");
  }

  // 3. Smoke script against build/index.js (full client-facing round trip).
  step("smoke script (Book/commit/balance/ledger/listAccounts/void)");
  const smokePath = path.join(scratch, "smoke.cjs");
  writeFileSync(
    smokePath,
    `"use strict";
const assert = require("assert");
const os = require("os");
const path = require("path");
process.env.MEDICI_SQL_DATABASE_URL = \`file:\${path.join(os.tmpdir(), "medici-sql-smoke-\${process.pid}.db")}\`;
const { Book } = require("medici-sql");
(async () => {
  const book = new Book("smoke-book");
  const journal = await book.entry("smoke entry").credit("Assets:Cash", 10).debit("Income", 10).commit();
  assert.ok(journal._id, "journal _id missing");
  const balance = await book.balance({ account: "Assets:Cash" });
  assert.deepStrictEqual(balance, { balance: 10, notes: 1 });
  const ledger = await book.ledger({ account: "Income" });
  assert.strictEqual(ledger.results.length, 1);
  assert.strictEqual(ledger.results[0].credit, 10);
  const accounts = await book.listAccounts();
  assert.deepStrictEqual(accounts, ["Assets", "Assets:Cash", "Income"]);
  await book.void(journal._id, "smoke void");
  const after = await book.balance({ account: "Assets:Cash" });
  assert.strictEqual(after.balance, 0);
  process.stdout.write("SMOKE OK | " + [book.name, balance.balance, ledger.total, accounts.join(","), journal._id.toString()].join(" | ") + "\\n");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
`
  );
  const smokeOut = execFileSync(process.execPath, [smokePath], { stdio: "pipe", cwd: scratch }).toString();
  if (!smokeOut.includes("SMOKE OK")) throw new Error(`smoke script did not report OK:\n${smokeOut}`);
  console.log(`[smoke] ${smokeOut.trim()}`);

  // 4. tsc a two-line consumer against the emitted types/index.d.ts.
  step("tsc two-line consumer against types/index.d.ts");
  const consumerPath = path.join(scratch, "consumer.ts");
  writeFileSync(
    consumerPath,
    `import { Book, mongoTransaction } from "medici-sql";\nexport const book = new Book("consumer");\nvoid mongoTransaction;\n`
  );
  execFileSync(TSC, [consumerPath, "--noEmit", "--strict", "--target", "es2021", "--module", "commonjs", "--moduleResolution", "node", "--skipLibCheck"], {
    stdio: "pipe",
    cwd: scratch,
  });
  console.log("[smoke] consumer type-checked clean");

  // 5. No unresolvable "mongoose" specifier may remain in build/ or types/.
  step("grep build/ types/ for unresolvable mongoose specifier");
  const greps = [
    path.join(pkgDir, "build"),
    path.join(pkgDir, "types"),
  ];
  for (const dir of greps) {
    let out = "";
    try {
      out = execFileSync("grep", ["-rn", "-E", 'require\\(["\']mongoose["\\']\\)|from ["\']mongoose["\']', dir], {
        stdio: ["ignore", "pipe", "ignore"],
      }).toString();
    } catch (err) {
      out = ""; // grep exits 1 on no matches
    }
    if (out.trim().length > 0) {
      throw new Error(`unresolvable "mongoose" specifier remains in ${dir}:\n${out}`);
    }
  }
  console.log("[smoke] no mongoose specifier in build/ or types/");

  console.log("[smoke] PASS");
  exitCode = 0;
} catch (err) {
  console.error(`[smoke] FAIL: ${err.message}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
  for (const f of readdirSync(REPO_ROOT).filter((f) => f.startsWith("medici-sql-") && f.endsWith(".tgz"))) {
    rmSync(path.join(REPO_ROOT, f), { force: true });
  }
}

process.exit(exitCode);
