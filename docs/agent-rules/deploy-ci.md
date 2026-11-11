# Build, CI and deploy pins

Moved from the root `AGENTS.md`. Runbook: [`docs/deploy.md`](../deploy.md).

- **The root API Dockerfile pins `node-gyp`** (`ws` has no musl-arm64 prebuild;
  `@latest` flakes on ARM).
- **`ci.yml`'s `Lint & Test` stays on x86** though `deploy-aws.yml` builds ARM:
  ARM runners have no service containers; `postgis/postgis` is amd64-only.
- **Web apps deploy to Cloudflare Workers, NOT Pages**, via **`bunx wrangler`,
  never `cloudflare/wrangler-action`** (its `npm i wrangler` chokes on
  `workspace:*`). All four deploys gate on `ci.yml`'s verdict for that commit;
  none runs a copy of the suite (#518). `docs/deploy.md`.
