# Claiming a guest checkout into an Oxy account (#109)

> Binding decisions: **ADR 0003** (`docs/adr/0003-commerce-actor-guest-identity.md`)
> D14 (claiming), D5 (the portal credential), D6 (the buyer model), D17 (what a
> proven inbox unlocks), I3/I6/I7 (the invariants this domain exists to hold).
> Schema decisions: `packages/backend/src/db/schema/CONVENTIONS.md`
> §"Claiming a guest checkout (#109)".
> Predecessors: #103 (the actor), #104 (the cart merge), #105 (inline contact),
> #106 (the buyer model and the claim columns), #108 (the portal credential).
> Successors: #110, #111.

A guest bought something. Later, from their inbox, they decide they would
rather have that purchase in their Mercaria account. #109 is the operation that
moves ACCESS to those orders into an Oxy account — and, much more of the work,
everything that makes sure nothing ELSE can.

---

## The failure mode this domain is shaped around

An account acquiring somebody else's purchase because two email addresses
matched. It is silent, it looks exactly like a feature working, and the person
it happens to finds out when a stranger cancels their order.

Every structural decision below is a different way of making that unreachable,
and the strongest of them is not a check at all — it is the claim service's
parameter list.

---

## The proof is a conjunction, held by a signature

`claimGuestCheckoutGroup` takes a resolved portal **grant**, an **Oxy user id**,
an optional presented **guest cart session**, and a clock. That is the whole
input, and #109's nine "insufficient by themselves" rules fall out of it:

| Rejected proof | Why it cannot arrive |
|---|---|
| Matching Oxy and checkout email | No email parameter. `guest-claim-isolation.test.ts` also fails the build if the path so much as reaches `email_hash` |
| Knowing an order number | No order-number parameter |
| The pre-purchase cart token | Accepted, but ONLY as `presentedGuestSessionId`, whose single use is #104's cart merge. Never compared, never consulted by an authorization decision |
| The same card, Link identity, wallet or device | No parameter, and the path cannot import the payment domain at all |
| Receiving merchant communication | Nothing here reads a message |
| Being a seller on a sibling order | The only order fact read is which contact record the group names |
| An operator typing an Oxy user id | There is no operator action that claims. The three that exist all DETACH |
| A referral link, code, touch or partner id | No parameter, and no code route into the referral domain in either direction |
| A referral partner's email or payout beneficiary | Same |

The two proofs that DO count are ADR 0003 D14's: a verified Oxy session, and a
live `email_verified` portal grant carrying `claim:write` for the exact checkout
group. `claim:write` is only ever granted to a credential whose inbox was proven
by a consumed magic link (`guest_order_access_grants_unverified_scope_check`
refuses it on an unverified row outright), so **paying cannot produce a
claimable credential in any code path** — which is D17's line between a device
and a person, enforced by the database rather than by this domain.

---

## What is revalidated before the commit, and what is not

The **grant** is re-read inside the transaction (claim-transaction rule 1). A
buyer on another device can press "secure my access" between the request
arriving and the commit, and a claim authorized by a credential its owner had
just revoked is exactly the case that rule exists for. Conflict case 4. It runs
AFTER the already-claimed check, for a reason measured rather than chosen — see
"the credential a winning claim revokes".

The **Oxy session** is not re-verified, and that is a decision rather than an
omission. Verifying it again means an HTTP round trip to Oxy while a database
transaction holds a row lock — a lock whose duration would become a function of
somebody else's availability. And the fact it would establish is not the one
that matters: `createOptionalOxyAuth` verified this request's bearer at its
start, and a token that expires four milliseconds later does not retroactively
unauthorize the request it authorized. Conflict case 5 is therefore answered by
the request's own verification; a session that had ALREADY expired never reached
the service.

---

## The transaction, and why the order of its statements is load-bearing

1. **Lock** the group's `guest_checkouts` row. This is the serialization point
   (claim-transaction rule 2). Locking the ORDERS instead would serialize a
   claim against every fulfilment write on the group — a lock a merchant would
   feel — and locking nothing costs the CONTEST RECORD (see below).
2. **Read the group's orders** and confirm every one still belongs to this
   contact record (rule 3). A group whose siblings name two contacts is the
   `mixedOriginGroups` pathology, and claiming half of it is worse than claiming
   none.
3. **Already claimed?** Two different answers and neither is an overwrite. The
   SAME account converges on the stored claim, writing nothing at all. A
   DIFFERENT account gets a recorded `conflicted` row and a 409.
