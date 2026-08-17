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

## What gates a deploy

**All four production deploys now wait for CI on the commit they ship** (#505).
Until then only the API did, and the pipeline LOOKED gated because of it —
`deploy-aws.yml`'s `needs: test` is visible and the three web workflows' absence
of one is not. Measured over the 329 pushes to `main` before the fix: **93 web
deploys shipped without a green CI** — 29 from an outright `failure`, and 64 from
a run the next merge had `cancelled`.

- **The API** (`deploy-aws.yml`) keeps its own `test` job and `needs: test`.
- **The three web apps** each run a `gate` job first, which calls
  `.github/scripts/require-ci-success.mjs`. That asks the Actions API what
  `ci.yml` concluded **for this exact commit** and refuses unless every job it
  defines is present and `success`.

### Why the gate reads CI's result instead of repeating CI

The three web workflows have no test job to `needs:`, so the two obvious repairs
are a `workflow_run` trigger or a second copy of the suite inside each workflow.
Both were rejected:

- **`workflow_run` carries no `paths:`.** The narrowing that stops a docs-only
  change redeploying three apps would have to be rebuilt out of a diff, and the
  trigger only runs the DEFAULT branch's copy of the file — so none of it is
  testable until it is merged, and the failure mode of getting it wrong is that
  deploys silently stop.
- **A copy of the suite drifts, and `deploy-aws.yml` is the proof.** Its `test`
  job runs the backend lint, the backend suite and the bundle — and NOT the ten
  `validate:*` guards, the five typechecks or the three app test runners that
  `ci.yml` has grown since. A second copy is a second answer to "did CI pass".

Reading the real run keeps one definition, keeps every `paths:` filter exactly as
it was, and is verifiable before merge — the script was run against real
historical commits, refusing `61e21d7f` (the `failure` #505 demonstrated) and
`01a5e50c` (a `cancelled` run) and passing `67c4bf3a`.

### Why `ci.yml` no longer cancels a run on `main`

The gate needs a verdict per commit, and there was not one. `ci.yml`'s
concurrency group was keyed on the ref, so a merge cancelled the run for the
commit that had just landed — 52 of those 329 runs. A cancelled run is not a
pass, so without this change the gate would have refused roughly a third of
deploys, and the app whose last attempt was refused would sit stale until the
next push touching its paths.

The sha is in the GROUP rather than `cancel-in-progress` being set false, because
false SERIALISES: one shared group would queue a burst of merges and make the
last commit's deploy wait out every earlier run. A per-sha group has nothing to
cancel and nothing to queue behind. Topic branches are unchanged — superseding a
run there is still right.

### What the app's own build does and does not prove

Each web deploy builds the app it ships, which is why the gap was easy to accept.
That build is `expo export` — a **bundler**. Babel strips types, so it ships code
`tsc` rejects. Measured on 2026-08-17 against `packages/pos`: a `string` assigned
to a `number` in `app/(app)/index.tsx` makes `tsc --noEmit` exit 2, while
`expo export` exits 0 and emits the module into the shipped bundle. So the export
proves the app BUNDLES — a missing import, a syntax error — and says nothing
about the typechecks, the ten guards or the three app test runners.

### There is no bypass

Deliberately, and symmetrically with `deploy-aws.yml`, which has none either. A
switch whose cheapest green is "ship the commit CI rejected" is worse than no
gate. Shipping from a red commit means reverting the commit. If CI is re-run
green after a failure, re-run the deploy workflow.

### Known gap this did not close

`deploy-aws.yml`'s `test` job is a partial copy of `ci.yml` and has drifted, as
above; it also never typechecks the backend, because `build:backend` is esbuild
(`packages/backend/build.ts`) and vitest does not typecheck either. So a backend
type error can still reach the API — `ci.yml`'s `Typecheck API` catches it on the
same push, but nothing makes the API deploy wait for that. Moving `deploy-aws.yml`
onto this same gate would close it and remove the duplicate suite; it was left out
of #505 to keep the API's deploy path unchanged in a PR about the three that had
no gate at all.

### The gate is armed

`packages/backend/src/db/__tests__/deployGating.test.ts` fails the build if any
of it comes undone: the script's required-job list must equal the jobs `ci.yml`
really defines (so a new CI job forces a decision), every job holding a
production credential must depend on a verification, the set of such jobs must be
EXACTLY the four known targets (so a fifth is classified rather than assumed),
and `ci.yml`'s concurrency must still key `main` on the sha. Each of those four
was mutation-tested. `judgeJobs` is unit-tested against the two shapes that read
as green — a `skipped` job and a MISSING one.

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
