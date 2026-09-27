// Shared helpers for the medici-sql upstream drift monitor (ITD-98).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const UPSTREAM_REMOTE = 'https://github.com/flash-oss/medici';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SURFACE_FORMAT = 'medici-sql/api-surface/v1';
export const REPORT_FORMAT = 'medici-sql/upstream-check/v1';

const MAX_BUFFER = 4 * 1024 * 1024 * 1024;

export function gitText(args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] }).replace(/\n$/, '');
  } catch (err) {
    if (allowFail) return null;
    throw new Error(`git ${args.join(' ')} failed: ${String(err.stderr || err.message).trim()}`);
  }
}

export function gitBuf(args) {
  return execFileSync('git', args, { cwd: ROOT, maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] });
}

export function gitOk(args) {
  try {
    execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

// CI checkouts have a fresh .git/config; make sure the upstream remote exists.
export function ensureUpstreamRemote() {
  const url = gitText(['remote', 'get-url', 'upstream'], { allowFail: true });
  if (!url || !url.trim()) gitText(['remote', 'add', 'upstream', UPSTREAM_REMOTE]);
}

// Extract a tree at <sha> into <dest> (fresh directory).
export function materialize(sha, dest) {
  mkdirSync(dest, { recursive: true });
  const tar = gitBuf(['archive', sha]);
  const tarPath = path.join(dest, '.archive.tar');
  writeFileSync(tarPath, tar);
  execFileSync('tar', ['-x', '-f', tarPath, '-C', dest]);
  rmSync(tarPath);
}

export function listFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

export function sha256Text(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function sha256File(p) {
  return sha256Text(readFileSync(p, 'utf8'));
}

// Upstream dependency tree: install without postinstall scripts (mongodb-memory-server
// downloads a binary in postinstall; the check never runs Mongo).
export function npmCiIfStale(tmp) {
  const lockPath = path.join(tmp, 'package-lock.json');
  if (!existsSync(lockPath)) throw new Error('upstream tree has no package-lock.json');
  const lockHash = sha256File(lockPath);
  const marker = path.join(tmp, '.medici-sql-nm-hash');
  const fresh =
    existsSync(path.join(tmp, 'node_modules', '.package-lock.json')) &&
    existsSync(marker) &&
    readFileSync(marker, 'utf8').trim() === lockHash;
  if (!fresh) {
    execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });
    writeFileSync(marker, lockHash);
  }
}

// Build the upstream public type surface (upstream package.json "build:types").
export function buildUpstreamTypes(tmp) {
  const bin = path.join(tmp, 'node_modules', '.bin', 'dts-bundle-generator');
  execFileSync(bin, ['-o', './types/index.d.ts', './src/index.ts', '--project', './tsconfig.types.json', '--no-check'], {
    cwd: tmp,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return readFileSync(path.join(tmp, 'types', 'index.d.ts'), 'utf8');
}

// Deterministic export list from a .d.ts bundle.
export function extractSurface(dtsText) {
  const sf = ts.createSourceFile('index.d.ts', dtsText, ts.ScriptTarget.ES2020, true);
  const printer = ts.createPrinter({ removeComments: true });
  const norm = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
  const out = [];
  const push = (name, kind, signature, extra) => out.push({ name, kind, signature: norm(signature), ...(extra || {}) });
  const print = (n) => printer.printNode(ts.EmitHint.Unspecified, n, sf);
  for (const stmt of sf.statements) {
    if (ts.isExportDeclaration(stmt)) {
      if (stmt.moduleSpecifier && !stmt.exportClause) {
        push('*', `export-from ${stmt.moduleSpecifier.text}`, `export * from ${stmt.moduleSpecifier.text}`);
        continue;
      }
      if (stmt.exportClause) {
        for (const el of stmt.exportClause.elements) {
          const name = el.name.text;
          const srcName = el.propertyName ? el.propertyName.text : name;
          push(name, name === 'default' ? 'default' : 're-export', `re-export of ${srcName}`, { source: srcName });
        }
      }
      continue;
    }
    const isExported = stmt.modifiers && stmt.modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!isExported) continue;
    if (ts.isClassDeclaration(stmt)) push(stmt.name.text, 'class', print(stmt));
    else if (ts.isFunctionDeclaration(stmt)) push(stmt.name.text, 'function', print(stmt));
    else if (ts.isInterfaceDeclaration(stmt)) push(stmt.name.text, 'interface', print(stmt));
    else if (ts.isTypeAliasDeclaration(stmt)) push(stmt.name.text, 'type', print(stmt));
    else if (ts.isEnumDeclaration(stmt)) push(stmt.name.text, 'enum', print(stmt));
    else if (ts.isModuleDeclaration(stmt)) push(stmt.name.text, 'namespace', print(stmt));
    else if (ts.isVariableStatement(stmt)) for (const d of stmt.declarationList.declarations) push(d.name.text, 'const', print(d));
    else if (ts.isImportEqualsDeclaration(stmt)) push(stmt.name.text, 'import-alias', print(stmt));
    else push('(statement)', 'statement', print(stmt));
  }
  return out;
}

// it()/fit()/xit() titles from a spec file. Non-literal first args are reported as
// `(dynamic: <arg>)` so they still get tracked (one exists upstream: spec/handleVoidMemo.spec.ts).
export function extractItTitles(src) {
  const titles = [];
  const re = /^\s*(?:fit|xit|it)(?:\.(?:skip|only))?\(\s*([^\n)]+?)\s*\(/gm;
  let m;
  while ((m = re.exec(src))) {
    let arg = m[1].trim().replace(/,+$/, '').trim();
    const q = arg.match(/^(['"`])(.*)\1$/s);
    titles.push(q ? q[2] : `(dynamic: ${arg})`);
  }
  return titles;
}

// Small LCS unified diff (files involved are small) with standard 3-line context hunks.
export function unifiedDiff(aText, bText, aLabel, bLabel, context = 3) {
  const a = aText.split('\n');
  const b = bText.split('\n');
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: 0, ai: i, bj: j });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ t: -1, ai: i });
      i++;
    } else {
      ops.push({ t: 1, bj: j });
      j++;
    }
  }
  while (i < n) ops.push({ t: -1, ai: i++ });
  while (j < m) ops.push({ t: 1, bj: j++ });
  // 1-based line numbers per op
  let ca = 0;
  let cb = 0;
  for (const op of ops) {
    op.aLine = ca + 1;
    op.bLine = cb + 1;
    if (op.t !== 1) ca++;
    if (op.t !== -1) cb++;
  }
  // keep only context lines near changes
  const keep = new Array(ops.length).fill(false);
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].t === 0) continue;
    for (let d = -context; d <= context; d++) {
      const q = k + d;
      if (q >= 0 && q < ops.length && ops[q].t === 0) keep[q] = true;
    }
  }
  const lines = [`--- ${aLabel}`, `+++ ${bLabel}`];
  let cur = null;
  const close = () => {
    if (!cur) return;
    lines.push(`@@ -${cur.startA},${cur.countA} +${cur.startB},${cur.countB} @@`);
    lines.push(...cur.body);
    cur = null;
  };
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    if (op.t === 0 && !keep[k]) {
      close();
      continue;
    }
    if (!cur) cur = { startA: op.aLine, startB: op.bLine, countA: 0, countB: 0, body: [] };
    if (op.t === 0) {
      cur.body.push(' ' + a[op.ai]);
      cur.countA++;
      cur.countB++;
    } else if (op.t === -1) {
      cur.body.push('-' + a[op.ai]);
      cur.countA++;
    } else {
      cur.body.push('+' + b[op.bj]);
      cur.countB++;
    }
  }
  close();
  return lines.join('\n');
}

