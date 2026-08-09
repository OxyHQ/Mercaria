# The guest order portal (#108)

How somebody who bought without an Oxy account comes back to that purchase —
from a different device, three weeks later, having lost the cart credential they
bought with — and how that is done without ever turning "an order number plus an
email address" into a password.

Binding decisions: ADR 0003 (`docs/adr/0003-commerce-actor-guest-identity.md`)
D5, D9, D10, D11, D12, D13, D14, D15, D17, and invariants I1–I5 and I11.
Schema decisions: `packages/backend/src/db/schema/CONVENTIONS.md`
§"The guest order portal (#108)".

## The one property everything here exists to hold

**A credential authorizes exactly ONE checkout group.** Not an email's orders,
not an inbox, not a person — one `checkout_group_id`, named on the grant row.

Two people who share an inbox and bought separately hold two unrelated
credentials. A recovery request for an address that placed three checkouts sends
three independent messages, each with its own single-use token scoped to one
group; at no point does an authorization context, a response or a message hold
two checkouts at once. That is #108's email-verification rule 8 — "do not
correlate separate guest checkouts automatically from a matching verified
email" — made structural rather than promised.

There is no shape anywhere in the domain that could describe "every order for
this address". A request asking for one is not refused; it is unrepresentable.

## The credentials

Two, in ONE table (`guest_order_access_grants`, ADR 0003 D5), because they are
the same five facts — a hashed secret, a checkout group, an expiry, a revocation
and an inbox proof — differing only in lifetime and carriage. A second table
would be a second place to get a liveness rule wrong, and liveness is the whole
of the authorization.

| | `mgx_` exchange | `mgp_` portal |
|---|---|---|
| Lives | 15 min (`GUEST_MAGIC_LINK_MINUTES`) | 30 days (`GUEST_PORTAL_GRANT_DAYS`) |
| Carriage | the FRAGMENT of a link Mercaria mails | `__Host-mercaria_portal` cookie, or the `X-Mercaria-Portal-Token` header |
| Use | single, atomic (`consumed_at` CAS) | many |
| Reads | nothing — the only statement that accepts one CONSUMES it | its group, at its scope |

Both are `<prefix>` + base64url of 32 CSPRNG bytes; the server stores only the
hex SHA-256. No pepper, for `guest_sessions`' reason: a 256-bit random preimage
is neither invertible nor dictionary-attackable, and a pepper makes every stored
hash unverifiable the day it rotates. Resolution narrows on the unique hash
index and the ACCEPT decision is then re-made with `verifySecret`, so the code
path that says yes never compares secrets with `!==`.

**Scope is STRUCTURAL.** `readExchangeToken` and `readPortalToken` are two
functions with two anchored patterns, and the portal has its own resolver
(`middleware/guest-portal.ts`) rather than a branch inside the commerce one. A
`mgs_` cart credential presented to the portal fails its shape gate before any
hashing — invariant I3 as a property of the call graph rather than of a `WHERE`
clause somebody could forget.

## Scopes

Eight, closed, rendered into a database CHECK:

`orders:read` · `tracking:read` · `documents:read` · `cancellations:request` ·
`returns:request` · `support:write` · `claim:write` · `contact_change:request`

