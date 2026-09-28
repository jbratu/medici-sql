#!/usr/bin/env node
// Public API surface report + parity check (ITD-97, type-level API parity).
//
// Generates `api-surface.json` at the repo root from the built type bundle
// `types/index.d.ts` (produced by `npm run build:types`). The report reuses
// the same extractor (extractSurface) and the same `medici-sql/api-surface/v1`
// shape as the upstream baseline `upstream/api-surface.json` (ITD-98), with
// exports in d.ts declaration order so the two files stay line-diffable.
// The `upstream` block describes the repo the surface was extracted from
// (this port), keeping the field for shape compatibility with the baseline.
//
// Usage:
//   node scripts/surface-report.mjs           regenerate the report, write it,
//                                             then run the parity diff
//   node scripts/surface-report.mjs --check   no write: verify the committed
//                                             report is in sync with
//                                             types/index.d.ts, then run the
//                                             parity diff
//
// Parity diff (our surface vs upstream/api-surface.json):
//   - added   (ours only)         allowed — the port's API is additive-only
//   - removed (baseline only)     FAIL — upstream symbols must stay exported
//   - changed (both, different text) listed below. Import-specifier drift
//     (e.g. `import("mongoose").X` vs a locally-inlined `X`) is normalized
//     away and reported as compatible. Anything still different is a
//     manual-review item and must be justified in REVIEWED_DRIFT.
// Exits 1 on removed entries, unjustified changed entries, or (with --check)
// a committed report that no longer matches types/index.d.ts.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { extractSurface, SURFACE_FORMAT, ROOT } from './lib/upstream-lib.mjs';

const DTS_PATH = path.join(ROOT, 'types', 'index.d.ts');
const REPORT_PATH = path.join(ROOT, 'api-surface.json');
const BASELINE_PATH = path.join(ROOT, 'upstream', 'api-surface.json');

// Manual-review verdicts for signatures that differ from the committed
// upstream baseline for a documented reason. Each entry must state why the
// difference is compatible (no removal, no narrowing). Not a blanket
// allowlist: an entry is only honored when the pair actually differs.
const REVIEWED_DRIFT = {
  Entry:
    'compatible widening (x2, credit/debit `extra`): the committed baseline predates the `extra = null as (T & Partial<U>) | null` default parameter; upstream pinned source (54fa40b, src/Entry.ts) is byte-identical to ours and produces `extra?: (T & Partial<U>) | null`. Widening an optional parameter is non-breaking for consumers; no other Entry member differs.',
  Book: 'compatible: (a) `entry` date param `Date` -> `Date | null` — the committed baseline predates the `date = null as Date | null` default parameter; upstream pinned source (54fa40b, src/Book.ts) is byte-identical to ours and produces `date?: Date | null`. (b) `Omit<import("mongoose").Document<any, any, any>, ...>` -> `Omit<Document, ...>` — reference resolution only: this port inlines its own Document interface in the bundle (identical after stripping the import specifier). No other Book member differs.',
};

function git(args) {
  return execSync(`git ${args}`, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

function normalizeSig(sig) {
  return sig.replace(/import\(\s*["'][^"']+["']\s*\)\./g, '').replace(/\s+/g, ' ').trim();
}

function fail(msg) {
  console.error(`surface-report: ${msg}`);
  process.exit(1);
}

function gitMeta() {
  return {
    remote: 'https://github.com/jbratu/medici-sql',
    sha: git('rev-parse HEAD'),
    ref: git('rev-parse --abbrev-ref HEAD'),
  };
}

function buildReport(dtsText) {
  return {
    format: SURFACE_FORMAT,
    upstream: gitMeta(),
    source: 'types/index.d.ts (dts-bundle-generator from src/index.ts, package.json "build:types")',
    exports: extractSurface(dtsText),
  };
}

function parityDiff(baseline, report) {
  if (baseline.format !== SURFACE_FORMAT) fail(`baseline format mismatch: ${baseline.format}`);
  const baseByName = new Map(baseline.exports.map((e) => [e.name, e]));
  const oursByName = new Map(report.exports.map((e) => [e.name, e]));

  const removed = [...baseByName.keys()].filter((n) => !oursByName.has(n));
  const added = [...oursByName.keys()].filter((n) => !baseByName.has(n));
  const changed = [];
  for (const [name, b] of baseByName) {
    const o = oursByName.get(name);
    if (!o || b.signature === o.signature) continue;
    changed.push({
      name,
      kind: b.kind,
      upstream: b.signature,
      ours: o.signature,
      referenceOnly: normalizeSig(b.signature) === normalizeSig(o.signature),
    });
  }
  return { removed, added, changed };
}

function printReport(diff, report) {
  console.log(`api-surface report: ${report.exports.length} exports (baseline: see upstream/api-surface.json)`);
  console.log('');
  console.log(`added (port-specific, allowed): ${diff.added.length}`);
  for (const n of diff.added) console.log(`  + ${n}`);
  console.log('');
  console.log(`changed vs baseline: ${diff.changed.length}`);
  for (const c of diff.changed) {
    const why = c.referenceOnly
      ? 'compatible (import-specifier/reference resolution only)'
      : REVIEWED_DRIFT[c.name] || 'UNREVIEWED';
    console.log(`  ~ ${c.name} [${c.kind}] — ${why}`);
    if (!c.referenceOnly) {
      console.log(`      upstream: ${c.upstream}`);
      console.log(`      ours:     ${c.ours}`);
    }
  }
  console.log('');
  console.log(`removed (breaking): ${diff.removed.length}`);
  for (const n of diff.removed) console.log(`  - ${n}`);
  return {
    breaking: diff.removed.length > 0,
    unreviewed: diff.changed.filter((c) => !c.referenceOnly && !REVIEWED_DRIFT[c.name]),
  };
}

const checkMode = process.argv.includes('--check');

if (!existsSync(DTS_PATH)) fail(`missing ${DTS_PATH} — run "npm run build:types" first`);
const dtsText = readFileSync(DTS_PATH, 'utf8');
const dtsSurface = extractSurface(dtsText);

let report;
if (checkMode) {
  if (!existsSync(REPORT_PATH)) fail(`missing committed report ${REPORT_PATH} — run "npm run surface:report"`);
  report = JSON.parse(readFileSync(REPORT_PATH, 'utf8'));
  const committed = JSON.stringify(report.exports);
  if (committed !== JSON.stringify(dtsSurface)) {
    fail('committed api-surface.json is out of sync with types/index.d.ts — run "npm run surface:report"');
  }
} else {
  report = buildReport(dtsText);
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`wrote ${path.relative(ROOT, REPORT_PATH)}`);
  console.log('');
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
const diff = parityDiff(baseline, report);
const verdict = printReport(diff, report);

if (verdict.breaking) fail(`parity FAILED: ${verdict.removed.length} upstream symbol(s) removed from our surface`);
if (verdict.unreviewed.length > 0) {
  fail(`parity FAILED: ${verdict.unreviewed.length} changed signature(s) without a compatible-drift justification (see above; add a REVIEWED_DRIFT verdict or fix the source)`);
}
console.log('parity OK: every upstream symbol is exported; no removals, no incompatible signature changes.');