4. **Revalidate the grant**, now that the group is known to be unclaimed and
   everything below writes. The ORDER of steps 3 and 4 was measured rather than
   chosen — see "the credential a winning claim revokes" below.
5. **Insert the claim row.** `ON CONFLICT DO NOTHING` on the active-group
   partial unique — the structural backstop behind the lock.
6. **Stamp every sibling**, a CAS on `claimed_by_oxy_user_id IS NULL`, and
   compare the count. A partial stamp RAISES rather than committing half a
   claim. That comparison is acceptance 4.
7. **Append the lifecycle trail**, one row per order, `actor_kind: 'oxy'` with
   the claiming account.
8. **Revoke every outstanding portal credential for the group**, including the
   one that authorized this claim. D14: "after a claim, order access is the Oxy
   account, not the emailed link."
9. **Enqueue the durable follow-up work**, committed with the claim.

Two things happen deliberately OUTSIDE the transaction:

- The **cart merge**, because `mergeGuestCart` opens its own transaction and
  takes its own locks — calling it from inside is the deadlock #59's merge
  runner already paid for. It is safe after the fact for the reason it is safe
  at all: `UNIQUE(cart_merges.guest_session_id)` plus two row locks make it
  exactly-once whoever calls it.
- The **review-eligibility grant** and the **notification**, because a
  downstream projection failing must not roll back an ownership change. They are
  outbox rows; see below.

### The credential a winning claim revokes

Step 8 revokes every outstanding credential for the group, and in a genuine race
that includes the LOSER's — which is why the already-claimed check runs before
the revalidation. With the two the other way round, a rival who presented valid
proof and lost the race is told "your access is not valid" instead of "somebody
else holds this", and the `conflicted` row an operator needs to resolve a
disputed purchase is never written. The concurrent-claims realdb case is what
surfaced it.

The same revocation has a consequence worth stating rather than hiding: **a
client retrying on the SAME credential is answered 401 by the middleware**,
because the claim it is retrying revoked it. Claim-transaction rule 12 is about
what the SERVICE answers, and it converges for every request that reaches it —
the realdb case drives exactly that with a fresh credential. A client that lost
the response looks at the account's own order history, which now holds the
orders. Sparing the presenting credential would fix the retry and leave one
emailed link live for thirty days after a claim, which is precisely what D14
ends.

### Why the lock is load-bearing for the AUDIT rather than for the ownership

Worth stating precisely, because it was mutation-tested rather than assumed.
Removing `FOR UPDATE` leaves the ownership outcome CORRECT: the partial unique
index refuses the second `completed` row and the loser refuses without stamping
anything. What it loses is the `conflicted` row — both racers read "unclaimed",
so the loser never sees a claim to record a contest against and fails at the
insert instead. `guest-claim.realdb.test.ts` asserts the contested row, which is
the only thing that notices.

---

## Which cart merges, and which does not

The claim merges the cart of the session the **request presented**, and no
other. A portal grant proves an INBOX, not a browser: using it to drain the cart
of the session that placed the checkout would move a cart this caller has not
proved they hold, which on a shared device or from a second machine may be
somebody else's current basket.

The honest consequence: a claim made from a device holding no cart credential
merges nothing, and the buyer's own `POST /cart/merge` still works from the
device that has one. In the ordinary flow the cart has usually already merged —
signing in triggers #104's own merge — and the claim's merge then converges.

---

## Conflicts, answered

| Case | Answer |
|---|---|
| 1. Already claimed by the SAME account | 200, the same completed result, nothing written |
| 2. Already claimed by ANOTHER account | 409, a recorded `conflicted` row, no overwrite. The D6 trigger refuses value → value regardless, so a service bug cannot answer it any other way |
| 3. Concurrent claims from two accounts | One winner, one 409. Pinned by a realdb race test |
| 4. Guest access revoked during the claim | 401 — the in-transaction revalidation. A group that is ALREADY claimed answers first, so a race's loser gets the honest 409 rather than a credential error |
| 5. Oxy session expires during the claim | The request's own verification stands. See above |
| 6. Some siblings cancelled or refunded | Claimed anyway. Access to a cancelled order is exactly what somebody needs |
| 7. The checkout has a pending payment | Claimed anyway. Claiming is about ACCESS; refusing would strand a buyer whose bank redirect is slow at precisely the moment they most want to track it |
| 8. Cart merge conflicts | #104's own visible review flags. A merge conflict never fails a claim |
| 9. The Oxy account is restricted, deleted or ineligible | Mercaria computes NO second account-eligibility verdict. Oxy owns identity, the authenticated session IS the test, and a second verdict could only disagree with it |
| 10. A support-assisted prior claim exists | It is a claim like any other; the same 409 and the same audited unclaim |
| 11. The claim event was emitted and a projection failed | The outbox row retries, then dead-letters VISIBLY in the trace |
| 12. The portal is open on another device | That credential was revoked with the rest. It gets the uniform 401 and can recover |
| 13/14/15. Referral conflicts, prior conversion, suspended partner | Not this domain's, in either direction. See the boundary below |

