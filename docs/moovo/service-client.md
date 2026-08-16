# Mercaria's Moovo service client (#156)

> Moved out of `AGENTS.md` unchanged. The dated survey with citations is
> `docs/moovo/2026-08-16-moovo-service-client-survey.md`.


`services/moovo/` (5 modules) + the `moovo` config block. **NO new tables, NO
migration, and the logistics port is NOT registered on any deployment.** Full
survey with citations and timestamps:
**`docs/moovo/2026-08-16-moovo-service-client-survey.md`**. #126 published
`MoovoLogisticsPort` as a fail-closed seam; this is the client that will satisfy
it, plus the measurement of why it cannot yet.

- **#156 acceptance 2 is UNBUILDABLE on BOTH sides, measured 2026-08-16.**
  `@oxyhq/core@19.1.0` has no `createServiceClient` and no audience-aware mint:
  `getServiceToken()` POSTs `{apiKey, apiSecret}` to `/auth/service-token` and
  every token it returns carries the hardcoded `oxy-api` audience, with
  `audience` appearing only as the VERIFICATION-side `expectedAudience`.
  `OxyHQ/oxy#878` is OPEN and unstarted, and its own body uses Moovo as the
  worked example. On the other side, every Moovo logistics route is
  `authenticateToken` (a real Oxy USER) plus "the caller IS the sender";
  `oxyServiceAuth` is exported at `middleware/auth.ts:60` and **mounted on
  nothing**. `OxyHQ/Moovo#27` and `#28` are OPEN.
- **Moovo IS deployed and its own `HANDOFF.md` denies it.** Measured
  2026-08-15T22:28Z: `api.moovo.now` answers 200 on `/health/ready`, ECS service
  `moovo` runs `oxy-moovo:3` desired 1 / running 1, ALB rule priority 120, target
  healthy. `HANDOFF.md` §3 still says the ECS service and ALB rule "must be
  provisioned". **The document is stale; the running system is the artefact.**
- **NO client id or secret variable, deliberately.** #156 item 5 asks for them,
  and the only token today's SDK can mint is audience `oxy-api` — so a credential
  configured now could only send a WRONG-AUDIENCE token to Moovo, the
  confused-deputy shape audience binding exists to prevent. The variables arrive
  with the transport that can use them correctly.
  `MOOVO_RESOURCE_APPLICATION_ID` is NOT that credential and IS required when
  enabled: which Moovo is being addressed may never be implicit.
- **A configured client with NO transport is NOT registered, and that is
  measured rather than stylistic.** `isMoovoBookingAvailable()` is an identity
  comparison against the refusing default and feeds `chooseFulfilmentMode`'s
  `moovoBookingAvailable`; a `true` makes Mode A the CHOSEN mode. A port that
  refused every call would therefore strand paid retail orders that would
  otherwise fall back to Mode B — a supplier booking its own carrier, which #126
  calls a complete fulfilment path. **The fail-closed state is no port at all,
  not a port that refuses**, which is the one place this domain diverges from the
  `guest-portal`/`price-alerts` empty-registry precedent.
- **Ambiguity OUTRANKS the failure class, and checking the class first is the
  natural spelling.** A 500 on a booking classifies `provider_unavailable`, which
  reads as "retry" — and retrying a booking that succeeded is one paid order
  becoming two parcels. `moovoRetryDisposition` tests the write-plus-ambiguity
  conjunction FIRST; a transport that THROWS is `afterWrite: 'unknown'`, treated
  exactly as `yes`. `MOOVO_UNAVAILABLE_REASONS` gained
  `provider_outcome_ambiguous` for this and it must never be collapsed into
  `provider_unreachable`: both mean "no answer" and they license OPPOSITE next
  actions. Mutation-tested — disarming the conjunction turns three cases red.
- **A provider's free text is UNREPRESENTABLE, and a character-scrubber does not
  work.** `MoovoTransportFailure` has four members and none is a message. One
  was written first, with an allow-list redactor stripping punctuation and long
  digit runs, and `"Rejected for Buyer Name at Calle Mayor 4"` passed straight
  through it — a street and a person are ordinary letters. Worse, the assertion
  beside it (`.not.toContain('Calle Mayor')`) passed VACUOUSLY because the
  redactor lower-cased its own output; only the case-insensitive sibling caught
  it. What survives is the status plus `redactMoovoProviderCode`, which drops
  anything containing whitespace rather than truncating it. **Every
  privacy assertion in that suite is case-insensitive for this reason.**
- **The idempotency key is DERIVED from #126's `sourceReference` and is never
  logged**; the per-ATTEMPT `correlationId` is, because it identifies nothing and
  is what an operator takes to Moovo. Two racers compose byte-identical keys.
- **The transport port stops at Mercaria's OWN types.** `@moovo/shared-types` is
  `private: true` and 404s on npm, there is no OpenAPI document, and the service
  API is `Moovo#28` — so the wire shapes are unknown and inventing them would
  produce a client that type-checks against a guess. Four of #156's eight
  operation families (serviceability, package allocation, labels, returns) do not
  exist at Moovo in any form; quotes exist only INSIDE `POST /shipments` and
  require a row owned by the calling user.
- **The wrong way to close this is available today and is a scanned gate.**
  Forwarding a buyer's own bearer through `createLinkedClient` WOULD reach
  Moovo's routes and would look like a working integration; it is impersonation
  (#156 acceptance 3). `moovo-client-isolation.test.ts` is five walls — carrier
  client, outbound HTTP, buyer impersonation, duplicate token cache/verifier,
  environment credential — each with a mutation self-test and a vacuity floor.
- Env: `MOOVO_ENABLED` (default false; gates a REGISTRATION, never a durable
  record), `MOOVO_BASE_URL` (no default, HTTPS with **no localhost exemption**),
  `MOOVO_RESOURCE_APPLICATION_ID`, `MOOVO_ENVIRONMENT` (no default and no
  fallback member — an unrecognised value is a hard failure, because reading a
  typo as a default points a production deployment at a rehearsal),
  `MOOVO_SCOPES`, `MOOVO_TIMEOUT_MS`, `MOOVO_MAX_ATTEMPTS`,
  `MOOVO_RETRY_BASE_DELAY_MS`, `MOOVO_RETRY_MAX_DELAY_MS`. A misconfiguration
  THROWS and reports EVERY problem at once; the refusal never echoes the resource
  application id.
- Seams: **`OxyHQ/oxy#878`** (the audience-aware client — one transport module
  plus the credential variables, and nothing else here changes), **`OxyHQ/Moovo#27`/`#28`**
  (the principal and the API), **#157** (the aggregate and projection), **#158**
  (the event inbox), **#159** (quotes, bookings, labels, return transport).
