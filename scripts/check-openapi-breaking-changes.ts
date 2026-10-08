#!/usr/bin/env node

/**
 * OpenAPI breaking-change detection for pull requests (issue #457).
 *
 * Diffs the generated `openapi.json` on the current (PR) branch against the
 * version on the base branch (default `main`) using `openapi-diff` (the
 * Atlassian/Microsoft-maintained diff engine behind the
 * openapi-diff/openapi-diff-action GitHub Action) and fails with a
 * human-readable report when the change introduces breaking differences.
 *
 * Two layers of detection:
 *
 * 1. `openapi-diff` classifies changes to `paths` (removed paths/methods,
 *    narrowed response bodies, removed required headers/status codes, …).
 * 2. A complementary analyzer for `components.schemas` — the only section
 *    this repo's generated spec currently populates (no routes register
 *    per-route schemas yet, see docs/type-generation.md) — which
 *    `openapi-diff` does not classify at all. It flags removed schemas,
 *    removed properties, newly-required properties, removed enum values and
 *    changed property types, recursively.
 *
 * A breaking change fails the check (exit 1) *unless* the PR also bumps the
 * OpenAPI `info.version` (semver greater than base). A version bump in the
 * committed spec is a deliberate, reviewable act — that is the documented
 * escape hatch for intentional contract changes; everything else is treated
 * as accidental and blocked.
 *
 * Usage:
 *   npm run openapi:check:breaking
 *   npx tsx scripts/check-openapi-breaking-changes.ts --base <ref> [--spec <file>]
 *
 * Exit codes:
 *   0 — no unacknowledged breaking changes (or nothing to compare against yet)
 *   1 — breaking changes detected
 *   2 — internal error (missing/unparseable spec, diff engine failure)
 *
 * The generated `openapi.json` at the repo root is produced by
 * `npm run generate:types` from `apps/api/src/openapi.config.ts`. This script
 * only reads it — it never regenerates it — so CI compares exactly the spec
 * files as they exist in the two git trees, rather than a rebuild that could
 * mask an un-committed regeneration.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
// `openapi-diff` is CommonJS with `export =`; use createRequire so the ESM
// tsx runtime can load it while keeping the package's own typings.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const openApiDiff = require('openapi-diff') as typeof import('openapi-diff');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface CheckOpenApiBreakingChangesArgs {
  /** Git ref to diff against (default: `main`). */
  baseRef?: string;
  /** Path to the spec file, relative to the repo root (default: `openapi.json`). */
  specPath?: string;
  /**
   * Read the base spec from a file instead of `git show`.
   * Used by CI (which snapshots the base commit into a temp file) and tests.
   */
  basePath?: string;
  /**
   * Read the head (current) spec from this file instead of
   * `<repoRoot>/<specPath>`. Used by tests. Relative paths resolve against
   * the repo root.
   */
  headPath?: string;
}

export interface BreakingCheckResult {
  /** `true` when any breaking difference was found (openapi-diff or schema analyzer). */
  breaking: boolean;
  /**
   * `true` when breaking changes exist but the OpenAPI `info.version` was
   * bumped above the base version — the documented, deliberate opt-out.
   */
  acknowledgedByVersionBump: boolean;
  /** Human-readable multi-line report for CI logs and the job summary. */
  report: string;
  /** `true` when the base ref (or base file) had no spec to compare. */
  baseSpecMissing: boolean;
  /** Breaking changes found by the component-schema analyzer. */
  schemaBreakingChanges: SchemaBreakingChange[];
}

export interface SpecSummary {
  paths: number;
  schemas: number;
  version: string | null;
}

export interface SchemaBreakingChange {
  /** Stable machine code, e.g. `schema.property.removed`. */
  code: string;
  /** Component schema name, e.g. `CreateWalletInput`. */
  schema: string;
  /** Dotted location inside the spec, e.g. `components.schemas.CreateWalletInput.properties.label`. */
  location: string;
  /** Human explanation of why this breaks consumers. */
  detail: string;
}

interface DiffEntityDetails {
  code: string;
  entity: string;
  action: string;
  sourceSpecEntityDetails: Array<{ location: string }>;
  destinationSpecEntityDetails: Array<{ location: string }>;
}

const DEFAULT_BASE_REF = 'main';
const DEFAULT_SPEC_PATH = 'openapi.json';

