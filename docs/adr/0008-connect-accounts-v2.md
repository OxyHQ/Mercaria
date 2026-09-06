# ADR 0008: Connect Accounts v2, because v1 account creation is refused

> **SUPERSEDED 2026-09-06 by [ADR 0009](0009-peable-payment-rail.md).** Mercaria
> no longer calls Stripe at all: the rail is Peable, and account creation lives
> there. Everything measured below is still TRUE of Stripe and still binds
> whoever ports `account.service.ts` — in particular D2-C and D2-D are ONE
> decision, and dropping the "unnecessary" `card_payments` capability silently
> stops `account.updated` firing, which is the only readiness trigger. Read this
> file as the specification of what the port must preserve, not as a description
> of what this repository does.

- **Status:** Superseded by ADR 0009
- **Date:** 2026-09-06
- **Issue:** part of epic
  [#35](https://github.com/OxyHQ/Mercaria/issues/35)
- **Supersedes:** [ADR 0001](0001-stripe-connect-architecture.md) **D2's account
  API choice only** — the third bullet of D2, "Accounts **v1** with controller
  properties, not Accounts v2 … Revisit when v2 reaches parity", and D2's
  capability set. **D1 and D3–D12 are inherited unchanged**: Mercaria is still
  merchant of record, still uses separate charges and transfers with one
  PaymentIntent per checkout group, the ledger is still the only record of
  commission, and D11's idempotency scheme still holds. Nothing here reopens
  any of them.
- **Stripe API measured:** 2026-09-06 in TEST mode against the platform account,
  on the pinned `STRIPE_API_VERSION = '2026-07-29.dahlia'`. Every claim below
  marked MEASURED was a real request; the responses are quoted.

## Context: the revisit condition fired, from the other side

D2 said "revisit when v2 reaches parity". What actually happened is that **v1
stopped being available**. `POST /v1/accounts` is now refused on this platform
account for every input, including a minimal `type=express, country=ES` with no
controller block at all (MEASURED):

> Stripe no longer recommends Accounts v1 for new Connect integrations. Create
> connected accounts with `POST /v2/core/accounts` instead. … If your
> integration requires v1 account creation for a supported compatibility
> scenario, enable Accounts v1 support in the Dashboard.

So `ensureConnectedAccount` can onboard nobody. This was invisible because there
has never been a connected account: an integration with zero live objects has
never exercised its own creation path, so the wall is behind every test, every
typecheck and every green deploy. The types still compile and the SDK still has
the method.

A compatibility toggle exists in the Stripe dashboard. It was **not** taken:
re-enabling a deprecated creation API postpones this decision to a moment
chosen by Stripe rather than by Mercaria, and the measurements below show the
port is small.

## Decisions

### D2-A. Accounts v2 for creation; the v1 API for everything else

Connected accounts are created with `POST /v2/core/accounts`. Nothing else
moves.

This is a port and not a renegotiation, and the reason is one measurement: a v2
account created with `dashboard: express` and `defaults.responsibilities` of
`losses_collector: application` / `fees_collector: application` reads back
through `GET /v1/accounts/<id>` carrying **ADR 0001 D2's controller block
verbatim** (MEASURED):

```json
{ "fees": { "payer": "application" },
  "losses": { "payments": "application" },
  "requirement_collection": "stripe",
  "stripe_dashboard": { "type": "express" },
  "type": "application", "is_controller": true }
```

`requirement_collection: stripe` is **derived**, not sent — which is the
property D2 wanted, now obtained by construction rather than by assertion.

**The money path does not move** (MEASURED, with a negative control):
`POST /v1/transfers` to a v2 account answers
`insufficient_capabilities_for_transfer` — Stripe resolved the destination and
is describing its capabilities — while a fabricated id answers
`resource_missing`. `POST /v1/account_links` also accepts a v2 account and
returns an ordinary `connect.stripe.com/setup/e/…` URL, which Stripe documents
in neither direction.

**D11's idempotency survives** (MEASURED): two `POST /v2/core/accounts` with one
`Idempotency-Key` returned the same `acct_…` id. The outer half of D11's
guarantee is intact, so the documented race cannot produce two accounts for one
seller.

### D2-B. Reads stay on the v1 API, deliberately

`retrieveStripeAccount` continues to call `GET /v1/accounts/<id>`, and
`snapshotStripeAccount` and `deriveOnboardingState` are unchanged.

Stated because it looks like an omission and is not. `v2.core.account` carries
no `payouts_enabled`, `charges_enabled`, `disabled_reason`, `default_currency`
or payout schedule — D9's readiness conjunction is expressed in none of them. A
census against the v2 typings therefore concludes the schema is damaged and two
migrations are needed. It is the wrong instrument for this codebase. Read
through v1, the same account answers (MEASURED):

```
payouts_enabled: false     charges_enabled: false     default_currency: eur
requirements.disabled_reason: requirements.past_due
settings.payouts.schedule: { "delay_days": 7, "interval": "daily" }
```

So `provider_accounts` needs no column, no CHECK widening and no migration, and
D9 is re-derived from nothing. **The obligation this creates:** the v1 read is
now load-bearing in a way it was not before. If Stripe withdraws it, D9 loses
its inputs — that is the risk this decision accepts, and it is cheaper than a
schema migration taken speculatively against zero accounts.

### D2-C. `card_payments` is requested alongside `transfers`, outside the US

D2 declined `card_payments` on the reasoning that a Mercaria seller never
charges cards and that requesting it couples both capabilities' disablement, so
a card-side problem would stop transfers. **That reasoning is still correct.
Stripe no longer offers the choice** (MEASURED, `country: es`):

> The `stripe_balance.stripe_transfers` capability cannot be requested without
> the `configuration.merchant.capabilities.card_payments` capability.

The coupling is country-specific and undocumented: a recipient-only seller is
expressible in the US and refused in ES, and across D8's transfer region.
Spain is the launch market, so the capability set is amended rather than the
market.

**The cost is onboarding friction, and it is real**: an ES company reaches 33
requirements, including `business_profile.mcc` and `business_profile.url` — a
merchant category code and a website, demanded of a seller who will never charge
a card. A P2P individual additionally owes a national identity number.

**The consolation is not cosmetic, and it is recorded because the next person
will otherwise remove it**: see D2-D.

### D2-D. The forced `merchant` configuration is what keeps readiness working

A v2 account with only a `recipient` configuration **never emits
`account.updated`** (MEASURED across the test platform: 0 of 3 recipient-only
accounts, 6 of 6 accounts carrying a `merchant` configuration). `account.updated`
is Mercaria's only readiness trigger.

Because D2-C forces a `merchant` configuration in ES, every Spanish seller lands
in the case that does emit — confirmed on the connected-account scope (MEASURED):
`account.updated` ×1, `capability.updated` ×2, `account.application.authorized`
×1, with the v1 payload shape intact.

**So D2-C and D2-D are one decision, and removing the "unnecessary"
`card_payments` would silently break onboarding.** Not totally — which is worse:
`account-readiness.job.ts` sweeps on a six-hour staleness window, so every seller
would still reach `ready`, up to six hours late, each raising an
`account_state_drift` row whose note says a webhook was lost. A demo passes. The
only evidence is a discrepancy table filling uniformly, which reads like a flaky
provider.

**The trigger that reopens this:** onboarding a seller in a country where a
recipient-only account IS expressible — the US today. Such a seller gets no
`account.updated` and is readiness-blind. Do not add a US seller country without
building the v2 event path in D2-E first.

### D2-E. v2 events need a THIRD webhook endpoint, and it is not on the critical path

Stripe partitions endpoints by payload shape: v1 types require
`event_payload: "snapshot"`, v2 types require `"thin"`, mixing them is a 400,
and `event_payload` is not an updatable field. Neither existing endpoint can be
converted. v2 account events for connected accounts also arrive on the
**platform** scope, not the Connect scope — so an endpoint created on Connect
scope receives nothing, forever, with no error.

None of this blocks going live, because D2-D leaves `account.updated` working on
the existing Connect endpoint. It is recorded so that the absence is a decision
rather than an oversight, and it becomes mandatory under D2-D's trigger.

Two hazards for whoever builds it:

- A valid v2 delivery is currently reported as **`invalid_signature`**.
  `constructEventAsync` verifies the signature and *then* throws on
  `object === 'v2.core.event'`, and `ingress.ts` maps every verification throw to
  `400 invalid_signature` with nothing persisted. An operator will chase the
  webhook secret.
- `stripe@22.4.0` ships the whole v2 **account** surface but **no
  `parseThinEvent`**, so receiving v2 events needs an SDK bump — which touches
  the deliberate `STRIPE_API_VERSION` compiler pin. Creating accounts needs no
  bump. The two halves have opposite costs, which is why they ship separately.

`STRIPE_V2_EVENT_TYPES` must be its own tuple with its own hand-written twin in
`event-scopes.test.ts`. Appending to the ADR-transcribed list would destroy the
one property that test exists for.

## What this does not change

D1, D3–D12. Merchant of record, separate charges and transfers, one
PaymentIntent per checkout group, immediate capture, the ledger as the sole
record of commission, the platform settlement currency, D8's transfer region,
D11's idempotency scheme, and the rule that a `return_url` redirect proves
nothing.

## Consequences

- Seller onboarding can run again. Before this, `ensureConnectedAccount` threw
  for every seller, so no seller could reach `ready` and
  `assertSellerGroupsPaymentReady` refused every native checkout group: **native
  checkout was not un-onboarded, it was down.**
- Each seller sees a longer onboarding form (D2-C), and Mercaria holds no more
  identity data than before — `requirement_collection` is still `stripe`.
- One capability set, one create call and one ADR conversation later, the
  webhook plane is unchanged. That is the whole port.
