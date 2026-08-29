# Order buyers, contact snapshots and order access (#106)

> Binding decisions: **ADR 0003** (`docs/adr/0003-commerce-actor-guest-identity.md`)
> D6 (`OrderBuyer`), D7 (compatibility reads), D13 (what sellers receive),
> D14 (claiming), D15 (erasure), D16 (guest actors in audit trails).
> Schema decisions: `packages/backend/src/db/schema/CONVENTIONS.md`
> §"`guest_checkouts` and the buyer origin on `orders`".
> Predecessors: #103 (the actor), #104 (the cart), #105 (inline contact and
> destination). Successors: #107, #108, #109, #110, #93, #112.

An order is the immutable record of a sale, and until #106 it could only belong
to an Oxy account. #105 made a guest order STORABLE — `buyer_origin` and
`buyer_guest_checkout_id` exist, and `orders_buyer_identity_check` refuses every
illegal combination of them. #106 makes it READABLE, OWNABLE and AUDITABLE: a
union every consumer switches on, a second owner a claim can add without
rewriting the first, one authorization service instead of four repository
filters, and an actor dimension on the lifecycle trail so "a guest cancelled
this" stops being spelled the same way as "a sweep cancelled this".

---

## The buyer model

```ts
type OrderBuyer =
  | { origin: 'oxy';   oxyUserId: string }
  | { origin: 'guest'; guestCheckoutId: string;
                       claimedByOxyUserId?: string; claimedAt?: string }
  | { origin: 'external'; connectorProvider?: ConnectorProviderId;
                          externalReference?: string };
```

`@mercaria/shared-types` `order-buyer.ts` declares it;
`services/orders/order-buyer.ts` is the ONE function that derives it from a row.

**There is no common id field**, exactly as `CommerceActor` has none (ADR 0003
D1/I1). A shared `buyer.oxyUserId` would let code that forgot which origin it
holds pass a guest's later CLAIMANT where the account that placed the purchase
was expected — a silent attribution error rather than a crash. With no common
field the compiler forces a `switch` at every consumer.

**A claim is a second owner, never a rewritten first one.** `origin` stays
`'guest'` forever (I7). The database holds the same shape three ways:

| Mechanism | What it stops |
|---|---|
| `orders_buyer_identity_check` (widened, not duplicated) | A claim on an `oxy` or `external` order; half a claim pair; a claimed order that also carries `buyer_oxy_user_id` |
| `mercaria_order_buyer_origin_immutable` (`CREATE OR REPLACE`d, one trigger) | Rewriting `buyer_origin` or `buyer_guest_checkout_id`; reassigning a set `buyer_oxy_user_id`; moving a claim value → value |
| `orders_claimed_by_created_at_idx` (partial) | Nothing — it is what makes the claim-aware read two indexed scans instead of a sequential one |

