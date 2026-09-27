#!/usr/bin/env node
// medici-sql upstream drift monitor (ITD-98).
//
// Compares the pinned upstream SHA (upstream/PINNED_SHA) against a new ref
// (default: upstream/master) and reports three classes of drift:
//   A. Public API surface  — builds upstream types/index.d.ts at the new SHA
//      (dts-bundle-generator, same as upstream "build:types") and diffs the
//      export list against upstream/api-surface.json. Added exports are
//      additive (informational); a removed export or changed signature is
//      breaking.
//   B. Verbatim src/ files — for every path in upstream/VERBATIM_FILES.txt,
//      diffs our copy against upstream at the new SHA. "Clean fast-forward"
//      (upstream moved, our copy still == pin content) is informational:
//      re-copy via `npm run upstream:baseline <sha>`. Anything else is drift.
//   C. spec/ drift — compares the new spec/ tree against
//      spec/UPSTREAM_PROVENANCE.md. New spec files / new it()s are
//      unclassified until TEST_COMPAT_MATRIX.md has a tier+rationale row for
//      them. Changed files are diffed and their matrix rows flagged stale.
//
// Plus a git-history audit: a PINNED_SHA bump that changes spec hashes must
// include TEST_COMPAT_MATRIX.md in the same commit.
//
// Usage: node scripts/upstream-check.mjs [--ref <ref>] [--full]
//   --ref   ref to compare against the pin (default upstream/master)
//   --full  run all classes even when the ref is already at the pinned SHA
//
// Exit codes: 0 clean, 1 findings (breaking|unclassified|drift|audit|matrix),
// 2 operational error.
//
// Outputs: human-readable report on stdout; JSON summary at
// upstream-check.report.json and a markdown copy at upstream-check-report.md
// (repo root, both gitignored).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  REPORT_FORMAT,
  ROOT,
  UPSTREAM_REMOTE,
  SURFACE_FORMAT,
  buildUpstreamTypes,
  ensureUpstreamRemote,
  extractItTitles,
  extractSurface,
  expandVerbatimFiles,
  finding,
  gitOk,
  gitText,
  isFileLevelRow,
  materialize,
  npmCiIfStale,
  parseMatrix,
  parseProvenance,
  readVerbatimList,
  scanSpecTree,
  sha256Text,
  short,
  unifiedDiff,
  validateMatrix,
} from './lib/upstream-lib.mjs';