---

## The durable follow-up work

`guest_order_claim_outbox`, the moderation outbox ported for the third time:
deterministic ids, `FOR UPDATE SKIP LOCKED` leases with an owner check, capped
exponential backoff, a visible `dead_letter`.

Two types rather than one row doing both, because they fail independently:

- **`review_eligibility`** — #76's verified-purchase grant for every claimed
  order. Idempotent because `insertEligibility` sits on
  `UNIQUE(order_item_id, oxy_user_id, scope)`, so a retry, a reclaimed lease and
  two racing dispatchers converge on one row per (line, author, scope). This is
  where `bothSidesProven: true` is asserted — and #76 does not take it on trust
  either: it compares the claimant the evidence names against
  `orders.claimed_by_oxy_user_id` **as stored**. Two independent facts, one of
  which is in the database.
- **`claim_notification`** — #108's `claim_completed` message to the checkout's
  contact inbox. It is a SECURITY notice as much as a courtesy: the claim
  revoked every outstanding credential, so somebody reading their order through
  a link needs to know why it stopped working. #108's transport is a named seam
  and nothing sends today, which this domain inherits rather than works around.

A dead-lettered eligibility grant is a buyer who owns their orders and cannot
review them yet — visible, repairable by re-running the job. Neither type
touches ownership, and there is no code path here that could: the module imports
no claim WRITE.

---

## Revocation: an audited compensating operation

**A claimant cannot detach their own orders**, and #109 revocation rule 2 asks
for that decision explicitly. Detaching is the value → NULL half of an ownership
MOVE. Give it to self-service and somebody who briefly held a claim — through a
stolen link, a shared inbox, a device somebody forgot to sign out of — can erase
the trail and let the group be claimed again, with no operator seeing that
ownership changed hands. Rule 1 forbids that move; permitting half of it
self-service permits all of it in two steps.

What a claimant loses is nothing they need. What they gain is that nobody can
quietly take the purchase away from them either.

The correction is **two operators and two requests**: one records a bounded
reason and an evidence reference, a DIFFERENT one approves, and the approval is
what executes. Two calls rather than one naming a second id, because one person
can type two ids — the reason #55 holds four eyes with a review ROW rather than
a comparison. `four_eyes_required` is SNAPSHOTTED at request time, so flipping
the flag can neither retroactively unapprove an executed correction nor silently
approve a pending one.

What a revocation does NOT touch: seller fulfilment access, financial history,
payments, refunds, shipping snapshots, `buyer_origin`, the guest contact record
and every prior claim event (rules 6 and 7). The whole of its effect is the
claim pair returning to NULL and the claim row moving to `revoked` — which is
why order access follows immediately with nothing to keep in step, since
`authorizeOrderAccess` derives from the same pair.

After a revocation the group can be claimed again, because the partial unique
sees only `completed` rows — by the rightful buyer, through the ordinary
two-sided proof from their own inbox, which is the only path in the system that
can establish who they are.

---

## The referral boundary

A claim changes **order access, not acquisition history**. It cannot create,
replace, extend or transfer an attribution, cannot recalculate a commission, and
referral status can neither authorize nor block order access.

