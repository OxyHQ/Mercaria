# Guest commerce: sessions, cart ownership and inline checkout

> #103, #104 and #105, moved out of `AGENTS.md` unchanged. ADR 0003 is binding.

## Guest sessions and the CommerceActor resolver (#103, ADR 0003)

ADR 0003 (`docs/adr/0003-commerce-actor-guest-identity.md`) binds the whole
guest-commerce epic (#101); #103 shipped its foundation. **No synthetic Oxy
users, ever** — a guest is Mercaria's own credential, structurally incapable of
appearing where an Oxy id is expected.

- **`CommerceActor`** (`services/commerce-actor.ts`) is the ONE actor union —
  `oxy | guest | anonymous`, deliberately with NO common `id` field so every
  consumer must switch on `kind` (I1). Resolved once per request by
  `middleware/commerce-actor.ts` (`resolveCommerceActor`), which COMPOSES the
  existing `createOptionalOxyAuth` — never a second Oxy verifier. Cart/checkout
  adopt it in #104 (M6/M7); until then only `/guest/session` consumes it.
- **Precedence (D2): Oxy wins; a failed Bearer is a 401, never a downgrade to
  the guest cookie; an invalid guest credential resolves as ABSENT** (marked
  `req.guestCredential='invalid'`). A valid guest credential beside Oxy auth is
  surfaced ONLY as `presentedGuestSessionId`, whose only legitimate consumers
  are cart merge (#104) and claim (#109).
- **Token:** `mgs_` + 32 CSPRNG bytes base64url; server stores hex SHA-256 only
  (`guest_sessions.token_hash`, unique). NO pepper — see `CONVENTIONS.md`
  §guest domain. Plaintext exists in exactly two response carriages:
  `Set-Cookie` (web) or the `X-Mercaria-Guest-Token` response header (native,
  declared with `X-Mercaria-Guest-Transport: header` on the issuing write) —
  NEVER a response body, log line, URL or analytics event.
- **Web cookie (D9):** `__Host-mercaria_guest` — HttpOnly, Secure,
  SameSite=Lax, Path=/, no Domain. Dev uses `mercaria_guest_dev` WITHOUT
  Secure under a different name, logged at first use — an explicit downgrade,
  never a silent one.
- **CSRF (D10):** strict Origin (else Referer) verification for every
  cookie-authenticated state-changing request AND cookie-transport issuance,
  against `lib/allowed-origins.ts` — the SAME list CORS reads; do not create a
  second origin authority or a double-submit token. Header transport is exempt
  (custom header ⇒ CORS preflight).
- **Issuance is LAZY and a WRITE** (`issueGuestActor`): the ensure endpoint
  today, cart writes in #104 — a page view never creates a row (T10).
  Rate-limited on the dedicated `rl:guest-issue:` bucket. Rejection of
  expired/revoked/malformed/unknown is UNIFORM (`null`/401); reasons exist only
  in the `log.guest` security events, which carry row ids and never tokens.
- **Expiry (D3/D11):** `expires_at` (90 d absolute) is the only stored
  deadline; idle expiry (30 d from `last_seen_at`, written at ≥60 s
  granularity) lives in the resolver. Rotation swaps `token_hash` in place with
  a 60 s `previous_token_hash` grace; the 7-day activity rotation answers in
  kind from the resolver. Purge = two expiry-sweep targets (7 d past
  expiry/revocation), hard DELETE.
- **Flags (M8):** `GUEST_COMMERCE_ENABLED` (default false) gates the MOUNT and
  requires BOTH `GUEST_PII_ENCRYPTION_KEY` and `GUEST_EMAIL_HASH_KEY` (the
  half-configuration rule; keys are consumed by #105+/#108 but demanded now).
  `GUEST_SESSION_ISSUANCE_ENABLED` (default true) is the incident kill switch:
  stops NEW sessions only — existing ones keep resolving/rotating/revoking.
  `GUEST_SESSION_IDLE_DAYS=30`, `GUEST_SESSION_ABSOLUTE_DAYS=90`. Production
  stays OFF until the M8 security + privacy review clears.
- **Conversion is a SEAM here:** `converted_at`/`converted_to_oxy_user_id` are
  written only by #104/#109; there is deliberately no generic "reassign
  session" endpoint, and `/guest/session` is the WHOLE public surface
  (ensure/inspect/rotate/revoke).

## Guest cart ownership and the merge (#104, ADR 0003 D8)

The cart is owned by a `CartOwner` — `{kind:'oxy_user'} | {kind:'guest_session'}`
— and `/cart` runs on `resolveCommerceActor` instead of `authenticateToken`.
ONE cart service, one hydration path, one grouping path for both kinds (I9):
there is nothing guest-shaped to fork, and no `GuestCart` model.

- **Two owner columns plus a CHECK, never a polymorphic pair.** An Oxy id must
  not carry an FK (Oxy owns identity) while `carts.guest_session_id` MUST —
  `ON DELETE CASCADE` is what makes retention correct by construction. Both
  uniques are PARTIAL, so every `ON CONFLICT` on them must repeat the
  predicate or Postgres refuses to infer the arbiter and `ensureCart` 500s.
- **`cartOwnerForActor` is the ONE actor→owner translation.** Neither union has
  a common `id` field, so the compiler forces a `switch` and a guest id can
  never reach `oxy_user_id` (I1).
- **Issuance is lazy and only on a write that CREATES state** — `POST /cart/items`
  and `PATCH /cart/items/:variantId`. A GET never mints (T10), and neither does
  a DELETE: removing a line from a cart that does not exist creates nothing.
- **Idempotency is explicit.** POST increments and is the one non-idempotent
  mutation; PATCH sets an ABSOLUTE quantity and CREATES the line, so it is what
  a retrying native client uses; DELETE converges on an empty cart rather than
  404ing the second time.
- **`makeActorRateLimiter`** keys on `actorRateKey` (`rl:cart:`, `rl:cart-merge:`),
  so guests are bucketed per SESSION — a per-IP bucket would make one NAT one
  guest. Its anonymous branch runs the address through `ipKeyGenerator` (a v6
  client otherwise walks its own /64 around the limit).
- **A guest's presentment currency rides the request** (`?currency=`, validated
  against `ALL_CURRENCY_CODES`) because they have no preferences row; an Oxy
  buyer's STORED preference stays authoritative and the parameter is ignored for
  them. Display only either way.
- **The merge is ONE transaction**, entered only from `POST /cart/merge`, which
  is the only consumer of `presentedGuestSessionId` besides #109. Nothing merges
  implicitly. Exactly-once rests on three mechanisms — `FOR UPDATE` on the
  session row, `FOR UPDATE` on the guest cart, and
  `UNIQUE(cart_merges.guest_session_id)`. Mutation-tested: the two locks are
  INDEPENDENTLY sufficient (removing either alone leaves the suite green);
  removing both doubles a quantity and fails the race test.
- **Quantities are summed and clamped IN SQL** (`LEAST(existing + incoming,
  ceiling)`), so a concurrent add from another authenticated device is summed
  with rather than overwritten, and the review flag is written by the SAME
  expression that applies the clamp — the caller counts clamps off the returned
  flag rather than re-deriving them.
- **No item disappears.** An out-of-stock line survives as ONE unit flagged
  `listing_unavailable` (a zero quantity is unrepresentable), which hydration
  marks `stale` and checkout refuses — so keeping it oversells nothing.
  `cart_items.merge_review_reason` is a STORED fact, unlike `stale`, which is
  re-derived live; the buyer clears it by setting that line's quantity.
- **Conversion is stamped LAST** and rolls back with everything else, which is
  how "converted only after the merge commits" and "a failed merge leaves both
  carts recoverable and the session active" are the same property.
- **What the merge cannot reach** is a test, not a promise —
  `services/__tests__/cart-merge-isolation.test.ts` scans the whole cart path
  for the payment domain, the referral domain, inventory writers, discount
  redemption and any OxyPay/FairCoin reference. Guest CHECKOUT (#105–#107),
  referral attribution (#141/#143) and a "discard instead of merge" mode (which
  ADR 0003 does not grant — not calling the endpoint IS the choice) are all
  deliberately absent.
- **Flags are three independent levers**, and #105–#107 adds a fourth:
  `GUEST_COMMERCE_ENABLED` (the domain), `GUEST_SESSION_ISSUANCE_ENABLED` (the
  incident kill switch for NEW credentials), `GUEST_CART_ENABLED` (may a
  credential own commerce state). With the cart lever off, reads answer empty
  and writes get `GUEST_CART_DISABLED` (403) — but the MERGE stays available,
  because gating it would strand every cart created while it was on.
- **`GUEST_OPERATOR_OXY_USER_IDS`** gates `/internal/guest-commerce/*`
  (cart-merge trace by correlation id + a consistency check), a THIRD
  allow-list beside payments and catalog for the reason those two are separate.
  Empty = not mounted (404). Read-only: every repair is already an idempotent
  path a buyer drives.
- **Frontend:** `lib/stores/guest-credential-store.ts` holds the NATIVE token
  (`expo-secure-store`, hydrated at module import so it is on the first
  request); web holds nothing because the credential is an `HttpOnly` cookie
  and `apiClient` sets `withCredentials`. `useGuestCartMerge` is a React Query
  QUERY, not an effect — `enabled` flipping true is the once-per-sign-in
  trigger. There is no analytics module in this app and #104 adds none;
  ADR 0003 I12's dimensions belong to #111's rollout work.

## Inline checkout contact and destination (#105, ADR 0003 D4/D6, ADR 0006 G6/G12)

`POST /checkout` takes a discriminated `CheckoutDestination` plus an explicit
`CheckoutContactInput`, for BOTH actor kinds, and runs on
`resolveCommerceActor` instead of `authenticateToken`. Code:
`services/checkout/` (4 modules), `db/guests/guestCheckoutRepository.ts`,
`lib/guest-pii.ts`, `db/schema/guests.ts` (`guest_checkouts`) and the buyer
widening on `db/schema/orders.ts`. Schema decisions:
`db/schema/CONVENTIONS.md` §"`guest_checkouts` and the buyer origin".

- **The contract is `{destination, contact, marketingOptIn}`**, and `addressId`
  is still accepted as the v1 spelling of `{type:'saved_address', addressId}`.
  That is a VERSIONED CONTRACT, not a compat shim — a shipped mobile build
  cannot be recalled. Sending BOTH is a 400 rather than a precedence rule
  nobody would remember. It retires when supported client versions have
  migrated.
- **"A guest cannot use a saved address" is STRUCTURAL, not a check.**
  `addressBookOwnerForActor` (`services/checkout/destination.ts`) is the only
  source of an `oxyUserId` for `findAddress`, and it is a `switch` over a union
  with no common `id` field — the `cartOwnerForActor` mechanism, one domain
  over. The refusal arrives BEFORE any lookup, so an invented id leaks nothing.
- **An inline authenticated address is saved only on an explicit, separate
  opt-in**, and the write happens AFTER the order and best-effort: a failed
  address-book write must never fail a purchase that already took stock, and a
  failed checkout must never grow the address book.
- **Contact is required for a guest and optional for an Oxy buyer**, and is
  NEVER read off an Oxy profile. A guest's email is encrypted onto
  `guest_checkouts`; an Oxy buyer's is validated and stored NOWHERE — their
  transactional channel is Oxy's own notifications, and copying an Oxy account's
  email into Mercaria would create the profile mirror ADR 0003 D15 says does not
  exist. Accepting it for both is what makes ONE shared inline form possible.
- **Pickup is representable and REACHES a real gate since #93.**
  `assertPickupLocationEligible` is GONE — a clean cut, not an alias — and
  `derivePickupEligibility` answers per store from a published, collectable
  location. Nothing fabricates a street for a collection: the pickup branch
  produces no address at all, and the order's snapshot comes from the
  PUBLICATION with the literal recipient `Collection`, never a person.
- **Unknown shipping is never free.** `resolveShippingCostMinor` refuses a
  method this deployment cannot price instead of letting `undefined` become 0.
- **Eligibility refusals name the SELLER**, because a mixed cart's remedy is to
  deselect one, and they mention nothing about the cart's contents — a rejection
  leaks no inventory. Guest P2P stays refused (ADR 0003 D18 / ADR 0006 G18)
  until #112; there is deliberately no flag for it.
- **Validation lives in ONE place** (`services/checkout/contact.ts`), is pure,
  and makes zero outbound calls — no geocoding, no address-correction provider
  (a static test asserts it). ISO-3166 alpha-2 is a real membership test, not a
  length check. Postal patterns exist only for countries whose rule is
  unambiguous; the long tail is length-checked, because an overfitted regex
  refuses a real buyer with no remedy. Email normalization is ADR 0003 D12
  verbatim — trim, NFC, lowercase the WHOLE address, no plus-tag stripping and
  no dot folding — and the DISPLAY form (what mail is sent to) is a different
  value from the LOOKUP form (what is hashed). Phone canonicalization never
  invents a country code.
- **`guest_checkouts` is ONE contact per checkout GROUP**, created inside the
  orders' transaction, immutable by trigger except D15's anonymization and
  #108's verification stage. `ensureGuestCheckout` is `ON CONFLICT DO NOTHING`
  plus a read: a retry carrying a different email must not replace the contact a
  placed order was made with. Repeated attempts converge through the existing
  layers; nothing new was added.
- **The transaction boundary is the ONLY place the two actor paths differ in
  shape**, and it is a row rather than a policy: a guest checkout writes a
  contact the orders reference by FK and it must commit with them, or an
  idempotency converge would strand one. `placeOrders` is the same body either
  way (ADR 0003 I9).
- **Flags are FOUR independent levers**, and the interaction matters:
  `GUEST_COMMERCE_ENABLED` off = no credential resolves at all (decommission);
  `GUEST_CART_ENABLED` off = a session resolves but owns no cart, so there is
  nothing to check out; `GUEST_INLINE_DESTINATION_ENABLED` off (the #105 lever,
  default true) = the cart survives and checkout is refused with
  "temporarily unavailable"; placed guest orders and their payments are never
  gated (ADR 0006 G17). `CHECKOUT_DESTINATION_COUNTRIES` is empty by default,
  which means unrestricted — today's behaviour exactly.
- **Privacy:** three encrypted/hashed columns are in `PROTECTED_COLUMNS` (the
  hash too — it is an exact-match ORACLE, not merely irreversible); no refusal
  or log line ever carries an address, an email or a hash, only field names,
  seller keys and row ids; the seller-visible set is stated on the checkout page
  itself. Marketing consent is its own column defaulting to false, so a
  transactional send can never be mistaken for consent to market.
- **Isolation is a test:** `services/__tests__/checkout-contact-isolation.test.ts`
  fails the build on any OxyPay/FairCoin spelling (COPY included, so it scans
  raw source), any referral reference, any geocoding client, any address-book
  write from a guest module, and any contact-based buyer lookup. The
  reachability detectors scan COMMENT-STRIPPED source, because the modules
  document what they refuse to do in the same vocabulary.
- Deferred and NOT built here: #106 (landed — see below), #107 (the guest
  Stripe client surfaces and the portal), #108 (verification, magic links,
  transactional mail), #109 (claiming), #93 (pickup), #112 (guest P2P).

