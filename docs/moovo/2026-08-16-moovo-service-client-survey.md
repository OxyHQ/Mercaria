# Mercaria's Moovo service client: what was measured, and what #156 could build

**Date:** 2026-08-16. Every measurement below is stamped, because two of them
("no run exists", "this issue is open") are the kind that expire on their own.

**Outcome:** #156 acceptance 2 — *"Mercaria authenticates as its existing Oxy
Application"* — **cannot be built today, on either side of the call.** The SDK
cannot mint a token bound to another application's audience, and Moovo exposes
no surface that would accept one. What #156 *could* build, and what this PR
contains, is the client abstraction with a fail-closed default, its
configuration and readiness rules, and the walls that stop the gap being closed
the wrong way while it is open.

---

## 1. The SDK cannot mint an audience-bound token

Measured against the installed `@oxyhq/core@19.1.0` and against
`OxyHQServices@origin/main` (`fea6d1bc`, confirmed equal to
`git ls-remote origin refs/heads/main` — the local checkout was stale and was
not read).

| Symbol | Present? |
|---|---|
| `createServiceClient` | **no** — 0 occurrences in `dist/cjs`, `dist/esm`, `dist/types`, and 0 on `origin/main` |
| `resourceApplicationId` / `clientCredentials` | **no** — 0 |
| `getServiceToken(apiKey?, apiSecret?)` | yes — `dist/types/mixins/OxyServices.auth.d.ts:354` |
| `configureServiceAuth(apiKey, apiSecret)` | yes — same file, `:334` |
| `serviceAuth({ expectedAudience? })` | yes — `dist/types/OxyServices.d.ts:115`, **inbound only** |
| `createLinkedClient(config)` | yes — `dist/types/OxyServices.d.ts:102` |

The mint path carries nothing that could name a target:

```js
// dist/esm/mixins/OxyServices.auth.js
this.makeRequest('POST', '/auth/service-token', { apiKey: key, apiSecret: secret }, {…})
```

`audience` appears only as `expectedAudience`, a **verification** input
defaulting to the hardcoded `OXY_JWT_AUDIENCE = 'oxy-api'`. So every token
Mercaria can mint today is for `oxy-api`, and there is no parameter anywhere
that would bind one to Moovo.

The zero counts are not blindness: `createLinkedClient` was found by the same
greps over the same trees, as a positive control.

**`OxyHQ/oxy#878` is OPEN and unstarted** (created 2026-08-08; `updatedAt`
equals `createdAt`). Its body proposes exactly the API #156 cites and uses
**Moovo as its worked example**. Bumping `@oxyhq/core` to the published 21.0.0
would not help — this is unwritten, not unpublished.

## 2. Moovo has no service-authenticated surface

Measured on `OxyHQ/Moovo@origin/main` = `6ed77a2d` (2026-08-11). The local
checkout at `/home/nate/Oxy/Moovo` was **50 commits behind** and was never read;
everything came from `git show origin/main:…` / `git grep … origin/main`.

- Every logistics route is `router.use(authenticateToken)` — a real Oxy **user**
  — plus an ownership check that the caller **is the sender**
  (`routes/shipments.ts:24`, `routes/jobs.ts:32`, `routes/courier.ts`).
- `oxyServiceAuth = oxyClient.serviceAuth({ debug: true })` exists at
  `middleware/auth.ts:60` and is **mounted on nothing**. Same for
  `authenticateTokenOrApiKey` (a `SERVICE_SECRET` compare that sets
  `req.userId = 'system'`), `requireScope` and `authenticateTelegramBot`. The
  only references anywhere are the definitions and their unit test.
- There is no `/internal` mount, no audience concept, no resource application
  id, no API-key store. `req.apiKey` is a declared Express augmentation nothing
  populates.

**`OxyHQ/Moovo#27` (accept canonical Oxy Application principals) and `#28`
(expose a versioned logistics service API) are both OPEN.**

## 3. Moovo IS deployed — and its own `HANDOFF.md` says otherwise

The two are in genuine conflict, so it was settled at the artefact.

Measured **2026-08-15T22:28:15Z** against `https://api.moovo.now`:

```
GET /health/ready → 200 {"status":"ready","postgres":"connected"}
GET /health       → 200 {"status":"healthy","postgres":"connected","redis":"connected","uptime":423146}
GET /             → 200 {"message":"Moovo API","version":"1.0.0","endpoints":[…]}
```

Live AWS (read-only, profile `oxy`, us-west-2): ECS service `moovo` on cluster
`oxy-cluster` is `ACTIVE`, desired 1 / running 1, task definition `oxy-moovo:3`,
running since 2026-08-11; ALB rule priority 120 on host `api.moovo.now`; target
`10.20.1.79` healthy; one SSM parameter, `/oxy/moovo/DATABASE_URL`.

Moovo's `HANDOFF.md` §3 still says the ECS service, task definition, ALB rule
and SSM wiring "must be provisioned in `oxy-infra`" and that the deploy workflow
"skips the ECS step". **That document is stale.** It is recorded here because
the next person to read it will otherwise reach the opposite conclusion from the
one the running system supports.

Note the endpoint list the live root returns independently confirms the route
survey: no `/internal`, no `/events`, no transport-service surface.

## 4. The eight operation families #156 asks for

Verdicts against `origin/main`, with what each was grepped for.

