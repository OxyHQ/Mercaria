# Runbook 60 — guest-commerce security signals (#111)

Every signal `GUEST_SECURITY_SIGNAL_REGISTER` defines, what a rise means, and
what to do about it. One file with a section per signal rather than sixteen
files: whoever is reading one of these at 3am is usually about to read a
neighbouring one, and sixteen documents that each need the same four paragraphs
of context is how a runbook set goes stale.

## Before any section below

**The counters name nobody, and that is deliberate.** Every signal is a COUNT
per window. There is no subject column on `guest_security_signal_counters` and
no endpoint that takes one, so no step in this document is "find out who did
it" — the questions these answer are "is this happening more than usual" and
"is a guarantee still true".

**Read the numbers here:** `GET /internal/guest-commerce/governance/signals`,
behind `GUEST_OPERATOR_OXY_USER_IDS`. It reports every signal in the register
with an `observed` flag beside its total, because a signal that has never been
recorded and one recorded as zero mean opposite things and read identically.

**An alert may carry a checkout group, an order, a payment, a grant, a claim or
a session id, and NOTHING else** — never a token, an email, an address or any
payment-method detail. Each section names the handles its signal permits.

**Owner:** the on-call engineer for the Mercaria API. Escalate a `critical`
signal to security if it does not resolve within one rotation.


## `guest_token_verification_failure`

**Guest token verification failures** — severity `warning`.

A credential was presented and did not resolve. Ordinary at a low rate (expired sessions  on returning devices); a spike is guessing or a rotation gone wrong.

**What to do:** Compare against the session issuance rate over the same window. A rise in BOTH is ordinary traffic growth; a rise in this one alone is guessing or a rotation that went wrong — check whether a deploy changed `GUEST_SESSION_IDLE_DAYS` or the cookie name.


## `csrf_failure`

**CSRF origin verification failures** — severity `warning`.

A cookie-authenticated state-changing request arrived from an origin the allow-list does  not contain. A sustained rate means either an attack or a deploy that forgot an origin.

**What to do:** Check `lib/allowed-origins.ts` against what actually shipped. A deploy that added a hostname without adding it there produces exactly this, and every affected buyer sees a refusal they cannot work around. If the origins are right, it is an attack and the counter is the whole response — nothing here needs blocking.


## `session_issuance_rate`

**Guest session issuance rate** — severity `info`.

How many credentials are being minted. The farming detector reads the same counter.

**What to do:** Read `GET /governance/interventions` for a `session_farming` row. If one fired, the cooldown is already applied and there is nothing to do but check the false-positive rate. If none did, the traffic is inside policy and this is information.


## `recovery_request_spike`

**Recovery request spike** — severity `warning`.

Somebody is asking about many inboxes. Never carries whether a lookup matched — that is  the enumeration oracle the uniform 202 exists to close.

**What to do:** Do NOT try to find out which inbox. The uniform 202 exists so that question has no answer, and the counter is keyed on the network for the same reason. The `recovery_spraying` policy applies a one-hour cooldown per /24; if that is not holding, the threshold is wrong and changing it is a code review.


## `magic_link_exchange_failure`

**Magic-link exchange failures** — severity `warning`.

An exchange token was presented and refused. Expected at a low rate (a link opened twice);  a spike means links are leaking or being guessed.

**What to do:** Expected at a low rate — a link opened twice burns the second attempt. A spike alongside `scanner_consumption_anomaly` is a mail security appliance prefetching; a spike without one means links are leaking or being guessed. Neither is fixed from here: the remedy is #108's single-use grant, which already holds.


## `scanner_consumption_anomaly`

**Link-scanner consumption anomaly** — severity `warning`.

Single-use links consumed by something that is not the recipient — a mail security  appliance prefetching. Shows as exchanges immediately followed by a human failure.

**What to do:** Identify the recipient DOMAIN from the delivery provider, never from Mercaria. The fix is a mail-side one (a scanner exclusion) and there is no Mercaria change that helps — shortening the link lifetime makes it worse.


## `cross_order_authorization_failure`

**Cross-order authorization failures** — severity `critical`.

A credential valid for one checkout group asked about another. Should be ZERO: a grant  authorizes exactly one group and nothing composes a request across two.

**What to do:** SHOULD BE ZERO. A grant authorizes exactly one checkout group and nothing composes a request across two, so any count is a code path that should not exist. Trace the named group through `GET /governance/data-requests/:checkoutGroupId` and the portal trace, and treat a non-zero count as a security incident rather than a bug report.


