# syntax=docker/dockerfile:1.7
#
# Production image for the @marketplace/backend service.
#
# Multi-stage, multi-arch. `node:22-alpine` and `oven/bun` are multi-arch
# manifests, so this image builds natively on AWS Graviton (linux/arm64) as well
# as x86_64 — Docker selects the right base layer per target platform.
#
# Build context is the monorepo ROOT (bun workspaces):
#   docker build -t marketplace-backend:test .
#
# Pipeline:
#   build: bun install --frozen-lockfile (incl. devDependencies for the build)
#          && bun run build:backend           (tsc shared-types + esbuild bundle
#                                               -> packages/backend/dist/index.js)
#          && reinstall production-only deps
#   run:   node packages/backend/dist/index.js
#
# @marketplace/shared-types is a first-party workspace package; the API bundle
# INLINES it (see packages/backend/build.ts), so the runtime image needs neither
# its dist nor its build-time devDependencies.

# ---------------------------------------------------------------------------
# Stage 1: builder — install the full dependency graph and bundle the API.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS builder

# Toolchain for any dependency that needs a node-gyp fallback when a prebuilt
# binary is unavailable for the target arch. Confined to the builder stage so it
# never reaches the runtime image.
RUN apk add --no-cache python3 make g++ libc6-compat

# Bun is the package manager / script runner at build time; the runtime stays
# Node. The musl build from the matching alpine image works on amd64 and arm64.
COPY --from=oven/bun:1.3.14-alpine /usr/local/bin/bun /usr/local/bin/bun

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

# Copy shared-types source before install so its `postinstall` (tsc) can build
# the package's dist during `bun install`.
COPY packages/shared-types ./packages/shared-types

# Deterministic install from the lockfile, including devDependencies (esbuild,
# TypeScript) required to bundle the API. The root postinstall builds
# @marketplace/shared-types.
RUN bun install --frozen-lockfile

# Copy the source needed to build the API.
COPY packages/backend ./packages/backend

# Build shared-types then bundle the API with esbuild ->
# packages/backend/dist/index.js (externalizes third-party node_modules, inlines
# @oxyhq/* and @marketplace/*; see packages/backend/build.ts).
RUN bun run build:backend

# Fail fast if the expected entry point was not emitted.
RUN test -f packages/backend/dist/index.js \
 || (echo "ERROR: packages/backend/dist/index.js was not produced by the build" && exit 1)

# Strip devDependencies so only production modules are carried into the runtime
# image (bun has no `prune`; a clean production install from the same lockfile is
# the deterministic equivalent). The API bundle inlines first-party code, so the
# shared-types dist is no longer needed at runtime.
RUN rm -rf node_modules \
 && bun install --frozen-lockfile --production

# ---------------------------------------------------------------------------
# Stage 2: runner — minimal runtime with production deps and the bundle.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runner

ENV NODE_ENV=production \
    PORT=3001

# libc6-compat: glibc shim some prebuilt native binaries expect on Alpine/musl.
# dumb-init: proper PID 1 so SIGTERM/SIGINT reach Node for graceful shutdown.
RUN apk add --no-cache libc6-compat dumb-init

WORKDIR /app

# Run as the unprivileged `node` user provided by the base image.
USER node

# Bring over the pruned (production-only) dependency tree and the workspace
# manifests so Node's workspace resolution stays valid.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/packages/backend/package.json ./packages/backend/package.json

# The bundled API.
COPY --from=builder --chown=node:node /app/packages/backend/dist ./packages/backend/dist

EXPOSE 3001

# Container-level health check hitting the app's /health endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.PORT||3001,path:'/health',timeout:4000},r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "packages/backend/dist/index.js"]