/** Reads and parses a JSON OpenAPI spec from disk. */
export async function readSpec(
  filePath: string
): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      throw new Error(
        `Spec file not found: ${filePath}. Run \`npm run generate:types\` and commit the result.`
      );
    }
    throw new Error(`Failed to read spec file ${filePath}: ${String(err)}`);
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(
      `Spec file ${filePath} is not valid JSON. Run \`npm run generate:types\` and commit the result.`
    );
  }
}

/**
 * Reads the spec as it exists on the base ref via `git show <ref>:<path>`.
 * Returns `null` for expected not-found situations (spec absent on the base
 * ref — first commit of the spec, brand-new forks — or an unknown ref in a
 * shallow checkout) and rethrows any other git failure.
 */
export function readBaseSpecFromGit(
  baseRef: string,
  specPath: string
): string | null {
  try {
    return execFileSync('git', ['show', `${baseRef}:${specPath}`], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024, // generous for an OpenAPI document
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const isExpectedMiss =
      message.includes('does not exist') || // path absent on ref
      message.includes('but not in') || // object exists on disk but not on ref
      message.includes('unknown revision') ||
      message.includes('bad revision') ||
      message.includes('exit code 128');
    if (isExpectedMiss) return null;
    throw new Error(`git show ${baseRef}:${specPath} failed: ${message}`);
  }
}

/** Small summary used for context lines in the report. */
export function summarizeSpec(spec: Record<string, unknown>): SpecSummary {
  const paths = spec.paths as Record<string, unknown> | undefined;
  const components = spec.components as
    | { schemas?: Record<string, unknown> }
    | undefined;
  const info = spec.info as { version?: unknown } | undefined;
  return {
    paths: paths ? Object.keys(paths).length : 0,
    schemas: components?.schemas ? Object.keys(components.schemas).length : 0,
    version: typeof info?.version === 'string' ? info.version : null,
  };
}

/**
 * Compares two dot-separated semver strings numerically.
 * Returns a positive number when `a > b`, negative when `a < b`, 0 when equal
 * (including when either side is missing or unparseable — "no bump").
 */
export function compareSemver(a: string | null, b: string | null): number {
  const parse = (v: string | null): number[] | null => {
    if (!v) return null;
    const parts = v.trim().replace(/^v/i, '').split('.');
    if (!parts.every((p) => /^\d+$/.test(p))) return null;
    return parts.map(Number);
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True for a schema whose only meaning is `type: 'null'`. */
function isNullSchema(node: unknown): boolean {
  return (
    isRecord(node) &&
    node.type === 'null' &&
    Object.keys(node).every((key) => key === 'type')
  );
}

/**
 * Returns a deep copy of `spec` rewritten so a strict OpenAPI 3.0 validator can
 * parse it. `openapi-diff`'s swagger-parser validates every document it is
 * handed against the OpenAPI 3.0 meta-schema and hard-fails the whole diff
 * (`JSON_OBJECT_VALIDATION_FAILED`) when it meets a construct 3.0 does not
 * define, aborting the check before any comparison happens.
 *
 * The committed `openapi.json` is generated from Zod, which emits two
 * JSON-Schema constructs that OpenAPI 3.0 has no equivalent syntax for:
 *
 * - `propertyNames: { type: 'string' }` on `z.record(...)` — redundant, since
 *   object keys are always strings and the value schema is already carried by
 *   `additionalProperties`.
 * - nullability as `anyOf: [X, { type: 'null' }]` (or a `type` list containing
 *   `'null'`) — the 3.0 spelling is `nullable: true` on the schema itself.
 *
 * Both are rewritten here, on the copies handed to `openapi-diff` only; the
 * raw specs still drive `analyzeComponentSchemas` and the report, so this never
 * hides a real breaking change. OpenAPI 3.1 supports the full JSON Schema
 * vocabulary, so specs declaring it are returned untouched.
 */
export function normalizeSpecForOpenApiDiff(
  spec: Record<string, unknown>
): Record<string, unknown> {
  const version = typeof spec.openapi === 'string' ? spec.openapi : '';
  if (!version.startsWith('3.0')) return spec;

  const clone = structuredClone(spec);

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!isRecord(node)) return;

    // OpenAPI 3.0 has no `propertyNames` keyword.
    delete node.propertyNames;

    // `anyOf`/`oneOf` with a `{ type: 'null' }` branch means "nullable".
    for (const key of ['anyOf', 'oneOf']) {
      const branches = node[key];
      if (!Array.isArray(branches)) continue;
      const kept = branches.filter((branch) => !isNullSchema(branch));
      if (kept.length === branches.length) continue;
      node[key] = kept;
      node.nullable = true;
      // A single remaining branch with no sibling keywords collapses cleanly
      // onto the parent, matching how the 3.0 generator emits nullable schemas.
      if (
        kept.length === 1 &&
        Object.keys(node).every((k) => k === key || k === 'nullable')
      ) {
        Object.assign(node, kept[0]);
        delete node[key];
      }
    }

    // `type: ['string', 'null']` means the same thing.
    if (Array.isArray(node.type)) {
      const types = node.type.filter((type) => type !== 'null');
      if (types.length !== node.type.length) {
        node.nullable = true;
        if (types.length === 0) delete node.type;
        else node.type = types;
      }
    }

    for (const value of Object.values(node)) visit(value);
  };

  visit(clone);
  return clone;
}

/** Recursively flags breaking changes between two component-schema definitions. */
function diffSchemaNode(
  base: unknown,
  head: unknown,
  schemaName: string,
  location: string,
  out: SchemaBreakingChange[]
): void {
  if (!isRecord(base) || !isRecord(head)) return;

  // `type` changed (e.g. string → integer): generated client types change
  // shape and serialized payloads are reinterpreted — breaking.
  if (
    typeof base.type === 'string' &&
    typeof head.type === 'string' &&
    base.type !== head.type
  ) {
    out.push({
      code: 'schema.type.changed',
      schema: schemaName,
      location,
      detail: `type changed from "${base.type}" to "${head.type}"`,
    });
    return; // subtrees are no longer comparable
  }

  // Enum values removed: clients sending/accepting the removed value break.
  if (Array.isArray(base.enum) && Array.isArray(head.enum)) {
    const headEnum: unknown[] = head.enum;
    const removed = base.enum.filter((v) => !headEnum.includes(v));
    if (removed.length > 0) {
      out.push({
        code: 'schema.enum.value.removed',
        schema: schemaName,
        location,
        detail: `enum value(s) removed: ${removed.map((v) => JSON.stringify(v)).join(', ')}`,
      });
    }
  }

  // Properties removed from an object schema: request payloads with those
  // fields no longer round-trip and generated types lose members.
  const baseProps = isRecord(base.properties) ? base.properties : {};
  const headProps = isRecord(head.properties) ? head.properties : {};
  for (const [prop, baseProp] of Object.entries(baseProps)) {
    if (!(prop in headProps)) {
      out.push({
        code: 'schema.property.removed',
        schema: schemaName,
        location: `${location}.properties.${prop}`,
        detail: `property "${prop}" was removed`,
      });
      continue;
    }
    diffSchemaNode(
      baseProp,
      headProps[prop],
      schemaName,
      `${location}.properties.${prop}`,
      out
    );
  }

  // Newly required properties: previously-optional inputs become mandatory,
  // breaking existing request builders.
  const baseRequired = Array.isArray(base.required) ? base.required : [];
  const headRequired = Array.isArray(head.required) ? head.required : [];
  for (const req of headRequired) {
    if (!baseRequired.includes(req)) {
      out.push({
        code: 'schema.required.added',
        schema: schemaName,
        location: `${location}.required`,
        detail: `"${String(req)}" became required`,
      });
    }
  }
}

/**
 * Breaking-change rules for `components.schemas`, which `openapi-diff` does
 * not classify (verified against openapi-diff@0.24.1: schema-only changes
 * produce zero differences). Only breaking directions are reported — adding
 * schemas, properties or enum values is additive and allowed.
 */
export function analyzeComponentSchemas(
  baseSpec: Record<string, unknown>,
  headSpec: Record<string, unknown>
): SchemaBreakingChange[] {
  const baseSchemas =
    (baseSpec.components as { schemas?: Record<string, unknown> } | undefined)
      ?.schemas ?? {};
  const headSchemas =
    (headSpec.components as { schemas?: Record<string, unknown> } | undefined)
      ?.schemas ?? {};

  const out: SchemaBreakingChange[] = [];

  for (const [name, baseSchema] of Object.entries(baseSchemas)) {
    const location = `components.schemas.${name}`;
    const headSchema = headSchemas[name];
    if (headSchema === undefined) {
      out.push({
        code: 'schema.removed',
        schema: name,
        location,
        detail: 'schema was removed entirely',
      });
      continue;
    }
    diffSchemaNode(baseSchema, headSchema, name, location, out);
  }

  return out;
}

/** One-line-per-concern formatting for a single openapi-diff difference. */
function formatDiffDetails(diff: DiffEntityDetails): string {
  const sourceLoc =
    diff.sourceSpecEntityDetails?.[0]?.location ?? '(not present before)';
  const destLoc =
    diff.destinationSpecEntityDetails?.[0]?.location ?? '(not present after)';
  return [
    `    [${diff.code}] ${diff.entity} ${diff.action}`,
    `        before: ${sourceLoc}`,
    `        after:  ${destLoc}`,
  ].join('\n');
}

function formatSchemaChange(change: SchemaBreakingChange): string {
  return `    [${change.code}] ${change.location}\n        ${change.detail}`;
}

function buildReport(parts: {
  specPath: string;
  baseRef: string;
  before: SpecSummary;
  after: SpecSummary;
  breakingDiffs: DiffEntityDetails[];
  unclassifiedDiffs: DiffEntityDetails[];
  nonBreakingDiffs: DiffEntityDetails[];
  schemaBreakingChanges: SchemaBreakingChange[];
  acknowledgedByVersionBump: boolean;
}): string {
  const {
    specPath,
    baseRef,
    before,
    after,
    breakingDiffs,
    unclassifiedDiffs,
    nonBreakingDiffs,
    schemaBreakingChanges,
    acknowledgedByVersionBump,
  } = parts;

  const lines: string[] = [];

  lines.push(`OpenAPI breaking-change check: ${specPath}`);
  lines.push(`Base: ${baseRef} → Head: current working tree`);
  lines.push(
    `Spec before: ${before.paths} paths, ${before.schemas} component schemas` +
      (before.version ? `, version ${before.version}` : '')
  );
  lines.push(
    `Spec after:  ${after.paths} paths, ${after.schemas} component schemas` +
      (after.version ? `, version ${after.version}` : '')
  );

  const hasBreaking =
    breakingDiffs.length > 0 || schemaBreakingChanges.length > 0;

  if (breakingDiffs.length > 0) {
    lines.push('');
    lines.push(
      `❌ ${breakingDiffs.length} breaking path/response ${breakingDiffs.length === 1 ? 'change' : 'changes'} detected by openapi-diff:`
    );
    for (const diff of breakingDiffs) {
      lines.push(formatDiffDetails(diff));
    }
  }

  if (schemaBreakingChanges.length > 0) {
    lines.push('');
    lines.push(
      `❌ ${schemaBreakingChanges.length} breaking component-schema ${schemaBreakingChanges.length === 1 ? 'change' : 'changes'} detected:`
    );
    for (const change of schemaBreakingChanges) {
      lines.push(formatSchemaChange(change));
    }
  }

  if (hasBreaking) {
    lines.push('');
    if (acknowledgedByVersionBump) {
      lines.push(
        `⚠️  Breaking changes acknowledged by an OpenAPI info.version bump (${String(
          before.version
        )} → ${String(after.version)}). Make sure the migration is documented for API consumers.`
      );
    } else {
      lines.push(
        'These changes would break existing API consumers. Either revert them, or, if the change is intentional, bump the OpenAPI `info.version` in apps/api/src/openapi.config.ts and run `npm run generate:types` (document the migration for consumers).'
      );
    }
  }

  if (unclassifiedDiffs.length > 0) {
    lines.push('');
    lines.push(
      `⚠️ ${unclassifiedDiffs.length} unclassified ${unclassifiedDiffs.length === 1 ? 'difference' : 'differences'} (review manually):`
    );
    for (const diff of unclassifiedDiffs) {
      lines.push(formatDiffDetails(diff));
    }
  }

  if (nonBreakingDiffs.length > 0) {
    lines.push('');
    lines.push(
      `✅ ${nonBreakingDiffs.length} non-breaking ${nonBreakingDiffs.length === 1 ? 'change' : 'changes'}:`
    );
    for (const diff of nonBreakingDiffs) {
      lines.push(`    ${diff.entity} ${diff.action} (${diff.code})`);
    }
  }

  if (
    !hasBreaking &&
    unclassifiedDiffs.length === 0 &&
    nonBreakingDiffs.length === 0
  ) {
    lines.push('');
    lines.push('✅ No API contract changes detected.');
  }

  return lines.join('\n');
}

/**
 * Recursively converts OpenAPI 3.1 / JSON Schema Draft-07 constructs (such as `propertyNames`
 * and `{ anyOf: [..., { type: 'null' }] }` or `type: 'null'`) into OpenAPI 3.0-compatible
 * forms so `openapi-diff`'s OpenAPI 3.0 schema validator doesn't reject valid specs.
 */
export function sanitizeSpecForDiff(spec: unknown): unknown {
  if (spec === null || typeof spec !== 'object') {
    return spec;
  }
  if (Array.isArray(spec)) {
    return spec.map(sanitizeSpecForDiff);
  }

  const obj = spec as Record<string, unknown>;

  // Check for anyOf / oneOf containing { type: 'null' }
  for (const unionKey of ['anyOf', 'oneOf'] as const) {
    if (Array.isArray(obj[unionKey])) {
      const union = obj[unionKey] as unknown[];
      const hasNull = union.some(
        (s) => s && typeof s === 'object' && (s as Record<string, unknown>).type === 'null'
      );
      if (hasNull) {
        const nonNulls = union.filter(
          (s) => !s || typeof s !== 'object' || (s as Record<string, unknown>).type !== 'null'
        );
        const rest: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj)) {
          if (k !== unionKey && k !== 'propertyNames') {
            rest[k] = sanitizeSpecForDiff(v);
          }
        }
        if (nonNulls.length === 1 && nonNulls[0] && typeof nonNulls[0] === 'object') {
          const unwrapped = sanitizeSpecForDiff(nonNulls[0]) as Record<string, unknown>;
          return {
            ...rest,
            ...unwrapped,
            nullable: true,
          };
        } else {
          return {
            ...rest,
            [unionKey]: nonNulls.map(sanitizeSpecForDiff),
            nullable: true,
          };
        }
      }
    }
  }

  // Handle type: 'null'
  if (obj.type === 'null') {
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k !== 'type' && k !== 'propertyNames') {
        rest[k] = sanitizeSpecForDiff(v);
      }
    }
    return {
      ...rest,
      nullable: true,
    };
  }

  // Handle type: ['string', 'null']
  if (Array.isArray(obj.type)) {
    const types = obj.type.filter((t) => t !== 'null');
    const nullable = obj.type.includes('null');
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k !== 'type' && k !== 'propertyNames') {
        rest[k] = sanitizeSpecForDiff(v);
      }
    }
    return {
      ...rest,
      type: types.length === 1 ? types[0] : types,
      ...(nullable ? { nullable: true } : {}),
    };
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'propertyNames') {
      continue;
    }
    result[key] = sanitizeSpecForDiff(value);
  }
  return result;
}

