import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

export const DEFAULT_SOURCE_ROOTS = ['apps', 'packages'];
export const BASELINE_PATH = 'quality/no-new-any-baseline.json';

export interface AnyOccurrence {
  fingerprint: string;
  line: number;
  column: number;
  kind: 'cast' | 'type';
  source: string;
}

export interface BaselineException {
  file: string;
  owner: string;
  reason: string;
  fingerprints: string[];
}

export interface AnyBaseline {
  version: 1;
  exceptions: BaselineException[];
}

export interface PolicyResult {
  errors: string[];
  occurrenceCount: number;
}

function isProductionTypeScript(filePath: string): boolean {
  const normalized = filePath.split(path.sep).join('/');
  return (
    /\/src\/.*\.tsx?$/.test(`/${normalized}`) &&
    !/\.(?:test|spec)\.tsx?$/.test(normalized) &&
    !normalized.includes('/__tests__/') &&
    !normalized.includes('/generated/') &&
    !normalized.endsWith('.d.ts')
  );
}

async function collectFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const files = await Promise.all(
    entries.map((entry) => {
      const entryPath = path.join(directory, entry.name);
      return entry.isDirectory() ? collectFiles(entryPath) : Promise.resolve([entryPath]);
    }),
  );
  return files.flat();
}

function occurrenceKind(node: ts.KeywordTypeNode): AnyOccurrence['kind'] {
  const parent = node.parent;
  return (ts.isAsExpression(parent) || ts.isTypeAssertionExpression(parent)) && parent.type === node
    ? 'cast'
    : 'type';
}

function sourceContext(node: ts.KeywordTypeNode, sourceFile: ts.SourceFile): string {
  let context: ts.Node = node.parent;
  while (
    context.parent &&
    !ts.isStatement(context) &&
    !ts.isPropertySignature(context) &&
    !ts.isParameter(context) &&
    !ts.isTypeAliasDeclaration(context)
  ) {
    context = context.parent;
  }
  return context.getText(sourceFile).replace(/\s+/g, ' ').trim();
}

/** Finds explicit `any` keywords in TypeScript source using the compiler AST. */
export function scanSource(source: string, file = 'source.ts'): AnyOccurrence[] {
  const scriptKind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind);
  const occurrences: AnyOccurrence[] = [];
  const fingerprintCounts = new Map<string, number>();

  function visit(node: ts.Node): void {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      const anyNode = node as ts.KeywordTypeNode;
      const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const kind = occurrenceKind(anyNode);
      const context = sourceContext(anyNode, sourceFile);
      const digest = createHash('sha256').update(`${kind}:${context}`).digest('hex').slice(0, 16);
      const duplicateIndex = fingerprintCounts.get(digest) ?? 0;
      fingerprintCounts.set(digest, duplicateIndex + 1);
      occurrences.push({
        fingerprint: `${digest}:${duplicateIndex}`,
        line: location.line + 1,
        column: location.character + 1,
        kind,
        source: context.slice(0, 200),
      });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return occurrences;
}

/** Scans production source under app and package workspaces, excluding tests and generated files. */
export async function scanProductionAny(
  repositoryRoot: string,
  sourceRoots = DEFAULT_SOURCE_ROOTS,
): Promise<Map<string, AnyOccurrence[]>> {
  const candidates = (await Promise.all(sourceRoots.map((root) => collectFiles(path.join(repositoryRoot, root)))))
    .flat()
    .filter(isProductionTypeScript)
    .sort();
  const findings = new Map<string, AnyOccurrence[]>();

  for (const absolutePath of candidates) {
    const source = await fs.readFile(absolutePath, 'utf8');
    const occurrences = scanSource(source, absolutePath);
    if (occurrences.length > 0) {
      findings.set(path.relative(repositoryRoot, absolutePath).split(path.sep).join('/'), occurrences);
    }
  }
  return findings;
}

