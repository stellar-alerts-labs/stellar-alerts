#!/usr/bin/env node
// Guards the CI typecheck/build contract for every workspace (issue #326):
//  1. every workspace under apps/* and packages/* exposes `typecheck` + `build`
//  2. the CI workflow matrix covers exactly those workspaces
//  3. all workflows agree on a single supported Node version (`.nvmrc`)
// Run with: node .github/verify-workspace-matrix.mjs
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

const rootPkg = readJson(join(repoRoot, 'package.json'));
const patterns = rootPkg.workspaces ?? [];

const workspaceDirs = [];
for (const pattern of patterns) {
  const parent = join(repoRoot, dirname(pattern));
  const prefix = pattern.split('/').pop();
  if (!existsSync(parent)) continue;
  for (const entry of readdirSync(parent)) {
    const dir = join(parent, entry);
    if (prefix !== '*' && entry !== prefix) continue;
    if (!statSync(dir).isDirectory()) continue;
    if (existsSync(join(dir, 'package.json'))) {
      workspaceDirs.push(relative(repoRoot, dir).replaceAll('\\', '/'));
    }
  }
}

for (const workspace of workspaceDirs) {
  const pkg = readJson(join(repoRoot, workspace, 'package.json'));
  for (const script of ['typecheck', 'build']) {
    if (!pkg.scripts?.[script]) {
      failures.push(`${workspace} is missing the "${script}" script`);
    }
  }
}

const ciPath = join(repoRoot, '.github', 'workflows', 'ci.yml');
const ci = readFileSync(ciPath, 'utf8');
const matrixWorkspaces = [...ci.matchAll(/^\s*(?:-\s*)?workspace:\s*([^\s#]+)\s*$/gm)].map(
  (match) => match[1].replace(/^['"]|['"]$/g, ''),
);

const uncovered = workspaceDirs.filter((dir) => !matrixWorkspaces.includes(dir));
const unknown = matrixWorkspaces.filter((dir) => !workspaceDirs.includes(dir));
if (uncovered.length > 0) {
  failures.push(`CI matrix does not typecheck/build: ${uncovered.join(', ')}`);
}
if (unknown.length > 0) {
  failures.push(`CI matrix references non-workspaces: ${unknown.join(', ')}`);
}

const nvmrcPath = join(repoRoot, '.nvmrc');
if (!existsSync(nvmrcPath)) {
  failures.push('missing .nvmrc (single supported Node version)');
} else if (!ci.includes("node-version-file: '.nvmrc'")) {
  failures.push("ci.yml must pin Node via node-version-file: '.nvmrc'");
}

const workflowsDir = join(repoRoot, '.github', 'workflows');
for (const file of readdirSync(workflowsDir)) {
  const body = readFileSync(join(workflowsDir, file), 'utf8');
  if (/^\s*node-version:\s/m.test(body)) {
    failures.push(`${file} hardcodes node-version; use node-version-file: '.nvmrc'`);
  }
}

if (failures.length > 0) {
  console.error('CI workspace matrix contract failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `CI workspace matrix contract OK: ${workspaceDirs.join(', ')} ` +
    `(Node ${readFileSync(nvmrcPath, 'utf8').trim()})`,
);