The trigger permits exactly two claim transitions: NULL → value (a claim, #109)
and value → NULL (an audited operator unclaim, D6). **value → value is refused**,
which is what makes D14's conflict resolution real: a second Oxy account
claiming an already-claimed group is answered 409 by the service, and the
trigger is why a service bug cannot answer it any other way. A mis-claim is
corrected by unclaim + re-claim, two audited steps, never by editing history.

**Connector and POS semantics are preserved explicitly** (migration rule 3).
POS and draft orders resolve a real Oxy id and stay `'oxy'`; connector imports
are `'external'`, backfilled by `source_connection_id IS NOT NULL` and **not**
by the `ext:` prefix — a string convention nothing enforces. Their legacy
`ext:<provider>:<externalId>` value stays in `buyer_oxy_user_id` as provenance;
ADR 0003 M9 stops NEW imports writing it and nothing rewrites the old ones.

---

## The contact snapshot, and why it is not copied onto the order

The immutable buyer contact is the order's own `guest_checkouts` row, reached
through a `RESTRICT` foreign key, immutable by trigger except D15's
anonymization and #108's verification stage. #106 adds its last two fields:
`contact_verified_at` (paired with the stage by a biconditional CHECK) and
`contact_policy_version`.

#106's contact rule 5 says the historical contact must never be rendered by
re-reading a live source, and rule 10 says contact retention must be separable
from order financial retention. **A per-order copy would satisfy the first and
break the second, so there is one snapshot and it is separately erasable.**
ADR 0003 D15 erases a guest's contact on a verified request while the orders,
totals, refunds and ledger entries are retained under a statutory obligation —
a copy on the immutable order record is exactly the copy that erasure could not
reach. An anonymized contact renders as `deleted`, which is honest rather than
stale.

What makes rule 5 true mechanically: `loadBuyerContacts` in
`order-hydration.service.ts` is the ONLY path to a contact projection, it reads
the FK'd snapshot in one batched statement, and **there is no Oxy profile call
on it to forget to remove**. An `oxy`-origin order gets `{source:'oxy_account'}`
and no value, because Mercaria stores none — copying an Oxy account's email here
would create the profile mirror D15 says does not exist.

Lookup hashes stay out of public DTOs by CONSTRUCTION: `email_hash` is in
`PROTECTED_COLUMNS` (it is an exact-match ORACLE, not merely irreversible) and
`GuestContactDisplayRow` has no property to carry one.

---

## What a SELLER receives

`MerchantOrder` / `MerchantOrderSummary` are their own types, built by
`hydrateOrdersForMerchant` / `summarizeOrdersForMerchant`, and they `Omit` the
three buyer fields rather than blanking them at runtime — so a merchant
serializer that reaches for a contact fails `tsc`, and a field added to `Order`
later cannot arrive in a merchant response by being picked up automatically.

A merchant gets the lines, the totals, the immutable shipping snapshot
(recipient name, address, delivery phone), the method, the status trail, and a
`MerchantBuyerLabel`. That label is the Oxy display handle for an `oxy` order
and the literal **`Guest`** for everything else — not `Guest #4821`, not a
masked email, not an initial. Any per-guest label is a correlation key wearing a
display name, which is precisely invariant I11. It is also why the label says
nothing about WHICH kind of buyer this is: #106 DTO rule 5 ("do not stigmatize
guest buyers in merchant UX") and I11 point the same way.

`order_status_history.actor_guest_session_id` is in `PROTECTED_COLUMNS` for the
same reason and it is the sharper case: the trail is attached to EVERY order and
serialized whole, so an ordinary `select()` would have put a guest's session row
id — shared across that guest's orders — into a merchant response. The
repository selects `PUBLIC_STATUS_EVENT_COLUMNS`; `actor_kind` is deliberately
NOT protected, because it says a guest acted without saying which.

---

## Order access: one service, six accepts, six rejects

`services/orders/order-access.service.ts`. Buyer model rule 8 asks for a shared
service and the reason is the shape of the mistake it prevents: access used to
be a filter column chosen at each call site, so a second kind of owner meant
four independent chances to forget.

`OrderAccessSubject` is a union with **no common id field** — an Oxy account, a
guest portal grant, a store member, a P2P seller, an operator.

| Allowed | Grant reason |
|---|---|
| The original authenticated buyer | `original_oxy_buyer` |
| An Oxy account that validly claimed a guest checkout | `claiming_oxy_account` |
| A scoped guest order-portal session (#108) | `guest_portal_grant` |
| A store member acting for the store that owns the order | `store_member` |
| The P2P seller who must fulfil it | `p2p_seller` |
| An operator on the allow-list | `operator` |

| Rejected | How |
|---|---|
| Another guest session with the same email | A grant is scoped to ONE checkout group; there is no email input at all |
| An Oxy account whose email merely matches | An unclaimed guest order has no Oxy owner and no argument could make one (I6) |
| A sibling seller inspecting another seller's order | Seller TYPE and id are both compared |
| **A cart token presented as paid-order access** | `orderAccessSubjectForCommerceActor` maps a `guest` actor to `null` (I3) |
| Order number plus public contact fields | Unrepresentable in the parameter list (I2/I4) |
| A claimed buyer after an audited claim revocation | The pair moved value → NULL, so the derivation stops matching |

**The service does not check store PERMISSIONS.**
`requireStorePermission('orders:read')` already decides whether a member may act
for a store; this decides whether an ORDER belongs to the store they are acting
for. Folding them together would put a permission matrix in the order domain and
an order predicate in the membership domain, each then checked twice.

**Buyer access is stated twice, and a test drives both.** The list path cannot
use a JavaScript predicate — filtering a million rows is not an authorization
strategy — so the scope is a separate SQL translation (`buyerOrClaimantSql`,
`buyer_oxy_user_id = $1 OR claimed_by_oxy_user_id = $1`). Two spellings of one
rule can disagree, so `order-buyer-claim.realdb.test.ts` runs the same four-order
matrix through both and fails if they ever do. Mutation-tested: narrowing the
SQL predicate back to the origin column fails exactly that case.

`OrderListFilter` keeps `buyerOxyUserId` BESIDE `buyerOrClaimantOxyUserId`
because two different questions are asked — "which orders did this account
PLACE" (reports, the customer relation) and "which orders may this account SEE".
Collapsing them would silently widen the first.

---

## The audit actor (D16)

`order_status_history` gains `actor_kind` (`oxy | guest | system | operator`)
and `actor_guest_session_id`. `order_status_history_actor_check` ties them:

- `oxy` / `operator` → `by_oxy_user_id` required, session id forbidden;
- `guest` → session id required, `by_oxy_user_id` forbidden;
- `system` → neither.

That is invariant I1 reaching audit rows: a service bug that put a session id in
the Oxy column is refused by the database rather than discovered in a support
conversation. `NewOrderStatusEvent.actorKind` is REQUIRED, so every writer
states which of the four it is — the compiler found all of them, and each is
documented at its call site (the sweep and the payment outbox are `system`, a
connector import is `system`, a POS sale and a refund are `oxy`, a guest
checkout is `guest`).

---

## Compatibility, and its retirement condition

`Order.buyerOxyUserId` survives as the **v1 spelling** of `buyer.oxyUserId` —
the same treatment `CheckoutInput.addressId` gets and for the same reason: a
shipped mobile build cannot be recalled. It is written only where its old
meaning holds, on an `oxy`-origin order.

**A claimed guest order deliberately carries none.** Filling it with the
claimant would tell an old client that an Oxy account placed a purchase it did
not place. An old client shows such an order without a buyer id, which is
honest; a new client reads `buyer`.

**Retirement** (migration rule 7): removed once every supported client version
reads `buyer` — a client-fleet measurement, not a server decision. The COLUMN
`orders.buyer_oxy_user_id` is never dropped; it remains the live origin-owner
data (ADR 0003 M9).

---

## The migration (`0030`, `pre`)

Purely additive: no column dropped, renamed or narrowed. The order of statements
is load-bearing and a regeneration destroys it — the file says so at the top,
and `docs/postgres.md` §"Rebasing a migration behind another branch's" is the protocol.

1. Add `orders.claimed_by_oxy_user_id` / `claimed_at`,
   `order_status_history.actor_kind` / `actor_guest_session_id`,
   `guest_checkouts.contact_verified_at` / `contact_policy_version`.
2. **Backfill, BEFORE the CHECKs.** `order_status_history.actor_kind = 'oxy'`
   where `by_oxy_user_id IS NOT NULL` (the `system` fast default is correct for
   the rest); `orders.buyer_origin = 'external'` where
   `source_connection_id IS NOT NULL`. Adding the actor CHECK first would fail
   the migration outright on every historical row with a real actor.
3. The index, then the CHECKs, then `CREATE OR REPLACE` on the trigger function.

**The identity CHECK is added VALIDATED, not `NOT VALID`.** ADR 0003 M1 stages
it `NOT VALID` expecting `ext:` rows to violate the final shape; they do not —
the `'oxy'` and `'external'` disjuncts both admit them, exactly as #105's own
migration recorded. The widening only constrains the two NEW columns, which the
serving image leaves NULL.

**Rollback** (acceptance 10, M10): image-level and flag-level, never
schema-level once a guest order exists. Reverting `0030` would drop the claim
columns and the actor dimensions — it is the forbidden move. With the guest
flags off, existing guest orders keep resolving, keep being fulfillable and keep
being readable: seller and admin queries key on `store_id` /
`seller_oxy_user_id`, payment and refund processing key on `checkout_group_id` /
`payment_id`, and none of those paths reads a buyer identity. "Gate the loop,
never the durable record."

---

## Consistency (acceptance 9, migration rule 10)

`readBuyerIdentityConsistency` counts the four invariants no CHECK can express,
each with a bounded sample, and the guest operator surface
(`GET /internal/guest-commerce/consistency`) reads them. All should be zero.

| Finding | Why a CHECK cannot see it |
|---|---|
| `legacyExternalMisclassified` | Compares a column against a string CONVENTION — M4's discriminating count, kept standing because a connector import with no connection row would be missed by the backfill and look like a real Oxy buyer to every report |
| `mixedOriginGroups` | Compares SIBLING rows: one cart is one buyer |
| `partiallyClaimedGroups` | D14's group-atomic claim is a transaction, not a constraint; this is the only thing that can observe it failing |
| `orphanedGuestCheckouts` | The FK states the other direction; a contact with no order is a person's email retained for nothing |

Read-only, deliberately: a misclassified origin, a mixed group and a partial
claim are each a decision about a commercial record, and #50's "nothing
auto-rewrites financial history to hide a mismatch" applies to a buyer identity
for the same reason it applies to a ledger entry.

---

## Downstream integrations

- **Notifications.** `notifications.oxy_user_id` is NOT NULL and stays so. An
  unclaimed guest order produces NO notification row and no push — a guest's
  channel is transactional mail to their `guest_checkouts` contact, which #108
  owns and which is deliberately not faked. In-app notification begins at the
  claim, addressed to the claimant, which is exactly what
  `accountWithBuyerAccess` returns.
- **Reviews.** `buyerHasOrderForListing` / `buyerHasOrderFromSeller` are
  claim-aware: a claimed purchase is a verified purchase (D7). The WRITE half —
  minting a `review_eligibilities` row with `claimed_guest_purchase` evidence —
  still refuses, because #109 owns the only writer of `claimed_by_oxy_user_id`
  and there is nothing to compare a caller's assertion against. #106 made two of
  that function's guards REAL (a non-guest order is refused by name now) and
  named the one line #109 replaces.
- **Analytics.** `BUYER_ORIGIN_EXPRESSION` reads the stored column, so a claimed
  guest order still counts as GUEST forever (#77 identity rule 7). #106 also
  CLOSED #77's `#106` seam — see `docs/analytics.md`.
- **Reports, refunds, moderation.** Unaffected: reports group by store and sum
  the shop side, `refunds` carries no buyer column, and moderation acts on
  listings and orders by id.
- **Payments.** `order-linkage.ts` stays the one seam; the operator trace's five
  handles already exclude buyer identity.

---

## Seams left, and to whom

| Owner | What is left | What exists now |
|---|---|---|
| **#107** | LANDED — see below | The Stripe client surfaces, the `guestCheckoutId` metadata key, the rollout kill switches, and the `guest_portal_initialization` outbox row #108 consumes |
| **#108** | `guest_order_access_grants`, magic links, transactional mail, the portal ROUTE | `GuestOrderPortalGrant`'s contract, the grant branch of `authorizeOrderAccess`, `resolveGuestPortalSubject` (returns `null`), `GuestOrderPortalView` and `buildGuestOrderPortalView`, `setGuestCheckoutVerificationStage`'s timestamp, and #107's durable `guest_portal_initialization` row (keyed on the checkout GROUP, carrying `{checkoutGroupId, guestCheckoutId, orderIds}`) |
| **#109** | The claim service — the ONLY writer of `claimed_by_oxy_user_id` | The columns, the CHECK, the trigger's two permitted transitions, the claim-aware reads, the review-eligibility guard that becomes one comparison |
| **#110** | Guest cancellations, returns, support | The claimant's own cancel path (an Oxy account acting on its own order) |
| **#93** | Pickup validation | `assertPickupLocationEligible`, now refusing with a bounded reason |
| **#112** | Guest P2P | The refusal, with reason `p2p_seller_excluded` |

**Nothing above is a stub that lies.** `resolveGuestPortalSubject` returns
`null` because no grant table exists, so the whole guest-portal path fails
closed; `grantEligibilitiesForClaimedGuestOrder` refuses unconditionally and
says which issue closes it; `buildGuestOrderPortalView` does real work on an
already-authorized group and supplies no authorization of its own.

### What #107 handed #108, and what it deliberately did not

On the verified `payment_intent.succeeded` of a guest-origin group, the
`payment_succeeded` outbox handler enqueues ONE `guest_portal_initialization`
row, keyed `payment:guest_portal_initialization:<checkoutGroupId>` so a
redelivered event, a reclaimed lease and a reconciliation sweep re-deriving the
same success all converge on it. #108 replaces the body of
`handleGuestPortalInitialization` with the grant mint and the confirmation
email.

It creates **no access credential**, and that division is a mechanism rather
than a courtesy: a grant token minted inside payment processing would exist
while the PaymentIntent's metadata is being composed, and ADR 0006 B4 says no
token may ever be in a position to reach it. Minting strictly after a verified
event, from a consumer of this row, makes "it cannot be in metadata" a fact
about the call graph rather than a rule somebody has to honour.

Until #108 lands, a guest's success screen is honest about what exists: it hands
over the ORDER NUMBER the buyer already holds and routes them to the storefront
rather than to `/orders/...`, which is account-authenticated and would answer
401 to the person who just paid. No email and no link is promised.
