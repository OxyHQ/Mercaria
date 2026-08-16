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
  build cannot be recalled; state `retiresWhen` and keep serving both.
- **Four eyes** (`CATALOG_FOUR_EYES_REQUIRED` and its siblings) is the ROW's
  shape — approvers differing from each other and from the requester, held by a
  CHECK or a partial unique, never by a service comparison.
- **Isolation between domains is a TEST**, not a convention
  (`*-isolation.test.ts`): ranking may not read fees or referrals, the payment
  domain may not read procurement, a claim path may not reach referrals, and so
  on. It scans RAW source (comments included) with a file-count floor.

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
