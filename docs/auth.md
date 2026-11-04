# Auth: there is no Mercaria service principal (#164)


`middleware/auth.ts` is three exports — `oxyClient`, `authenticateToken`,
`optionalAuth` — all composed from `@oxy.so/core/server`, with nothing locally
implemented. `oxyClient` is the ONE `OxyServer` in the process: Mercaria's own
workload identity, its `applicationId`, `serviceIdentity: 'when-anonymous'` and
the service-token `expectedAudience` every auth mount accepts, named once.
`OXY_API_URL` is read once, in `config/oxy-identity.ts`. #164 deleted the whole legacy surface as a clean cut:
`SERVICE_SECRET` and its `authenticateTokenOrApiKey` (a shared-secret bearer
compare that set `req.userId = 'system'` and an `appId: 'internal'` no Oxy
Console grant describes), `authenticateTelegramBot` (a second shared secret that
took the acting user's id from the `x-oxy-user-id` HEADER, so one env var
impersonated any account), the local `requireScope` over an `req.apiKey` bag
nothing populated, and the `apiKey`/`serviceApp`/`workspace` Express
augmentations.

- **All of it was UNMOUNTED, and that is the point rather than a reprieve.**
  Every `/internal/*` router runs `authenticateToken` plus one of the seven
  operator gates in `middleware/operator-authz.ts` — Oxy APPLICATION ROLES
  (`payments.operate`, `catalog.operate`, `guest.operate`, `analytics.operate`,
  `retail.operate`, `procurement.operate`, `referrals.operate`) read with
  `oxyClient.middleware.requireAppPermission`; the enumeration is
  `OPERATOR_PERMISSIONS` there, so count from the code, never a remembered
  number — so no route reached any of it — which is exactly why no
  behavioural test could defend the removal and why it had to go: each was one
  `router.use(...)` from authorizing everything, outside grant audit, with
  rotation and revocation local to a deployment.
- **A real Oxy-to-Oxy caller (#156/#158) mounts `oxyClient.middleware.service()`
  on the route that needs it** (the audience is the client's own
  `expectedAudience`), reading the principal off the SDK's own `OxyAuthRequest`. There
  is deliberately NO pre-exported unmounted service-auth middleware to reach
  for. Never build a second verifier.
- **A provider webhook is a different principal.** Stripe, Shopify, WooCommerce,
  CrowdSource and supplier callbacks verify their own signatures on their own
  raw-body mounts; none may be satisfied by an Oxy credential, or the reverse,
  because it arrives as a bearer-shaped string.
- **`ANALYTICS_INTERNAL_TRAFFIC_TOKEN` is NOT auth** and was deliberately kept:
  it classifies a request as internal so it leaves the quality metrics (#77) and
  authorizes nothing.
- **`middleware/__tests__/service-auth-retirement.test.ts`** fails the build on
  any of it returning — four scans over comment-stripped tracked source plus the
  env template and the deploy workflow, with a vacuity floor and a mutation
  self-test. `auth.ts` and the gate are excluded BY PATH, since both explain the
  prohibition in the vocabulary the detectors match.
- **The infra half is OWED and the ORDER is load-bearing.** `oxy-mercaria:3`
  still names `SERVICE_SECRET` (measured 2026-08-16) and
  `/oxy/mercaria/SERVICE_SECRET` still exists; the repo no longer reads or syncs
  it. oxy-infra must drop the entry from the task definition and roll out BEFORE
  the SSM parameter or the GitHub secret is deleted — a task definition naming a
  parameter that is gone fails at task START with `ResourceInitializationError`,
  on the next scale-up rather than immediately.


## Store access is Oxy's answer, asked with the caller's bearer (ADR 0012)

Who may act for a store is a role on the Oxy account that owns it, never a
Mercaria list. `services/store-access.service.ts` asks with the CALLER's own
session through the SDK: `oxyClient.accountAccessFor(caller, accountId, { fresh })`
for one account and `oxyClient.withUser(bearer, (user) => user.accounts.list())`
for the store list — never by setting a token on the shared `oxyClient`. A
delegated session (a person operating an organization) is authorized as its
human operator, which is also how Oxy answers it; only an undelegated session
that IS the owning account skips the round trip. Outcomes are the SDK's one
mapping (`lib/errors/oxy-access.ts`): 401 → sign in again, 403/404 → no access,
anything else → `503 SERVICE_UNAVAILABLE`. Only positive answers are cached
(per session, 30 s, in the SDK); a refusal or outage is never remembered, and
every write asks fresh. Giving an account a store needs Oxy's `account:update`
there (its owners and admins) — a permission, never a role name. The model, routes and runbook are
[stores.md](stores.md).


## Operator desks are application roles

`/internal/*` is mounted on every deployment and each desk is gated on its own
key (`middleware/operator-authz.ts`), declared on Mercaria's Oxy application and
granted to people by the owning account's owners and admins in the Oxy Console
(append-only, audited, never to themselves). A non-holder — or a request with
no person, including any service token — is answered 404; an Oxy outage is 503
and never remembered; a write asks Oxy fresh. Record `operatorId(req)` (the
human Oxy resolved) as the actor. There are no `*_OPERATOR_OXY_USER_IDS`
variables; the deploy strips any an earlier task revision still carries.
