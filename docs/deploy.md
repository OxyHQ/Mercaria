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
- **`ci.yml`'s `Lint & Test` runs on `ubuntu-latest` (x86), deliberately NOT the
  `ubuntu-24.04-arm` `deploy-aws.yml`'s `deploy` job uses** — GitHub-hosted ARM
  runners do not support service containers at all, and `postgis/postgis`
  publishes `linux/amd64` only. Don't "fix" the mismatch. This constraint used to
  be recorded on `deploy-aws.yml`'s own `test` job as well; #518 deleted that job
  as a drifted copy, so `Lint & Test` is now the only job in the repository with
  a service container and the only place the rule applies.
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

**All four now gate the SAME way** (#518). Each runs a `gate` job first, which
calls `.github/scripts/require-ci-success.mjs`. That asks the Actions API what
`ci.yml` concluded **for this exact commit** and refuses unless every job it
defines is present and `success`.

Until #518 the API was the exception: it had a `test` job of its own, and that
job was a partial copy of `ci.yml` rather than CI. It ran **4 steps where
`ci.yml`'s `Lint & Test` ran 21** — no `validate:*` guard and no typecheck at
all — so the API deploy looked gated and was not. Demonstrated on `7071d999` by
appending `export const X: number = PRODUCTION_ORIGINS[0];` to
`packages/backend/src/lib/allowed-origins.ts`:

| step | in the API's old gate? | result |
|---|---|---|
| `--filter @mercaria/backend typecheck` | **no** | **exit 2**, `TS2322` |
| `--filter @mercaria/backend test` | yes | 82 tests passed |
| `bun run build:backend` | yes | exit 0 |

and the mutated symbol appeared **twice in `packages/backend/dist/index.js`** —
the artifact baked into the ECS image. `build:backend` is esbuild and vitest
transpiles rather than typechecks, so a backend type error was deployable.

### Why the gate reads CI's result instead of repeating CI

The three web workflows have no test job to `needs:`, so the two obvious repairs
are a `workflow_run` trigger or a second copy of the suite inside each workflow.
Both were rejected:

- **`workflow_run` carries no `paths:`.** The narrowing that stops a docs-only
  change redeploying three apps would have to be rebuilt out of a diff, and the
  trigger only runs the DEFAULT branch's copy of the file — so none of it is
  testable until it is merged, and the failure mode of getting it wrong is that
  deploys silently stop.
- **A copy of the suite drifts, and `deploy-aws.yml` was the proof.** Its `test`
  job ran the backend lint, the backend suite and the bundle — and NOT the ten
  `validate:*` guards, the five typechecks or the three app test runners that
  `ci.yml` grew after it was written. A second copy is a second answer to "did CI
  pass", and the two disagreed for as long as it existed. #518 deleted it rather
  than widening it to 21 steps: widening leaves two lists to keep in sync, which
  is how it drifted in the first place.

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

### What to do when a gate times out — and the two wrong repairs

**A gate timing out is a symptom of runner occupancy, not of an impatient
budget. The two wrong repairs are raising the wait (it hides the queue and
delays the refusal) and dropping the gate (it restores the bug).** Whoever hits
this at 3am will reach for exactly one of those two.

The `gate` job POLLS, so it holds a runner for its entire wait. Measured on
2026-08-17 under a real merge burst, before the per-app concurrency groups
existed: **9 of 16 running jobs were idle gates**, each with its own assigned
runner id, while the `ci.yml` runs they were waiting on sat `queued` — one of
them having gone from `in_progress` BACK to `queued`, losing runners it already
held to the jobs waiting on it. The worst gate reached **14.9 minutes of its
30-minute budget with its CI still `queued`**.

The cost of the burst is measurable on CI itself: queue-to-conclusion was a
**9.2 minute median all day (n=37)** and **17.4 minutes on the first run after
the sha-keyed group landed, +70%**.

So the right lever is reducing how many gates wait at once, which is what the
per-app `concurrency:` block on each web deploy workflow does — nine concurrent
gates become three. #518 added a fourth gate, for the API, and it is bounded at
ONE by that workflow's `cancel-in-progress: false` group; it also removed a
15-minute duplicate suite from every push, so the burst got cheaper rather than
denser. If that is ever not enough, the honest options are to stop
holding a runner at all (a `workflow_run` trigger, with `paths:` rebuilt from a
diff — which is the option §"Why the gate reads CI's result" rejected, and its
untestability comes back with it) or more runner capacity. Not a longer wait.

**One narrowing that looks cheap and is not:** the gate waits for the WHOLE
`ci.yml` run, including the three ~80-second Expo builds. Measured on
`c82ed408`, `Lint & Test` concluded at 08:57:17 while the gate polled until
09:08 for the builds. Waiting only on `Lint & Test` would shorten the hold and
weaken the gate to four-fifths of CI — the count-not-identity mistake this whole
section exists to prevent.

**Note the two concurrency settings in this repo are deliberately opposite.**
`ci.yml` owes a VERDICT PER COMMIT, so it must never cancel. A deploy owes only
the NEWEST ARTIFACT, so each web deploy workflow cancels its own superseded
runs. Reading them side by side, one looks like a mistake; the difference is
what each one owes.

### What is merged is asserted to have shipped (#574)

`deploy-coverage.yml` + `.github/scripts/require-deploy-coverage.mjs`. The
invariant, in one line:

> **The newest run of a deploy workflow on `main` must have concluded
> `success`.** Every non-success run newer than the last success names a commit
> that is merged and not shipped.

**The hole it closes.** `deploy-aws.yml` serialises on ONE group per ref with
`cancel-in-progress: false`, and GitHub keeps at most one PENDING run per group
— so a third arrival **evicts the queued second**, which then executes nothing:
no rollout, no migration, no notification.

Measured over `Deploy to AWS` runs **60–358** on `main` (298 completed,
2026-07-29 to 2026-08-17): **232 success, 42 cancelled, 15 failure, 9
action_required.** Those 66 form **37 windows** in which a merged commit was not
in production — median 23.1 minutes, worst **358.2 minutes** — and **two of them
contained a newly added `post` migration** (`0003`+`0005` on 2026-08-08 across a
4.5-hour window, and `0106_panoramic_patch` on 2026-08-17, the one #574 was
opened for). Nothing reported any of it.

The full table, every run id, and the two migration-carrying windows are in
**`docs/deploy/2026-08-18-evicted-deploy-run-evidence.md`**, committed because
Actions run history ages out and these numbers cannot be re-derived once it
does. **The window is pinned to run NUMBERS rather than to a date range** — the
repository is live and every figure above moved while it was first being
written (300/41/36 became 298/42/37 inside twenty minutes), so "the last four
weeks" reproduces nothing.

**Why the concurrency block was not the thing changed.** Per-sha groups (the
`ci.yml` shape) would let two runs migrate CONCURRENTLY, and `@oxyhq/db`'s
migrator takes no lock — the interlock is exactly what that group is. And
sparing a migration-carrying run from eviction needs a fact that is only
readable after checkout, which is after the eviction has happened. So the
eviction stays, and what was missing was never a different queue: it was that
**nobody was told**.

**Why an eviction is survivable at all**, and this is the part worth keeping:
the evictor is always a DESCENDANT, so it ships a superset of the code, and
`deploy-aws.yml`'s post-migration step greps the WHOLE journal rather than the
release's diff — so it applies whatever the ledger says is pending, including
the evicted run's migrations. That is how `f38227b7`, a commit adding no
migration at all, applied `0106`. **Narrowing that grep to the release's own
diff would read as a tightening and would delete the recovery**, turning a
bounded window into a permanent one; `deployWorkflow.test.ts` fails the build if
anybody does. The recovery holds exactly while the evictor SUCCEEDS, which is
the condition this check asserts.

**Three things about the implementation that are load-bearing:**

- **It anchors on the newest RUN, never the newest COMMIT.** All four deploys
  carry `paths:`/`paths-ignore:`, so a docs-only tip legitimately has no run —
  anchoring on the commit would mean rebuilding those filters out of a diff, the
  untestable reconstruction §"Why the gate reads CI's result" already rejected.
- **Coverage is ordered by `run_number`, never by completion time.** An evicted
  run completes in seconds while the run it queued behind takes fifteen minutes,
  so a completion-order sort puts the success ABOVE cancellations it did not
  cover. This shipped wrong the first time and was caught by replaying it against
  real history: at 2026-08-17T07:39Z it reported 1 unshipped commit where the
  truth was 3.
- **A run still in flight DEFERS.** Without it every eviction reports a gap that
  resolves on its own minutes later — 125 of those 298 completions had another
  run in flight, which is high precisely because this is the one workflow that
  SERIALISES — and an alarm that fires on work already in hand is one somebody
  mutes. With it, the same window produces **23** reports rather than 66, each a
  state where the pipeline had genuinely stopped.

**It reports and does not act.** No bypass input (the cheapest green is a
successful deploy, which is the remedy) and no re-dispatch: that would make a
report an actor holding `actions: write`, and against a genuinely failing deploy
— the ECR pull timeout on `203d8754` — it would loop. **To clear a report:**
re-run the newest failed deploy, or merge again so a fresh deploy ships the tip.
One successful deploy applies everything pending.

**What it does NOT claim.** It does not fire for an eviction whose evictor
succeeded, because nothing was lost — the five-minute window in #574's own
timeline is a consistent older state, not a torn one, and removing it needs one
of the rejected options. The guarantee is carried by the hourly `schedule`; the
`workflow_run` trigger only makes the answer fast, so nothing rests on whether
GitHub emits an event for a run cancelled by concurrency.

### There is no bypass

Deliberately, and symmetrically with `deploy-aws.yml`, which has none either. A
switch whose cheapest green is "ship the commit CI rejected" is worse than no
gate. Shipping from a red commit means reverting the commit. If CI is re-run
green after a failure, re-run the deploy workflow.

### The gap #505 left, closed by #518

#505 left the API on its own drifted `test` job, to keep the API's deploy path
unchanged in a PR about the three targets that had no gate at all. #518 moved it
onto this gate and deleted the copy. Two consequences are worth knowing rather
than rediscovering:

- **The PostGIS service container went with the `test` job.** The gate job needs
  no database — it runs one `fetch` loop — so `deploy-aws.yml` now starts no
  service container at all. Nothing else in it depended on that environment:
  `deploy` takes no output from the job it `needs:` and touches no Postgres.
- **The API deploy is now COUPLED to `ci.yml` reaching a conclusion.** Before, it
  re-ran the backend suite itself, so it was gated even on a commit whose CI run
  was cancelled. Now a cancelled or absent CI run refuses the deploy. That is the
  correct refusal — a cancelled run is not a pass — and it is only workable
  because #505 keyed `ci.yml`'s concurrency group on the sha, which is what stops
  back-to-back merges cancelling each other's verdicts. Reverting that line would
  now block API deploys as well as web ones.

The API's `concurrency` block was deliberately NOT touched. `cancel-in-progress`
stays `false` there for reasons that have nothing to do with gating — cancelling
between `run-task` and its exit-code check orphans a live migration task — and it
also bounds the new gate's runner occupancy: at most one run of that workflow is
in progress per ref, so at most one API gate ever polls, where the three web
deploys can have three. Net, the workflow occupies less than before: a poll loop
replaced a full duplicate run of the backend suite plus a service container.

### The gate is armed

`packages/backend/src/db/__tests__/deployGating.test.ts` fails the build if any
of it comes undone: the script's required-job list must equal the jobs `ci.yml`
really defines (so a new CI job forces a decision), every job holding a
production credential must depend on a verification, the set of such jobs must be
EXACTLY the four known targets (so a fifth is classified rather than assumed),
and `ci.yml`'s concurrency must still key `main` on the sha. Each of those four
was mutation-tested.

**A fifth was added by #574, and its absence is the lesson.** `deploy-aws.yml`'s
`cancel-in-progress: false` — the setting whose own thirty-line comment says it
"reads like an optimisation to flip" — was asserted by **nothing**. The
requirement was stated in a comment in this very test file, while the `it.each`
that checks the posture iterates `WEB_DEPLOY_WORKFLOWS`, which excludes
`deploy-aws.yml`. The control that settles it rather than suggesting it: **four
`toBe(true)` in the file and zero `toBe(false)`.** So the exact flip everything
warned against passed every gate in the repository. **A stated requirement is not
a checked one, and prose is where an invariant goes to be admired.**

Now asserted both ways, because the two break differently: `cancel-in-progress`
must be explicitly `false` (deleting the line is behaviourally identical and
orphans the comment, so absence fails too), and the group must **not** key on the
sha — the tempting fix for #574's evictions, which would let two deploys migrate
concurrently against a migrator that takes no lock. Mutation-tested three ways
(flip to `true`, key on the sha, delete the line); all three go red naming the
assertion, each with a one-line diff proving the mutation applied. `judgeJobs` is unit-tested against the two shapes that read
as green — a `skipped` job and a MISSING one.

#518 NARROWED the second of those and added one. "A verification" used to accept
`--filter @mercaria/backend test`, specifically so `deploy-aws.yml`'s own `test`
job satisfied it — so the guard agreed a job was verified by the very copy that
made a type error deployable. It now accepts only the gate script. The addition
asserts no deploy workflow runs the API suite ITSELF, with a positive control on
`ci.yml` so a rename cannot make it vacuous — the repair for a drifting copy is
having no copy, so the guard states the absence.

Mutation-tested three ways, each checked to fail with the reason it claims:
restoring the old `--filter @mercaria/backend test` shape as the dependency goes
red on "must wait for a green ci.yml run" (it was GREEN under the old predicate);
replacing the gate step with a no-op goes red on the same assertion and NOT on
the vacuity floor, which is what proves the narrowing rather than the floor is
refusing; and removing `needs:` entirely goes red on the floor, naming it
ungated.

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
