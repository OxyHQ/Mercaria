# House invariants

> Moved out of `AGENTS.md`. These recur in every domain of this codebase; a
> domain doc states only its own delta. Schema decisions are
> `packages/backend/src/db/schema/CONVENTIONS.md`.

- **ONE stored verdict per fact.** Two representations of one fact can disagree.
  Where the inputs sit on tables the domain does NOT own, DERIVE at read time
  instead (`deriveNativeCheckoutEligibility`, the retail eligibility verdict,
  seller-profile visibility) — that is what makes a moderation restriction or a
  recall bite in the statement that applies it, with no sweep in between.
- **Closed value sets are `text` + CHECK rendered from the shared-types tuple**,
  never a pg `enum`. A prohibition is modelled as a vocabulary DISJOINT from the
  allowed one, so the forbidden thing has no row shape — plus a scanned
  isolation test with a vacuity floor and a mutation self-test.
- **Payloads, metadata and DTOs are ALLOW-lists that REFUSE**, never deny-lists
  that strip. A deny-list is correct only until the provider adds a field, which
  is exactly when a sensitive one appears.
- **A flag gates the LOOP or the MOUNT, never a durable record.** Half-configured
  is OFF. An operator surface stays mounted while its loop is off — the evidence
  has to be readable during the incident that turned the loop off.
- **An outbox row IS the job:** deterministic id, claims are leases with an owner
  check (`FOR UPDATE SKIP LOCKED`), capped exponential backoff, visible
  `dead_letter`.
