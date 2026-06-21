# Mercaria

A buy/sell marketplace by [Oxy](https://oxy.so) — for new items from shops and secondhand items from people (eBay / Wallapop style).

This repository is the **base shell**: the proven Oxy Expo + Express monorepo with Oxy auth/SSO, Socket.IO, TanStack Query, NativeWind, and deploy CI wired up. The marketplace domain (listings, buy/sell, shops) is built on top of this base.

> See [`HANDOFF.md`](./HANDOFF.md) for what is intentionally deferred (infra, Oxy client registration, the marketplace domain).

## Stack

- **Frontend**: Expo (SDK 56) + React Native Web + NativeWind 5 (Tailwind v4) + Reanimated + Zustand + TanStack Query
- **Backend**: Express + TypeScript + MongoDB/Mongoose + Redis (optional) + Socket.IO
- **Auth**: Oxy (`@oxyhq/core`, `@oxyhq/services`, `@oxyhq/auth`) — SSO/cold-boot handled entirely by the SDK
- **UI**: `@oxyhq/bloom` shared component library
- **Infra**: AWS ECS Fargate (API) + Cloudflare Pages (web) — see `HANDOFF.md`

## Monorepo

```
apps/
  app/   # Expo cross-platform app (web + iOS + Android)
  api/   # Express backend API
```

This is a **bun workspaces** monorepo. Use `bun` (never npm/yarn) and `bunx` (never npx).

## Development

```bash
bun install
cp packages/backend/.env.example packages/backend/.env   # fill in your values
bun run dev:api    # start the API (Express) on :3001
bun run dev:app    # start the app (Expo)
```

## Build & verify

```bash
bun run build:backend  # esbuild bundle -> packages/backend/dist/index.js
bun run build:frontend  # Expo web export -> packages/frontend/dist
```

Type-check:

```bash
cd packages/backend && bunx tsc --noEmit
cd packages/frontend && bunx tsc --noEmit
```

## Tests

```bash
bun run --filter @mercaria/backend test   # Vitest
```

## Conventions

- TypeScript-first. No `as any`, no `@ts-ignore`, no non-null `!` assertions.
- Frontend styling via NativeWind classNames (not inline styles where a class exists).
- State via Zustand; data fetching via TanStack Query; routing via expo-router.
- Backend auth uses `@oxyhq/core/server` middleware — do not hand-roll auth.
- MongoDB database name follows `mercaria-{NODE_ENV}` (passed to `mongoose.connect()`).