export function short(sha) {
  return sha.slice(0, 12);
}

// ---- upstream/VERBATIM_FILES.txt ----

export function readVerbatimList() {
  const p = path.join(ROOT, 'upstream', 'VERBATIM_FILES.txt');
  if (!existsSync(p)) throw new Error('upstream/VERBATIM_FILES.txt is missing');
  return readFileSync(p, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

// Expand list entries (exact path or dir prefix ending "/") against the materialized tree.
export function expandVerbatimFiles(entries, tmp) {
  const files = new Set();
  for (const e of entries) {
    if (e.endsWith('/')) {
      const dir = path.join(tmp, e);
      if (!existsSync(dir)) continue;
      for (const f of listFiles(dir)) files.add(path.relative(tmp, f).split(path.sep).join('/'));
    } else {
      files.add(e);
    }
  }
  return [...files];
}

// ---- spec/UPSTREAM_PROVENANCE.md ----

export function parseProvenance() {
  const p = path.join(ROOT, 'spec', 'UPSTREAM_PROVENANCE.md');
  if (!existsSync(p)) return null;
  const rows = {};
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\|\s*(spec\/\S+?)\s*\|\s*([0-9a-f]{64})\s*\|\s*(\d+)\s*\|\s*$/);
    if (m) rows[m[1]] = { sha256: m[2], itCount: parseInt(m[3], 10) };
  }
  return rows;
}

