# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
#
# Production image for the @mercaria/backend service.
#
# Every external image (the syntax frontend above, both bases and the
# `COPY --from` below) is pinned by its multi-arch INDEX digest. The digest is
# what the build pulls; the tag is kept only for readability. Re-pushing a tag
# therefore changes nothing here, and a bump means a new digest, a re-review and
# a re-pin (`python3 .github/scripts/reviewed-image.py pin`). Resolved
# 2026-10-12: docker/dockerfile:1.7 = 1.7.1, node:24-alpine = 24.21.0-alpine,
# oven/bun:1.4.3-alpine; each index lists linux/arm64 and linux/amd64.
#
# Multi-stage, multi-arch. `node:24-alpine` and `oven/bun` are multi-arch
# manifests, so this image builds natively on AWS Graviton (linux/arm64) as well
# as x86_64 — Docker selects the right base layer per target platform.
#
# The API RUNS ON BUN (oven/bun:1.4.3-alpine, musl like the stages that install
# its dependencies). It ran on node:24-alpine until 2026-10; Bun serves the same
# esbuild bundle (ESM, platform=node) unchanged. Measured on the built dist
# against a local PostgreSQL 17 + PostGIS: every migrator phase applies, the
# taxonomy one-shot provisions and is idempotent on a re-run, /health/ready
# answers 200, a socket.io WebSocket upgrade reaches the Oxy auth middleware, the
# 65 s keep-alive closes an idle socket at 66 s exactly as on Node, SIGTERM runs
# the graceful shutdown to exit 0, and a boot without a reachable database exits
# 1. CI's `Build API` job proves the same against the real image
# (.github/scripts/smoke-api-image.sh).
#
# Rolling back to Node is reverting the change that made this switch: it moved
# this runner stage AND every one-shot command (`.github/scripts/run-migration-task.sh`,
# the capability-catalog step in deploy-aws.yml) together, and they must stay
# together — a `bun …` command against a Node image dies at task start.
#
# Build context is the monorepo ROOT (bun workspaces):
#   docker build -t mercaria-backend:test .
#
# Pipeline:
#   builder:   toolchain, bun, every workspace manifest, the lockfile
#   prod-deps: bun install --frozen-lockfile --production  (runtime node_modules)
#   bundle:    bun install --frozen-lockfile (incl. devDependencies for the build)
#              && bun run build:backend    (tsc shared-types + esbuild bundle
#                                            -> packages/backend/dist/index.js)
#   run:       bun packages/backend/dist/index.js   (oven/bun runtime)
#
# @mercaria/shared-types is a first-party workspace package; the API bundle
# INLINES it (see packages/backend/build.ts), so the runtime image needs neither
# its dist nor its build-time devDependencies. Everything else — third-party
# node_modules AND @oxy.so/* — stays EXTERNAL and is resolved from the production
# node_modules copied into the runtime stage.

# ---------------------------------------------------------------------------
# Stage 1: builder — the toolchain and everything a `bun install` reads. The
# two stages below start from it: one for the runtime dependency tree, one for
# the build.
# ---------------------------------------------------------------------------
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS builder

# Toolchain for any dependency that needs a node-gyp fallback when a prebuilt
# binary is unavailable for the target arch (e.g. ws's optional native
# accelerators bufferutil/utf-8-validate, which have no musl-arm64 prebuild).
# Confined to the builder stage so it never reaches the runtime image.
# node-gyp is installed explicitly (pinned) so the install step never has to
# fetch it on the fly via `bunx node-gyp@latest` — that on-demand fetch races
# and intermittently fails with ENOENT on `.bin/node-gyp`, breaking the build.
RUN apk add --no-cache python3 make g++ libc6-compat \
 && npm install -g node-gyp@10

# Bun is the package manager / script runner at build time (and the runtime,
# below). This stage stays on node:24-alpine because node-gyp, which builds the
# native fallbacks above, runs on Node; nothing from it but node_modules and the
# bundle reaches the runner. The musl build from the matching alpine image works
# on amd64 and arm64, and is the same binary the runner stage ships.
COPY --from=oven/bun:1.4.3-alpine@sha256:629e17411f1f129dbec3af78d5af9c9f2a937435c80349437206c6b0b7422373 /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

