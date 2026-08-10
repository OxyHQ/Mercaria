# Buyer post-purchase requests — cancellations, returns and support (#110)

`services/buyer-requests/` (13 modules) + `db/buyerRequests/` (4 repositories) +
`db/schema/buyerRequests.ts` (8 tables) + `controllers/buyer-requests.controller.ts`
+ `routes/buyer-requests.ts`, mounted twice.

#105 let somebody buy without an account, #106 made that order readable and
ownable, #108 gave them a scoped way back to it. This is what they can **ask
for** once they are there — and it serves an authenticated Oxy buyer through the
same code, because after the credential is resolved there is nothing
guest-shaped left (ADR 0003 I9).

The binding decisions are ADR 0003. What follows is what the rules ARE and why,
not a list of endpoints.

---

## The one sentence everything rests on

**A buyer never sets order status. A buyer files a REQUEST.**

The tempting shape is an endpoint that cancels, and it is wrong for a reason
that has nothing to do with guests: cancelling a paid order has to return money,
restock goods and respect a seller's fulfilment state, and every one of those
belongs to a service that already exists and already gets it right. A `cancel`
endpoint would be a second, weaker copy of all three, reachable by the
least-authenticated actor in the system.

So a buyer writes a row. A **seller** (or an operator) decides it. The decision
then drives `order.service.transition` or `refund.service.process` — the same
functions a merchant's own dashboard drives — and stamps the request `completed`
only once they have returned.

The enforcement is the import graph, not a convention. `cancellation-request.service.ts`
and `return-request.service.ts` import no order writer, no refund service, no
inventory function and nothing from the payment domain;
`buyer-request-isolation.test.ts` fails the build if they start to, and asserts
the positive half too (the decision services DO reach both) so the gate cannot
pass by those services having been renamed out of existence. That is acceptance
2 — "a guest cannot mutate status or provider payment directly" — checkable by
reading a list of imports.

---

## Authorization

### A read-only credential cannot reach a mutation, structurally

Authorization rule 1 asks that read-only portal scope be insufficient for a
mutation. The weak form is a scope check at the top of every mutating service,
which works until somebody adds the eighth one and forgets.

Every mutating function in the domain takes a `BuyerRequestActor`, and a
`BuyerRequestActor` can only be obtained from `authorizeBuyerRequest`, because
the type carries a **module-private `unique symbol`** no other file can supply.
There is no object literal, no partial and no cast short of `as any` that
satisfies it — and `as any` is forbidden by the house rules and refused by a
lint rule.

So "did this path check the scope?" is not answered by reading the path. It is
answered by the path existing at all.

### It composes #106 and re-decides nothing

The order half of every decision is `authorizeOrderAccess`, called on a subject
built from the credential. That makes rules 4 and 5 free: the grant's
`checkout_group_id` is compared to the ORDER's, so a credential for one group
cannot reach an order in another, and a request names ONE order so a sibling is
never carried along. `submitCancellationRequest` takes one `orderId`; there is
no `cancelGroup`.

### What it cannot be given

`BuyerRequestCredential` has no member for an email, a phone, an order number, a
cart token, a Stripe identity or an IP address. Rule 6 is held by the parameter
list — the `authorizeOrderAccess` device, one layer up — and the request schemas
have no such field either, which `buyer-request-isolation.test.ts` asserts.

### Step-up

`BUYER_REQUEST_ACTIONS` is a table, not a switch: each action names its scope and
whether it needs a fresh inbox proof. The two SUBMIT actions do; withdraw and
support write do not.

The line is whether the action moves **money or goods**. The attack it closes is
vandalism rather than theft — a refund always returns to the original payment
instrument (rule 9), so somebody holding a stolen 30-day portal credential gains
no money by cancelling. They can still destroy a purchase.

Requiring it on WITHDRAW would be worse than useless: an email round trip
between a buyer and the undo of their own mistake, when the undo is the safe
direction.

### A claimed checkout uses Oxy authorization, and the guest audit survives

Rule 7. An Oxy account proves itself on every request, so there is no scope set
to consult and no staleness to measure. Nothing in that path rewrites a request
the guest filed — the requester triple on an existing row is never touched.

### CSRF