export function writeProvenance(pin, rows) {
  const lines = [
    '# Upstream spec provenance',
    '',
    `Pinned upstream: [${UPSTREAM_REMOTE} @ ${pin}](https://github.com/flash-oss/medici/commit/${pin})`,
    '',
    'Generated by `npm run upstream:baseline <sha>`. Do not edit by hand — the drift monitor',
    '(`npm run upstream:check`) compares the spec/ tree of the new upstream SHA against this table.',
    '',
    '| path | sha256 | itCount |',
    '| --- | --- | --- |',
  ];
  for (const [rel, info] of Object.entries(rows).sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`| ${rel} | ${info.sha256} | ${info.itCount} |`);
  }
  lines.push('');
  mkdirSync(path.join(ROOT, 'spec'), { recursive: true });
  writeFileSync(path.join(ROOT, 'spec', 'UPSTREAM_PROVENANCE.md'), lines.join('\n'));
}

export function scanSpecTree(tmp) {
  const files = {};
  const specDir = path.join(tmp, 'spec');
  if (!existsSync(specDir)) return files;
  for (const f of listFiles(specDir)) {
    const rel = path.relative(tmp, f).split(path.sep).join('/');
    const content = readFileSync(f, 'utf8');
    files[rel] = { sha: sha256Text(content), titles: extractItTitles(content), content };
  }
  return files;
}

// ---- TEST_COMPAT_MATRIX.md ----

function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

function cleanCell(c) {
  return (c || '').replace(/^`+|`+$/g, '').trim();
}

export function parseMatrix() {
  const p = path.join(ROOT, 'TEST_COMPAT_MATRIX.md');
  if (!existsSync(p)) return null;
  const text = readFileSync(p, 'utf8');
  const budgetM = text.match(/TIER_C_BUDGET:\s*(\d+)/);
  const budget = budgetM ? parseInt(budgetM[1], 10) : 0;
  const lines = text.split('\n');
  const headerIdx = lines.findIndex((l) => /^\|/.test(l) && /\bfile\b/i.test(l) && /\btier\b/i.test(l));
  if (headerIdx === -1) return { budget, rows: [] };
  const header = splitRow(lines[headerIdx]).map((h) => cleanCell(h).toLowerCase());
  const col = (name) => header.indexOf(name);
  const cFile = col('file');
  const cTitle = col('title');
  const cKind = col('kind');
  const cTier = col('tier');
  const cRat = col('rationale');
  const cRepl = col('replacement');
  const cCi = col('client_impact');
  const rows = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l.startsWith('|')) {
      if (rows.length) break;
      continue;
    }
    if (/^\|[\s:|-]+\|$/.test(l)) continue;
    const cells = splitRow(lines[i]);
    const need = Math.max(cFile, cTitle, cTier) + 1;
    if (cFile === -1 || cTitle === -1 || cTier === -1 || cells.length < need) continue;
    rows.push({
      file: cleanCell(cells[cFile]),
      title: cleanCell(cells[cTitle]),
      kind: cKind >= 0 ? cleanCell(cells[cKind]) : '',
      tier: cleanCell(cells[cTier]),
      rationale: cRat >= 0 ? cleanCell(cells[cRat]) : '',
      replacement: cRepl >= 0 ? cleanCell(cells[cRepl]) : '',
      clientImpact: cCi >= 0 ? cleanCell(cells[cCi]) : '',
    });
  }
  return { budget, rows };
}

