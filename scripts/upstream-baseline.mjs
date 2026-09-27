#!/usr/bin/env node
// medici-sql reconciliation baseline generator (ITD-98, see upstream/RECONCILING.md).
//
// Adopts a new upstream SHA as the pin:
//   1. re-copies every verbatim file (upstream/VERBATIM_FILES.txt) into the worktree,
//   2. regenerates spec/UPSTREAM_PROVENANCE.md (path | sha256 | itCount for the new spec/ tree),
//   3. rebuilds upstream/api-surface.json (dts-bundle-generator on src/index.ts at the new SHA),
//   4. writes upstream/PINNED_SHA,
//   5. runs `upstream:check --full` against the new SHA so any unclassified specs
//      or matrix violations are visible immediately.
//
// Triage unclassified specs into TEST_COMPAT_MATRIX.md BEFORE committing. The
// commit must include the matrix + verbatim copies + provenance + surface +
// PINNED_SHA together (the pin-bump audit in upstream-check.mjs enforces this).
//
// Usage: node scripts/upstream-baseline.mjs <new-sha>

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  ROOT,
  SURFACE_FORMAT,
  UPSTREAM_REMOTE,
  buildUpstreamTypes,
  copyTreeFiles,
  ensureUpstreamRemote,
  extractSurface,
  expandVerbatimFiles,
  gitOk,
  gitText,
  materialize,
  npmCiIfStale,
  readVerbatimList,
  scanSpecTree,
  sha256Text,
  short,
  SRC_PORTED_REAPPLY,
  SRC_PORTED_FILES,
  writeProvenance,
  writeSrcProvenance,
} from './lib/upstream-lib.mjs';
import { runCheck } from './upstream-check.mjs';

function die(message) {
  process.stderr.write(`upstream:baseline: ${message}\n`);
  process.exit(2);
}

const sha = process.argv[2];
if (!sha) die('usage: node scripts/upstream-baseline.mjs <new-sha>');

let newSha;
try {
  ensureUpstreamRemote();
  gitText(['fetch', 'upstream', '--quiet']);
  newSha = gitText(['rev-parse', '--verify', `${sha}^{commit}`]);
} catch (err) {
  die(`cannot resolve upstream SHA "${sha}": ${err.message}`);
}

const pinPath = path.join(ROOT, 'upstream', 'PINNED_SHA');
const oldPin = existsSync(pinPath) ? readFileSync(pinPath, 'utf8').trim() : null;

if (oldPin && oldPin !== newSha && !gitOk(['merge-base', '--is-ancestor', oldPin, newSha])) {
  die(`history rewrite: current pin ${short(oldPin)} is not an ancestor of ${short(newSha)} — reconcile manually, do not run baseline`);
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'medici-sql-baseline-'));
try {
  materialize(newSha, tmp);

  const entries = readVerbatimList();
  const files = expandVerbatimFiles(entries, tmp);
  const copied = copyTreeFiles(tmp, files);
  process.stdout.write(`re-copied ${copied}/${files.length} verbatim file(s) into the worktree\n`);

  // Re-apply the documented port deviations (ITD-94): the re-copy restores the
  // upstream bytes of ported files, but the port must keep its permitted
  // additions — see SRC_PORTED_REAPPLY in scripts/lib/upstream-lib.mjs.
  for (const [rel, line] of Object.entries(SRC_PORTED_REAPPLY)) {
    const f = path.join(ROOT, rel);
    const body = existsSync(f) ? readFileSync(f, 'utf8') : '';
    if (!body.includes(line.trim())) {
      writeFileSync(f, `${body.trimEnd() ? body.trimEnd() + '\n\n' : ''}${line}\n`);
      process.stdout.write(`re-applied ported deviation to ${rel}\n`);
    }
  }

  const specFiles = scanSpecTree(tmp);
  const rows = {};
  for (const [rel, info] of Object.entries(specFiles)) rows[rel] = { sha256: info.sha, itCount: info.titles.length };
  writeProvenance(newSha, rows);
  process.stdout.write(`regenerated spec/UPSTREAM_PROVENANCE.md (${Object.keys(rows).length} files, ${Object.values(rows).reduce((a, r) => a + r.itCount, 0)} it() total)\n`);


  // M17: regenerate the src verbatim pin-integrity table (M17) from the
  // worktree AFTER re-copy + re-apply, so ported files store their ported hash.
  const srcRows = {};
  for (const rel of files) {
    srcRows[rel] = { sha256: sha256Text(readFileSync(path.join(ROOT, rel), 'utf8')), ported: Boolean(SRC_PORTED_FILES[rel]) };
  }
  writeSrcProvenance(newSha, srcRows);
  process.stdout.write(`regenerated upstream/SRC_PROVENANCE.md (${Object.keys(srcRows).length} files)\n`);

  // Machine-readable sidecar (ITD-95 hash guard, QA M2). Preserves the
  // `replaced` section and per-file `mode` flags across re-baselines so the
  // Tier C content-replaced file stays tracked with its replacement hash.
  const sidePath = path.join(ROOT, 'spec', 'UPSTREAM_PROVENANCE.json');
  const oldSide = existsSync(sidePath) ? JSON.parse(readFileSync(sidePath, 'utf8')) : {};
  const side = {
    format: 'medici-sql/spec-upstream-provenance/v1',
    upstream: {
      remote: UPSTREAM_REMOTE,
      sha: newSha,
      ref: 'master',
      version: oldSide.upstream?.version ?? null,
    },
    files: Object.fromEntries(
      Object.entries(rows).map(([rel, r]) => [
        rel,
        { sha256: r.sha256, itCount: r.itCount, mode: oldSide.files?.[rel]?.mode ?? 'upstream' },
      ]),
    ),
    replaced: oldSide.replaced ?? {},
  };
  writeFileSync(sidePath, JSON.stringify(side, null, 2) + '\n');
  process.stdout.write(`regenerated spec/UPSTREAM_PROVENANCE.json (${Object.keys(side.files).length} files, ${Object.keys(side.replaced).length} replaced)\n`);