# Install dependencies first for better layer caching. Copy only the manifests,
# the lockfile and the bun config (hoisted linker — required so the runtime
# image can resolve deps from the root node_modules; see the Bun-1.3 isolated
# linker gotcha) so this layer is reused unless dependencies change. Every
# workspace's package.json is included (the frontend source is excluded by
# .dockerignore) so the bun workspace graph stays valid.
COPY package.json bun.lock bunfig.toml ./
COPY packages/backend/package.json ./packages/backend/package.json
COPY packages/frontend/package.json ./packages/frontend/package.json
COPY packages/shared-types/package.json ./packages/shared-types/package.json
# The Expo apps + shared UI lib are part of the bun workspace graph (frontend
# depends on @mercaria/ui), so their manifests MUST be present for
# `bun install --frozen-lockfile` to resolve the `workspace:*` links — even
# though the API bundle never imports them and their source is not copied.
COPY packages/ui/package.json ./packages/ui/package.json
COPY packages/dashboard/package.json ./packages/dashboard/package.json
COPY packages/pos/package.json ./packages/pos/package.json
# `@mercaria.co/sdk` (#1017) joined the workspace graph too. Without its manifest
# the lockfile names a member this context does not have and
# `bun install --frozen-lockfile` refuses with "lockfile had changes" — measured
# against a copy of exactly the files this stage copies, which installs on
# `main` and fails with the SDK merged. The API never imports the SDK and its
# source is copied only in the bundle stage for the root postinstall.
COPY packages/sdk/package.json ./packages/sdk/package.json

# Copy shared-types and contracts source before install so the root
# `postinstall` (tsc, shared-types first) can build both dists during
# `bun install`. `@mercaria/contracts` (#1017) is the public API's one
# definition; the API bundle inlines it like shared-types.
COPY packages/shared-types ./packages/shared-types
COPY packages/contracts ./packages/contracts

# ---------------------------------------------------------------------------
# Stage 1b: prod-deps — the production-only dependency tree, from the SAME
# manifests and lockfile, and nothing else.
#
# This used to be the builder's LAST step (`rm -rf node_modules && bun install
# --production`), which put it after `COPY packages/backend`: every backend
# source change invalidated it, so every deploy re-downloaded the whole tree —
# 81.3s of the 161s build (Deploy to AWS run 36277048418, step #34). Here it
# depends only on what an install reads, so the layer is reused from the gha
# cache until a manifest, the lockfile or shared-types changes, and BuildKit
# builds it alongside the builder when it does.
#
# Same tree, measured: a production install run in this stage's shape and one
# run the old way (full install, backend source present, node_modules removed,
# production install) produced identical package lists — 850 package.json
# files, same names and versions (bun, 2026-09-29). And since this layer now
# only changes with the dependencies, its share of the ~22s layer export and
# of the push should also drop out of an ordinary release (expected, not yet
# measured).
# ---------------------------------------------------------------------------
FROM builder AS prod-deps
# Runtime dependencies need no workspace build output: the API bundles the
# private workspaces. Avoid invoking the SDK development build in this stage.
RUN bun install --frozen-lockfile --production --ignore-scripts

# ---------------------------------------------------------------------------
# Stage 1c: bundle — the full install and the API build.
# ---------------------------------------------------------------------------
FROM builder AS bundle
COPY packages/sdk ./packages/sdk

# Deterministic install from the lockfile, including devDependencies (esbuild,
# TypeScript) required to bundle the API. The root postinstall builds
# @mercaria/shared-types, then @mercaria/contracts.
RUN bun install --frozen-lockfile

# Copy the source needed to build the API.
COPY packages/backend ./packages/backend

# Build shared-types and contracts, then bundle the API with esbuild ->
# packages/backend/dist/index.js (externalizes third-party node_modules INCLUDING
# @oxy.so/*, inlines only @mercaria/*; see packages/backend/build.ts).
#
# @oxy.so/* being external is what makes the `prod-deps` install load-bearing:
# the bundle `import`s those packages by name, so they MUST be present in the
# runtime node_modules. They are all in @mercaria/backend's `dependencies` (not
# devDependencies), so `--production` keeps them. Moving one to devDependencies
# would produce an image that builds green and dies at container start with
# ERR_MODULE_NOT_FOUND.
RUN bun run build:backend

