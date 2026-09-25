# CI typecheck & build contract

Every workspace in the monorepo is typechecked and built by the
`workspace-matrix` job in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml):

| Workspace | Typecheck | Build |
|---|---|---|
| `packages/shared` | `npm run typecheck --workspace=packages/shared` | `npm run build --workspace=packages/shared` |
| `packages/cli` | `npm run typecheck --workspace=packages/cli` | `npm run build --workspace=packages/cli` |
| `apps/api` | `npm run typecheck --workspace=apps/api` | `npm run build --workspace=apps/api` |
| `apps/web` | `npm run typecheck --workspace=apps/web` | `npm run build --workspace=apps/web` |

Each package declares matching `typecheck` (`tsc --noEmit`) and `build`
scripts, so the matrix is just two commands per entry. The same commands are
available from the repo root via Turborepo (`npm run typecheck`, `npm run build`);
`turbo.json` makes both depend on `^build`, so `packages/shared` is built before
its dependents.

## Supported Node version

The single supported version lives in [`.nvmrc`](../.nvmrc). Every
`actions/setup-node` step reads it with `node-version-file: '.nvmrc'` instead of
hardcoding a version. The root `engines.node` range (`>=20`) documents the same
floor.

## Keeping the matrix complete

`node .github/verify-workspace-matrix.mjs` runs in the `validate` job and
fails the build when:

- a workspace under `apps/*`/`packages/*` lacks `typecheck` or `build`;
- the CI matrix does not cover exactly the workspaces declared in the root
  `package.json`;
- a workflow hardcodes `node-version` instead of using `.nvmrc`.

Add the workspace's `typecheck`/`build` scripts and a matrix entry, then run the
guard locally with `node .github/verify-workspace-matrix.mjs`.