Unchanged from #108: `resolvePortalSession` runs `passesPortalCookieCsrf` on
every cookie-carried state change, against `lib/allowed-origins.ts` — the ONE
origin authority CORS reads (ADR 0003 D10). This issue adds no second one.

---

## Cancellation requests

### Five states, and `accepted` is not `completed`

Rule 2 asks that "a request does not mark the order cancelled before payment,
inventory and seller rules complete". Acceptance is the seller's DECISION;
completion is the world having changed. They are separated because the step
between them can fail, and a single state would have to lie about which side of
the failure the request is on.

There is deliberately no `failed`. A completion that did not complete leaves the
request `accepted` with a bounded `completion_failure` beside it, and the retry
is the same idempotent call — the `payment_repairs` posture.

### Two completion modes, and the mode is RE-DERIVED

`release` returns a reservation; `refund` returns money AND stock through
`refund.service`, which is the only thing in Mercaria that may do both.

The mode is snapshotted at submission from the order's payment state and
**re-derived at completion**, because the two can legitimately differ — a buyer
asks while a payment is still verifying and it verifies a second later, and
completing in `release` mode then would release a reservation on money already
taken. The snapshot survives as what the buyer was told.

### Partial cancellation works only in `refund` mode

Rule 3 says "requested line quantities or whole-order scope **where supported**",
and this is where. Undoing part of an UNPAID order would mean rewriting the
order's lines and totals, which are an immutable snapshot. Partial-on-paid is a
partial refund plus a restock, which `refund.service` does natively. The refusal
names the remedy rather than implying it.

### The safe response names what to do next

`CANCELLATION_INELIGIBILITY_REASONS` has five members rather than one
`not_cancellable`, because "it already shipped, open a return" and "somebody
already asked, read that request" lead to opposite actions.
`CANCELLATION_REASONS_OFFERING_RETURN` states rule 6's return offer as DATA, and
`readBuyerOrderRequestOptions` computes it from the return's OWN eligibility — so
a shipped order past its return window does not offer a return that would be
refused. None of the five discloses anything about another buyer, another seller,
a sibling order or the order's contents.

`order_already_dispatched` is read from the status HISTORY, never from the
current status: an order that shipped and was then partially refunded reads
`partially_refunded` today, and asking "is it shipped" of the current status
would offer a cancellation on goods already with the buyer.

---

## Return requests

### Nine states, and three pairs that look like one until you ask who acts next

- **`approved` vs `awaiting_item`.** Approval is the seller agreeing the return
  is valid; `awaiting_item` is the seller having issued instructions and waiting
  for the parcel. The step between them carries the instructions.
- **`withdrawn` vs `cancelled`.** The buyer abandoned it, versus a seller or
  operator terminating an approved one. Two facts about who acted should not
  share a word.
- **`refund_pending` vs `completed`.** The commerce record has committed and the
  rail has not finished. ADR 0001 D7 makes those genuinely different facts and
  #49 already carries both; this state is where the difference is visible to the
  buyer.

`received` is a STATE rather than a flag because of the timing it enforces: a
cancellation refunds and restocks immediately (the goods never left), a return
cannot — refunding at approval would put units back on the shelf that are still
in a parcel. `refund.service` is the only thing that restocks, so the refund
waits for `received`. That is rule 5 with the timing made structural.

### Return shipping is the seller's words, and Mercaria composes none

The issue says return instructions are "owned by the relevant fulfilment system"
and forbids building a carrier or shipping-zone system here. Moovo owns that and
has not landed, so `return_instructions` is a bounded text a seller writes.
Mercaria generates no label, no address and no drop-off point, and
`ship_back_deadline_at` is the seller's own answer to "by when" — the CHECK
refuses a deadline with no instructions behind it, because that is a date nobody
was told about.

### The unit ceiling counts requests IN FLIGHT

"How much is still returnable" subtracts the units an OPEN return is already
bringing back, not only what a completed one did. Counting completed returns
alone would let a buyer open a second return for the same three shirts while the
first three were in the post, and a seller approving both would refund six.

### `replacement` is representable and refused