- **Every `enqueue*` takes its database handle as a REQUIRED parameter** — never
  `= getDb()`, never `db?`, and never `db ?? getDb()` in the wrapper above it.
  The root `Database` and a transaction share the one `DatabaseOrTransaction`
  type, so a default makes "I forgot to thread `tx`" compile, and the write lands
  outside the transaction the caller believed it was in. A caller with no
  transaction passes `getDb()` and says so.
  `outbox-enqueue-handle-census.test.ts` (#584). Required is NECESSARY and not
  SUFFICIENT: under `strict: false` an `undefined` satisfies a required
  parameter, so a caller whose OWN handle is optional coalesces at the call site
  (`tx ?? getDb()`) — measured, a bare optional `tx` type-checked and silently
  materialized nothing.
- **An enqueue whose only wrapper SWALLOWS exceptions cannot be guarded at
  runtime — the compile error is the only mechanism that survives the `catch`.**
  `requireTransaction` is the right guard for the moderation outbox, whose caller
  lets the throw out. It is INERT on the two catalogue queues: `requestMatch` and
  `requestNativeOfferSync` catch everything by design, so a catalogue write cannot
  fail because a projection could not be queued (#58 operations 4) — and a guard
  that throws there produces a WARN line and a lost job. The same `catch` is why
  the foreign key that makes `offer_outboxes` refuse an uncommitted listing
  (`23503`) is not loud either. Check what a guard's exception does two frames up
  before choosing one; `match_queue` has no mandatory FK at all, so nothing but
  the signature stands between it and a silent write.
- **A defaulted handle is the house convention for a READ or a dispatcher's own
  lifecycle statement** — ~1138 of them across 160 files in `db/` — and the
  enqueues are the deliberate exception, not an inconsistency. The line is
  whether the row must commit with a subject the CALLER is writing. `claim*`,
  `complete*` and `release*` are the worker's own statements and belong to no
  caller's transaction; `find*` and `summarize*` are reads. Only an enqueue owes
  atomicity to somebody else's write.
- **Idempotency is a partial unique index plus `ON CONFLICT DO NOTHING
  RETURNING`** — the empty result set IS the "already claimed" answer, so a real
  failure still propagates. Repeat the index's `WHERE` predicate on every
  `ON CONFLICT`, or Postgres refuses to infer the arbiter.
- **`cardinality(col) >= 1`, never `array_length(col,1) >= 1`** — on an empty
  array the latter is NULL and a CHECK reads NULL as SATISFIED, admitting exactly
  the row it refuses. Measured three times in this schema.
- **A "present exactly when" CHECK over several columns is TWO biconditionals,
  not one over their conjunction** — the conjunction is satisfied when both sides
  are false, which is the row the rule exists to forbid.
- **The backend compiles `strict: false`.** Without `strictNullChecks` TypeScript
  does not narrow a union on a boolean-literal discriminant, so every
  discriminated union uses a STRING discriminant.
- **A provider id is NEVER a Mercaria primary key** — a plain indexed column;
  their key space changes between test and live mode.
- **Immutability is a trigger.** Append-only means UPDATE *and* DELETE unless
  retention requires the DELETE (analytics, price history, snapshots), in which
  case say so — a trigger refusing it makes the retention sweep fail silently.
- **A versioned wire contract, never a `@deprecated` alias.** A shipped mobile
  build cannot be recalled; state `retiresWhen` and keep serving both. Register
  it in `backend/src/__tests__/v1-wire-contracts.ts` — the population is DERIVED
  from the docblocks, so an unregistered one fails the census, and an entry with
  no `provenBy` moves an exact count somebody has to justify. Prove it at the
  ENTRY POINT: the v1 condition projection was pinned exhaustively as a pure
  function while the hydration call served a constant, and all 10,500 tests were
  green.
- **Four eyes** (`CATALOG_FOUR_EYES_REQUIRED` and its siblings) is the ROW's
  shape — approvers differing from each other and from the requester, held by a
  CHECK or a partial unique, never by a service comparison.
- **Isolation between domains is a TEST**, not a convention
  (`*-isolation.test.ts`): ranking may not read fees or referrals, the payment
  domain may not read procurement, a claim path may not reach referrals, and so
  on. It scans RAW source (comments included) with a file-count floor.
- **Closing a seam means sweeping the COMMENTS that cited it — that is where the
  work is.** #93 closed four named seams; six modules elsewhere stated as fact
  that pickup was refused at checkout, and after landing every one of those
  sentences was false. A false sentence in a comment is the one thing no gate
  catches: `tsc` and the test suite are both blind to prose. Grep every symbol,
  issue number and claim the closed seam's code cited BEFORE it closed, in
  comments and docs as well as code, and re-decide rather than re-word each one
  — some need a genuine new decision (a refusal that stands for a DIFFERENT
  reason now), not just updated wording.

## Raw-body mounts

Four routers must stay mounted BEFORE `express.json()` in `app.ts`, and one more
route buffers its own body:

`/channels/webhooks` · `/webhooks/crowdsource` · `/webhooks/stripe` and
`/webhooks/stripe/connect` · `/webhooks/suppliers/:supplierAccountId`, plus the
feed-import upload route (`express.raw`, refuses a JSON content type).

Asserted against the REAL middleware chain by
`routes/__tests__/stripe-webhook.integration.test.ts`. `app.ts` exists so the app
can be built without listening, which is what makes that assertion possible.

## Operator allow-lists

Every internal surface is gated by an explicit Oxy-user-id allow-list. **Empty is
a working configuration and means the router is NOT MOUNTED (404, never 401).**
There are SEVEN. **A new surface joins the list whose power it already shares** —
a new list is justified only by a power none of these grants, and the code
records two that were refused on exactly that test (there is deliberately no
`MERCHANT_DEMAND_OPERATOR_OXY_USER_IDS` and no `SEO_OPERATOR_OXY_USER_IDS`).

| Variable | Surface |
|---|---|
| `PAYMENT_OPERATOR_OXY_USER_IDS` | `/internal/payments/*` (incl. fee schedules, retail-pricing policies) |
| `CATALOG_OPERATOR_OXY_USER_IDS` | every catalogue surface: commerce-graph, offers, matching, ingestion, backfill, attributes, condition, eBay, Awin, feed-imports, offer-freshness, product-saves, price-history, price-alerts, price-signals, search, search-intent, SEO |
| `GUEST_OPERATOR_OXY_USER_IDS` | `/internal/guest-commerce/*` (cart merge, portal, claims, buyer requests, P2P) |
| `ANALYTICS_OPERATOR_OXY_USER_IDS` | `/internal/analytics/*`, and the merchant-demand acquisition pipeline |
| `RETAIL_OPERATOR_OXY_USER_IDS` | `/internal/retail-eligibility/*` |
| `PROCUREMENT_OPERATOR_OXY_USER_IDS` | `/internal/supplier-preflight/*`, `/internal/procurement/*`, `/internal/retail-pilot/*` |
| `REFERRAL_OPERATOR_OXY_USER_IDS` | `/internal/referrals/*` — pausing attribution stops partners EARNING, and approving a payout batch is ADR 0005 D14's second pair of eyes (`approved_by <> created_by`, so one populated account cannot approve its own batch) |

The payment gate is INTERIM: store permissions are scoped to a store by
construction, so none can express "may see all stores' money" without becoming
one an owner could grant themselves. `resolvePaymentOperatorIds` and
`requirePaymentOperator` are the two places that change when Oxy grows a platform
operator role.
