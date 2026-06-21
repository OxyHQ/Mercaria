# Contributing to Mercaria

## Prerequisites

- **Bun 1.3.14** (the pinned package manager — never use npm/yarn)
- **Node.js 22** (runtime for the built API)
- **MongoDB** (local or remote)
- **Redis** (optional — rate limiting and Socket.IO scaling fall back gracefully without it)

## Getting Started

```bash
git clone git@github.com:OxyHQ/Mercaria.git && cd Mercaria
bun install                                # installs all workspaces
cp packages/backend/.env.example packages/backend/.env      # fill in your values
bun run dev:api                             # API only
bun run dev:app                             # Expo app only
```

## Monorepo Structure

This is a **bun workspaces** monorepo.

| Package | Stack | Purpose |
| --- | --- | --- |
| `packages/backend` | Express + TypeScript | Core API runtime |
| `packages/frontend` | Expo (SDK 56, React Native + Web) | Main app (web + iOS + Android) |
| `packages/shared-types` | TypeScript | Domain DTOs shared by frontend + backend |

## Branch Naming

```
feat/short-description
fix/short-description
refactor/short-description
```

Always branch from `main`.

## Commit Messages

Use [conventional commits](https://www.conventionalcommits.org/):

```
feat: add listing creation flow
fix: correct token refresh race condition
refactor: extract feed query into shared hook
docs: update deployment guide
test: add integration tests for listings API
chore: bump dependencies
```

## Pull Request Process

1. Create a branch from `main` with the naming convention above.
2. Keep PRs focused — one feature or fix per PR.
3. Write a descriptive PR summary (what changed and why).
4. Ensure CI passes (lint + tests + API build + app build) before requesting review.

## Code Style

- **TypeScript strict mode.** Avoid `any` — use proper types. No `@ts-ignore`, no non-null `!` assertions.
- **Frontend styling**: NativeWind (Tailwind). No inline style objects where a class exists.
- **State management**: Zustand stores. Data fetching via TanStack Query (avoid `useEffect` for data).
- **Routing**: expo-router (file-based) in `packages/frontend`.
- **Auth**: backend uses `@oxyhq/core/server` middleware; frontend uses the Oxy SDK providers. Do not hand-roll SSO/session/auth code — it belongs in the shared SDK.
- Follow existing patterns. When in doubt, look at neighboring files.

## Testing

```bash
bun run --filter @mercaria/backend test
```

Tests use **Vitest**. Place test files next to source as `*.test.ts`.

## Database

MongoDB with Mongoose. Database name follows `mercaria-{NODE_ENV}`. The connection URI is shared across the Oxy ecosystem — the `dbName` is passed to `mongoose.connect()`, not embedded in the URI.
