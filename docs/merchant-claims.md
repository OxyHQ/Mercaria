# Merchant claiming (#83): proving you operate a merchant

`services/merchant-claims/` + `db/merchant-claims/` + `db/schema/merchantClaims.ts`
(5 tables), plus `/merchant-claims/*` (claimant) and
`/internal/commerce-graph/claims/*` (operator review, the SAME
`CATALOG_OPERATOR_OXY_USER_IDS` gate #54 uses). Schema decisions:
`db/schema/CONVENTIONS.md` §"Merchant claiming". The rules that are
load-bearing:

- **`merchants.claim_state` stays ADR 0002 D9's ONE stored verdict** and this
  domain is its only writer. No second boolean, and `assurance` is DERIVED from
  the method (`claim-methods.ts`), never a column.
- **The verification contract is a TABLE, not a switch.** `claim-methods.ts`
  holds every per-method property; the state machine reads it and never asks
  "is the method dns_txt". `autoVerifies: false` on a `low` method is what
  makes "a matching email domain alone cannot complete a claim" structural —
  such a claim reaches `review_pending` and nothing else.
- **`role_email` is in the closed set and NOT AVAILABLE.** Mercaria has no
  outbound email transport, so the token cannot reach the role address. The
  value stays in the tuple (state machine, review path, CHECK all exist for it)
  and the registry refuses to offer it — the issue's "safe subset at launch",
  made explicit rather than dropped. Adding a transport is the only change
  needed to turn it on.
- **`platform_oauth` consumes the connector's EXISTING OAuth round trip** —
  a `connections` row that flow already authorized — rather than registering a
  second redirect URI and a second callback with every platform. Two places
  establishing one shop's identity could disagree. `channel_key` is the same
  proof one rail over, and BOTH additionally require `store:manage` on the
  store that owns the connection (the payment-onboarding permission, same
  reasoning): a leaked key alone must not move a merchant's identity.
- **Scope is a set of proven facts, in a pure function** (`claim-scope.ts`).
  Domain containment is LABEL-wise (`endsWith('.' + proven)`), so `notapple.com`
  is not covered by `apple.com`; a platform proof matches `(provider,
  externalShopId)` or the shop's own host and reaches nothing else; a storefront
  belonging to another merchant is always out of scope. Requested and verified
  scope are two STATES of one row, so a channel a proof missed is visible.
- **Two partial unique indexes carry the security properties.**
  `(merchant_id) WHERE state='verified'` is acceptance 4 — a second claimant is
  refused by the database and lands in DISPUTE rather than replacing the
  incumbent, who keeps management access until an operator revokes it as a
  separate audited act. `(claim_id) WHERE closed_at IS NULL` is what
  "single-use" means; consuming is a CAS whose predicate carries the expiry.
- **The token is minted once, returned once, and stored as a SHA-256** — the
  `guest_sessions` decision, no pepper. Verification presents it back and the
  accept decision is `verifySecret`; for the site methods that adds no secrecy
  (a published token is public) and exists so the server never stores a live
  credential.
- **Four rate-limit axes, three of them durable.** `rl:merchant-claims:` is the
  network axis; per user, per merchant and per domain are counted in Postgres,
  because "how often may this DOMAIN be challenged, across every claimant and
  every ECS task" is not a question a per-IP bucket can answer. One message for
  all three, so a refusal never reports somebody else's activity.
- **SSRF is `safeFetch` and nothing hand-rolled**, HTTPS-only, with a bounded
  read the caller owns. DNS TXT is resolved with its own `Resolver` timeout and
  is outside the SSRF surface entirely.
- **Revocation removes management access and preserves public history**: the
  merchant returns to `unclaimed` with no claimant (native-checkout eligibility
  is derived from that verdict, so it turns false with it) and NOTHING else
  moves — no storefront, no verified domain, no rollup. The former operator is
  notified, as is the incumbent of a contest (`merchant_claim_revoked` /
  `merchant_claim_contested`), and neither message names the other party.
- **Claiming grants no relationship and nothing operational.**
  `relationship-isolation.test.ts` fails the build if any module in the domain
  references the brand/relationship layer (#55) or native-store linkage (#84).
- Deferred and NOT implemented here: the native-store flow (#84) — the claim
  records an `native_store_id` INTENT and writes no link; relationship
  verification (#55); the dashboard/storefront UI (#84/#85). `role_email`
  delivery, per the transport rule above.