/**
 * Diffs the head spec against the base spec and returns a structured result
 * plus a human-readable report. Never throws for "breaking changes found" —
 * that is a normal outcome surfaced via `result.breaking`; it only throws for
 * internal errors (missing/unreadable specs, diff engine failure).
 */
export async function checkOpenApiBreakingChanges(
  args: CheckOpenApiBreakingChangesArgs = {}
): Promise<BreakingCheckResult> {
  const baseRef = args.baseRef ?? DEFAULT_BASE_REF;
  const specPath = args.specPath ?? DEFAULT_SPEC_PATH;

  // The script lives in <repo>/scripts, so the repo root is one level up —
  // this works regardless of the caller's cwd.
  const repoRoot = path.resolve(__dirname, '..');
  const headSpecAbsPath = args.headPath
    ? path.resolve(repoRoot, args.headPath)
    : path.resolve(repoRoot, specPath);

  const headSpec = await readSpec(headSpecAbsPath);

  // Prefer an explicit base file (CI snapshot/tests); otherwise read from git.
  let baseSpecContent: string | null;
  if (args.basePath) {
    try {
      baseSpecContent = await fs.readFile(
        path.resolve(repoRoot, args.basePath),
        'utf8'
      );
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        baseSpecContent = null;
      } else {
        throw err;
      }
    }
  } else {
    baseSpecContent = readBaseSpecFromGit(baseRef, specPath);
  }

  if (baseSpecContent === null) {
    const report = [
      `OpenAPI breaking-change check: ${specPath}`,
      `Base: ${baseRef} → Head: current working tree`,
      '',
      `ℹ️ No ${specPath} on base ref "${baseRef}" — nothing to compare yet.`,
      'This check starts comparing once the spec exists on the base branch.',
    ].join('\n');
    return {
      breaking: false,
      acknowledgedByVersionBump: false,
      report,
      baseSpecMissing: true,
      schemaBreakingChanges: [],
    };
  }

  let baseSpec: Record<string, unknown>;
  try {
    baseSpec = JSON.parse(baseSpecContent) as Record<string, unknown>;
  } catch {
    throw new Error(
      `Base spec from ${
        args.basePath ? `file ${args.basePath}` : `${baseRef}:${specPath}`
      } is not valid JSON.`
    );
  }

  // `openapi-diff` validates the specs against the OpenAPI meta-schema before
  // diffing, so hand it copies whose keywords its target version can parse.
  // The raw specs still drive the schema analyzer and the report below.
  const baseSpecForDiff = normalizeSpecForOpenApiDiff(baseSpec);
  const headSpecForDiff = normalizeSpecForOpenApiDiff(headSpec);

  let outcome: import('openapi-diff').DiffOutcome;
  try {
    outcome = (await openApiDiff.diffSpecs({
      sourceSpec: {
        content: JSON.stringify(sanitizeSpecForDiff(baseSpec)),
        location: 'base',
        format: 'openapi3',
      },
      destinationSpec: {
        content: JSON.stringify(sanitizeSpecForDiff(headSpec)),
        location: 'head',
        format: 'openapi3',
      },
    })) as import('openapi-diff').DiffOutcome;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`openapi-diff failed to compare specs: ${message}`);
  }

  const schemaBreakingChanges = analyzeComponentSchemas(baseSpec, headSpec);
  const before = summarizeSpec(baseSpec);
  const after = summarizeSpec(headSpec);
  const breakingDiffs = outcome.breakingDifferencesFound
    ? outcome.breakingDifferences
    : [];
  const acknowledgedByVersionBump =
    compareSemver(after.version, before.version) > 0;

  const report = buildReport({
    specPath,
    baseRef,
    before,
    after,
    breakingDiffs,
    unclassifiedDiffs: outcome.unclassifiedDifferences ?? [],
    nonBreakingDiffs: outcome.nonBreakingDifferences ?? [],
    schemaBreakingChanges,
    acknowledgedByVersionBump,
  });

  return {
    breaking: breakingDiffs.length > 0 || schemaBreakingChanges.length > 0,
    acknowledgedByVersionBump,
    report,
    baseSpecMissing: false,
    schemaBreakingChanges,
  };
}

