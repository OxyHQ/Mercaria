# 0020 — A USD order is payable in FairCoin, and the fee follows the method

- **Status:** Accepted, 2026-11-06. The owner's rule (Peable ADR 0021): *anyone
  can always pay with FairCoin; fiat methods are optional.*
- **Amends:** ADR 0019 D1 (a USD order is no longer card-only) and D5 (the fee
  is decided by the method, not the currency); ADR 0018 D2 (closes the question
  it left open: a rail that settles a USD order in FairCoin).
- **Peable side:** `@peable.to/sdk` 4.1.0 — a FairCoin-only fiat Checkout
  Session (`payment_method_types: ['faircoin']`, `connected_account`), quoted in
  FAIR when the payer confirms (Peable ADR 0021 D3, D4).

## Decisions

### D1. The buyer of a USD order chooses card or FairCoin

The storefront checkout asks "How you'll pay" on every card-currency order
(Card / FairCoin; a FAIR order is FairCoin and asks nothing). FairCoin sends
`paymentMethod: 'faircoin'`. The order stays priced in USD; the buyer pays its
total in FairCoin at Peable's quote. `assertCheckoutCurrencyEligible` takes
FairCoin on a FAIR order and on any currency the card rail presents in, and
nothing else. The one-seller rule and every unavailable reason of ADR 0019
D3/D4 apply unchanged, before anything is reserved.

### D2. The payment is a FairCoin-only Peable Checkout Session for ONE seller

The card leg stays a raw card PaymentIntent with separate charges and
transfers. Only the FairCoin choice of a fiat order is a session:
`mode: 'payment'`, `ui_mode: 'embedded'`, one `price_data` line in the order's
currency for the group's grand total, `payment_method_types: ['faircoin']`,
`connected_account` = the seller (never without it: that would pay the Peable
wallet of the account that owns Mercaria's application), `client_reference_id`
and `metadata.mercaria_payment_id` = Mercaria's payment, idempotency key
`pi:<paymentId>`. The payment row is `peable_faircoin` with the SESSION
(`cs_…`) as its provider object, because Peable creates the quoted intent
itself, without Mercaria's metadata. The handoff says
`payerObject: 'checkout_session'`; the storefront opens Peable's sheet over the
session's secret.

### D3. Completion is Peable's outcome, read from the session

`checkout.session.completed` / `async_payment_succeeded` / `async_payment_failed`
/ `expired` are correlated by the session id (and its marker) and RE-READ:
`expired` → `canceled`; `complete` + `paid` → `succeeded` (money received);
`complete` + `unpaid` → `processing`, or `canceled` once the intent underpaid;
`open` → `requires_action` while a live quote awaits the coins, `created`
otherwise (a lapsed quote leaves the session open). The session's intent's own
`payment_intent.*` events carry no marker and are ignored. The open-payment
reconciliation reads the same session. The reservation sweep expires the
session when it releases unpaid orders, as it cancels an unpaid FAIR intent.

### D4. The fee follows the method, decided once, at pricing

The method is known before the orders are priced, so the fee is decided there,
at the root: `planConnectedMarketplaceFee` takes the `paymentRail`.
FairCoin selects NO schedule in any currency and snapshots the new result
`faircoin_exempt` (a real zero; basis recorded, no schedule named); card
selects the card schedule (`marketplace-card`, 5% + $0.30). Because no
schedule is selected, a FairCoin sale asks no card-terms acceptance of the
seller. `peable_faircoin` books no ledger entries and makes no transfer, so the
seller's payout is the whole amount, already in their wallet. Nothing is
charged and refunded later. The payment rail a placed group opens on is read
from its orders' snapshots (`faircoin_exempt` ⇒ FairCoin), so a replayed
checkout can never open a card payment for orders priced without a fee, or
the reverse; a group whose orders disagree is refused.

## Consequences

- Migration `0192` (pre): `order_fee_snapshots_result_check` gains
  `faircoin_exempt`.
- The handoff gains `payerObject`.
- Peable's webhook endpoint for Mercaria must carry the four
  `checkout.session.*` types beside the existing ones (`docs/payments.md`,
  Webhooks checklist); until it does, the open-payment reconciliation is the
  only path that moves such a payment.
- Changing the method after the orders exist is not offered: the buyer
  abandons and checks out again (the sweep releases the reservation).
