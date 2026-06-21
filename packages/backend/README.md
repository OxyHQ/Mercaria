# Marketplace API

Express + TypeScript backend for Marketplace.

This is the **base shell** — it provides the bootstrap, auth, real-time, and
notification infrastructure. The marketplace domain (listings, buy/sell, shops)
is built on top of it (see `HANDOFF.md` in the repo root).

## What's here

- Express bootstrap with graceful shutdown, process-level error handling, and CORS
- MongoDB/Mongoose connection (`src/lib/db.ts`, db name `marketplace-{NODE_ENV}`)
- Redis client (optional) for rate-limit store + Socket.IO scaling
- Oxy auth via `@oxyhq/core/server` (`src/middleware/auth.ts`)
- Socket.IO with authenticated per-user rooms (`src/socket.ts`)
- Notification service: in-app (socket), Expo push, and web push (`src/lib/notification-service.ts`)
- Structured logging (pino) and a typed error system (`src/lib/errors`)

## Routes

- `GET /health`, `/health/live`, `/health/ready` — probes
- `GET /auth/me`, `POST /auth/logout` — Oxy session helpers
- `/feedback` — feedback submission
- `/notifications` — notification list + push/web-push registration

## Development

```bash
# from repo root
bun run dev:api

# or from packages/backend
bun run dev
```

## Build & test

```bash
bun run build   # esbuild bundle -> dist/index.js
bun run start   # node dist/index.js
bun run test    # Vitest
```

## Environment

Copy `packages/backend/.env.example` to `packages/backend/.env` and fill in:

- Server/CORS: `PORT`, `WEB_URL`
- MongoDB: `MONGODB_URI`
- Oxy: `OXY_API_URL`
- Redis (optional): `REDIS_URL`
- Web push (optional): `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`
