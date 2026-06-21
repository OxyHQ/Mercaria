# Mercaria — Project Conventions

Mercaria is a buy/sell app by [Oxy](https://oxy.so) — users buy and sell both
**new** items (from shops) and **secondhand** items (from people), eBay / Wallapop
style. This repo currently contains the **base shell** only; the marketplace
domain (listings, buy/sell, shops, search) is built on top of it.

See `HANDOFF.md` for the deferred work (infra, Oxy client registration, the domain).

## Monorepo Structure

- `packages/frontend/` — Expo app (React Native + Web), expo-router, NativeWind 5
- `packages/backend/` — Express backend API (TypeScript, MongoDB/Mongoose, Socket.IO)
- `packages/shared-types/` — `@mercaria/shared-types`: TypeScript domain DTOs
  (`Listing`, `ListingCondition`, `Seller`, `Money`, `ApiResponse`, pagination)
  shared by both frontend and backend. Build with `bun run build:shared-types`.

Bun workspaces. **Always use `bun`, never npm/yarn. Use `bunx`, not `npx`.**

## Tech Stack

- **Frontend**: Expo SDK 56, React Native 0.85.3, NativeWind 5 (Tailwind v4 + postcss), Reanimated, Zustand, TanStack Query, expo-router (file-based)
- **Backend**: Express, TypeScript, MongoDB/Mongoose, Redis (optional), Socket.IO
- **Auth**: `@oxyhq/core` (incl. `@oxyhq/core/server`), `@oxyhq/services` (`OxyProvider`, `useOxy`/`useAuth`), `@oxyhq/auth` where the web SSO RP provider is used
- **UI**: `@oxyhq/bloom` shared component library (`BloomThemeProvider`, `useTheme`, `ImageResolverProvider`, etc.)

## MongoDB Database Naming

All Oxy ecosystem apps share the same MongoDB cluster. Each app uses its own
database named `{appName}-{NODE_ENV}` (here: `mercaria-production`). The
`dbName` is passed to `mongoose.connect()` (see `packages/backend/src/lib/db.ts`), NOT
embedded in `MONGODB_URI`.

## Oxy Auth / Session Contract (do not reinvent)

- Frontend auth/session state belongs to the Oxy SDK providers with a registered
  `clientId` (`EXPO_PUBLIC_OXY_CLIENT_ID`). The SDK cold boot owns the
  `/__oxy/sso-callback` consume, stored-session restore, FedCM/silent restore,
  and the SSO bounce. Apps are zero-config.
- Do NOT add app-local SSO helpers, callback routes, token providers, auth
  interceptors, manual `Authorization` plumbing, refresh retries, or session
  invalidation. SSO helpers live ONLY in `@oxyhq/core`.
- The web SSO callback bootstrap is injected in `app/+html.tsx` via
  `getSsoCallbackBootstrapScript()` from `@oxyhq/core`.
- Backend APIs use `@oxyhq/core/server`: `createOxyAuthMiddleware`,
  `createOptionalOxyAuth`, `createOxyRateLimit`, `requireOxyAuth`,
  `getRequiredOxyUserId`, and `authSocket` (see `packages/backend/src/middleware/auth.ts`).
  Do NOT define app-local `AuthRequest`, `requireAuth`, `getUserId`, bearer
  parsers, or token-decoding middleware.
- Bearer-authenticated writes do NOT fetch app-local CSRF tokens.

## Quality Standards

- Production-grade, clean, scalable code. No hacks, no workarounds, no half-baked
  solutions. Fix root causes.
- NEVER use `as any`, `@ts-ignore`/`@ts-expect-error`, non-null `!` assertions,
  silent `catch {}`, `var`, `console.log` debugging, or hardcoded URLs/keys/magic
  numbers. NEVER leave TODO/FIXME/HACK comments.
- Avoid `useEffect` for data — prefer derived state, event handlers, `useMemo`, or
  TanStack Query.
- Fix bugs in shared packages (`@oxyhq/core`, `@oxyhq/services`, `@oxyhq/bloom`)
  UPSTREAM, never patch downstream in this app.
- After installing/updating packages, run `bun install` and commit the updated
  `bun.lock` in the SAME commit as the `package.json` change.

## Display Names (API contract)

Render `name.displayName` from Oxy user/profile DTOs directly. Do NOT recompute
names from `name.first`/`name.last`/`name.full` or add local
`displayName || username` fallbacks.

## Deploy

- **API** → AWS ECS Fargate via `.github/workflows/deploy-aws.yml` (builds
  `linux/arm64`, pushes to ECR, force-new-deployment). The ECS service +
  task def + ALB rule + ECR repo + SSM params must be provisioned in `oxy-infra`
  first (handoff).
- **Web** → Cloudflare Pages via `.github/workflows/deploy-cloudflare.yml`
  (Expo web export → `pages deploy`). The CF Pages project + DNS must be created
  first (handoff).
- CI (`.github/workflows/ci.yml`) runs lint + tests + API build + app build on
  every push/PR. Bun is pinned to `1.3.14` everywhere a lockfile is consumed.