export function isFileLevelRow(r) {
  return !r.title || r.title === '—' || r.title === '-' || r.title === '*';
}

// Matrix integrity rules (ITD-98, plan r2 bypasses):
//  - Tier C rows need a rationale plus either a verified replacement
//    (`spec/sql/<file>.ts :: <title>` where the file exists and contains the title)
//    or `replacement: none` with a non-empty client_impact.
//  - Test-level Tier C rows count against TIER_C_BUDGET.
export function validateMatrix(matrix, findings) {
  if (!matrix) return 0;
  let cTestRows = 0;
  for (const r of matrix.rows) {
    if (!r.tier || r.tier === '—' || r.tier === '-') continue;
    if (!/^[abc]$/i.test(r.tier)) {
      findings.push(finding('matrix', 'fail', r.file || r.title, `matrix row has unknown tier "${r.tier}" (expected A, B or C)`));
      continue;
    }
    if (r.tier.toUpperCase() !== 'C') continue;
    const testRow = !isFileLevelRow(r);
    if (testRow) cTestRows++;
    const what = testRow ? `test "${r.title}" in ${r.file}` : `file ${r.file}`;
    if (!r.rationale) {
      findings.push(finding('matrix', 'fail', r.file, `Tier C row for ${what} has an empty rationale`));
      continue;
    }
    const repl = r.replacement;
    if (repl.startsWith('spec/sql/')) {
      const m = repl.match(/^spec\/sql\/(.+?)\s*::\s*(.+)$/);
      if (!m) {
        findings.push(finding('matrix', 'fail', r.file, `Tier C row for ${what}: replacement must be "spec/sql/<file>.ts :: <title>" or "none"`));
        continue;
      }
      const target = path.join(ROOT, m[1]);
      if (!existsSync(target)) {
        findings.push(finding('matrix', 'fail', r.file, `Tier C row for ${what}: replacement target ${m[1]} does not exist in the repo`));
      } else if (!readFileSync(target, 'utf8').includes(m[2])) {
        findings.push(finding('matrix', 'fail', r.file, `Tier C row for ${what}: title "${m[2]}" not found in ${m[1]}`));
      }
    } else if (!repl || repl === 'none' || repl === '—' || repl === '-') {
      if (!r.clientImpact) {
        findings.push(finding('matrix', 'fail', r.file, `Tier C row for ${what}: replacement "none" requires a non-empty client_impact`));
      }
    } else {
      findings.push(finding('matrix', 'fail', r.file, `Tier C row for ${what}: unrecognized replacement "${repl}" (use "spec/sql/<file>.ts :: <title>" or "none")`));
    }
  }
  if (cTestRows > matrix.budget) {
    findings.push(finding('matrix', 'fail', '-', `Tier C test rows (${cTestRows}) exceed TIER_C_BUDGET (${matrix.budget})`));
  }
  return cTestRows;
}

export function finding(cls, severity, file, message) {
  return { class: cls, severity, file, message };
}

export function copyTreeFiles(tmp, files) {
  let copied = 0;
  for (const f of files) {
    const src = path.join(tmp, f);
    if (!existsSync(src)) continue;
    const dest = path.join(ROOT, f);
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    copied++;
  }
  return copied;
}
