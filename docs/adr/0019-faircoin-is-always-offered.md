# 0019 — FairCoin is always offered: a FAIR checkout pays the seller's own Peable wallet

- **Status:** Accepted, 2026-11-06. D1 (a USD order is card-only) and D5 (the
  fee follows the currency) amended by ADR 0020: a USD order is payable in
  FairCoin, and the fee follows the method. The owner's rule, carried from Peable ADR
  0021: *FairCoin must always be available and cannot be turned off; fiat
  methods are optional.*
- **Builds on:** ADR 0009 (Peable is the rail), ADR 0001 D3/D8 (card sales are
  platform charges in USD), ADR 0018 (no commission on FairCoin), ADR 0012
  (a store is owned by an Oxy account).
- **Peable side:** Peable ADR 0021 (FairCoin on every order; no key is ever
  registered — FairCoin is received into the Peable wallet of the account that
  owns the payee) and ADR 0012 as amended (a marketplace seller's FairCoin half
  names the seller's own Oxy account and is confirmed by the seller).
- **Retires:** the "FairCoin is not a payment method in this roadmap" exclusion
  in `docs/payments.md`, `PaymentProviderId`'s docblock and the isolation gates
  that enforced it (#105, #107), and #129 acceptance 9's ban on NAMING
  FairCoin in storefront copy: `commercial-presentation-isolation.test.ts`
  now forbids the retired OxyPay name and any buying, selling or exchanging of
  FAIR (the product boundary), never the payment method's name. ADR 0004 D11
  (Mercaria-retail never names FairCoin) is unchanged.

## Context

Mercaria's marketplace checkout made raw card PaymentIntents only (#1206), in
USD. All three production stores have `FAIR` as their default currency and
`FAIR` is the marketplace's default display currency, so activation reported
`currency_not_supported` and a buyer pricing in FAIR could not pay at all.
Peable 4.0.0 (`@peable.to/sdk` 4.0.0) can pay a marketplace seller in FairCoin
on their behalf, into the Peable wallet of their own Oxy account, with no key.

## Decisions

### D1. The rail follows the presentment currency

`FAIR` is paid in FairCoin; a card currency (USD, `PEABLE_PRESENTMENT_CURRENCIES`)
by card (`native-rail.ts` `railForCurrency`, the one place the rule is written).
A checkout that names no method gets its currency's rail; one that names a
method is checked against the currency and refused when they disagree, never
switched. Any other currency is refused with a message naming both remedies
(USD for card, FAIR for FairCoin). There is no switch that turns FairCoin off:
the FairCoin rail is configured exactly when the Peable rail is.

A raw PaymentIntent cannot quote fiat into FAIR — that is a Peable Checkout
Session feature — so a USD-priced order is paid by card in this decision.
Offering FairCoin on USD orders through a FairCoin-only Checkout Session per
seller is the follow-up (Peable `@peable.to/sdk` 4.1.0).

### D2. A seller's FairCoin half, opened by Mercaria and confirmed by the seller

The seller's ONE Peable connected account (`external_ref` `store:<id>` /
`user:<id>`) gains a FairCoin half with `faircoin: { network, oxy_user_id }`:
the store's OWNING Oxy account (often an organization) or the P2P seller.
The receiving account is read from the loaded store or the session, never a
request body. The seller confirms on Peable's page, signed in as (or acting as)
that account; Peable refuses the confirmation while the account has no Peable
wallet. `provider_accounts` records the half beside the card verdict
(`faircoin_state` `not_connected | pending | active`, `faircoin_network`,
`faircoin_oxy_account_id`, `faircoin_confirmed_at`), re-read from the gateway
like the card half. `country` is nullable: a FairCoin-only seller has no card
half. The half cannot be re-pointed at another Oxy account.

`PEABLE_FAIRCOIN_NETWORK` picks the chain: `mainnet` in production, `testnet`
elsewhere.

### D3. A FAIR checkout is one on-behalf FairCoin PaymentIntent for ONE seller

`peable_faircoin` is its own `PaymentProviderId`, so every total table over the
providers had to answer for it:

- `PROVIDER_BOOKS_LEDGER.peable_faircoin = false` — the coins go to the
  seller's wallet; Mercaria never holds them, owes nothing and takes nothing.
- Not a settling provider — no transfer.
- Refunds are recorded where they are decided and move no money here (the
  seller returns the coins from their wallet); Peable refuses FairCoin refunds.
- One seller per FairCoin checkout: one FairCoin payment pays one address
  (Peable ADR 0021 D6). A FAIR cart naming several sellers is refused before
  reservation (`faircoin_one_seller_per_checkout`); the buyer checks out each
  seller separately, as `sellerKeys` already allows.
- The intent expires with the reservation (`RESERVATION_TTL_MS`), and the
  reservation sweep no longer releases a group whose payment is `processing`
  (broadcast and confirming), which a FairCoin payment can be for longer than
  a reservation lasts.
- The handoff carries `rail: 'faircoin'` and the payer's instruction (address,
  FAIR amount, `faircoin:` URI); `providerPaymentId` + `clientSecret` open
  Peable's hosted pay page (`/i/:id#client_secret=…`), whose wallet deep link
  reports the broadcast. A guest can pay this way too: a wallet is needed, not
  an Oxy session.

### D4. Every reason FairCoin cannot be paid is shown

Before anything is reserved, a FAIR checkout is refused with
`faircoin_unavailable` and the reason: `seller_not_connected`,
`seller_not_confirmed`, `faircoin_network_closed` (Peable's deployment gate,
read from the `faircoin` entry of Mercaria's own payment method configuration,
which Peable checks before the wallet), and at creation Peable's own
`faircoin_wallet_missing`. The seller's payment settings carry the same
answer (`SellerPaymentSettings.faircoin`). Nothing falls back to card silently.

### D5. Activation and the fee

A store's default currency is supported if any native rail is paid in it
(`nativeCheckoutCurrencies`: USD + FAIR), so a FAIR-default store is never
`currency_not_supported`. `payment_provider_ready` is satisfied by either rail.
The fee is selected in the order's currency, which is the rail's (D1): FairCoin
orders carry no fee (ADR 0018), card orders the card schedule, and the fee terms
every seller accepts say so (`ui.feeTerms.faircoinNoFee`). The fee is
therefore decided by the method at pricing, never refunded afterwards.

## Consequences

- Migration `0191_faircoin_rail`: ten provider CHECKs widened, the four
  `provider_accounts.faircoin_*` columns, `country` nullable.
- Mercaria's OWN merchant (plans) has no Peable wallet yet (`oxy` owns the
  application) and mainnet identity receive is behind Peable's gate, so plan
  sessions show FairCoin unavailable with Peable's reason. Plans never narrow
  `payment_method_types`; a FairCoin-paid plan's subscription is `send_invoice`.
  While its first payment confirms it is `incomplete` (shown as waiting, never
  ended), and its paid invoice books the FAIR received to `faircoin_received`,
  never fiat through `provider_clearing` (`docs/merchant-plans.md`).
- In production today FairCoin is unavailable for sellers too until Peable
  opens mainnet identity receive (`faircoin_network_closed`), and each seller
  must open and confirm their half.
