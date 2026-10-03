# I08 Mercaria published SDK adoption candidate

Source `a267c2ef` uses published @peable.to/sdk0.2.0, transitive
shared-types0.3.0, with npm SHA512 in bun.lock and no local overrides. All98
installed files match downloaded registry tarballs verified in Peable#94.
The [cohort guide](../../integrations/i08-billing-cohort.md) states authority,
compatibility and activation limits; ADR0009 amends only this approved cohort.

Executed from this worktree:

- Backend package `bun run test` over six explicit files (new adapter/registration,
  existing Stripe mapping, domain isolation, merchant-plans SQL and request
  schemas): **68 pass**. SDK/HTTP/controllers/domain/SQL and ledger real; Oxy/store
  authorization, Peable responses and Stripe read boundaries synthetic.
- Real createApp preflight: **1 expected RED → 1 GREEN** after adding the new
  Idempotency-Key header to the existing origin allowlist.
- Dashboard package `bun run test lib/billing/__tests__/intent.test.ts`: **4 pass**.
- Backend build and typecheck; dashboard typecheck with route generation: pass.
- ESLint changed files from their package directories: pass; diff check pass.

Postgres is an owned local PG17 instance at127.0.0.1:5575, owner
oxy_i08_mercaria. The existing Vitest harness creates a random oxydb_test_*
database, applies actual migrations and drops that database. The empty teardown
census proves no fixture database remains on that server. The server persists
for this task; the other agent's5574 instance was never modified. Database URLs
contain no password. No tables/triggers/history were weakened or rewritten.

The first new SQL fixture used an unsupported eventKind `status_changed` and
failed a real CHECK (24 pass/1 fail); fixed to existing `reconciled`. The expanded
receipt assertion initially summed bigint with number (12 pass/1 fail); fixed
to bigint0n. Both failed runs are retained as fixture mistakes, not product
regressions. An earlier ESLint invocation from repository root could not locate
the package config; final checks run at package cwd. No full-suite claim.

This candidate does not authorize/activate a catalogue or a production cohort.
Application/service-credential payments scopes, Peable/Mercaria deployed exact
platform account/mode, verified reference imports and rollout are separate
reviewed operations. Existing Stripe webhook/settlement reads stay transitional;
no claim that all ingress moved. No real Stripe call or money movement was made
by these tests. Production's empty commercial tables support a historical no-op,
not an invented merchant or imported rows.