**Bound server-side, and there is nowhere for a client value to arrive.**
`resolveGrantScopes(origin, emailVerified)` takes no caller-supplied argument, no
route schema accepts a `scopes` field, and the emailed link carries one opaque
token and nothing else (#108 magic-link rule 7). `guest-portal-isolation.test.ts`
fails the build if any module in the path reads a scope off a request.

**`contact_change:request` is DEFINED and NOT GRANTABLE.** Changing the address
a placed order was made with is a mutation of an immutable commercial record and
needs a re-verification of the NEW inbox that no flow exists to perform; #110
owns the surface. The value stays in the tuple — the CHECK, the projection and
the authorization switch all exist for it — and the registry declines to offer
it. That is `role_email`'s decision from merchant claiming (#83): deleting the
member would make the gap invisible and turn enabling it into a schema change.

## The verification model, and the two CHECKs that carry it

ADR 0003 D17 draws a line between PROSPECTIVE operations (what a device may do)
and RETROSPECTIVE ones (what proof of an inbox may do). #108 makes both halves
structural rather than procedural:

- **`guest_order_access_grants_verification_origin_check`** refuses a
  verification instant on a `post_checkout` row. So paying — by card, by wallet,
  through Stripe Link — cannot mark a Mercaria contact address proven, in any
  code path, ever. That is #108 email-verification rules 2 and 3.
- **`guest_order_access_grants_unverified_scope_check`** holds an unproven
  PORTAL credential to `tracking:read`. So the strongest thing possession of the
  paying device can buy is a bounded status view, whatever a service does.

It exempts `exchange` rows deliberately: their scopes are a PROMISE of what the
credential they mint will carry, and an exchange token can read nothing.

`email_verified_at` is ONE column and the boolean is derived. ADR 0003 D5 names
`email_verified boolean NOT NULL`; storing the instant instead is the same
correction #106 made to `guest_checkouts.contact_verified_at`, for the reason
`guest_sessions` has no status column — and the instant is what a step-up
freshness check needs anyway, so the boolean would have had to sit beside it
rather than replace it.

## The three ways a credential comes into existence

### 1. The confirmation the paying device PULLS

`POST /guest/orders/confirmation` — the device presents the guest SESSION that
placed the group, and the authorization is a JOIN rather than a comparison: the
group's `guest_checkouts` row must name that session. A session that placed
nothing, or placed something else, matches no row.

**Why pulled and not pushed.** ADR 0003 D5 says checkout completion mints this
grant. It cannot: completion runs in the payment outbox, minutes after the
buyer's request ended and with nobody there to receive a bearer token — a token
minted into a handler is a token minted into a log. So the WHEN moved and
nothing else did. The consequence is a good one: the confirmation view works
before the webhook arrives, which is #108 initial-confirmation rule 3 and test
case 11 in one.

This is not the cart token becoming order access (I3). It exchanges one
credential for a DIFFERENT, narrower, separately expiring and separately
revocable one, scoped to the single group that session created, carrying
`tracking:read` alone. At most five live at once, because a buyer legitimately
wants the confirmation on the phone they paid from AND the laptop they were
browsing on — and unbounded would make one cart credential a credential factory.

### 2. The link in a message

Minted INSIDE the send transaction, so the plaintext exists for the length of
one delivery attempt and never rests in a queue row. Three message kinds carry
one (`order_confirmation`, `access_link_recovery`, `access_link_step_up`); every
other kind links to the portal's entry page with no credential in the URL at
all. A shipping notice does not need to hand out access, so it does not.

### 3. The exchange

`POST /guest/orders/exchange`. ONE transaction, and everything in it is a
consequence of the consume succeeding. The consume is
`UPDATE … SET consumed_at = now() WHERE token_hash = $1 AND consumed_at IS NULL
AND revoked_at IS NULL AND expires_at > now() RETURNING …` — the empty-vs-one-row
result IS the already-used answer, so two concurrent exchanges of one link mint
exactly one credential with no lock and no read-then-write for a racer to walk
past.

**A link scanner cannot burn a link.** The token rides in the URL FRAGMENT
(ADR 0003 T4), which no client sends to a server, so following the URL reaches a
page and never the exchange statement. Consuming requires a POST that only the
SPA makes, from a value only the browser can see.

**Superseding is narrow on purpose.** A `sensitive_action` exchange rotates the
session it was requested from (#108 magic-link rule 9). An `initial_confirmation`
or `recovery` exchange revokes nothing: a person reading mail on a laptop must
not silently log out the phone they paid from, and the credential they are
replacing may be the only one they still have. "Secure my access" is the
deliberate, user-driven revoke-everything and is a separate act with a separate
button.

## Recovery

`POST /guest/orders/recover` **always answers 202 with one fixed sentence.**

The work happens AFTER the response is written, so a match and a non-match
cannot be told apart by timing either (ADR 0003 T5), and
`requestGuestOrderRecovery` resolves `void` — there is no return value a caller
could branch on. A malformed body is the one exception and is a 400: it says
nothing about whether any address exists, and answering 202 to a request that
named no address would hide a client bug behind a security property.

- **The destination is never a caller's to choose.** The request has no
  destination field and the send path reads `guest_checkouts.email_ciphertext`.
  #108 recovery rule 4 is unrepresentable rather than refused.
- **The order number is a HINT.** ADR 0003 T6 treats order numbers as public.
  It narrows a search already scoped by the email hash; it can never widen one,
  cannot be presented without an address, and a number naming somebody else's
  order narrows to nothing (which is why the answer is identical either way —
  ignoring a non-matching hint would let a caller learn that a guessed number
  belongs to a different inbox by observing that they still got a mail).
- **Repeats converge.** The message's dedupe suffix is the throttle WINDOW, so
  five requests inside one window produce one message per group, while a request
  in the next window legitimately produces a fresh link for somebody whose first
  one expired (#108 recovery rule 5).
- **Fan-out is bounded** to the five most recent groups. An address that placed
  fifty checkouts is either a very good customer or a mail amplifier, and an
  unbounded fan-out is the second one whichever it is; the order-number hint is
  how somebody reaches an older group.

### Throttling: three axes, two of them durable

| Axis | Where | Why |
|---|---|---|
| `network` | Redis (`rl:guest-recover:`) plus a durable counter | Coarse — IPv4 /24, IPv6 /64. Shared by whole offices and carriers, so it bounds a flood and identifies nobody; a /64 is what stops a v6 client walking its own allocation around the limit. |
| `email_hash` | Postgres | "How often has THIS INBOX been asked for, across every ECS task and every source address" is not a question a per-process bucket can answer. |
| `order_reference` | Postgres | Same. |

Every subject is an HMAC under `GUEST_EMAIL_HASH_KEY` with the AXIS in the
preimage, so the table counts without being able to name an address, an order or
a client, and a digest from one axis cannot be tested against another's rows.
There is no user agent, screen metric, TLS characteristic or persistent client
identifier anywhere in it — the absence IS #108 recovery rule 2's "without
fingerprinting". Counting is `INSERT … ON CONFLICT DO UPDATE SET attempts =
attempts + 1 RETURNING attempts`, one statement, so a burst cannot have every
racer read the same value and all pass a ceiling they collectively exceeded.

## Transactional messages

`guest_portal_messages` is the moderation outbox, ported once more: a
deterministic caller-supplied id, `ON CONFLICT DO NOTHING` so a repeat is a
genuine no-op down to the row's `xmin`, leases taken with `FOR UPDATE SKIP
LOCKED`, capped exponential backoff, and a visible `dead_letter`.

The deterministic id is what makes **duplicate payment webhooks converge on one
initial message** (#108 initial-confirmation rule 7): a redelivered
`payment_intent.succeeded`, a reconciliation sweep re-deriving the same fact and
two tasks racing all collide on the primary key.

**The row holds no recipient**, in any form. The send path decrypts
`guest_checkouts.email_ciphertext` at the moment of sending and never writes it
down, so a queue that backs up is a list of things Mercaria owes rather than a
mailing list. It holds no subject and no body either: the TEMPLATE is code, so a
copy fix or a new language applies to queued messages instead of freezing
whatever the enqueuing process rendered.

### The transport is a NAMED, FAIL-CLOSED seam — nothing sends today

**Mercaria has no outbound email.** `services/guest-portal/transport.ts`
declares the port and its registry is EMPTY; nothing in the repository registers
one. Every message is enqueued durably, rendered from a real template, checked
against the suppression list, and then fails its delivery attempt with
`transport_unconfigured` — visibly, in the operator trace, with the row still
there.

That is deliberate, and the alternatives were both worse. A `console.log`
transport looks like a working feature in every test and sends nothing in
production. An SES client against credentials nobody provisioned looks like a
working feature in production and fails on a credential error that reads like an
outage rather than like an unfinished issue. This is the same refusal
`role_email` makes in merchant claiming (#83) and the supplier adapter registry
makes in preflight (#122).

**Closing it costs one module implementing `GuestMessageTransport` and one
`registerGuestMessageTransport` call at boot.** Nothing else in #108 changes —
not the queue, not the templates, not the retry policy, not the suppression
list, not a single test.

`transport_unconfigured` is classed PERMANENT: a seam does not close on its own,
so retrying every five seconds forever would fill an operator's view with a fact
about the deployment rather than about any message.

### The seventeen kinds, and who triggers each

`GUEST_PORTAL_MESSAGE_TRIGGERS` (in `message.service.ts`) names the enqueuer for
every kind or the issue that owes one, and
`guest-portal-policy.test.ts` fails the build if a kind is neither — the
`deferred: #NN` device from the Stripe event ingress.

Triggered today: `order_confirmation` (the #107 outbox handler),
`order_processing` / `order_shipped` / `order_delivered` / `order_cancelled` /
`refund_completed` (the order status transition, guest-origin orders only),
`access_link_recovery`, `access_link_step_up`, `access_security_notice`.

Deferred with their owners: `payment_pending`, `payment_failed`,
`payment_delayed_success` (#111 — each needs a threshold nobody has chosen;
mailing every 3-D Secure challenge, or a buyer mid-retry, is worse than
silence), `refund_pending` (#49/#110), `tracking_updated` (#110 — Moovo),
`order_ready_for_pickup` (#93 — pickup fails closed at checkout, so no order can
reach the state), `return_request_updated` (#110), `claim_completed` (#109).

### Bounces, complaints and permanent failure

`guest_contact_suppressions` is keyed on the email HMAC and never on an address,
so a leak of the whole list discloses no addresses and the send path needs no
more than a yes or no. Suppression is a fact about an ADDRESS and not about an
order: a hard bounce means the mailbox does not exist and no order changes that.

**Nothing expires.** A hard bounce does not heal on a schedule and a person who
complained did not consent again by waiting; lifting one is an explicit act with
a stored actor, instant and reason. A suppressed address makes every future
message to it terminal — and **the ORDER stays fully readable in the portal**,
which is #108 privacy rule 5 ("handle bounces, suppression and complaints
without losing the order record").

**When delivery permanently fails**, the buyer's route back is the portal itself:
every critical fact is in it and not only in an email (privacy rule 10), the
order number they were shown at checkout identifies the purchase, and an
operator can trigger one audited re-send.

## The portal surface

| Route | Needs | Answers |
|---|---|---|
| `POST /guest/orders/recover` | nothing | 202, always the same |
| `POST /guest/orders/exchange` | a valid `mgx_` | 201 + credential in kind |
| `POST /guest/orders/confirmation` | a guest SESSION that placed the group | 201 + credential in kind |
| `GET /guest/orders/session` | a portal credential | what it is and may do |
| `GET /guest/orders/:groupId` | `orders:read` | the full view |
| `GET /guest/orders/:groupId/status` | `tracking:read` | the bounded view |
| `POST /guest/orders/:groupId/step-up` | a portal credential | 202, link queued |
| `POST /guest/orders/:groupId/secure-access` | a FRESH inbox proof | revoked ids |
| `DELETE /guest/orders/session` | nothing | 204, always |

**Two views, two TYPES.** `GuestOrderPortalView` is the full picture;
`GuestOrderStatusView` is what an unverified confirmation credential may see —
order number, coarse status, seller and an item COUNT, and deliberately no
money, no address, no item titles and no contact in any form. A different type
rather than a filtered one, the `MerchantOrder` device from #106: a serializer
that reached for a total on the bounded shape fails `tsc`.

The full read goes through `authorizeOrderAccess` (#106) per order rather than
re-implementing the rule. The route additionally compares the `:groupId` in the
path against the credential's own — not redundant: it is what makes a client
holding two credentials get a 404 instead of silently reading whichever the
cookie named.

**A scope mismatch is a 403 and a group mismatch is a 404**, because "this group
exists but is not yours" is a fact about somebody else's purchase.

### Sensitive actions need a FRESH proof

`secure-access` requires `email_verified_at` within
`GUEST_PORTAL_STEP_UP_MINUTES`. The point is that a thief holding a stolen
credential must not be able to lock the owner out with it — and a stolen
credential is by definition not fresh unless the thief also has the inbox, at
which point the order is not the loss. `step-up` sends a new link; consuming it
ROTATES the session, so the window measures the newest proof.

"Secure my access" spares the presenting credential. Without that, securing your
access logs you out, and a control people avoid pressing protects nobody.

## Transport and CSRF

`middleware/guest-portal.ts` reuses `commerce-actor.ts`'s decisions verbatim,
because they were argued once and a second answer could only disagree:

- **Web:** `__Host-mercaria_portal` — HttpOnly, Secure, SameSite=Lax, Path=/, no
  Domain. Dev uses `mercaria_portal_dev` WITHOUT Secure under a different name,
  logged once at first use: an explicit downgrade, never a silent one.
  `SameSite=Lax` rather than `Strict` because the portal is reached by clicking
  a link in a mail client, and `Strict` drops the cookie on exactly that
  navigation.
- **Native:** the `X-Mercaria-Portal-Token` response header once, then
  `expo-secure-store`, then the request header of the same name. Delivered by a
  VERIFIED universal/app link and never a custom scheme, which any app on the
  device can register (ADR 0003 T14).
- **CSRF:** strict Origin (else Referer) verification against
  `lib/allowed-origins.ts` — the SAME list CORS reads, no second authority and
  no double-submit token — for every cookie-authenticated state change AND for
  the exchange, which SETS a cookie. Header transport is exempt: a custom header
  forces a CORS preflight the existing allowlist already refuses cross-site.

### What the client must do, because the server cannot

The token is in the fragment precisely so the server never sees it, which makes
three obligations the storefront's (`app/(app)/guest-orders/portal.tsx`):

1. **Strip it immediately** — `history.replaceState` removes it from the address
   bar and from the entry the back button would return to, before the exchange
   resolves. The value is captured into a local first: replacing the URL is what
   makes it unreadable, so reading it has to come first.
2. **`<meta name="referrer" content="no-referrer">`** on the portal and recovery
   screens, so that even in the window before the strip no subresource can carry
   the location to a third party.
3. **Exchange ONCE** — a `useRef` guard plus `retry: false` on the mutation.
   React's development double-invoke, a fast refresh or a query retry would each
   burn a grant and leave the buyer told their link is invalid.

## The operator surface

`/internal/guest-commerce/portal/*`, behind the SAME
`GUEST_OPERATOR_OXY_USER_IDS` allow-list #104's cart diagnostic uses — reading
who could reach which checkout group is the same power class as reading who
merged which cart, and a seventh allow-list would grant whichever an operator
was not vetted for. Empty means the router is not mounted at all (404).

- `GET  …/portal/checkouts/:checkoutGroupId` — the trace.
- `POST …/portal/checkouts/:checkoutGroupId/resend-access-link`
- `POST …/portal/checkouts/:checkoutGroupId/revoke-access`

**Two actions and no third.** Both are things the buyer can already do
themselves, so this adds an audited TRIGGER and no new capability — the
`payment_repairs` posture. There is deliberately no "read this address", no
"send to a different address", no "mark this contact verified" and no "grant
access to this group": **no Mercaria employee is ever in possession of a portal
credential**, because the only function that mints one from an operator's
request puts it in the buyer's inbox (ADR 0003 T15).

The re-send has no destination field, in the service signature or the HTTP
schema. The trace opens from a CHECKOUT GROUP and nothing else — no email, no
hash, no order number, no session id — so "everything this inbox has ever
accessed" has no request shape. The contact appears only as `email_redacted`,
the grant list carries no token hash, and the message list has no recipient
column to omit.

Every attempt is audited in `guest_portal_operator_actions`, append-only, with a
mandatory actor and reason — **refusals included**, because an audit that only
recorded successes answers "did anyone try" with silence.

## Flags

Five levers now, and the interaction is the part worth knowing:

| Flag | Default | Gates |
|---|---|---|
| `GUEST_COMMERCE_ENABLED` | false | the whole guest domain — no credential resolves at all |
| `GUEST_SESSION_ISSUANCE_ENABLED` | true | NEW sessions only |
| `GUEST_CART_ENABLED` | true | whether a credential may own commerce state |
| `GUEST_INLINE_DESTINATION_ENABLED` | true | whether a guest may place an order |
| `GUEST_PORTAL_MESSAGE_DELIVERY_ENABLED` | true | the dispatcher LOOP, never the row |

**No lever gates a portal READ.** The router is mounted unconditionally, the
exchange resolves unconditionally, and recovery answers unconditionally — #108
acceptance 10 and ADR 0003 M8, which says the flag gates issuance and guest
checkout "never the durable records: existing portal grants and magic-link
recovery for already-placed guest orders keep working with the flag off".
`guest-portal-isolation.test.ts` fails the build if a read path learns to read
one, and `guest-portal.integration.test.ts` runs its whole suite on a deployment
where `GUEST_COMMERCE_ENABLED` is off — asserting the premise, so the file
cannot quietly start relying on it.

The ONE interaction that IS real: `POST /guest/orders/confirmation` needs a live
guest SESSION, which only resolves while `GUEST_COMMERCE_ENABLED` is on. With
guest commerce switched off mid-flight, a buyer who has already paid reaches
their orders through the emailed link rather than from the tab they paid in.
That is the correct trade — the confirmation grant is a NEW credential derived
from one the deployment has stopped honouring.

Other configuration: `GUEST_PORTAL_GRANT_DAYS` (30),
`GUEST_MAGIC_LINK_MINUTES` (15), `GUEST_PORTAL_STEP_UP_MINUTES` (15),
`GUEST_MAGIC_LINK_BASE_URL` (**empty by default and refused rather than
defaulted** — a link built on a guessed host either does not work or works
somewhere Mercaria does not control), `GUEST_PORTAL_MESSAGE_BATCH_SIZE`,
`_POLL_INTERVAL_MS`, `_LEASE_MS`, `_MAX_ATTEMPTS`,
`GUEST_RECOVERY_WINDOW_MINUTES` and the three `GUEST_RECOVERY_MAX_PER_*`
ceilings.

## Retention

| Rows | Live | Purge |
|---|---|---|
| exchange grants | 15 min | 24 h past expiry |
| portal grants | 30 days | 90 days past expiry — they ARE the audit of who could reach what |
| messages | until sent or terminal | 14 days from enqueue |
| recovery counters | one window | 7 days past the window start |
| suppressions | until lifted | **never** |
| operator actions | — | **never** |

The two windows over one grant table are expressed as a `purge_at` COLUMN the
writer stamps from the credential's purpose, because `ExpirySweepTarget` has no
filter — the `notifications` resolution from `db/expiryTargets.ts` reused: make
the condition a column. It is stamped at insert and never advanced, so a
revocation does not pull the deadline in.

## Production-readiness checklist

Everything below is unfinished work, not a suggestion.

1. **Register a transport.** Until one exists no guest receives anything —
   including their order confirmation. This is the single blocking item.
2. **Set `GUEST_MAGIC_LINK_BASE_URL`** to the HTTPS universal-link base, and
   verify the association files so native opens it rather than a browser
   (ADR 0003 T14). Unset, every link-bearing message fails visibly.
3. **Set `GUEST_OPERATOR_OXY_USER_IDS`** before the rail carries live traffic.
   Empty is a working configuration and means nobody can trace portal access or
   re-send a link for a buyer who cannot reach their inbox.
4. **Confirm the sender domain is authenticated** (SPF/DKIM/DMARC) with the
   transport, and wire its bounce and complaint feedback into
   `suppressGuestContact`. Until then the suppression list only grows from
   Mercaria's own permanent failures.
5. **Record the M8 security and privacy review** on #111 before
   `GUEST_COMMERCE_ENABLED=true` in any non-test environment (ADR 0003
   acceptance 8).

## Deferred, each a named contract rather than a stub

- **#109 (claiming)** — `claim:write` is already granted on every verified
  credential and `guest_checkouts`/`orders` already carry the columns and the
  trigger. What is missing is the endpoint. `claim_completed` is in the message
  vocabulary and triggered by nothing.
- **#110 (cancellations, returns, support)** — `cancellations:request`,
  `returns:request` and `support:write` are granted; nothing consumes them yet.
- **#111 (rollout)** — the three payment-notification thresholds, and the
  retention coordination.
- **#93 (pickup)** — `order_ready_for_pickup` cannot fire because
  `assertPickupLocationEligible` refuses every pickup at checkout.
- **`contact_change:request`** — see Scopes above. Defined, ungrantable, and
  #110's to build.