export function createBaseline(
  findings: Map<string, AnyOccurrence[]>,
  previous?: AnyBaseline,
): AnyBaseline {
  const previousByFile = new Map(previous?.exceptions.map((exception) => [exception.file, exception]));
  return {
    version: 1,
    exceptions: [...findings.entries()].map(([file, occurrences]) => {
      const existing = previousByFile.get(file);
      return {
        file,
        owner: existing?.owner ?? 'stellar-alerts-maintainers',
        reason: existing?.reason ?? 'Pre-existing explicit any debt recorded for incremental removal.',
        fingerprints: occurrences.map((occurrence) => occurrence.fingerprint),
      };
    }),
  };
}

/** Compares current findings with the owned baseline and reports additions or stale exceptions. */
export function checkPolicy(findings: Map<string, AnyOccurrence[]>, baseline: AnyBaseline): PolicyResult {
  const errors: string[] = [];
  const baselineByFile = new Map<string, BaselineException>();

  if (baseline.version !== 1 || !Array.isArray(baseline.exceptions)) {
    return { errors: ['Baseline must use version 1 and contain an exceptions array.'], occurrenceCount: 0 };
  }

  for (const exception of baseline.exceptions) {
    if (
      !exception.file ||
      !exception.owner?.trim() ||
      !exception.reason?.trim() ||
      !Array.isArray(exception.fingerprints)
    ) {
      errors.push(`Baseline exception ${exception.file || '<unknown>'} must include an owner, reason, and fingerprints.`);
      continue;
    }
    if (baselineByFile.has(exception.file)) errors.push(`Duplicate baseline exception for ${exception.file}.`);
    baselineByFile.set(exception.file, exception);
  }

  for (const [file, occurrences] of findings) {
    const exception = baselineByFile.get(file);
    const allowed = new Set(exception?.fingerprints);
    for (const occurrence of occurrences) {
      if (!allowed.has(occurrence.fingerprint)) {
        errors.push(
          `${file}:${occurrence.line}:${occurrence.column} new explicit any (${occurrence.kind}, ${occurrence.fingerprint}): ${occurrence.source}`,
        );
      }
    }
  }

  for (const exception of baseline.exceptions) {
    const current = new Set(findings.get(exception.file)?.map((item) => item.fingerprint));
    for (const fingerprint of exception.fingerprints) {
      if (!current.has(fingerprint)) {
        errors.push(`${exception.file} has a stale baseline occurrence ${fingerprint}; regenerate the baseline.`);
      }
    }
  }

  return {
    errors,
    occurrenceCount: [...findings.values()].reduce((total, occurrences) => total + occurrences.length, 0),
  };
}

async function readBaseline(filePath: string): Promise<AnyBaseline | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as AnyBaseline;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function run(repositoryRoot: string, update = false): Promise<boolean> {
  const baselinePath = path.join(repositoryRoot, BASELINE_PATH);
  const findings = await scanProductionAny(repositoryRoot);
  const baseline = await readBaseline(baselinePath);

  if (update) {
    const additions = baseline
      ? checkPolicy(findings, baseline).errors.filter((error) => error.includes(' new explicit any '))
      : [];
    if (additions.length > 0) {
      console.error(
        `[no-new-any] Refusing to expand the baseline. Document approved exceptions manually:\n${additions.join('\n')}`,
      );
      return false;
    }
    const nextBaseline = createBaseline(findings, baseline);
    await fs.writeFile(baselinePath, `${JSON.stringify(nextBaseline, null, 2)}\n`, 'utf8');
    console.log(`[no-new-any] Recorded ${nextBaseline.exceptions.length} files in ${BASELINE_PATH}.`);
    return true;
  }
  if (!baseline) {
    console.error(`[no-new-any] Missing ${BASELINE_PATH}. Run npm run quality:any:update.`);
    return false;
  }

  const result = checkPolicy(findings, baseline);
  if (result.errors.length > 0) {
    console.error(`[no-new-any] Policy failed with ${result.errors.length} difference(s):\n${result.errors.join('\n')}`);
    return false;
  }
  console.log(`[no-new-any] ${result.occurrenceCount} existing explicit any occurrence(s); no new production any.`);
  return true;
}

async function main(): Promise<void> {
  const success = await run(process.cwd(), process.argv.includes('--update'));
  if (!success) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error('[no-new-any] Failed:', error);
    process.exitCode = 1;
  });
}