function parseArgs(argv: string[]): {
  baseRef: string;
  specPath: string;
  basePath?: string;
  headPath?: string;
} {
  let baseRef = DEFAULT_BASE_REF;
  let specPath = DEFAULT_SPEC_PATH;
  let basePath: string | undefined;
  let headPath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--base') {
      baseRef = argv[++i] ?? baseRef;
    } else if (arg === '--spec') {
      specPath = argv[++i] ?? specPath;
    } else if (arg === '--base-path') {
      basePath = argv[++i];
    } else if (arg === '--head') {
      headPath = argv[++i];
    }
  }
  return { baseRef, specPath, basePath, headPath };
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(
      [
        'Usage: npx tsx scripts/check-openapi-breaking-changes.ts [options]',
        '',
        'Options:',
        '  --base <ref>       Git ref to diff against (default: main)',
        '  --spec <path>      Spec file path relative to repo root (default: openapi.json)',
        '  --base-path <path> Read the base spec from a file instead of git (used by CI and tests)',
        '  --head <path>      Read the head spec from this file instead of <repo>/<spec>',
        '  -h, --help         Show this help',
      ].join('\n')
    );
    return;
  }

  const { baseRef, specPath, basePath, headPath } = parseArgs(
    process.argv.slice(2)
  );

  try {
    const result = await checkOpenApiBreakingChanges({
      baseRef,
      specPath,
      basePath,
      headPath,
    });
    console.log(result.report);
    if (result.breaking && !result.acknowledgedByVersionBump) {
      process.exitCode = 1;
    }
  } catch (err: unknown) {
    console.error(
      `[check-openapi-breaking-changes] ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    process.exitCode = 2;
  }
}

// ESM-safe "is this the entry point" check, same pattern as
// scripts/generate-types.ts (works across POSIX and Windows paths).
const isEntrypoint =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  main().catch((err: unknown) => {
    console.error(
      `[check-openapi-breaking-changes] ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    process.exitCode = 2;
  });
}
