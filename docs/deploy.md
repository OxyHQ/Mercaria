# Deploy

> Moved out of `AGENTS.md`. The rules that stop somebody breaking it stay there;
> this is the topology and the handoff. Infrastructure itself is owned by
> `~/Oxy/oxy-infra`.

## Topology

- **API** on AWS ECS Fargate (service `mercaria`, cluster `oxy-cluster`) via
  `.github/workflows/deploy-aws.yml` (`linux/arm64`, ECR `oxy/mercaria`). The ECS
  service, task definition, ALB rule, ECR repo and SSM params are provisioned in
  `oxy-infra`.
- **Database `mercaria` on the shared RDS instance `oxy-postgres`**
  (`postgres.internal.oxy.so:5432`), owned by role `mercaria`, with PostGIS
  installed once by a privileged role — it is not a trusted extension. See
  `docs/runbooks/30-postgres-database-provisioning.md` in `oxy-infra`.
- **The `test` job runs on `ubuntu-latest` (x86), deliberately NOT the
  `ubuntu-24.04-arm` the `deploy` job uses** — GitHub-hosted ARM runners do not
  support service containers at all, and `postgis/postgis` publishes
  `linux/amd64` only. Don't "fix" the mismatch.
- **Web apps go to Cloudflare Workers (Static Assets), NOT Pages** — one Worker
  each (`deploy-cloudflare.yml`, `deploy-dashboard.yml`, `deploy-pos.yml`) via
  `bunx wrangler deploy` with a per-package advanced-mode `wrangler.jsonc`
  (`main: ./dist/_worker.js`, `assets.binding: ASSETS`, `run_worker_first: true`,
  `not_found_handling: single-page-application`, `workers_dev: false`,
  `preview_urls: false`, and `public/.assetsignore` containing `_worker.js` so
  the script is not re-uploaded as an asset). Pages was abandoned because its
  `*.pages.dev` production URL cannot be removed; nothing exposes a `*.pages.dev`
  or `*.workers.dev` host. Custom domains are Worker Custom Domains on the
  `mercaria.co` zone. **Do NOT use `cloudflare/wrangler-action`** — its
  `npm i wrangler` chokes on `workspace:*`.
- CI (`.github/workflows/ci.yml`) runs lint, tests, the API build and the app
  builds on every push and PR.

### How a migration reaches production

`bun run db:generate` (drizzle-kit) writes the SQL; `packages/backend/src/db/migrate.ts`
is the only thing that applies it — never `drizzle-kit migrate`, a devDependency
that cannot reach the production image. In production it runs as the COMPILED
`packages/backend/dist/db/migrate.js`, launched as a one-shot ECS task around
the rollout (`.github/scripts/run-migration-task.sh`); the Dockerfile refuses to
build if that file was not produced.

- **Migrations normally run as the pre/post pair around the rollout** — `pre`
  (additive) before, `post` (drops/renames/narrows) after the new image is live.
- **`migration_phase=all`, dispatched by hand, is for a from-zero/cutover batch
  ONLY — never a normal release.** It applies the whole chain in one run before
  anything serves it, which is what a journal whose phases cannot be applied in
  order needs (a queued `pre` sitting behind an unapplied `post`) and is wrong
  for every other case: it is a `workflow_dispatch` dropdown an operator sees
  under pressure, and picking it for an ordinary release overrides the
  pre/post rule that keeps a rollout safe.

### Topology handoff

- Register 2 Oxy RP client ids (dashboard, POS).
- `DATABASE_URL` is live via GitHub secret → SSM `/oxy/mercaria/DATABASE_URL` →
  the task definition; the task will not boot without it.
- Populate the operator allow-lists above before the rails carry live money or
  real compliance decisions. EMPTY is a working configuration and means nobody
  can trace a payment, replay an event, run a repair, publish an eligibility
  policy, lift a recall or approve a payout batch. Pre-launch lists:
  `docs/payments.md`, `docs/retail-eligibility.md` and `docs/referral-pilots.md`
  §"Production-readiness checklist".
- **Referral payouts need FOUR things, not one:** the operator list populated;
  `STRIPE_ENABLED` plus a payment-ready connected account per partner (with the
  rail off every partner's readiness reads `unknown`, which BLOCKS); a partner
  who actually enrolled — agreement AND tax questionnaire
  (`REFERRAL_PARTNER_ENROLLMENT_ENABLED`, ADR 0005 D15 gate 2); and a published
  pilot cohort, since a programme with no active cohort attributes NOTHING.
- **`SERVICE_SECRET` is still owed on the infra side and the ORDER is
  load-bearing.** The task definition still names it while the repo no longer
  reads it; oxy-infra must drop the entry and ROLL OUT before the SSM parameter
  or the GitHub secret is deleted, or the next scale-up fails at task start with
  `ResourceInitializationError`.
