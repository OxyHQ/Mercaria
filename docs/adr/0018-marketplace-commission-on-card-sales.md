# 0018 — The marketplace commission: 5% + $0.30 per card order, processing included

- **Status:** Accepted, 2026-11-06. Decided by the owner's delegate under the
  owner's instruction "you choose, economical". D3 amended 2026-11-06: the
  owner decided the commission applies to marketplace card sales generally,
  private (P2P) sellers included.
- **Supersedes:** the EUR `marketplace-standard` v1 schedule (10% + €0.30) that
  `services/fees/catalog.ts` carried but never published. It is removed at the
  root: `fee_schedules` held no row for it (read 2026-11-05), so nothing was
  accepted under it, and no legacy or migration exists for it.
- **Builds on:** ADR 0001 D3 (separate charges and transfers; the commission is
  the ledger's residual) and D8 (card sales in USD only, as amended
  2026-11-05); #88's fee domain (`docs/payments.md` §Marketplace fees).

## Context

Card checkout went live in USD (#1206) with `PEABLE_ENABLED` on. The only
schedule in the repository was EUR-scoped, so a USD card sale carried no
commission at all. Under separate charges and transfers Oxy Platforms, Inc. is
the platform: the card processor's fee is debited from the platform, and the
seller's transfer is the order's share minus the commission. With a zero
commission every card sale costs Oxy the processing fee and earns nothing.

## Decision

### D1. One all-in fee on card sales: 5% of the item subtotal + $0.30 per order

Schedule `marketplace-card` v1 (terms `marketplace-card-v1`): `percentageBps:
500`, `fixedFee: 30 USD`, scope `eligibleCurrency: USD`,
`eligibleSellerType: store`.

- **All-in.** Card processing is included. The seller is shown one fee and no
  processing line, because the platform already pays the processor (ADR 0001
  D3's cost table: "Stripe processing fees — Mercaria, priced into the
  commission"). At about 2.9% + $0.30 for a domestic card, the margin is about
  2.1% of the item subtotal, before refunds and disputes.
- **Competitive.** Etsy charges 6.5% on the transaction plus 3% + $0.25 for
  payment processing (and a listing fee); eBay's final-value fee is around 13%
  in most categories. A seller here pays one fee, lower than either.
- **Per order.** An order is one seller's share of a checkout, so a cart from
  two sellers is two orders and each pays $0.30 once.

**The closest faithful form, and where it differs from the words.** The
schedule model expresses a percentage plus a fixed component per order
exactly, so no approximation was needed in the rate. Two properties come from
the model rather than from the decision, and are part of it:

- the base is the item subtotal **after discounts**; delivery and tax are never
  charged on (`discounted_item_subtotal` is the only basis);
- the fee never exceeds that base (a $0.25 order pays $0.25, not $0.31), and
  the fee on a refunded amount is returned in proportion (`proportional`, the
  only refund policy). The processor does not return its own fee on a refund;
  the platform bears that.

### D2. FairCoin sales: no fee

No schedule covers FAIR, so a sale priced in FAIR selects none and is recorded
as `no_active_schedule` — the honest zero, distinguishable from a schedule that
calculated zero. This is how "0% on FairCoin" is expressed: the scope set has
no payment-method column, deliberately (#88: payment-method identity can never
select a fee), and card checkout presents only in USD, so the currency already
separates the two rails. It also follows from the rails themselves: a FairCoin
payment goes to the seller's own address, so there is no transfer to take a
commission from and no on-chain fee mechanism exists.

A future rail that settles a USD-priced order in FairCoin would select this
schedule. Such a rail must decide its fee treatment before it ships; this ADR
does not.

### D3. Private sellers pay the same fee, accepted where they manage payments

*As amended 2026-11-06.* The first version scoped the schedule to stores only,
because `merchant-activation/checkout-gate.ts` refuses a checkout whose seller
has not accepted the schedule its order selects, and private (P2P) sellers had
nowhere to accept: a `user`-reaching schedule would have taken every
individual's card checkout offline instead of billing it. The owner then
decided that the commission applies to marketplace card sales generally, so the
gap is closed at the root:

- **One acceptance model.** A private seller accepts on the storefront's
  Settings → Payments (`GET /seller/fees/schedule`, `POST /seller/fees/accept`),
  served by the SAME handlers as the store routes with the caller as the owner,
  writing the same `fee_schedule_acceptances` rows with `owner_type = 'user'` —
  the table the gate already read for `user:` groups. The terms render through
  one component (`@mercaria/ui`'s `FeeScheduleTerms`) on both apps, in every
  language each ships; the summary a seller accepts is the store's English text,
  by design (`catalog.ts`).
- **Selected in the card rail's currencies.** A person has no currency of their
  own, so `findApplicableSellerSchedule` asks only the rail's presentment
  currencies for them (a store asks its own first). Those are exactly the
  currencies a P2P card order is presented in, so the version a seller accepts
  is the version checkout hands the gate. This was the decision the gate's
  docblock said was missing.
- **A separate schedule key.** `marketplace-card-individual` v1 (terms
  `marketplace-card-individual-v1`): the same 500 bps + 30 USD, the same words,
  `eligibleSellerType: user`, `eligibleCurrency: USD`. Not a v2 of
  `marketplace-card` without a seller scope: activating a version supersedes
  the key's active one, so that v2 would have voided every store's v1
  acceptance and asked each store to accept identical terms again before its
  next card order. Disjoint scopes also keep `selectFeeSchedule` from ever
  seeing two matches.
- **Prompted before the first sale, never a generic error.** The fee card sits
  first on Settings → Payments and starting payout setup waits on it; `/sell`
  shows the same prompt while it is pending; an already-onboarded seller is
  told card sales wait on it and is never stopped from managing payouts. A
  buyer refused by the gate is told which seller is not accepting orders, by
  public name (`details.reason: seller_not_activated`, the keys in
  `details.sellers`, as #1208 did for payment readiness) — never which lever
  fired, which stays somebody else's business.
- **Activated only after the screen shipped.** The version is drafted and
  activated through `publish-fee-schedules.yml` once the storefront carrying
  the screen is deployed. `preview` now reports, per version not yet active,
  how many payment-ready sellers would block activation (counts by owner kind,
  no ids), and `activate` checks every draft before activating any, so a
  refusal leaves the whole catalogue as it was.

### D4. A store's fee is selected in the currency its card sales are charged in

The dashboard used to select a store's schedule in `stores.default_currency`
alone. All three production stores default to FAIR, and the cart converts their
listings to USD for a card sale, so the fees screen would have said "no
marketplace fee applies" while checkout charged — and the gate refused — under
the USD schedule. `findApplicableStoreSchedule` asks the store's currency and
then each currency the card rail presents in; the fees screen, its acceptance
and the activation checklist all use it.

### D5. Published by a reviewed change, activated by a guarded dispatch

The rate is code (`services/fees/catalog.ts`), so a change is a pull request.
`.github/workflows/publish-fee-schedules.yml` runs
`scripts/provision-fee-schedule.ts` on the live task definition: `preview`
reads, `draft` publishes drafts (which charge nobody), and `activate` makes a
draft the schedule checkout charges. Activation refuses while any
payment-ready seller the schedule reaches has not accepted it, because
activating would refuse that seller's checkout. Both writes record
`deployment` plus the live image's commit as their author.

## Consequences

- Every marketplace card sale in USD carries the commission once its seller's
  schedule is active: `marketplace-card` for stores, `marketplace-card-individual`
  for private sellers.
- Seller surfaces state the fee from the schedule itself, never a literal:
  Settings → Marketplace fees (the terms, "card processing is included",
  "FairCoin sales carry no fee"), Settings → Payments & payouts (a summary and a
  link to the terms) and each order's "Marketplace fee and payout" card (the
  snapshot's fee, processing included, and what the seller receives), in every
  language the dashboard ships. The merchant summary a store accepts is English
  only by design (`catalog.ts`: a translation is a new terms version).
- A store that becomes payment-ready after activation sees the terms as pending
  and cannot take card orders until an owner accepts them; a private seller
  meets them as a step of payout setup, on Settings → Payments.
- A NEW version of either schedule cannot be accepted until it is active, and
  `activate` refuses while a payment-ready seller it reaches has not accepted
  it — so a version change while sellers are `ready` needs a way to accept a
  published draft first. That does not arise for these two first versions and
  is recorded in `HANDOFF.md`.
- A rate change is a new version with its own terms version, accepted afresh.