# Fail fast if any expected entry point was not emitted. The migrator one-shot is
# checked as well as the server, because nothing else would notice it missing
# until the deploy's migration task failed — the server bundle would still be here
# and the image would look fine.
RUN test -f packages/backend/dist/index.js \
 || (echo "ERROR: packages/backend/dist/index.js was not produced by the build" && exit 1)
RUN test -f packages/backend/dist/db/migrate.js \
 || (echo "ERROR: packages/backend/dist/db/migrate.js was not produced by the build" && exit 1)
RUN test -f packages/backend/dist/register-capability-catalog.js \
 || (echo "ERROR: packages/backend/dist/register-capability-catalog.js was not produced by the build" && exit 1)
# The taxonomy provisioner is checked for the migrator's reason, one step
# further: it is run by hand as a one-shot ECS task, so a missing emit would be
# discovered by an operator holding an incident rather than by this build.
RUN test -f packages/backend/dist/scripts/provision-taxonomy.js \
 || (echo "ERROR: packages/backend/dist/scripts/provision-taxonomy.js was not produced by the build" && exit 1)

# devDependencies are stripped by taking node_modules from `prod-deps` above
# rather than from this stage (bun has no `prune`; a clean production install
# from the same lockfile is the deterministic equivalent). The API bundle inlines
# first-party code, so the shared-types dist is not needed at runtime — but every
# EXTERNAL import (all third-party deps plus @oxy.so/*) must be in that tree.

# ---------------------------------------------------------------------------
# Stage 2: runner — minimal runtime with production deps and the bundle.
# ---------------------------------------------------------------------------
FROM oven/bun:1.4.3-alpine@sha256:629e17411f1f129dbec3af78d5af9c9f2a937435c80349437206c6b0b7422373 AS runner

ENV NODE_ENV=production \
    PORT=3001

# libc6-compat: glibc shim some prebuilt native binaries expect on Alpine/musl.
# dumb-init: PID 1 that forwards SIGTERM/SIGINT to Bun (the graceful shutdown in
# src/index.ts) and reaps zombies. The base image already carries the
# libgcc/libstdc++ Bun links against.
RUN apk add --no-cache libc6-compat dumb-init

WORKDIR /app

# Run as the unprivileged `bun` user (uid/gid 1000, like Node's `node`) the
# base image provides.
USER bun

# Bring over the pruned (production-only) dependency tree and the workspace
# manifests so workspace resolution stays valid.
COPY --from=prod-deps --chown=bun:bun /app/node_modules ./node_modules
COPY --from=prod-deps --chown=bun:bun /app/package.json ./package.json
COPY --from=prod-deps --chown=bun:bun /app/packages/backend/package.json ./packages/backend/package.json

# The bundled API.
COPY --from=bundle --chown=bun:bun /app/packages/backend/dist ./packages/backend/dist

# The SQL migrations, which EVERY serving task needs — not just the one-shot
# migration task. `db/postgres.ts` reads this folder's journal at module load to
# decide whether the task may serve traffic (`/health/ready`), so an image without
# it crashes at container start rather than starting and answering "not ready".
# `src/db/migrationsFolder.ts` resolves the path from the package root, which is
# why this lands beside `dist` rather than anywhere else.
COPY --from=bundle --chown=bun:bun /app/packages/backend/drizzle ./packages/backend/drizzle

EXPOSE 3001

# Container-level health check hitting the app's /health endpoint: any answer
# below 500 is healthy, no answer within 4 s is not.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"

# Every one-shot that overrides this command (the migrator and the capability
# catalog in deploy-aws.yml, the taxonomy provisioner by hand) names `bun` too.
# The base image puts a `node` on PATH, but it is a symlink to bun
# (/usr/local/bun-node-fallback-bin/node): there is no Node in this image, so
# `node <file>` would run Bun while claiming otherwise.
ENTRYPOINT ["dumb-init", "--"]
CMD ["bun", "packages/backend/dist/index.js"]