| Family | Verdict |
|---|---|
| Serviceability | **absent** — `serviceability\|serviceable\|coverage-area` → 0 hits. `company_service_areas` is a courier company's *declared* areas, read only by its own CRUD; `dispatch.service.ts` never consults it. |
| Quotes | **exists, not standalone** — generated synchronously inside `POST /shipments` (`shipment.service.ts` → `await quoteShipment(created)`); `GET /shipments/:id/quotes` is a pure read. There is no "price this hypothetical move", and a quote requires a persisted row owned by the calling **user**. |
| Transport create / read / cancel | **exists** — `POST/GET /shipments`, `GET /shipments/:id`, `POST /shipments/:id/cancel`. All caller-scoped. |
| Package allocation | **absent** — no `packages` table among the 34 in migration `0000`; `ParcelDetails` carries `pieces: number` and one bounding dimension. `manifest`, `waybill` → 0 hits. |
| Booking | **exists** — `POST /shipments/:id/book`, body `{quoteId, idempotencyKey?}`. |
| Labels | **absent** — `label` matches only `vehicle.label`, `address.label` and an inherited marketplace text column. `ProviderBooking` returns `{bookingRef, trackingUrl?}`. |
| Tracking import / reconcile | **absent** — `ProviderAdapter.track()` is *outbound* to a carrier. No inbound tracking endpoint; the only webhook in the app is `/webhooks/crowdsource`. `reconcile` → 0 hits. |
| Returns | **absent** — no reverse leg is representable; `ShipmentStatus` has no member for one. |
| Event ack / reconcile | **absent for logistics** — the only event ingress is CrowdSource moderation. |
| Health / readiness | **exists** — `/health`, `/health/live`, `/health/ready`. |

Four of the eight do not exist in any form; two more exist only in a shape that
is not a service boundary.

## 5. The types are unreachable

`@moovo/shared-types` is `"private": true` with no `publishConfig`;
`npm view @moovo/shared-types` → `E404`. It exports the DTOs Mercaria would
want (`Shipment`, `Quote`, `Job`, `ProviderQuote`), and every money field is
`FairMoney` — FAIR minor units, with no `DualMoney`. There is no OpenAPI
document anywhere in the repo (`openapi|swagger` → 0 hits) and no generated
client.

---

## 6. What this PR therefore builds, and what it refuses to build

### Built

- **`services/moovo/` — one typed client module.** Idempotency derived from
  #126's `sourceReference`, a fresh correlation id per attempt, one bounded
  retry policy, one normalization of every failure, redaction, and per-operation
  metrics. Driven in tests through a fake transport, so the policy under test is
  the production policy.
- **A transport PORT whose default is unregistered**, with the blockers carried
  as a value so a refusal names them.
- **Configuration and readiness rules**, where a misconfiguration is a hard
  failure that reports every problem at once.
- **Five scanned walls** (`moovo-client-isolation.test.ts`), each with a
  mutation self-test and a vacuity floor.

### Deliberately NOT built

- **No `MOOVO_CLIENT_ID` / `MOOVO_CLIENT_SECRET`.** #156 item 5 asks for them
  and they will come — but the only token today's SDK can mint carries audience
  `oxy-api`, so a credential configured now could only be used to send a
  **wrong-audience token** to Moovo. That is the confused-deputy shape audience
  binding exists to prevent, and a secret in the environment that cannot be used
  correctly is a secret with no upside.
- **No token cache and no verifier.** Acceptance 4 forbids both, and writing one
  to work around §1 would be exactly the duplicate `oxy#878` exists to remove.
- **No wire shapes.** The transport port stops at Mercaria's own types. Guessing
  Moovo's request and response bodies would produce a client that type-checks
  against a guess.
- **No registration of the logistics port without a transport.** Measured:
  `isMoovoBookingAvailable()` feeds `chooseFulfilmentMode`'s
  `moovoBookingAvailable`, and a `true` makes Mode A the **chosen** mode — so a
  port that refuses every call would strand paid orders that would otherwise
  fall back to Mode B (a supplier booking its own carrier, which #126 calls a
  complete fulfilment path). The fail-closed state is no port at all.

### The wrong way to close this, named so nobody takes it

The one route from Mercaria to Moovo that **works right now** is forwarding a
buyer's own Oxy bearer through `createLinkedClient`, because Moovo's logistics
routes authenticate a user and check that the caller is the sender. It would
look exactly like a working integration. It is impersonation, #156 acceptance 3
forbids it, and WALL 3 of `moovo-client-isolation.test.ts` fails the build on
it.

---

## 7. What would close each remaining criterion

| # | Criterion | What closes it |
|---|---|---|
| 2 | Mercaria authenticates as its Oxy Application | `OxyHQ/oxy#878` ships `createServiceClient`; then the credential variables and one transport module. |
| 5 | Environment and audience enforced by default | Half of it is here (environment, base URL, resource id). The audience half is `oxy#878`. |
| 6 | Retry/idempotency appropriate to each command | Present as policy; becomes observable when a transport exists. |
| 8 | A mocked and a real canary use the same client contract | The mocked half is the fake transport in `moovo-client.test.ts`; the canary half needs `OxyHQ/Moovo#27`/`#28`. |

Operation families beyond create/read/cancel/book additionally need Moovo to
build them: serviceability, package allocation, labels, returns and a logistics
event feed do not exist there at all.
