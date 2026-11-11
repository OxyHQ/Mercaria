# Mercaria

Oxy's buy/sell marketplace (new items from shops, secondhand from people): a commerce
backend serving three Expo apps (storefront, dashboard, POS) and a shared UI package.

## Commands

Use `bun` only, from the repo root. The backend suite needs Postgres:
`docker compose -f docker-compose.postgres.yml up -d` (port 5435).

```bash
bun install
bun run dev                                  # all packages; dev:backend / dev:frontend / dev:dashboard / dev:pos for one
bun run build                                # shared-types + contracts + backend + frontend
bun run build:shared-types                   # after any shared-types change, and before db:generate
bun run --cwd packages/backend test          # vitest, including *.realdb.test.ts
bun run --cwd packages/backend typecheck     # also: --filter @mercaria/{ui,frontend,dashboard,pos}
bun run lint                                 # Biome + Expo ESLint; lint:fix and format write
bun run validate:agents-md                   # AGENTS.md byte budget
```

## Map

- Start at [`docs/index.mdx`](docs/index.mdx); decisions are in [`docs/adr/`](docs/adr/).
- Backend invariants and DB work: [`docs/house-invariants.md`](docs/house-invariants.md),
  [`docs/postgres-testing-and-migrations.md`](docs/postgres-testing-and-migrations.md),
  [`packages/backend/AGENTS.md`](packages/backend/AGENTS.md) (migrations and test DB rules).
- Schema rules: `packages/backend/src/db/schema/CONVENTIONS.md`. Deferred work: [`HANDOFF.md`](HANDOFF.md).
- Packages: `frontend` (mercaria.co), `dashboard`, `pos` (Expo apps), `ui` (shared), `backend`,
  `shared-types` (DTOs, closed value sets), `contracts` (`/public/v1` zod source), `sdk` ([`docs/sdk.md`](docs/sdk.md)).
- Rules that break silently live in [`docs/agent-rules/`](docs/agent-rules/): `money`, `auth-identity`,
  `silent-breakers`, `client-packages`, `i18n-rtl`, `deploy-ci`. Read the one for the area you touch.

## Conventions that differ from defaults

- `@mercaria/ui` has no `dist`; apps import its source (Metro `watchFolders`). Do not add a build step or
  keep a local copy of anything it owns. Why: a second copy drifts silently.
- Spell dynamic route targets as objects (`{ pathname, params }`), not template literals; `validate:route-targets`
  gates it. Why: `tsc` only checks template literals partly. Detail: [`client-packages`](docs/agent-rules/client-packages.md).
- Money: the catalog stores native currency, every column is `bigint`, the ledger is the only commission record,
  corrections are reversing transactions. Detail: [`money`](docs/agent-rules/money.md).
- Auth: one `OxyServer` client, a person's calls use `oxyClient.withUser`; `/internal/*` desks are Oxy app roles,
  never env id lists. Detail: [`auth-identity`](docs/agent-rules/auth-identity.md).
- Migrations come from `db:generate` and are applied only by `src/db/migrate.ts`, each with one
  `-- oxy:deploy-phase=pre|post` marker. Why: no default phase. Detail: `packages/backend/AGENTS.md`.
- Client strings go through the one locale registry in `@mercaria/ui/src/i18n/`; layout uses logical utilities
  (`ms-`, `start-`), not `ml-`. Gates: `validate:i18n-strings`, `validate:rtl-classes`. Detail: [`i18n-rtl`](docs/agent-rules/i18n-rtl.md).
- Peable is the only payment rail; Moovo owns logistics (no shipping zones or rates); place facts come from GoWay
  and store crawls from Clarity. Detail: [`silent-breakers`](docs/agent-rules/silent-breakers.md).

## Boundaries

Never:
- Run `drizzle-kit migrate`, rename a migration, or hand-edit `meta/_journal.json` or snapshots: the journal drifts from the SQL.
- Convert `*.realdb.test.ts` suites to mocks: a mock accepts statements Postgres rejects.
- Mount a webhook router after `express.json()`, or add a second writer to `listings.published_at` or the ledger:
  chokepoint tests fail the build.
- Add a build step to `@mercaria/ui`, or deploy web apps with `cloudflare/wrangler-action` (Workers via `bunx wrangler`).
- Rewrite or auto-delete financial history: repairs are audited operator actions.

Ask first:
- Adding a `CurrencyCode` or condition key (needs a `pre` migration and an SDK release first; see `money`).
- Changing `allowed-origins.ts`, the Dockerfile, or `.github/workflows/` (CODEOWNERS review applies).
- Building shipping UI, or growing this file past its budget (move material to `docs/` in the same edit).

## Testing

- Backend change: `bun run --cwd packages/backend test` and `typecheck`. DB change: run the `*.realdb.test.ts` suites.
- Client change: `typecheck` for each of `@mercaria/{ui,frontend,dashboard,pos}` it touches; a build is not a substitute.
- Done means `bun run lint`, the relevant `validate:*` gate and the affected tests pass locally; CI runs the same.
- Write real-database tests that scope counts to ids the file owns; the test DB is shared across parallel files.

## PR and commit rules

- Follow the [Oxy contributing guide](https://github.com/OxyHQ/.github/blob/main/CONTRIBUTING.md) and the PR template.
- Write `Closes #N` only when the PR finishes that issue, in the body and in every commit message.
- Merge with bare `gh pr merge --squash`; do not pass `--delete-branch` when a merge queue is on.
- Package releases happen by merging a version bump: [npm releases](https://github.com/OxyHQ/oxy/blob/main/docs/npm-releases.md). Never publish from a laptop.

## Secrets

Env values come from each package's `.env` (copy `.env.example`) and the deploy environment. Never print or
commit `DATABASE_URL` or any credential; refer to variable names only.

## Further reading

- [Engineering standards](https://github.com/OxyHQ/oxy/blob/main/docs/engineering/standards.md),
  [lint and format](https://github.com/OxyHQ/oxy/blob/main/docs/engineering/lint-and-format.md),
  [gate writing](https://github.com/OxyHQ/oxy/blob/main/docs/engineering/gate-writing.md),
  [build and runtime traps](https://github.com/OxyHQ/oxy/blob/main/docs/engineering/build-and-runtime-traps.md)
- [Application roles](https://github.com/OxyHQ/oxy/blob/main/docs/auth/application-roles.md),
  [Postgres and Drizzle](https://github.com/OxyHQ/oxy/blob/main/docs/postgres-and-drizzle.md),
  [Bloom app conventions](https://github.com/OxyHQ/Bloom/blob/main/docs/app-conventions.mdx)

Owner: OxyHQ (CODEOWNERS). Last reviewed: 2026-11-11.
