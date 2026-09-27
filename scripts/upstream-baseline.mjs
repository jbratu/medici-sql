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
  short,
  writeProvenance,
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

  const specFiles = scanSpecTree(tmp);
  const rows = {};
  for (const [rel, info] of Object.entries(specFiles)) rows[rel] = { sha256: info.sha, itCount: info.titles.length };
  writeProvenance(newSha, rows);
  process.stdout.write(`regenerated spec/UPSTREAM_PROVENANCE.md (${Object.keys(rows).length} files, ${Object.values(rows).reduce((a, r) => a + r.itCount, 0)} it() total)\n`);

  npmCiIfStale(tmp);
  const dts = buildUpstreamTypes(tmp);
  const surface = {
    format: SURFACE_FORMAT,
    upstream: { remote: UPSTREAM_REMOTE, sha: newSha, ref: 'upstream/master' },
    source: 'types/index.d.ts (dts-bundle-generator from src/index.ts, upstream package.json "build:types")',
    exports: extractSurface(dts),
  };
  writeFileSync(path.join(ROOT, 'upstream', 'api-surface.json'), JSON.stringify(surface, null, 2) + '\n');
  process.stdout.write(`regenerated upstream/api-surface.json (${surface.exports.length} exports)\n`);

  writeFileSync(pinPath, newSha + '\n');
  process.stdout.write(`updated upstream/PINNED_SHA: ${oldPin ? `${short(oldPin)} -> ${short(newSha)}` : short(newSha)}\n`);

  process.stdout.write('\nReminder: triage any unclassified specs into TEST_COMPAT_MATRIX.md (tier + rationale) BEFORE committing.\n');
  process.stdout.write('Commit matrix + verbatim copies + provenance + api-surface.json + PINNED_SHA in ONE commit.\n\n');
  process.stdout.write('Running upstream:check --full against the new SHA...\n\n');
  const exitCode = await runCheck({ ref: newSha, full: true });
  process.exit(exitCode);
} catch (err) {
  die(`baseline failed: ${err.stack || err.message}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
