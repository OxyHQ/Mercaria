# Contributing to Mercaria

Mercaria is Oxy's buy and sell marketplace: new items from shops, secondhand items from people, one commerce backend behind all of it.

**The contribution process lives in the [Oxy organisation CONTRIBUTING guide](https://github.com/OxyHQ/.github/blob/main/CONTRIBUTING.md)**: reporting an issue, filing a feature request, opening a pull request, code review, licensing. It applies here unchanged. This file layers on top of it the same way `AGENTS.md` files layer, so it is short on purpose: it carries only what is different about this repository.

## Prerequisites

- **Bun.** The package manager for every Oxy repository, never npm or yarn. The pinned version is `packageManager` in the root `package.json`, and CI installs that exact version.
- **Node.js 22.** The runtime the API is built and deployed on. CI pins it alongside bun.
- **PostgreSQL with PostGIS**, to run the API *and* its test suite — the repositories are tested against a real server, not a mock. `docker compose -f docker-compose.postgres.yml up -d postgres` starts the pinned image; the harness creates its own throwaway database on it per run.
- **Redis**, optional. Rate limiting, FX rate caching and Socket.IO scaling fall back gracefully without it.

## Setup

```bash
git clone https://github.com/OxyHQ/Mercaria.git && cd Mercaria
bun install
cp packages/backend/.env.example packages/backend/.env   # fill in your values
bun run dev                                              # every package at once
```

One package at a time, which is what you normally want with four runnable apps:

```bash
bun run dev:backend     # API only
bun run dev:frontend    # Expo storefront (runs with --clear --tunnel)
bun run dev:dashboard   # Expo merchant admin
bun run dev:pos         # Expo point of sale
```

`build:*` follows the same naming. There is no `dev:api` and no `dev:app`.

Only `packages/backend` and `packages/frontend` ship a `.env.example`. The dashboard and POS read their Oxy client ids from `EXPO_PUBLIC_OXY_CLIENT_ID_DASHBOARD` and `EXPO_PUBLIC_OXY_CLIENT_ID_POS`, which are not yet registered; see `HANDOFF.md`.

## Layout

A bun workspaces monorepo, six packages, one API serving three apps:

| Package | Path | Role |
| --- | --- | --- |
| `@mercaria/backend` | `packages/backend/` | Express API (TypeScript, PostgreSQL, Socket.IO) |
| `@mercaria/frontend` | `packages/frontend/` | Expo storefront, mercaria.co |
| `@mercaria/dashboard` | `packages/dashboard/` | Expo merchant and store admin |
| `@mercaria/pos` | `packages/pos/` | Expo point of sale |
| `@mercaria/ui` | `packages/ui/` | Shared component library |
| `@mercaria/shared-types` | `packages/shared-types/` | DTOs shared by all packages |

Two layout facts that will otherwise cost you an afternoon:

- **`@mercaria/ui` is consumed from source and has no dist.** Apps reach it through Metro `watchFolders`, the `@mercaria/ui/theme/tailwind.preset` Tailwind preset, and a `tsconfig.paths` alias. Do not add a build step, and do not copy any of its components or helpers into an app. It is the single source of truth for `formatMoney`, `PriceDisplay`, `FxContext` and the marketplace UI primitives.
- **The API Dockerfile is at the repository root**, not under `packages/backend/`.

`shared-types` is built by `postinstall` and again ahead of the backend build. Run `bun run build:shared-types` after changing a shared type.

## Tests

```bash
bun run --filter @mercaria/backend test
```

Vitest. Four packages carry a suite: `backend`, and the three Expo apps.

Each app's runner is deliberately narrow — `lib/**` only, node environment, no jsdom, no React — and each app has its OWN, which is a correctness property rather than a convenience. A test importing across a package boundary compiles the imported source under the **importing** package's `strict` setting; all four client packages are `strict: true` and `packages/backend` is `strict: false`, so an app module exercised from the API suite would lose every null-safety check it was written to rely on and pass anyway. `packages/frontend/vitest.config.ts` carries the full argument, including the measured reason component tests are out of scope (`react-native` ships Flow source a bundler cannot parse, so a renderer here would test a module graph neither shipped app uses).

Put app tests under `lib/**/__tests__/*.test.ts` and backend tests next to the source as `*.test.ts`. `packages/backend/src/__tests__/client-test-runners.test.ts` fails the build if a package declares a real `test` script that no CI step runs, or if a CI step points at a package whose `test` is a placeholder.

CI runs the following on every pull request, and each line runs locally as written:

```bash
bun run validate:no-mongo
bun run validate:agents-md
bun run validate:rtl-classes
bun run validate:bidi-isolation
bun run validate:i18n-strings
bun run validate:authoring-schema
bun run validate:money-formatting
bun run validate:storefront-catalog
bun run validate:route-targets
bun run --filter @mercaria/backend lint
bun run --filter @mercaria/backend typecheck
bun run --filter @mercaria/ui typecheck
bun run --filter @mercaria/dashboard typecheck
bun run --filter @mercaria/dashboard test
bun run --filter @mercaria/frontend typecheck
bun run --filter @mercaria/frontend test
bun run --filter @mercaria/pos typecheck
bun run --filter @mercaria/pos test
bun run --filter @mercaria/backend test
bun run build:backend
```

**All three Expo apps are typechecked, and that is deliberate.** A build is not a substitute: Babel strips types, so `expo export` will happily bundle code `tsc` rejects. A `shared-types` change that broke the dashboard once passed every build job.

## Conventions

Coding standards for this repository are in `AGENTS.md` at the repository root, and this is a repository where reading it first genuinely pays: the multi-currency model (native catalog prices, `DualMoney` on anything transacted, FAIR only at settlement) is easy to get subtly wrong, and "report" means two unrelated things in this codebase, store sales analytics and abuse reports, which must never be merged. `AGENTS.md` is read directly by Claude Code, Codex, Cursor and Copilot, and it is the file to update when a convention changes.

## Referencing an issue without closing it

GitHub scans for `close(s|d)?|fix(e[sd])?|resolve[sd]?` immediately followed by
`#N` and does **not** parse negation, hedging or surrounding grammar — "does
not close #123" and "fails closed: #123" both auto-close issue #123 the moment
the PR merges. It scans every commit message in the merge too, not just the PR
body, so a phrase buried in one commit of a multi-commit PR still fires on
squash. This has happened twice in this repo (#67, closed by a commit message;
#69, closed by a PR body) with nothing in either PR implementing the issue.

To mention an issue without closing it, never put a closing verb next to its
number — write "issue #123", "(#123)" or "deferred to #123" instead. Before
merging, verify what is actually on GitHub (a local draft is not what merges):

```bash
gh pr view <n> --json body --jq '.body' | grep -nEi '(close[sd]?|fix(e[sd])?|resolve[sd]?)[[:space:]]*:?[[:space:]]*#[0-9]+'
git log <base>..<head> --format=%B | grep -nEi '(close[sd]?|fix(e[sd])?|resolve[sd]?)[[:space:]]*:?[[:space:]]*#[0-9]+'
```

Every line either command prints must name an issue you intend to close.