## `duplicate_payment_or_idempotency_conflict`

**Duplicate payment or idempotency conflict** — severity `critical`.

A payment key was reused with different content. Means a client is composing a key  non-deterministically or two racers disagree about a checkout group.

**What to do:** A payment key was reused with different content. Open the payment trace on `/internal/payments`; the usual cause is a client composing a key non-deterministically, and the usual damage is none because the key is what prevented the duplicate. A rise WITHOUT a corresponding client release is the alarming case.


## `claim_conflict`

**Claim conflicts** — severity `warning`.

Two accounts tried to claim one checkout group. One is legitimate (a household); many  from one actor is the abuse pattern above.

**What to do:** One is legitimate — a household with two accounts. Many from one actor is `repeated_claim_conflict`, which routes to manual review rather than a cooldown, because the right answer may be that the INCUMBENT claim is the wrong one. Use `/internal/guest-commerce/claims/checkouts/:id`.


## `cleanup_lag`

**Retention cleanup lag** — severity `critical`.

Rows past their deadline that still exist. The one failure in this domain invisible from  everywhere else: the system works perfectly while a retention guarantee has quietly  stopped being true.

**What to do:** The one failure in this domain invisible from everywhere else: the system works perfectly while a retention guarantee has quietly stopped being true. Check `GET /governance/retention-runs` for a `failed` pass and `GUEST_RETENTION_JOB_ENABLED`. If the job is running and the lag persists, the batch size is below the arrival rate.


## `encryption_failure`

**Encryption or decryption failures** — severity `critical`.

A contact could not be sealed or opened. Means a key rotation went wrong, and every  affected order becomes unshippable rather than merely unreadable.

**What to do:** A contact could not be sealed or opened, which makes the affected orders UNSHIPPABLE rather than merely unreadable. Check whether `GUEST_PII_ENCRYPTION_KEY` changed. Do NOT rotate the key while investigating — a second rotation makes the first unrecoverable.


## `notification_delivery_failure`

**Transactional notification delivery failures** — severity `warning`.

A message dead-lettered. Today every attempt fails `transport_unconfigured` because  Mercaria has no outbound mail; this counter is what makes that visible as a number  rather than as an absence.

**What to do:** Today every attempt fails `transport_unconfigured`, because Mercaria has no outbound mail transport at all (#108). This counter is what makes that visible as a number rather than as an absence, and it is EXPECTED to be non-zero until a transport is registered.


## `operator_sensitive_access`

**Operator access to sensitive guest records** — severity `info`.

Staff read or acted on a guest record. Counted rather than alerted on: the point is that  the number exists and is reviewable, not that any single access is suspicious.

**What to do:** Not an alert. Reviewed periodically, because the point is that the number exists and is reviewable rather than that any single access is suspicious. Compare against the support ticket volume for the same window.


## `provider_metadata_missing_ids`

**Provider metadata missing the stable Mercaria ids** — severity `critical`.

A PaymentIntent reached the rail without the ids reconciliation needs. Every payment  after it is unattributable until somebody notices, which is what this counter is for.

**What to do:** A PaymentIntent reached the rail without the ids reconciliation needs, so every payment after it is unattributable until somebody notices. Check the metadata composition in `checkout-payment.service.ts` — both gates there THROW rather than filter, so a non-zero count means a path that bypassed them.


## `provider_identity_used_as_access`

**Attempts to use provider identity as order access** — severity `critical`.

Something presented a Stripe Customer, a Link identity or a wallet as proof of who a  buyer is. Should be structurally impossible — no function takes one — so any count is a  code path that should not exist.

**What to do:** Should be structurally impossible: no function takes a Stripe Customer, a Link identity or a wallet as proof of who a buyer is. Any count is a code path that should not exist. Treat as a security incident.


## `payment_verified_portal_initialization_lag`

**Portal initialization lag after verified payment** — severity `warning`.

A payment succeeded and the portal grant that lets the buyer find it has not been  initialized. The buyer has paid and cannot see their order, which is the worst state  guest commerce has.

**What to do:** The worst state guest commerce has: somebody paid and cannot see their order. Check the payment outbox for stuck `guest_portal_initialization` rows. The buyer is not stranded — the order is placed and the confirmation endpoint mints a grant on demand — but they have no way to know that until the queue drains.
