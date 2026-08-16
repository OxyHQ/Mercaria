# Auth: there is no Mercaria service principal (#164)


`middleware/auth.ts` is three exports — `oxyClient`, `authenticateToken`,
`optionalAuth` — all composed from `@oxyhq/core/server`, with nothing locally
implemented. #164 deleted the whole legacy surface as a clean cut:
`SERVICE_SECRET` and its `authenticateTokenOrApiKey` (a shared-secret bearer
compare that set `req.userId = 'system'` and an `appId: 'internal'` no Oxy
Console grant describes), `authenticateTelegramBot` (a second shared secret that
took the acting user's id from the `x-oxy-user-id` HEADER, so one env var
impersonated any account), the local `requireScope` over an `req.apiKey` bag
nothing populated, and the `apiKey`/`serviceApp`/`workspace` Express
augmentations.

- **All of it was UNMOUNTED, and that is the point rather than a reprieve.**
  Every `/internal/*` router runs `authenticateToken` plus one of the
  `*_OPERATOR_OXY_USER_IDS` allow-lists (measured 2026-08-16: SEVEN — payment,
  catalog, guest, analytics, retail, procurement, referral. This said EIGHT
  until 2026-08-16, from a `require[A-Za-z]*Operator` grep that also matched
  `requireResponsibleOperator`, a BOOLEAN FIELD on a retail-eligibility policy
  row and not a gate at all. The enumeration is in `AGENTS.md`; count them from
  `config/index.ts`, never quote a remembered number — including this one),
  so no route reached any of it — which is exactly why no
  behavioural test could defend the removal and why it had to go: each was one
  `router.use(...)` from authorizing everything, outside grant audit, with
  rotation and revocation local to a deployment.
- **A real Oxy-to-Oxy caller (#156/#158) mounts `oxyClient.serviceAuth(...)` on
  the route that needs it**, against a credential issued to a registered
  Application, reading the principal off the SDK's own `OxyAuthRequest`. There
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

