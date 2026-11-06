# 0021 — One Pay with Peable checkout per cart; the fee follows the method used

- **Status:** Accepted, 2026-11-06. The owner's rule, verbatim: *"cualquier
  persona siempre tiene que poder pagar con faircoin"* — anyone must always be
  able to pay with FairCoin.
- **Amends ADR 0020** (D1: no buyer pre-choice is needed for the card — every
  fiat cart's session offers the card AND FairCoin; the "How you'll pay" choice
  stays only to route a cart whose sellers cannot take the card to a
  FairCoin-only session; D2: one session per CART, a line per seller order, the
  card through the session; D3: the session's intents carry Mercaria's marker
  and are linked; D4: the fee is recorded at the OUTCOME — `faircoin_exempt`
  pricing stays for a cart priced for FairCoin), and ADR 0019 D1 (the rail no longer decides which methods a cart
  offers — every cart offers FairCoin), D3 (a FAIR cart of several sellers is
  no longer refused) and D5 (the fee is decided by the method USED, at the
  outcome, not by the currency at pricing); ADR 0018 D2 (the "future rail that
  settles a USD-priced order in FairCoin" exists now, and its fee is decided
  here: none).
- **Peable side:** Peable ADR 0021 D6 as amended (a FairCoin payment of a
  multi-seller order is ONE payer-signed transaction with one output per
  seller, each to an address in that seller's own Peable wallet; the platform
  is never an output) and D8 (`payment_intent_data.metadata` is copied to every
  payment a Checkout Session creates). `@peable.to/sdk` 5.0.0.

## Context

Before this ADR a USD cart was a bare card PaymentIntent and only a FAIR cart
could be paid in FairCoin, and then only for ONE seller. So a buyer of a USD
listing could never pay with FairCoin, against the owner's rule, and a FAIR
cart of two sellers was refused.

## Decisions

### D1. One cart, one Peable Checkout Session

`openCheckoutPayment` opens ONE embedded Peable Checkout Session per checkout
group, for every currency: one `price_data` line per seller order — that
order's presentment grand total, shipping, tax and discount included, quantity
1 — each naming the seller's connected account (`line_items[].connected_account`).
The session's total is therefore exactly the payment's (asserted), its
idempotency key is `cs:<paymentId>`, its `client_reference_id` the Mercaria
payment id, and ADR 0001 D11's metadata (plus `mercaria_payment_id`) rides on
every payment it creates (`payment_intent_data.metadata`). It expires no
sooner than Peable's 30-minute floor and is expired by the reservation sweep.

A fiat (USD) cart's session offers the card AND FairCoin, quoted by Peable; a
`FAIR` cart's offers FairCoin. The buyer chooses in the shared
`PeableSheetCheckout` (`sessionSource(clientSecret)`), and may switch before
money moves. A single-seller cart is the one-line case — there is no second
path. The handoff is `{ paymentId, provider, checkoutSessionId, clientSecret,
amount, methods }`.

Readiness stays where it was: a fiat cart needs every seller card-ready and on
accepted card terms (the card is offered); a `FAIR` cart needs every seller's
FairCoin half active. A seller of a fiat cart who cannot take FairCoin makes
FairCoin unavailable on that order in Peable's sheet, with the reason; the
card keeps working.

### D2. The card is still Mercaria's platform charge, settled by transfers

The session's card payment carries no `on_behalf_of` and no `transfer_data`:
it is Mercaria's own platform charge (ADR 0001 D3), booked by the ledger and
settled to each seller by the transfers `settlePaymentTransfers` has always
made (separate charges and transfers, Peable ADR 0015). Nothing in the
settlement path changed.

### D3. FairCoin pays every seller directly, in one transaction

A FairCoin payment of the session pays each seller its order's share (Peable
splits the quoted total by line subtotal, largest remainder), each into the
seller's own Peable wallet. Mercaria records no transfer, books nothing and
holds nothing; there is no fee output. `peable_faircoin` keeps every property
ADR 0019 D3 gave it.

### D4. The payment learns its rail from the gateway

The payment row starts on the cart currency's rail (`peable` for USD,
`peable_faircoin` for FAIR) with `provider_checkout_session_id` set and no
`provider_object_id`. A `payment_intent.*` event is matched by
`provider_object_id`, else by Mercaria's own `mercaria_payment_id` marker, and
then acted on ONLY if the session (re-read from Peable) still names that intent
as its payment: a card attempt the payer abandoned for FairCoin is cancelled at
Peable and its `payment_intent.canceled` must not cancel the order. Attaching
sets `provider_object_id` and `provider` (`peable` for a card intent,
`peable_faircoin` for FairCoin) with a compare-and-swap on the payment still
being `created`, `requires_action` or `failed`. `payments_rail_immutable`
(migration 0194) keeps both columns write-once in every other case, so a
payment that started moving money can never move rails.

`checkout.session.completed` and `async_payment_*` take the same path for the
session's current payment; `checkout.session.expired` cancels the payment
through the path a cancelled intent takes, which releases the orders.

### D5. The fee follows the method used, decided at the outcome

`order_fee_snapshots` stay the pricing-time record of the card terms the seller
accepted (append-only, unchanged). In the transaction that moves a checkout
payment to `succeeded`, `order_fee_outcomes` records, per order, how it was
paid and the fee that stands: `card` keeps the snapshot's marketplace-card fee
(5% + $0.30, `marketplace-card` / `marketplace-card-individual`), `faircoin`
takes none. It is append-only by trigger. Every reader of the effective fee —
the settlement projection (`order-linkage.ts`, through `effectiveFeeAmount`),
the order fee summary sellers and operators read (`paidWith`, `fee`) — reads
the outcome when present. Before an order is paid the snapshot's card terms are
what it would cost by card.

## Consequences

- `faircoin_one_seller_per_checkout` is gone from the refusal vocabulary.
- A request naming `paymentMethod: 'faircoin'` on a USD cart opens the cart's
  session (FairCoin is in it) instead of being refused.
- Live orders' FairCoin option answers `faircoin_network_closed` until Peable
  opens mainnet identity receive (Peable ADR 0002's deployment gate); the card
  is unaffected.
- `@peable.to/sdk` 5.0.0 is required (line sellers, `payment_intent_data`).
