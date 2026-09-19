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

Five routers must stay mounted BEFORE `express.json()` in `app.ts`, and one more
route buffers its own body:

`/channels/webhooks` · `/webhooks/crowdsource` · `/webhooks/stripe` and
`/webhooks/stripe/connect` · `/webhooks/peable` (ADR 0009) ·
`/webhooks/suppliers/:supplierAccountId`, plus the feed-import upload route
(`express.raw`, refuses a JSON content type).

Asserted against the REAL middleware chain by
`routes/__tests__/stripe-webhook.integration.test.ts` and
`routes/__tests__/peable-webhook.integration.test.ts`. `app.ts` exists so the app
can be built without listening, which is what makes that assertion possible.

**The assertion is PER MOUNT, and that is why there are two files rather than a
shared one.** A raw-body test proves something about the router it sends bytes
to; the Stripe file staying green says nothing about a router added afterwards,
which is exactly how a new webhook acquires a parser above it and nobody notices.
Each has its own vacuity guard — the same router mounted behind `express.json()`,
required to REFUSE the identical delivery — so an accepted delivery is positive
evidence the handler read raw bytes rather than a green that cannot fail. A sixth
mount brings a sixth file.

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
| `ANALYTICS_OPERATOR_OXY_USER_IDS` | `/internal/analytics/*`, `/internal/discovery/*`, and the merchant-demand acquisition pipeline |
| `RETAIL_OPERATOR_OXY_USER_IDS` | `/internal/retail-eligibility/*` |
| `PROCUREMENT_OPERATOR_OXY_USER_IDS` | `/internal/supplier-preflight/*`, `/internal/procurement/*`, `/internal/retail-pilot/*` |
| `REFERRAL_OPERATOR_OXY_USER_IDS` | `/internal/referrals/*` — pausing attribution stops partners EARNING, and approving a payout batch is ADR 0005 D14's second pair of eyes (`approved_by <> created_by`, so one populated account cannot approve its own batch) |

The payment gate is INTERIM: store permissions are scoped to a store by
construction, so none can express "may see all stores' money" without becoming
one an owner could grant themselves. `resolvePaymentOperatorIds` and
`requirePaymentOperator` are the two places that change when Oxy grows a platform
operator role.

## The digital-commerce chokepoints (#1015, ADR 0010)

The same shape every domain in this file has: one writer, one authorizer, and the
refusal stated where a second one would otherwise grow.

| Invariant | Held by | What it prevents |
|---|---|---|
| **An `asset_rights` row is the ONLY thing that authorizes a download.** Not a payment, not a signed URL, not an order status. | `services/digital/download.service.ts`, six checks in a fixed order | #1015 boundary 4 — a paid payment proving the right to arbitrary files |
| **`asset_files.storage_key` is read in exactly ONE place**, after the last refusal. | `PROTECTED_COLUMNS.asset_files`, `findAssetFileStorageKey` | the input a signed URL is minted from leaving the process in a response body |
| **A download grant's token is never stored and never logged.** Only a SHA-256 of it. | `asset_download_grants.token_hash` + its shape CHECK | a dump or a log line opening somebody's paid files |
| **A published version, file or licence version cannot be edited or deleted.** | four triggers in `0156` | v2 mutating what v1 was; a creator swapping bytes after a sale |
| **A right's COMMERCIAL half cannot be rewritten and the row cannot be deleted.** Only `status` and the revocation basis move. | `asset_rights_commercial_half_immutable` | a buyer's licence being upgraded in place |
| **A `digital` order has NO address and every other order has a whole one.** | `orders_shipping_address_digital_check` | a fabricated street — #1015 boundary 16 |
| **Place of supply is resolved PER LINE.** | `rateMatchesPlaceOfSupply` in `pricing.service.ts` | a digital supply taxed at the shipping address, or silently at zero |
| **No IP, raw or derived, establishes a supply country.** | `FORBIDDEN_DIGITAL_SUPPLY_EVIDENCE_KINDS`, asserted disjoint | the obvious cheap answer, which is the one piece of evidence Mercaria may not keep |
| **A digital line produces NO inventory movement.** | `metaForMutation` short-circuits an untracked variant; no stock column exists in the digital schema | #1015 boundary 1 — fake stock |

**Two refusals are the service's rather than the database's, and both are the
server's own reading of the cart**: `digital_delivery` is refused for a cart holding
a physical line, and a digital line is refused when the withdrawal waiver is absent.
Neither can be a schema rule, because a schema cannot see a cart — the same split
`services/checkout/destination.ts` documents for the actor rules.

## The digital-retail chokepoints (#1016, ADR 0011)

The same shape again, for a domain where the thing being handled is a bearer
secret bought with real money at the moment a customer pays.

| Invariant | Held by | What it prevents |
|---|---|---|
| **At most ONE live procurement attempt exists per order line, ever.** | `digital_purchase_orders_live_line_key`, a partial unique over the non-terminal statuses | the double-buy: a fallback stepping over an ambiguous attempt that may already have bought a key |
| **A timeout can only reach `ambiguous`, never `failed`.** | `DIGITAL_PURCHASE_ORDER_TRANSITIONS` has no such edge, and the repository refuses one before issuing SQL | a claim that nothing was bought, which nothing on this side of the wire can make |
| **Only provider truth leaves `ambiguous`.** A failed recovery leaves it exactly where it was. | `recoverAmbiguousPurchaseOrder`'s three branches | "I could not reach them" being read as "nothing happened" |
| **Every non-terminal status has a terminal exit.** | the transition map, asserted by `digital-retail-walls.test.ts` | an attempt with no way out, which the live-line index turns into an order line blocked forever |
| **A purchase order's identity and cost snapshot are frozen.** | `digital_purchase_orders_snapshot_immutable` | a catalogue refresh rewriting what a submitted order was quoted |
| **No order line can pay more than its ceiling.** | `max_accepted_cost`, inherited by every fallback, plus two CHECKs | a cost increase reaching a customer who never agreed to it |
| **An ambiguous or unmapped offer can never fulfil.** | `mapping_status`, and `deriveDigitalProcurementEligibility` | the wrong edition, platform or region being substituted silently |
| **Nothing procures without an agreement RIDER.** | `digital_supply_terms`, and `digital_purchase_orders.digital_supply_terms_id` NOT NULL | an API account being mistaken for a resale right |
| **Exactly one artifact is active per fulfilment.** | `digital_fulfilment_artifacts_active_key` | the original and the replacement both working |
| **The plaintext has no column, and the sealed three cannot be read by a whole-row select.** | `PROTECTED_COLUMNS.digital_fulfilment_artifacts`, and the seal-immutability trigger | a dump, a log line or a serializer opening every key Mercaria has sold |
| **A reveal is not a redemption.** | two columns, and no operator path to `redeemed` | an operator making a refund ineligible by typing |
| **An operator cannot fabricate a fulfilment.** | `digital_fulfilment_artifacts_operator_check` — a manual artifact REQUIRES an operator and an incident | value being manufactured with no audit |
| **A machine cannot file an operator incident.** | `digital_fulfilment_incidents_operator_check` | an automated escalation with nobody accountable for it |
| **The reveal audit carries no IP, device or session.** | the absence, asserted against the real `information_schema` | the fraud-shaped reason for building a tracker |
| **Ranking cannot read supplier economics.** | no shared module, table or type; asserted by an import census | margin buying organic placement |
