# Coverage policy and exception process

This repository treats coverage as a regression gate rather than a vanity metric. The backend package (`apps/api`) enforces package-level thresholds in Vitest and fails the CI job when coverage drops below the minimums.

## Required thresholds

- Lines: 85%
- Functions: 85%
- Branches: 80%
- Statements: 85%

The coverage configuration lives in `apps/api/vitest.config.ts` and writes the report to `apps/api/coverage/`.

## CI reporting

Every pull request runs the package coverage command and uploads the generated artifacts so reviewers can inspect the report without rerunning tests locally.

Artifact contents include:

- HTML report for interactive review
- `coverage-summary.json` for quick threshold checks
- `lcov.info` for external tooling and review dashboards

## Exclusions

The coverage gate intentionally ignores generated code, Prisma schema outputs, test files, mocks, and worker entrypoints that are not part of the product logic under test. These exclusions are configured in the Vitest coverage block and should be kept narrow and reviewed whenever new generated or infrastructure files are introduced.

## Exception process

A coverage exception is allowed only when the missing coverage is an unavoidable consequence of platform constraints, generated code, or a clearly documented integration boundary.

Each exception must be recorded in the PR description and include:

1. The package and files affected.
2. The exact reason the coverage gap exists.
3. The owner responsible for follow-up work.
4. A date the exception expires.
5. The issue or task used to remove the exception.

Exceptions are approved by a maintainer and should be time-boxed. They must not become permanent policy unless the team explicitly reaffirms the new baseline in a follow-up change.