That is held by `guest-claim-isolation.test.ts`, which asserts the claim path
has no code route into the referral domain in either direction — a strictly
stronger statement than "these rows did not move this time" — with a vacuity
floor and a mutation self-test. The scan covers the STOREFRONT screens too, so
UX rule 12 ("do not show the referral partner, its earnings or an attribution
conflict to the buyer") is a build failure rather than a copy review.

The commercial half — "one verified order creates at most one conversion, and a
claim replays the source event and creates nothing new" — is #142's, and its own
`referral-writes.realdb.test.ts` already drives it end to end. `guest-claim.realdb.test.ts`
deliberately does not rebuild that fixture stack: it would duplicate the case
against a GLOBAL program namespace, which is how a shared-slot flake gets
introduced. What it pins instead is acceptance 12 from the other side: order
access after a claim is a function of the claim columns alone, through BOTH
spellings of the rule (the pure decision and the indexable predicate).

---

## What a claim never does

Forbidden effects 1-11, and how each is unreachable rather than refused:

| Effect | Mechanism |
|---|---|
| Save the guest shipping address | No address-repository import (scanned) |
| Save a payment method | No payment-domain import (scanned) |
| Subscribe the account to marketing | No `marketing_opt_in` write (scanned) |
| Merge other checkouts sharing the email | The claim is scoped to the grant's ONE checkout group, and there is no email input to widen it with |
| Change the transaction currency or rail | No payment-domain import |
| Grant retroactive reputation | The only reputation effect is #76's verified-purchase eligibility, per eligible line, under its own evidence type |
| Publicly expose the guest contact | No contact column reaches any projection; `MerchantOrder` still `Omit`s the buyer fields |
| Make the order appear originally authenticated | `buyer_origin` stays `guest` forever (I7), the immutability trigger refuses to move it, and `Order.buyerOxyUserId` deliberately stays empty on a claimed guest order |
| Create, replace, extend or transfer attribution | Scanned |
| Recalculate or accelerate commission | Scanned |
| Create a wallet, balance or provider record on either excluded rail | Scanned, in code AND in copy, across both packages |

---

## Surfaces

**Buyer** — both on the guest-orders router, both requiring BOTH proofs:

- `GET /guest/orders/:groupId/claim` — the review screen's read. Changes
  nothing, which is what makes "never auto-submit after sign-in" (UX rule 10) a
  property of the API rather than of the client's discipline.
- `POST /guest/orders/:groupId/claim` — the confirmation. The body is EMPTY.

Rate-limited on the dedicated `rl:guest-claim:` bucket: a claim is a
once-per-group act requiring two verified credentials, so a caller hammering it
is retrying a refusal or probing.

**Operator** — `/internal/guest-commerce/claims*`, on the SAME
`GUEST_OPERATOR_OXY_USER_IDS` allow-list #104 and #108 use, deliberately not a
seventh list. Two reads (a trace opening from a CHECKOUT GROUP and nothing else,
and the consistency probes) and three writes that are three STEPS of one
capability. Empty allow-list means the router is not mounted at all.

**Storefront** — the offer on the guest confirmation and on the portal, the
review screen showing which checkout and which sibling orders attach, an
explicit confirmation, and a "Not now" that leaves purchase access exactly as it
was.

---

## Environment

| Variable | Default | What it gates |
|---|---|---|
| `GUEST_CLAIM_ENABLED` | `true` | The claim WRITE. Never the read of a claim already made |
| `GUEST_CLAIM_FOUR_EYES_REQUIRED` | `true` | Whether a revocation needs a second operator. Snapshotted per request |
| `GUEST_CLAIM_PROJECTION_ENABLED` | `true` | The follow-up dispatcher LOOP. Never the row |
| `GUEST_CLAIM_JOB_BATCH_SIZE` | `25` | Rows per dispatcher pass |
| `GUEST_CLAIM_JOB_POLL_INTERVAL_MS` | `5000` | How often it wakes |
| `GUEST_CLAIM_JOB_LEASE_MS` | `60000` | How long a claimed row stays claimed |
| `GUEST_CLAIM_JOB_MAX_ATTEMPTS` | `8` | Attempts before `dead_letter` |

**Not one of them gates a stored claim.** A claim is an ownership record:
turning a lever off must never make an already-claimed order stop belonging to
the account that claimed it, stop appearing in its history, or stop being
readable by an operator. `guest-claim-isolation.test.ts` fails the build if
`order-access.service.ts`, `order-buyer.ts`, the projection or the operator
surface starts reading one.

---

## Seams left, and to whom

| Owner | What is left |
|---|---|
| **#108** | The transactional transport. The `claim_completed` message is composed, queued and retried; nothing SENDS, because Mercaria has no outbound mail and #108 left that a named fail-closed seam rather than a `console.log` that looks like a working feature |
| **#110** | Cancellations, returns and support for a claimed order. A claimant reaches them through the ordinary account path, which already exists |
| **#111** | `guest_claim_offered` and `guest_claim_declined`. An offer is a screen having been shown and a decline is somebody navigating away; the server observes neither, and the nearest substitutes (a preview read, a claim that never arrived) are different facts. `oxy_claim_funnel` therefore has a live numerator and no denominator, which its `seam` field says on the dashboard |
| **#141-#143** | Every referral consequence of a claim. This domain records none and can reach none |

Nothing above is a stub that lies. The message is genuinely queued and
genuinely retried; the two analytics types are declared and emitted by nothing,
which a gate enforces.
