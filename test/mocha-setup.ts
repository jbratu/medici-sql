/**
 * Mocha bootstrap for the vendored upstream spec suite (ITD-95).
 *
 * Loaded via `ts-mocha --require` before any spec file (QA M11: ACID_AVAILABLE
 * must not come from a spec import — mocha's glob order is not a contract).
 *
 *  1. Sets ACID_AVAILABLE so the gate at spec/xacid.spec.ts:9 registers its
 *     12 tests.
 *  2. Self-heals the database before every test: port-owned spec suites
 *     (spec/scaffold.spec.ts, spec/transaction.spec.ts) disconnect the Prisma
 *     singleton in their after() hooks, and the vendored xacid suite runs
 *     last — without this it would see a fresh empty database. The hook only
 *     creates the schema when the tables are missing; it never truncates
 *     (QA S1: book.spec.ts depends on state accumulated across its own suite).
 *  3. Quarantines exactly the two Tier C tests (TEST_COMPAT_MATRIX.md,
 *     TIER_C_BUDGET: 2) by marking them pending — per-test, never a blanket
 *     describe.skip.
 *  4. After the run, asserts the vendored suite's shape against
 *     TEST_COMPAT_MATRIX.md (the source of truth for test classification):
 *       - every vendored file ran exactly the matrix's test-row count
 *         (runtime count — loop-generated it()s, e.g. handleVoidMemo's six
 *         cases, are each a matrix row),
 *       - the executed title set per vendored file exactly matches the
 *         matrix's test rows (both directions — unclassified or stale rows
 *         fail the build),
 *       - the acid block executed a non-zero count (a silently-empty ACID
 *         suite is the single easiest way to fake-pass this port),
 *       - executed total == the matrix's Tier A+B test-row count,
 *       - pending set == exactly the matrix's Tier C test rows, which must
 *         equal the QUARANTINED list below (zero skips outside Tier C),
 *       - every provenance file has at least one matrix row,
 *       - per-file pass/fail/pending matches spec/BASELINE.json when present
 *         (ITD-96 drives the baseline toward all-green; a deliberate
 *         re-baseline is a visible edit).
 *     Any mismatch throws from the root afterAll hook and fails the run.
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import os from "node:os";
import path from "path";
import { createRequire } from "module";
import { isFileLevelRow, parseMatrix } from "../scripts/lib/upstream-lib.mjs";

process.env.ACID_AVAILABLE = "true";

// Run from the repo root (npm scripts do); mocha loads this file via --require
// as ESM (Node type-stripping), so src is required through a CJS require that
// the ts-node hook compiles — sharing the same module cache as the spec files.
const requireTs = createRequire(import.meta.url);

// The vendored suite runs on a file-backed database (one per process). Prisma
// interactive transactions (used by the vendored xacid spec via
// mongoTransaction / connection.transaction) open a SEPARATE connection, and
// for file::memory: that separate connection is a fresh empty in-memory
// database with no schema — so Tier A xacid tests can never pass in-memory
// (the port's own spec/transaction.spec.ts uses a file DB for the same
// reason). A temp file is the port's production shape (default
// MEDICI_SQL_DATABASE_URL is a repo-root file).
export const TEST_DB_FILE = path.join(os.tmpdir(), `medici-sql-${process.pid}.db`);

// Spec files may set MEDICI_SQL_DATABASE_URL at module load (after this file);
// the root before() in spec/helper/MongoDB.spec.ts re-asserts the file URL
// after all module loads have run.
if (!process.env.MEDICI_SQL_DATABASE_URL) {
  process.env.MEDICI_SQL_DATABASE_URL = `file:${TEST_DB_FILE}`;
}

const ROOT = process.cwd();
const RESULTS_PATH = path.join(ROOT, "spec", "test-results.json");
const BASELINE_PATH = path.join(ROOT, "spec", "BASELINE.json");
const PROVENANCE_PATH = path.join(ROOT, "spec", "UPSTREAM_PROVENANCE.json");

// Tier C quarantine (TEST_COMPAT_MATRIX.md rows; TIER_C_BUDGET: 2). Matched on
// the runtime (file, title) pair — the vendored files are byte-identical.
//   spec/book.spec.ts › "should save all transactions in bulk and mitigate mongodb 'insertedIds' bug"
//   spec/setTransactionSchema.spec.ts › "should return full ledger with _journal2"
const QUARANTINED: Array<{ file: string; title: string }> = [
  {
    file: "spec/book.spec.ts",
    title: "should save all transactions in bulk and mitigate mongodb 'insertedIds' bug",
  },
  {
    file: "spec/setTransactionSchema.spec.ts",
    title: "should return full ledger with _journal2",
  },
];

// Vendored spec files that touch the database (all twelve upstream spec files;
// index/helpers/types register no tests).
const VENDORED_WITH_DB = new Set([
  "spec/balance.spec.ts",
  "spec/book.spec.ts",
  "spec/constructKey.spec.ts",
  "spec/extractObjectIdKeysFromSchema.spec.ts",
  "spec/fpPrecision.spec.ts",
  "spec/handleVoidMemo.spec.ts",
  "spec/parseBalanceQuery.spec.ts",
  "spec/parseDateField.spec.ts",
  "spec/parseFilterQuery.spec.ts",
  "spec/safeSetKeyToMetaObject.spec.ts",
  "spec/setTransactionSchema.spec.ts",
  "spec/xacid.spec.ts",
]);

interface PerFile {
  passed: number;
  failed: number;
  pending: number;
}

interface SuiteShape {
  format: string;
  generatedAt: string;
  perFile: Record<string, PerFile>;
  totals: { passed: number; failed: number; pending: number; executed: number };
  quarantined: string[];
}

type MochaSuite = {
  file?: string;
  parent?: MochaSuite | null;
  tests?: MochaTest[];
  suites?: MochaSuite[];
};

type MochaTest = {
  title: string;
  state?: string;
  pending?: boolean;
  parent?: MochaSuite;
};

let rootSuite: MochaSuite | null = null;

function relFile(file: string | undefined): string | null {
  if (!file) return null;
  const rel = path.relative(ROOT, file);
  return rel.startsWith("..") || path.isAbsolute(rel) ? null : rel;
}

function emptyPerFile(): PerFile {
  return { passed: 0, failed: 0, pending: 0 };
}

function walk(suite: MochaSuite, perFile: Record<string, PerFile>, runtimeLines: Map<string, number>): void {
  for (const test of suite.tests ?? []) {
    const file = relFile(test.parent?.file ?? suite.file);
    if (!file) continue;
    const bucket = (perFile[file] ??= emptyPerFile());
    if (test.state === "passed") bucket.passed += 1;
    else if (test.state === "failed") bucket.failed += 1;
    else if (test.pending) bucket.pending += 1;
    if (test.pending) bucket.pending += 0;
    const line = `${file} :: ${test.title}`;
    runtimeLines.set(line, (runtimeLines.get(line) ?? 0) + 1);
  }
  for (const child of suite.suites ?? []) walk(child, perFile, runtimeLines);
}

/**
 * Ensure the schema exists on whichever client is active. No-op when the
 * tables are present; recreates only on a fresh (e.g. post-disconnect) client.
 * For vendored suites it also re-asserts the file-backed URL: port-owned
 * suites (e.g. spec/scaffold.spec.ts) switch the env var back to in-memory in
 * their before() hooks, and a later vendored suite (xacid runs last) must not
 * inherit an in-memory client (interactive transactions, see above).
 */
