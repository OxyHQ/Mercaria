# Deploy, and the traps around it

## Gotchas

**Dockerfile node-gyp pin.** The API Dockerfile lives at the **repo root**, not
under `packages/backend/`, and pins `node-gyp` explicitly in the builder stage.
`ws`'s optional native accelerators have no musl-arm64 prebuild, and an on-demand
`bunx node-gyp@latest` races and fails intermittently on ARM. Do NOT remove this
pin.

## Deploy

- **API** is live on AWS ECS Fargate (service `mercaria`, cluster
  `oxy-cluster`), `.github/workflows/deploy-aws.yml` (`linux/arm64`, ECR
  `oxy/mercaria`). The ECS service, task definition, ALB rule, ECR repo and SSM
  params are provisioned in `oxy-infra`. The workflow's `test` job runs on
  `ubuntu-latest` (x86), deliberately NOT the `ubuntu-24.04-arm` the `deploy`
  job uses — GitHub-hosted ARM runners don't support service containers at all,
  AND `postgis/postgis` publishes `linux/amd64` only, so the job needs a real
  PostGIS service container either way. Don't "fix" the runner mismatch.
- **Web apps go to Cloudflare Workers (Static Assets), NOT Pages.** Each app
  deploys a Worker (`mercaria`, `mercaria-dashboard`, `mercaria-pos`) via
  `bunx wrangler deploy` using the per-package `wrangler.jsonc`. Workflows:
  `deploy-cloudflare.yml` (storefront, `mercaria.co`), `deploy-dashboard.yml`
  (`dashboard.mercaria.co`), `deploy-pos.yml` (`pos.mercaria.co`). Pages was
  abandoned because its `*.pages.dev` production URL cannot be removed; Workers
  with `workers_dev:false` and `preview_urls:false` serve ONLY the custom domain.
- **Each `wrangler.jsonc` is advanced-mode static assets:** `main: ./dist/_worker.js`
  (the repo's SPA and MIME-fix worker), `assets.binding: ASSETS`,
  `run_worker_first: true`, `not_found_handling: single-page-application`.
  `public/.assetsignore` (containing `_worker.js`) stops the script being
  re-uploaded as an asset. **Do NOT use `cloudflare/wrangler-action`**: its
  `npm i wrangler` chokes on the monorepo's `workspace:*` deps. Run `bunx
  wrangler` directly.
- Custom domains are Worker Custom Domains (managed DNS plus cert), bound on the
  `mercaria.co` zone. No `*.pages.dev` or `*.workers.dev` is exposed anywhere.
- CI (`.github/workflows/ci.yml`) runs lint, tests, the API build and the app
  build on every push and PR.

### Deploy handoff

- Register 2 Oxy RP client ids (dashboard, POS):
  `EXPO_PUBLIC_OXY_CLIENT_ID_DASHBOARD`, `EXPO_PUBLIC_OXY_CLIENT_ID_POS`.
- The ECS service, task definition, ALB rule, ECR repo and SSM params are
  provisioned in `oxy-infra` (role `mercaria` owns database `mercaria` on the
  shared `oxy-postgres` RDS instance; `DATABASE_URL` is live via GitHub secret →
  SSM `/oxy/mercaria/DATABASE_URL` → the task definition, and the task will not
  boot without it — see "PostgreSQL" above).
- Set `RETAIL_OPERATOR_OXY_USER_IDS` to the Oxy compliance accounts that may
  reach `/internal/retail-eligibility/*` — a FIFTH list, deliberately distinct
  from the payments and catalog ones. EMPTY is a working configuration and means
  the surface is not mounted at all, which also means nobody can publish an
  eligibility policy version, verify a document or raise a recall. The full
  pre-launch list is `docs/retail-eligibility.md`
  §"Production-readiness checklist".
- Set `PAYMENT_OPERATOR_OXY_USER_IDS` to the Oxy accounts that may reach
  `/internal/payments/*`. EMPTY is a working configuration and means the surface
  is not mounted at all — but it also means nobody can trace a payment, replay an
  event or run a repair, so it must be populated before the rail carries live
  money. Alerting and scraping for the metrics this exposes belong to
  `oxy-infra`; the full pre-launch list is `docs/payments.md`
  §"Production-readiness checklist".