`RETURN_RESOLUTIONS` carries it; `SUPPORTED_RETURN_RESOLUTIONS` does not, and the
submit path refuses it BY NAME with the remedy. A replacement is a second
shipment against a line that is already paid: it needs an order that charges
nothing, reserves stock and settles no seller, and Mercaria models none of that.

Keeping the value is the `role_email` decision from #83 — the refusal names what
the buyer asked for, and enabling it later is a service change rather than a
migration. The refusal is at SUBMIT rather than at approval, so a buyer is not
told "yes" and then "actually no" a day later by a seller with no way to deliver
it.

### Deadlines are snapshotted from a REAL policy

`stores.policies_return_window_days` already exists and is already editable by a
merchant, so `return_window_ends_at` is a snapshot of something rather than of a
constant. A store shortening its window tomorrow cannot close a return filed
today.

A P2P seller has no store row and gets `DEFAULT_RETURN_WINDOW_DAYS` — the
generous direction deliberately: somebody selling one used item has stated no
policy, and inventing a shorter window on their behalf would take a consumer
right away by omission.

The window is anchored on the DELIVERED event when there is one, else on SHIPPED,
because a seller who never marks an order delivered must not be able to run a
buyer's return window out by inaction.

### Evidence is DECLARED, and Mercaria validates nothing about the file

A bare Oxy `file_id` the buyer already uploaded to their own Oxy storage — the
`abuse_reports` posture. Never a URL, and never a `mercaria.co` one: the
moderation domain already establishes why (a reviewer's browser fetching a
Mercaria URL would tell this host when its content is being looked at).

**The gap, stated:** Mercaria holds no Oxy service credential, so
`getServiceAssetMetadataByIds` would throw — it cannot read the file's metadata,
cannot compute a digest and cannot scan it. Asserting any of the three would be
worse than admitting it has none. This is the SAME gap `services/moderation/`
documents, and closing it closes both: Oxy service credentials, and then the
digest must also enter whatever the evidence is cited in.

---

## Refunds

`refund-bridge.ts` is the ONE place this domain moves money, and it reimplements
nothing. Every rule the issue's refund section asks for already exists in #49 and
is fed rather than copied:

| Rule | Where it already lives |
|---|---|
| 1 — provider-neutral operation | `refund.service.process` → the `payment_refunded` outbox |
| 2 — amounts from immutable order and prior refunds | `refund.service` computes from the order's discounted net |
| 3 — fee and transfer behaviour | #88's snapshot + `seller-net-shares.ts` |
| 4 — verified provider events authoritative | read from `refunds.provider_state` |
| 5 — restock approved quantities exactly once | `refund.service` restocks per line; nothing here touches inventory |
| 6 — pending/succeeded/failed/reversed represented | #49's three states, surfaced as `refund_pending` vs `completed` |
| 9 — destination stays the original path | the adapter has no destination parameter |
| 10 — never ask for card or bank credentials | nothing in this domain could use them |

**The idempotency key is derived from the REQUEST** (`buyer-request:<id>`), and
`refunds.idempotency_key` is uniquely indexed with `refund.service` short-
circuiting on it *before* touching inventory. So an operator retry, a second
seller pressing the same button and a redelivered job converge on ONE refund.
That is what makes "cannot double-restock" true rather than merely likely.

**A cancellation refunds delivery and a return does not.** A cancelled order was
never shipped; a returned one was carried, and refunding that is a policy
decision nobody has taken. A seller who wants to can issue a further refund from
their own dashboard, which is where a discretionary gesture belongs.

**The dependency points one way.** This domain reads `refunds.provider_state`; it
does not subscribe to provider events, and nothing in the payment domain knows
this domain exists. A hook from `refund-execution.service` into here would invert
the seam that keeps the money path free of everything built on top of it — the
same one-way rule `verified-conversion.ts` states for analytics. The sweep in
`reconciler.ts` is what catches a rail that answered late.

### The one gap, named

`refund.service.process` is scoped to a STORE, and
`/admin/stores/:storeId/orders/:id/refunds` is the only route that reaches it —
so **a P2P order has no refund path in this repository, for any actor, and never
had one.** That is pre-existing and #110 names it rather than papering over it:
`orderHasRefundPath` answers `false` and the completion records
`refund_path_unavailable`.