async function ensureDatabase(testFile: string | null): Promise<void> {
  const { getPrismaClient, connectPrisma, disconnectPrisma, isInMemoryUrl, databaseUrl } =
    requireTs("../src/database/client");
  const { createSchema } = requireTs("../src/database/schema");
  if (testFile && VENDORED_WITH_DB.has(testFile) && isInMemoryUrl(databaseUrl())) {
    process.env.MEDICI_SQL_DATABASE_URL = `file:${TEST_DB_FILE}`;
    await disconnectPrisma();
  }
  const prisma = getPrismaClient();
  await connectPrisma();
  const rows = await prisma.$queryRawUnsafe(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'medici_id_sequence'"
  );
  if (Array.isArray(rows) && rows.length === 0) {
    await createSchema(prisma);
  }
}

function guard(): void {
  if (!rootSuite) {
    throw new Error("ITD-95 suite-shape guard: no suite observed (the run did not reach beforeEach)");
  }
  const perFile: Record<string, PerFile> = {};
  const runtimeLines = new Map<string, number>();
  walk(rootSuite, perFile, runtimeLines);

  const provenance: { files: Record<string, { sha256: string; itCount: number; mode?: string }> } = JSON.parse(
    readFileSync(PROVENANCE_PATH, "utf8")
  );
  const vendored = Object.keys(provenance.files);
  const findings: string[] = [];

  const matrix = parseMatrix();
  if (!matrix) {
    throw new Error("ITD-95 suite-shape guard: TEST_COMPAT_MATRIX.md is missing or unparseable");
  }
  const matrixLines = new Map<string, number>();
  const expectedPerFile: Record<string, number> = {};
  const filesWithAnyRow = new Set<string>();
  let abCount = 0;
  const cLines: string[] = [];
  for (const row of matrix.rows) {
    if (!row.tier || row.tier === "—" || row.tier === "-") continue;
    filesWithAnyRow.add(row.file);
    if (isFileLevelRow(row)) continue;
    const line = `${row.file} :: ${row.title}`;
    matrixLines.set(line, (matrixLines.get(line) ?? 0) + 1);
    expectedPerFile[row.file] = (expectedPerFile[row.file] ?? 0) + 1;
    const tier = row.tier.toUpperCase();
    if (tier === "A" || tier === "B") abCount += 1;
    else if (tier === "C") cLines.push(line);
  }

  // 1. Every provenance (vendored) file has at least one matrix row.
  for (const file of vendored) {
    if (!filesWithAnyRow.has(file)) {
      findings.push(`${file}: no row in TEST_COMPAT_MATRIX.md (unclassified — the drift monitor rejects this)`);
    }
  }

  // 2. Per vendored file: runtime test count == matrix test-row count.
  for (const file of vendored) {
    const expected = expectedPerFile[file] ?? 0;
    const got = perFile[file];
    const total = got ? got.passed + got.failed + got.pending : 0;
    if (total !== expected) {
      findings.push(`${file}: expected ${expected} tests (TEST_COMPAT_MATRIX.md rows), found ${total}`);
    }
  }

  // 3. Runtime title set == matrix test-row set, per vendored file, both
  //    directions (unclassified upstream tests and stale matrix rows fail).
  for (const [line, n] of runtimeLines) {
    const file = line.split(" :: ")[0];
    if (!vendored.includes(file)) continue;
    const m = matrixLines.get(line) ?? 0;
    if (m < n) {
      findings.push(`test not classified in TEST_COMPAT_MATRIX.md: ${line}`);
    }
  }
  for (const [line, n] of matrixLines) {
    const file = line.split(" :: ")[0];
    if (!vendored.includes(file)) continue;
    const r = runtimeLines.get(line) ?? 0;
    if (r < n) {
      findings.push(`stale row in TEST_COMPAT_MATRIX.md (test no longer runs): ${line}`);
    }
  }

  // 4. The acid block actually ran (QA M11) — a non-zero executed count.
  const xacid = perFile["spec/xacid.spec.ts"];
  const xacidExecuted = xacid ? xacid.passed + xacid.failed : 0;
  if (xacidExecuted === 0) {
    findings.push("spec/xacid.spec.ts: the acid describe block executed 0 tests (ACID_AVAILABLE gate did not open)");
  }

  // 5. Executed total == the matrix's Tier A+B test-row count.
  const vendoredExecuted = vendored.reduce((n, f) => {
    const g = perFile[f];
    return n + (g ? g.passed + g.failed : 0);
  }, 0);
  if (vendoredExecuted !== abCount) {
    findings.push(`executed ${vendoredExecuted} != Tier A+B ${abCount} (matrix test rows)`);
  }

  // 6. Pending == exactly the matrix's Tier C test rows, which must contain
  //    the QUARANTINED list (zero skips outside Tier C; matrix/quarantine drift).
  const pendingSet = new Set<string>();
  (function collectPending(suite: MochaSuite): void {
    for (const test of suite.tests ?? []) {
      if (test.pending) {
        const file = relFile(test.parent?.file ?? suite.file);
        if (file && vendored.includes(file)) pendingSet.add(`${file} :: ${test.title}`);
      }
    }
    for (const child of suite.suites ?? []) collectPending(child);
  })(rootSuite);
  for (const line of pendingSet) {
    if (!cLines.includes(line)) {
      findings.push(`unexpected pending/skipped test: ${line} (only Tier C matrix rows may be pending)`);
    }
  }
  for (const line of cLines) {
    if (!pendingSet.has(line)) {
      findings.push(`Tier C row did not run as pending: ${line} (it executed, is missing, or the title changed)`);
    }
  }
  for (const q of QUARANTINED) {
    const l = `${q.file} :: ${q.title}`;
    if (!cLines.includes(l)) {
      findings.push(`quarantined test ${l} is not a Tier C matrix row (matrix/quarantine drift)`);
    }
  }

  // 7. Baseline comparison (checked-in spec/BASELINE.json, per-file pass/fail/pending).
  if (existsSync(BASELINE_PATH)) {
    const baseline: SuiteShape = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
    for (const file of vendored) {
      const b = baseline.perFile[file] ?? emptyPerFile();
      const g = perFile[file] ?? emptyPerFile();
      if (b.passed !== g.passed || b.failed !== g.failed || b.pending !== g.pending) {
        findings.push(
          `${file}: ${g.passed}/${g.failed}/${g.pending} pass/fail/pending drifted from spec/BASELINE.json (${b.passed}/${b.failed}/${b.pending}) — fix the regression or re-baseline deliberately (ITD-96 drives green)`
        );
      }
    }
  }

  const results: SuiteShape = {
    format: "medici-sql/test-results/v1",
    generatedAt: new Date().toISOString(),
    perFile,
    totals: {
      passed: Object.values(perFile).reduce((n, g) => n + g.passed, 0),
      failed: Object.values(perFile).reduce((n, g) => n + g.failed, 0),
      pending: Object.values(perFile).reduce((n, g) => n + g.pending, 0),
      executed: Object.values(perFile).reduce((n, g) => n + g.passed + g.failed, 0),
    },
    quarantined: [...pendingSet],
  };
  writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2) + "\n");

  if (findings.length > 0) {
    throw new Error("ITD-95 suite-shape guard:\n- " + findings.join("\n- "));
  }
}

export const mochaHooks = {
  beforeEach: [
    async function ensureDatabaseHook(this: { currentTest?: MochaTest }): Promise<void> {
      await ensureDatabase(relFile(this.currentTest?.parent?.file));
    },
    function quarantineHook(this: { currentTest?: MochaTest; skip(): void }): void {
      const test = this.currentTest;
      if (!test) return;
      if (!rootSuite) {
        let suite: MochaSuite | undefined = test.parent;
        while (suite && suite.parent) suite = suite.parent;
        rootSuite = suite ?? { tests: [], suites: [] };
      }
      const file = relFile(test.parent?.file);
      const hit = file !== null && QUARANTINED.some((q) => q.file === file && q.title === test.title);
      if (hit) {
        // Tier C quarantine (TEST_COMPAT_MATRIX.md; TIER_C_BUDGET: 2)
        this.skip();
      }
    },
  ],
  afterAll(): void {
    guard();
  },
};