function parseArgs(argv) {
  const args = { ref: 'upstream/master', full: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--ref') args.ref = argv[++i];
    else if (argv[i] === '--full') args.full = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

function failOperational(message, state) {
  const report = {
    format: REPORT_FORMAT,
    generatedAt: new Date().toISOString(),
    upstream: state || null,
    exit: 2,
    error: message,
    findings: [],
  };
  writeFileSync(path.join(ROOT, 'upstream-check.report.json'), JSON.stringify(report, null, 2) + '\n');
  process.stderr.write(`upstream:check: OPERATIONAL ERROR: ${message}\n`);
  process.exit(2);
}

function render(state, findings, additive, cleanFF, newRecopy, changedSpec, staleRows, infos, surfaceStats, atPin) {
  const L = [];
  L.push('upstream:check report');
  L.push(`upstream: ${UPSTREAM_REMOTE}`);
  L.push(`pin:      ${state.pin}`);
  L.push(`ref:      ${state.ref} -> ${state.newSha}`);
  L.push('');
  L.push('[A] Public API surface');
  if (atPin) {
    L.push('    skipped (ref is at the pinned SHA; use --full to force the surface build)');
  } else if (surfaceStats) {
    L.push(`    ${surfaceStats.baseline} exports at pin, ${surfaceStats.now} exports at ref.`);
  }
  const surfFindings = findings.filter((f) => f.class === 'surface');
  if (surfFindings.length) for (const f of surfFindings) L.push(`    BREAKING: ${f.message}`);
  else if (surfaceStats?.check) L.push('    OK — no removed exports or changed signatures.');
  for (const a of additive) L.push(`    additive (informational): ${a}`);
  L.push('');
  L.push('[B] Verbatim src/ files');
  const verFindings = findings.filter((f) => f.class === 'verbatim');
  if (atPin) {
    L.push('    skipped (ref is at the pinned SHA)');
  } else {
    if (verFindings.length) for (const f of verFindings) L.push(`    DRIFT: ${f.message}`);
    else L.push(`    OK — ${state.verbatimChecked} file(s) match upstream (or are clean fast-forwards).`);
    for (const c of cleanFF) L.push(`    clean fast-forward: ${c}`);
    for (const c of newRecopy) L.push(`    new upstream file to re-copy: ${c}`);
  }
  L.push('');
  L.push('[C] spec/ drift');
  const specFindings = findings.filter((f) => f.class === 'spec');
  if (atPin) {
    L.push('    skipped (ref is at the pinned SHA)');
  } else {
    if (specFindings.length) for (const f of specFindings) L.push(`    UNCLASSIFIED: ${f.message}`);
    if (!specFindings.length && !changedSpec.length && !staleRows.length) L.push('    OK — no new files, no new tests, no changed tests.');
  }
  for (const c of changedSpec) {
    L.push(`    changed: ${c.file} (+${c.added.length} it(), -${c.removed.length} it())`);
    L.push(c.diff.split('\n').map((l) => `      ${l}`).join('\n'));
  }
  for (const s of staleRows) L.push(`    stale matrix rows to verify: ${s}`);
  for (const s of infos) L.push(`    ${s}`);
  L.push('');
  L.push('[D] Matrix integrity + pin-bump audit');
  const rest = findings.filter((f) => f.class === 'matrix' || f.class === 'audit');
  if (rest.length) for (const f of rest) L.push(`    ${f.severity.toUpperCase()}: ${f.message}`);
  else L.push('    OK.');
  L.push('');
  const failing = findings.length;
  if (failing === 0) L.push(`RESULT: CLEAN (0 findings — exit 0)`);
  else L.push(`RESULT: ${failing} finding(s) — exit 1`);
  L.push('');
  return L.join('\n');
}

export async function runCheck(args) {
  const state = { remote: UPSTREAM_REMOTE, pin: null, ref: args.ref, newSha: null };
  const findings = [];
  const additive = [];
  const cleanFF = [];
  const newRecopy = [];
  const changedSpec = [];
  const staleRows = [];
  const infos = [];
  let surfaceStats = null;
  let verbatimChecked = 0;

  try {
    ensureUpstreamRemote();
    gitText(['fetch', 'upstream', '--quiet']);
  } catch (err) {
    failOperational(`git fetch upstream failed: ${err.message}`, state);
  }

  const pinPath = path.join(ROOT, 'upstream', 'PINNED_SHA');
  if (!existsSync(pinPath)) failOperational('upstream/PINNED_SHA is missing — run `npm run upstream:baseline <sha>` first', state);
  const pin = readFileSync(pinPath, 'utf8').trim();
  if (!/^[0-9a-f]{40}$/.test(pin)) failOperational(`upstream/PINNED_SHA is not a full SHA: "${pin}"`, state);
  state.pin = pin;

  let newSha;
  try {
    newSha = gitText(['rev-parse', '--verify', `${args.ref}^{commit}`]);
  } catch (err) {
    failOperational(`cannot resolve ref "${args.ref}": ${err.message}`, state);
  }
  state.newSha = newSha;

  // ---- Pin-bump audit (plan r2 bypass ii) + matrix integrity: always run ----
  const pinCommit = gitText(['log', '-1', '--format=%H', '--', 'upstream/PINNED_SHA'], { allowFail: true });
  if (pinCommit) {
    const parent = gitText(['rev-parse', `${pinCommit}^`], { allowFail: true });
    if (parent) {
      const oldPinRaw = gitText(['show', `${parent}:upstream/PINNED_SHA`], { allowFail: true });
      const oldPin = oldPinRaw ? oldPinRaw.trim() : null;
      if (oldPin && oldPin !== pin && /^[0-9a-f]{40}$/.test(oldPin)) {
        const specChanged = (gitText(['diff', '--name-only', oldPin, pin, '--', 'spec/'], { allowFail: true }) ?? '').trim();
        const commitFiles = (gitText(['show', '--name-only', '--format=', pinCommit], { allowFail: true }) ?? '').split('\n');
        const matrixTouched = commitFiles.includes('TEST_COMPAT_MATRIX.md');
        if (specChanged && !matrixTouched) {
          findings.push(
            finding('audit', 'fail', '-', `PINNED_SHA was bumped ${short(oldPin)} -> ${short(pin)} in commit ${short(pinCommit)} while spec/ changed (${specChanged.split('\n').length} file(s)) but TEST_COMPAT_MATRIX.md was not updated in that commit`)
          );
        }
      }
    }
  }
  const matrix = parseMatrix();
  if (matrix) validateMatrix(matrix, findings);

  if (newSha === pin && !args.full) {
    const state2 = { ...state, verbatimChecked: 0 };
    const text = render(state2, findings, [], [], [], [], [], [], null, true);
    writeFileSync(
      path.join(ROOT, 'upstream-check.report.json'),
      JSON.stringify({ format: REPORT_FORMAT, generatedAt: new Date().toISOString(), upstream: state2, exit: findings.length ? 1 : 0, error: null, findings, note: 'ref == pin; classes A/B/C skipped' }, null, 2) + '\n'
    );
    writeFileSync(path.join(ROOT, 'upstream-check-report.md'), text);
    process.stdout.write(text);
    return findings.length ? 1 : 0;
  }

  if (!gitOk(['merge-base', '--is-ancestor', pin, newSha])) {
    failOperational(`history rewrite: pin ${short(pin)} is not an ancestor of ${short(newSha)} — the verbatim/spec baseline is invalid; reconcile manually`, state);
  }

  const tmp = mkdtempSync(path.join(os.tmpdir(), 'medici-sql-upstream-'));
  try {
    materialize(newSha, tmp);

    // ---- Class A: public API surface ----
    try {
      npmCiIfStale(tmp);
      const dts = buildUpstreamTypes(tmp);
      const newSurface = extractSurface(dts);
      const basePath = path.join(ROOT, 'upstream', 'api-surface.json');
      if (!existsSync(basePath)) {
        failOperational('upstream/api-surface.json is missing — run `npm run upstream:baseline <sha>` first', state);
      }
      const baseline = JSON.parse(readFileSync(basePath, 'utf8'));
      if (baseline.format !== SURFACE_FORMAT) failOperational(`upstream/api-surface.json has unknown format "${baseline.format}"`, state);
      const byName = new Map(newSurface.map((e) => [e.name, e]));
      const baseNames = new Set(baseline.exports.map((e) => e.name));
      for (const e of baseline.exports) {
        const n = byName.get(e.name);
        if (!n) {
          findings.push(finding('surface', 'breaking', '-', `public export removed upstream: ${e.name} (${e.kind})`));
        } else if (n.kind !== e.kind || n.signature !== e.signature) {
          findings.push(finding('surface', 'breaking', '-', `public signature changed upstream: ${e.name}\n  was: ${e.signature}\n  now: ${n.signature}`));
        }
      }
      for (const e of newSurface) {
        if (!baseNames.has(e.name)) additive.push(`new public export ${e.name} (${e.kind}) — additive, accept and note in RECONCILING history`);
      }
      surfaceStats = { check: true, baseline: baseline.exports.length, now: newSurface.length };
    } catch (err) {
      failOperational(`class A (surface build) failed: ${err.message}`, state);
    }

    // ---- Class B: verbatim src/ files ----
    const entries = readVerbatimList();
    const verbatimFiles = expandVerbatimFiles(entries, tmp);
    verbatimChecked = verbatimFiles.length;
    for (const f of verbatimFiles) {
      const tmpF = path.join(tmp, f);
      const newContent = existsSync(tmpF) ? readFileSync(tmpF, 'utf8') : null;
      const rootF = path.join(ROOT, f);
      const ours = existsSync(rootF) ? readFileSync(rootF, 'utf8') : null;
      const pinContent = gitText(['show', `${pin}:${f}`], { allowFail: true });
      if (newContent === null) {
        if (pinContent !== null) findings.push(finding('verbatim', 'drift', f, `upstream deleted ${f} (present at pin) — triage the verbatim list before bumping the pin`));
        continue;
      }
      if (ours === newContent) continue;
      if (pinContent === null && ours === null) {
        newRecopy.push(f);
        continue;
      }
      if (pinContent !== null && ours === pinContent) {
        cleanFF.push(`${f} (upstream moved it; our copy still matches the pin — re-copy with npm run upstream:baseline ${short(newSha)})`);
        continue;
      }
      findings.push(
        finding(
          'verbatim',
          'drift',
          f,
          `our copy of ${f} differs from upstream at ${short(newSha)} and is not a clean fast-forward from the pin — manual drift, review required${
            ours === null ? ' (file missing in our tree)' : ''
          }\n${unifiedDiff(ours ?? '', newContent, `ours ${f}`, `upstream ${short(newSha)} ${f}`).split('\n').map((l) => `  ${l}`).join('\n')}`
        )
      );
    }

    // ---- Class C: spec/ drift ----
    const provenance = parseProvenance();
    if (!provenance) failOperational('spec/UPSTREAM_PROVENANCE.md is missing — run `npm run upstream:baseline <sha>` first', state);
    const newFiles = scanSpecTree(tmp);
    for (const [rel, info] of Object.entries(newFiles).sort()) {
      const base = provenance[rel];
      if (!base) {
        const fileRow = matrix ? matrix.rows.find((r) => r.file === rel && isFileLevelRow(r)) : null;
        if (fileRow && fileRow.tier && fileRow.rationale) {
          infos.push(`new spec file ${rel} is covered by a matrix row (tier ${fileRow.tier})`);
        } else {
          findings.push(finding('spec', 'unclassified', rel, `new upstream spec file with no row in TEST_COMPAT_MATRIX.md — add a file-level row (tier + rationale) before bumping the pin`));
        }
        continue;
      }
      if (base.sha256 === info.sha) continue;
      const oldContent = gitText(['show', `${pin}:${rel}`], { allowFail: true }) ?? '';
      const oldTitles = extractItTitles(oldContent);
      const added = info.titles.filter((t) => !oldTitles.includes(t));
      const removed = oldTitles.filter((t) => !info.titles.includes(t));
      for (const t of added) {
        const row = matrix ? matrix.rows.find((r) => r.file === rel && r.title === t) : null;
        if (row && row.tier && row.rationale) {
          infos.push(`new it() "${t}" in ${rel} is covered by a matrix row (tier ${row.tier})`);
        } else {
          findings.push(finding('spec', 'unclassified', rel, `new it() "${t}" in ${rel} has no row in TEST_COMPAT_MATRIX.md — add a test-level row (tier + rationale) before bumping the pin`));
        }
      }
      for (const t of removed) infos.push(`upstream removed it() "${t}" from ${rel}`);
      const rowsForFile = matrix ? matrix.rows.filter((r) => r.file === rel) : [];
      if (rowsForFile.length) staleRows.push(`${rel} (${rowsForFile.length} matrix row(s) for this file may be stale — verify during triage)`);
      changedSpec.push({
        file: rel,
        added,
        removed,
        diff: unifiedDiff(oldContent, info.content, `upstream ${short(pin)} ${rel}`, `upstream ${short(newSha)} ${rel}`),
      });
    }
    for (const rel of Object.keys(provenance).sort()) {
      if (!newFiles[rel]) infos.push(`upstream removed spec file ${rel}`);
    }

    // ---- Reports ----
    state.verbatimChecked = verbatimChecked;
    const text = render(state, findings, additive, cleanFF, newRecopy, changedSpec, staleRows, infos, surfaceStats);
    const summary = {
      format: REPORT_FORMAT,
      generatedAt: new Date().toISOString(),
      upstream: state,
      exit: findings.length ? 1 : 0,
      error: null,
      counts: {
        breaking: findings.filter((f) => f.severity === 'breaking').length,
        unclassified: findings.filter((f) => f.severity === 'unclassified').length,
        drift: findings.filter((f) => f.severity === 'drift').length,
        fail: findings.filter((f) => f.severity === 'fail').length,
        total: findings.length,
      },
      findings,
      additive,
      cleanFastForwards: cleanFF,
      newFilesToRecopy: newRecopy,
      changedSpecFiles: changedSpec,
      staleMatrixRows: staleRows,
      infos,
    };
    writeFileSync(path.join(ROOT, 'upstream-check.report.json'), JSON.stringify(summary, null, 2) + '\n');
    writeFileSync(path.join(ROOT, 'upstream-check-report.md'), text);
    process.stdout.write(text);
    return findings.length ? 1 : 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`upstream:check: ${err.message}\nUsage: node scripts/upstream-check.mjs [--ref <ref>] [--full]\n`);
    process.exit(2);
  }
  runCheck(args)
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`upstream:check: unexpected error: ${err.stack || err.message}\n`);
      process.exit(2);
    });
}