It is unreachable for a guest today, because guest P2P checkout is refused
outright (ADR 0003 D18 / ADR 0006 G18, until #112) — so every guest order is a
store order. It IS reachable for an authenticated Oxy buyer who bought from a
person, and the honest answer is louder than a refund that silently never
happens.

---

## The support thread

### What it exists instead of

"Rather than exposing buyer and seller personal email by default." The
enforcement is absence: no address column anywhere in the domain, no recipient on
a message, and the notification that a reply is waiting goes through
`guest_portal_messages`, which decrypts the contact at the moment of sending and
never writes it down.

### The author is a KIND and a label, never a person

`buyer | seller | operator`, and the two buyer origins collapse into one: a
seller reading the thread must not learn whether they are talking to a guest or
an account holder. That is #106's `Guest` label rule applied to a conversation
and merchant rule 7 ("do not label a guest as lower trust merely because no Oxy
account exists"). `author_oxy_user_id` and `author_grant_id` are in
`PROTECTED_COLUMNS`, so the repository's row type has no such property and one
projection is correct for both sides.

### Redaction happens before storage

`redactSupportBody` is pure and runs in the write path, so what lands in the
table is the redacted form and the original is dropped. Five kinds — card, IBAN,
email, phone, Mercaria access token — and the rule ORDER is load-bearing:
credentials first, IBANs before cards, both before the phone rule. The phone
rule's separators are MANDATORY, or `order 4021 8899` is a phone number and the
messages worth keeping are exactly the ones full of reference numbers.

The list is deliberately short. An over-eager pass eats order numbers, tracking
references and postal codes, and a support channel that cannot quote an order
number is useless for the thing it exists for. Rule 6 says "warned against AND
redacted where feasible"; the warning is the storefront's.

### Append-only

`support_messages` refuses UPDATE and DELETE by trigger, which is what makes a
thread usable as evidence in a dispute: neither side can edit what they said and
neither can remove it. Rule 9 ("thread closure does not remove financial or
dispute records") is the weaker half of the same property — closing writes two
columns on the THREAD and touches nothing else.

A reply reopens a closed thread, because a closed thread that cannot be reopened
only teaches people to open a second one.

### Never a review, never a case

Rules 7 and 8. This domain writes no `reviews` row, opens no moderation case and
imports neither domain; the isolation gate fails the build if that changes.
Reporting abuse routes to `POST /reports`, which already exists and already
delivers through the moderation outbox.

### No attachments, and that is a decision

Rule 5 asks that attachments use "approved media validation, malware scanning
and retention". **Mercaria has no malware scanning at all**, and no credential
with which to read an uploaded file's metadata. Building an unvalidated upload
channel that a seller's browser then opens is the thing rule 5 exists to prevent.

So this domain has no attachment column on a message and no route that could
accept one. A buyer with a photograph attaches it to the RETURN REQUEST, where a
seller's decision cites it — one provenance channel, the #90 reasoning. Two
places establishing a photograph's ownership could disagree.

---

## Contact and address correction — EXCLUDED

The issue's last option for this section is rule 10: "exclude the capability
entirely if #102 or operational review determines it is unsafe." It is excluded,
and the reasons are specific rather than a shrug:

- **Rule 3 asks it to revalidate seller, shipping, tax, payment and fraud
  implications.** Mercaria can revalidate none of them. Moovo owns shipping and
  has not landed, #93 owns pickup and fails closed, and there is no fraud
  service to consult.
- **Rule 2 asks for step-up verification of the NEW inbox.** No flow verifies an
  address that is not already the one on the checkout — the whole portal is
  built on a credential scoped to a contact that already exists.
- **Rule 1 asks it be a request rather than a mutation of immutable history**,
  and the honest version of that is a request nothing can fulfil.

#108 had already made `contact_change:request` **defined and not grantable** —
the CHECK, the projection and the authorization switch all exist for it, and
`resolveGrantScopes` declines to offer it. #110 leaves it that way. The gap is
documented rather than invisible, and enabling it is a service change rather
than a schema one.

---

## Merchant experience

- **No Oxy buyer profile is required.** The merchant projections read the
  request row and nothing else.
- **`requesterLabel` is the literal `Buyer`** — never `Guest`, never
  `Guest #4821`, never an Oxy handle, and no buyer-origin discriminant anywhere
  in either shape. Merchant rule 7 is held by the projection not saying which.
- **The allow-list is a VALUE, walked at RUNTIME.**
  `MERCHANT_BUYER_REQUEST_FIELDS` is compared against the keys of a real emitted
  projection. The first spelling of this rule was `Omit<T, never>`, which
  compiles, looks like #106's `MerchantOrder` device, and can never fail —
  there is no buyer-identifying field on a request today, so subtracting the
  empty set enforces nothing and would go on enforcing nothing after somebody
  added one.
- **Permissions reuse what exists.** `orders:read` reads the queue and answers a
  thread; `orders:fulfill` decides and completes a cancellation, issues return
  instructions and marks a return received; `refunds:write` decides a RETURN and
  commits its refund. No new store permission was needed, which is what the
  issue asks for.

---

## Notifications

Seven new message kinds on top of #108's seventeen, and the arithmetic is not
one-to-one:

- "Cancellation approved OR rejected" is two events with opposite meanings and
  gets two kinds — the subject lines have to differ.
- "Return approved, rejected or awaiting item" and "return received" are four
  STATES of one request and share `return_request_updated`, told apart by the
  state passed as the enqueue's `dedupeSuffix`. That is #108's own mechanism,
  used for the case it was built for.
- "Cancellation completed" needs no kind at all: completing one cancels or
  refunds the order, and `order_cancelled` / `refund_completed` already fire
  from the transition.

`refund_pending` was deferred by #108 on the reasoning that "pending" would mean
the RAIL had not paid yet, which a buyer cannot act on. In a RETURN it means
something different and actionable — the seller approved, the goods are
accounted for, the money is coming — which is why the trigger lives here and not
in the payment domain.

**Every function in `notifications.ts` returns `void.`** Communication rule 6 ("a
notification failure does not roll back a completed refund or cancellation") is
held by the SIGNATURE: there is nothing to await, so a caller who tried would get
a `tsc` error and a queue write can never join a money transaction.

**Every message links to the portal ENTRY, never to a mutation.** None of the
seven is in `GUEST_PORTAL_LINK_BEARING_MESSAGE_KINDS`, so their bodies carry the
credential-free portal URL. A "cancel now" link in an email would be a mutation
reachable from a forwarded message.

**Marketing is unreachable.** No subscription call, no list id and no consent
read anywhere in the domain — asserted by the isolation gate.

---

## Analytics

The three #77 event types (`guest_cancellation_requested`,
`guest_return_requested`, `guest_support_request_created`) EMIT now, from the
controller and AFTER the write succeeded — so `guest_post_purchase_demand`
counts requests that were FILED rather than requests that were attempted, which
is what its "requests, not outcomes" attribution limit means.

They carry the ORDER (admitted for these types by
`ANALYTICS_COMMERCE_CORRELATED_EVENT_TYPES`) and the actor KIND, and nothing
else. The request's reason code, the buyer's note and every support message body
have no column and must not acquire one.

A request filed by a CLAIMANT of a guest order counts too — it is the same
purchase — which is why the numerator is the three event types rather than an
actor-kind filter over them.

The metric stays aggregate-only and merchant-invisible, and **metrics cannot
become a guest-ranking or service-denial rule**: nothing in the domain reads a
rollup, and the analytics domain's own ranking-isolation gate already runs both
ways.

---

## Operations

### Levers

| Variable | Default | What it stops |
|---|---|---|
| `BUYER_REQUESTS_ENABLED` | `true` | NEW buyer requests (503, `BUYER_REQUESTS_DISABLED`). Reads, decisions and every request already filed are unaffected. |
| `BUYER_REQUEST_RECONCILER_ENABLED` | `true` | The refund-settlement sweep LOOP. The merchant and operator surfaces drive the same idempotent path. |
| `BUYER_REQUEST_RECONCILE_INTERVAL_MS` | `60000` | — |
| `BUYER_REQUEST_RECONCILE_BATCH_SIZE` | `50` | — |
| `BUYER_REQUEST_RECONCILE_GRACE_MS` | `30000` | How long a `refund_pending` return is left to the inline drain before the sweep touches it. |

**Neither lever gates a durable record.** A cancellation request is a buyer
waiting for an answer, and a flag that stopped the row being written would lose
it silently.

`BUYER_REQUESTS_DISABLED` is a 503 rather than a 403 on purpose: this deployment
DOES do cancellations and returns, it has temporarily stopped taking new ones,
and retrying later is the client's correct response.

### The operator surface

`/internal/guest-commerce/buyer-requests/*`, on the SAME
`GUEST_OPERATOR_OXY_USER_IDS` allow-list #104 and #108 use rather than a seventh
one — the power is the same (reading what a guest did with their purchase and
driving a path they can drive themselves). It is deliberately NOT the payment
operator list: a support agent tracing a stuck return should not thereby be able
to see every store's money.

A trace opens from an ORDER and nothing else. The ONE write drives
`reconcileReturnRefund`, an idempotent path a merchant also drives — so this
surface adds a trigger and no new way to move money. There is no "set this
request completed", no "override this decision", no "approve this return" and no
way to write into a support thread as somebody else.

### Incident runbook

**A return is stuck in `refund_pending`.** Read
`GET /internal/guest-commerce/buyer-requests/orders/:orderId` — the timeline
shows whether `refund_committed` fired. If it did, the commerce record is
committed and the stock is back; the rail is what has not answered. `POST
…/returns/:requestId/reconcile` re-reads `refunds.provider_state` and advances,
or leaves it where it is. If the rail reported a failure, #49's own
`refund_failed` discrepancy is where the money question lives; this domain only
records that the buyer was told.

**A cancellation is stuck in `accepted`.** `completion_failure` names why.
`refund_refused` and `order_state_changed` both mean the order moved underneath
the decision — re-read the order. The retry is
`POST /admin/stores/:storeId/orders/:id/cancellation-requests/:requestId/complete`,
which is the same idempotent call the accept path makes.

**A buyer says they cancelled and the order shipped anyway.** The request's
timeline is append-only and records every attempt including refusals. A
`decision_refused` or a `completion_failed` with `order_state_changed` says the
seller shipped between the request and the completion.

---

## Production-readiness checklist

- [ ] `GUEST_OPERATOR_OXY_USER_IDS` populated — without it the trace is not
      mounted (404), which also means nobody can reconcile a stuck return.
- [ ] `BUYER_REQUESTS_ENABLED` reviewed. It defaults ON; guest commerce as a
      whole is still gated by `GUEST_COMMERCE_ENABLED`, which is OFF until the
      ADR 0003 M8 review clears.
- [ ] A transport registered for `guest_portal_messages` (#108's seam). **Until
      then no buyer is told anything** — every message row is created, kept and
      marked `transport_unconfigured`, visibly. The requests themselves work.
- [ ] Store return windows reviewed. `stores.policies_return_window_days`
      defaults to 30 and `policies_refund_policy` is free prose beside it; a
      store whose prose says 14 days while the column says 30 is a real
      inconsistency this issue surfaces rather than creates.

---

## Seams left, each a named contract

- **#93 (pickup)** — `pickup_not_supported` is a real branch that is unreachable
  today, because `assertPickupLocationEligible` refuses every pickup at
  checkout. It is kept rather than deleted so a cancellation cannot quietly take
  the `release` path and leave a collectable-inventory hold nobody modelled.
- **#112 (guest P2P)** — the reason `refund_path_unavailable` is unreachable for
  a guest. When guest P2P lands, a P2P refund path has to land with it.
- **#111 (retention)** — support rule 10. Buyer requests are commercial records
  retained with their orders, and this domain registers no expiry target;
  `guest_checkouts` erasure (ADR 0003 D15) already removes the contact while the
  orders and their requests stay.
- **#102 (privacy review)** — the contact-correction exclusion above is the
  answer #110 gives today; a review that finds it safe would enable
  `contact_change:request` in `resolveGrantScopes` and build the flow.
- **Oxy service credentials** — until they exist, declared return evidence
  carries no digest and no scan. The same gap `services/moderation/` documents.
- **Moovo** — return shipping. Instructions are the seller's own words and
  Mercaria composes no label, address or drop-off point.
