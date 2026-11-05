# ADR 0009: Peable is the payment rail — Stripe moves behind the gateway, not out of the picture

- **Status:** Accepted. **D13 executed 2026-11-05** — the direct Stripe
  marketplace rail is deleted, ahead of the end-to-end verification D13 asked
  for, by owner decision (see D13 "As built").
- **Date:** 2026-09-06
- **Issue:** part of epic [#35](https://github.com/OxyHQ/Mercaria/issues/35)
- **Supersedes:** [ADR 0001](0001-stripe-connect-architecture.md)'s **choice of
  rail only**, and the whole of [ADR 0008](0008-connect-accounts-v2.md), whose
  subject — how Mercaria calls `POST /v2/core/accounts` — stops being Mercaria's
  question. **D1 and D3–D12 of ADR 0001 are inherited unchanged**: Mercaria is
  still merchant of record, still uses separate charges and transfers with one
  payment per checkout group, capture is still immediate, the ledger is still
  the only record of commission, and D11's idempotency scheme still holds.
  Nothing here reopens any of them.
- **Companion:** Peable's [ADR 0001](https://github.com/OxyHQ/Peable/blob/main/docs/adr/0001-multi-rail-gateway.md),
  which decides the gateway side. Where the two disagree, this one binds
  Mercaria and that one binds Peable; they were written together.

## Context

ADR 0001 wrote down, in its last consequence, exactly what this ADR does:

> Everything provider-specific stays behind the #45 `PaymentProvider` interface;
> a future rail — see the FairCoin/OxyPay boundary in the context above — plugs
> into the same seams (group-level payment, per-order settlement records)
> without Stripe leaking into the domain.

OxyPay is Peable. The rail arriving is not FairCoin-only, as that sentence
assumed: **Peable becomes Oxy's gateway for all payment methods**, serving fiat
through providers (Stripe first, SumUp and Square later) and FairCoin through
the rail it already has. Mercaria stops holding a Stripe integration and holds a
Peable integration instead.

**The moment matters, and it will not come again.** ADR 0008 recorded that
`POST /v1/accounts` was refused on this platform account for every input, so
`ensureConnectedAccount` threw for every seller — *"native checkout was not
un-onboarded, it was DOWN"*. `HANDOFF.md` §5.5 says the same from the other
side: no browser onboarding run has happened, and no settling transfer has ever
executed. **There has never been a connected account, a charge, a transfer, a
refund or a dispute.** There is no data to migrate and no money in flight.
Six months into real operation this same change would be a reconciliation
project; today it is a port.

## Decisions

### D13. The rail is `peable`; Stripe is no longer a `PaymentProviderId`

`PAYMENT_PROVIDER_IDS` gains `'peable'`. Once the new rail is verified end to
end, `'stripe'` is removed and `services/payments/stripe/` is deleted — not
before, and not in the same change. The two rails coexist behind
`resolvePaymentProvider` for exactly as long as it takes to prove the new one,
which is what keeps checkout up across the move.

**As built (2026-11-05): executed early, by owner decision.** The owner
approved removing the direct rail at once ("Quitarlo ya"), overriding "not
before" above. Nothing was being kept up by the coexistence: the direct rail
had never carried money and was off in production. The evidence, gathered
read-only before the change:

- **The production database held nothing the rail wrote.** A read-only
  transaction against `mercaria` (migrations `0000`–`0182` applied) found zero
  rows in `provider_accounts`, `payments`, `payment_attempts`,
  `payment_provider_events`, `transfers`, `payouts`, `disputes`, `refunds`,
  `payment_discrepancies`, `payment_repairs`, `ledger_transactions`,
  `ledger_entries`, `referral_payout_batches`, `referral_payout_batch_items`,
  `retail_reconciliation_evidence`, `guest_launch_gate_signoffs` and
  `guest_rollout_stage_advances`. `orders` held two rows, both with a NULL
  `payment_provider`. `reconciliation_cursors` held only `ledger_audit` and
  `withheld_transfers`, so the Stripe-only sweeps had never run. No column or
  table name contained `stripe`.
- **The running task definition had no rail.** `oxy-mercaria:162` set no
  `STRIPE_ENABLED`, no `STRIPE_SECRET_KEY` and no webhook secret (Mercaria#1178
  removed them with Stripe billing). Only plain onboarding and checkout
  settings (`STRIPE_ONBOARDING_BASE_URL`, `STRIPE_ONBOARDING_RETURN_URL`,
  `STRIPE_CHECKOUT_RETURN_URL`, `STRIPE_PLATFORM_CURRENCY`,
  `STRIPE_PRESENTMENT_CURRENCIES`, `STRIPE_SELLER_COUNTRIES`) and the
  `STRIPE_ONBOARDING_STATE_SECRET` reference remained.
- **Mercaria's Stripe account (`acct_1TnXkUQWiCE02OnU`) has never had a
  charge, transfer, payout or connected account.**

What was deleted: `services/payments/stripe/` (the adapter, Connect onboarding
and its signed round trip, the event ingress, router, processor and
dispatcher, the account reconciler, 3-D Secure thresholds and the settlement
reader), `/webhooks/stripe`, `/stripe/onboarding`, the store and P2P
payment-account routes (`/admin/stores/:storeId/payments/*`,
`/seller/payments/*`), the Stripe-only reconciliation sweeps
`provider_objects` and `account_readiness`, the Stripe referral payout rail,
the storefront's Stripe card step and its return route, the dashboard's
Payments & payouts screen, the `stripe` npm package and the three
`@stripe/*` client packages, and every `STRIPE_*` setting. Schema: migration
`0183` (`pre`) admits the rail-neutral names that replace `stripe_*` closed-set
values, and `0184` (`post`) narrows fifteen CHECKs — `'stripe'` leaves the ten
provider CHECKs, the nine discrepancy kinds only the deleted sweeps raised
leave `payment_discrepancies_kind_check`, the two jobs leave
`reconciliation_cursors_id_check`, and `stripe_*` leaves the retail evidence
and guest launch-gate CHECKs. No table was dropped: every payment table is the
domain D14 keeps, and the Peable rail writes or will write each of them.

**What the Peable rail still lacks, and is therefore NOT verified end to
end.** Removing the direct rail did not build these, and each is a gap before
`PEABLE_ENABLED` can take a buyer's money:

- ~~seller onboarding~~ — **built**: a seller is a Peable connected account of
  Mercaria's merchant (card half; `services/payments/peable/accounts.ts`),
  opened with `external_ref` = the seller key and onboarded through Peable's
  hosted link; `connected_account.updated` and the seller's refresh re-read it
  into `provider_accounts` (see `docs/payments.md`, "Onboarding on Peable");
- a NATIVE card form — the storefront's card step (2026-11-05) hands the payer
  SDK the gateway PaymentIntent and its own `client_secret`
  (`CheckoutPaymentHandoff.providerPaymentId` / `clientSecret`; the acquirer
  secret in `client_action` never leaves the adapter), mounts Peable's Elements
  on the web and polls the server for the outcome; iOS and Android open Peable's
  hosted page (`checkout.peable.to/i/:pi`) in the system browser, because
  Peable's SDK has no native card path (Elements and `checkout/ui`'s
  `PeableProviderFields` need a DOM). Peable's `PeableElement.on` also does not
  type the Express Checkout `confirm` event the wallet sheet waits on, so the
  step widens that one listener. Neither path has confirmed a real payment;
- ~~dispute, payout and connected-account events~~ — **built**: the Peable
  router handles payment intents, `charge.refunded`, `connected_account.updated`,
  `payout.*` (re-read as the seller's account into `recordPayout`), `refund.*` (a
  refund failing after the fact raises `refund_failed`, one Mercaria never made
  `refund_unmatched`) and `charge.dispute.*` (re-read with its withdrawal into
  `recordDispute`; an inquiry books nothing), each re-read from the gateway;
- ~~refund settlement figures~~ — **built**: Peable 3.1.0 reports what a refund
  took and what a dispute withdrew in the settlement currency (Peable ADR 0015
  "as built"); the adapter books the refund from it, and `PEABLE_REFUNDS_BOOK`
  and its seven skipped cases are gone. `transfer_changed` is removed (migration
  `0185`): Peable sends no transfer events, because a transfer and its reversals
  are Mercaria's own calls, recorded from their answers;
- a referral payout rail — **deliberately not built**: the program is off in
  production (`REFERRALS_ENABLED` and `REFERRAL_PAYOUT_BATCHES_ENABLED` unset),
  and Peable's `/v1/transfers` moves money out of one named charge while a
  referral reward is owed from commission across many; built when the program
  is switched on, after Peable adds a first-party payout funded from the
  merchant's revenue (`docs/payments.md`);
- a reconciliation of the gateway's settled movements — **not buildable on
  Peable today**: Peable keeps a ledger only for a merchant's own connected
  account (Peable ADR 0015) and Mercaria's charges are platform charges, so
  there is no ledger of its movements to compare against; transfers, reversals
  and refunds are recorded from Peable's answers under durable keys and the
  events are re-read instead (`docs/payments.md`);
- D18's three real-world checks.

`external` and `manual_pos` are untouched: they are payments Mercaria RECORDS
rather than makes, they have no adapter, and they book no ledger entries. That
distinction is the point of the set and this ADR does not blur it.

### D14. The domain does not move. Only the rail does

Everything that makes Mercaria a marketplace stays in Mercaria:

| Stays here | Why it is not gateway work |
|---|---|
| `settlement-shares.ts` — the gross split, largest remainder, ties by input order | It is a property of what the buyer was shown, and it must be deterministic across an outbox retry, a settlement and a later refund |
| `seller-net-shares.ts` — the fee snapshot subtraction | The fee schedule is a marketplace policy (#88), snapshotted per order |
| `ledger_transactions` / `ledger_entries` | ADR 0001 D3: the commission is `gross − Σnets` and exists nowhere else at all |
| `provider_accounts` and `assertSellerGroupsPaymentReady` | Readiness gates **checkout group construction**, which is a Mercaria decision made before any rail is called |
| The reconciliation sweeps, discrepancies and operator repairs | They compare Mercaria's books against the rail; moving them would leave nothing to compare |

Peable owns the rail and only the rail: open a payment, settle a seller order,
reverse it, refund, and tell Mercaria what happened in a signed event.

A corollary worth stating because the opposite is tempting: **Peable is never
asked to split anything.** It is told an amount per destination. A gateway that
computed marketplace shares would be a second definition of a figure that
ADR 0001 already insists has exactly one.

### D15. Mercaria keeps its Stripe platform account — it is registered inside Peable

**2026-11-04: the I08 billing cohort (2026-10-03 amendment) is retired.** It
routed merchant subscriptions through Peable's Stripe-Billing proxy on
Mercaria's own Stripe platform account, with Mercaria still holding that
account's secret key to verify the cohort. It never carried a subscription:
read-only checks of that account found no subscription, customer, invoice,
charge or connected account, and Peable retired the proxy. Merchant
subscriptions are now native Orbit subscriptions (see D17) and Mercaria holds
no Stripe credential for them. No `provider_connections` row or
merchant-supplied credential was ever introduced.

The former `provider_connections` description is historical, not an implemented
or approved credential model.

The reasoning is Peable's ADR 0001 D3 and is not repeated here, but the
conclusion for this repository is what preserves ADR 0001 D1: **Mercaria remains
merchant of record and continues to bear the platform-account exposure** —
chargebacks, connected-account negative balances, the `losses.payments =
application` that separate charges and transfers forces. Nothing about
Mercaria's legal position changes, which is why this ADR does not reopen D1 and
does not need a legal review to ship.

Direct Stripe access is gone from Mercaria entirely: merchant billing moved
first, and the marketplace rail was deleted under D13 on 2026-11-05.

### D16. `getStatus` becomes real, because the read path stops bypassing the port

Four of the eleven files under `services/payments/reconciliation/` import Stripe
directly rather than going through the adapter —
`open-payments.job.ts` (`retrieveStripePaymentIntent`, `readStripeSettlement`,
`mapPaymentIntentStatus`), `provider-objects.job.ts`
(`listStripeBalanceTransactions`), `account-readiness.job.ts`
(`reconcileStaleAccounts`) and `repairs.service.ts` (`syncAccountRow`). That is
why `getStatus` has no production call site through `resolvePaymentProvider`
today: the question it answers is being asked of Stripe behind the port's back.

They are re-pointed at Peable through the port. This is not tidying: a
reconciliation that reads a different source from the one that writes cannot
detect a disagreement between them, which is the entire job.

**As built (2026-11-05).** `open_payments` and the operator's `refetch` read
through `resolvePaymentProvider(payment.provider).getStatus` and converge
statuses only (the port reports no amounts). `provider_objects` (Stripe balance
transactions) and `account_readiness` (Stripe account re-reads) had no Peable
surface to point at and were deleted with the direct rail, with the
discrepancy kinds only they raised. Repairs read the stored seller account. The
Peable router raises `payment_succeeded_after_release` for a capture that lands
after the reservation sweep released the goods, as the Stripe router did.

### D17. Three things use Stripe here, and only one of them is this ADR

Recorded so the other two are decisions rather than oversights.

| Use | Where | Disposition |
|---|---|---|
| Marketplace payments | `services/payments/**` | **This ADR.** |
| Referral payouts | `services/referral-payouts/rail.ts` → `createStripeTransfer` | **Deleted (2026-11-05)** with the direct rail. The readiness and risk-facts readers stay registered; the payout-rail port is empty, so a batch fails `rail_not_configured`, retryably, until a Peable payout rail registers. |
| Merchant subscriptions | `services/billing/peable/**` (#89) | **Moved (2026-11-04).** Native subscriptions of Peable's billing engine (Peable ADR 0018) on Mercaria's own Peable merchant: a Checkout Session in `mode: 'subscription'`, Peable's customer portal, `cancel_at_period_end`, and `customer.subscription.*` / `invoice.*` events on `/webhooks/peable`. The Stripe Billing adapter, the I08 cohort and its Stripe reader are deleted; Mercaria holds no credential for billing. It books `subscription_revenue`, which ADR 0001 D3's commission residual deliberately does not touch. |

Billing has moved, so no deployed Mercaria task needs a Stripe credential, and
the direct marketplace rail is deleted (D13 "As built").

**Merchant subscriptions in production (2026-11-05).** The owner decided that
merchant-plan revenue goes to Oxy Platforms, Inc. Mercaria's Peable merchant
(`merch_bd106296a0fef49a861ee6b7`) stays `first_party`, so Peable ADR 0015
routing makes each plan charge a platform charge on Oxy Platforms' live Stripe
account. Endpoint `we_82b5f363eb495108b252e607` delivers to `/webhooks/peable`
in production, which verifies it. No plan is on sale: no paid capability exists
and no price is approved, so `MERCHANT_BILLING_ENABLED` stays off
(`docs/runbooks/merchant-plans-live.md`). The plan checkout sends no
`automatic_tax`, so as built a plan invoice carries no tax. Whether it should is
an owner decision recorded in that runbook.

### D18. What a new rail has to prove before it carries money

`runPaymentProviderContract` (`services/payments/__tests__/provider-contract.ts`)
is the gate, unmodified: the happy path reaching `succeeded` and refunding to
`refunded`, a partial refund landing on `partially_refunded`, every mutation
idempotent under a repeated key, failures arriving as `PaymentProviderError`
with a `retryable` flag, `verifyEvent` refusing a bad signature non-retryably,
and duplicate and out-of-order events converging on one state.

**That suite covers `PaymentProvider` and not `SettlingPaymentProvider`.** There
is no contract test for `createTransfer` or `reverseTransfer` — the half that
moves sellers' money and takes it back. Writing one is part of this work and not
a follow-up: a settling rail that passed only the existing suite would have
proved nothing about the operations a seller's balance depends on.

Beyond the suite, three things no test can establish, in this order:

1. One real hosted-onboarding run in a browser. The account cannot be driven to
   `active` by API — under `requirements_collector: stripe` the platform is
   refused ToS acceptance (`tos_acceptance_on_behalf_not_allowed`), which is
   exactly the property ADR 0001 D2 wants.
2. One real card charge, in test mode, for a **two-seller** group: one payment,
   two transfers, the ledger summing to zero per currency, the commission in
   `commission_revenue`.
3. A delivery from Peable interrupted mid-flight, converging by retry. Mercaria
   reaches `paid` only from a verified event, so a lost event is a paid order
   that stays unpaid — which is why Peable's ADR 0001 D7 replaces its inline,
   three-attempt, 150 ms-backoff dispatcher with a durable outbox before this
   adapter is trusted.

### D19. WHICH rail a native checkout uses is a deployment fact, and Peable wins

`NATIVE_RAIL` was a constant pinned in the type to `'stripe'`, and three
separate places read `config.payments.stripe.enabled` as a proxy for "does this
deployment have a native rail at all". The three disagreed the moment this ADR
made a second rail real, and one of them —
`assertSellerGroupsPaymentReady` — failed **open**: it returned before looking
at anything, so a Peable-only deployment's checkout admitted every seller,
including sellers with no connected account on any rail. ADR 0001 D4 exists to
refuse exactly that seller. The other two failed closed, so the seller was
shown "not ready" while checkout sold through them anyway.

`services/payments/native-rail.ts` is now the single answer, with two records
TOTAL over `PaymentProviderId` — is the rail configured, and can it serve a
native checkout — so a sixth provider cannot compile without answering both.
`mock` answers `null` to the second: `POST /orders/:id/mock-pay` funds a group
AFTER checkout, so a mock deployment must behave like one with no rail.

**Peable outranked Stripe** while both existed; since D13's execution Peable
is the only native rail (`NATIVE_RAIL`, pinned in the type) and
`PEABLE_ENABLED=false` is the whole of "no card rail". `undefined` — no rail —
stays an ordinary answer: those deployments place orders exactly as they did
before any of this existed.

Two boundaries that go with it, because both are easy to get backwards:

- **`findSellerAccount` is not gated on the rail being configured.** Which
  account a seller is connected to is a different question from whether this
  deployment can charge on it today. Only the second depends on configuration,
  and turning a rail off during an incident must not make Mercaria forget the
  account — `resolvePartnerTransferDestination` asks the first question and
  needs an answer either way.
- **A payout names the rail that reported it.** `ObservedPayout.provider` is
  supplied by the webhook router that saw the event, not read from a constant: a
  payout is an observation, and the observer is the only thing that knows its
  own rail.

### D20. The client asks for `card`, and `stripe` stays as a synonym

**As built (2026-11-05):** the `stripe` synonym, `publishableKey` and the
handoff's `returnUrl` (with `STRIPE_CHECKOUT_RETURN_URL` and the storefront's
return route, which only Stripe's 3-D Secure redirect used) are gone with the
direct rail. `STRIPE_PAYMENT_SURFACE_METHODS` is
`CHECKOUT_PAYMENT_SURFACE_METHODS` and the high-value hold reads
`HIGH_VALUE_HOLD_THRESHOLDS` / `HIGH_VALUE_HOLD_WINDOW_MS`. What follows is the
decision as taken.

`CheckoutRail` was `'stripe' | 'none'`, and `resolveCheckoutRail` read
`config.payments.stripe.enabled` directly — so a Peable-only deployment
answered `'none'`: orders placed, no payment opened, nothing anywhere saying
why. The type now names the SURFACE (`'card' | 'none'`) and the rail behind it
is resolved by D19.

On the wire, `CheckoutPaymentMethod` gains `'card'` and **keeps `'stripe'` as a
deprecated synonym**. That is not tidiness deferred: `'stripe'` is what every
shipped client sends, and refusing it on the deployment that is mid-migration
would break checkout at exactly the moment the vocabulary changed. It carries
no meaning of its own any more — a request naming it gets whichever rail the
deployment resolves. It is request vocabulary only and renders no CHECK, so
this is additive with no migration.

Three consequences worth stating, because each was a decision:

- **`publishableKey` is sent only on the Stripe rail.** Peable's `publicKey` was
  Mercaria's own ApplicationCredential; putting it in a handoff would ship a
  server credential to every buyer's browser. (Mercaria now reaches Peable with
  its Oxy workload identity and holds no Peable key at all; the rule stands.) Absent means "use the key the app
  was built with", which is the correct instruction on a rail with no
  server-side key to reconcile against.
- **Presentment currencies are per rail.** `PEABLE_PRESENTMENT_CURRENCIES`
  defaults to ADR 0001 D8's launch set. This is Mercaria stating what it
  BELIEVES the gateway can charge; the gateway's own configuration is the
  authority, and a disagreement surfaces as a refusal from Peable rather than as
  a silently wrong checkout. The parser is shared between the two rails rather
  than copied, because a second copy is where the currency validation silently
  stops applying to the newer rail.
- **`STRIPE_PAYMENT_SURFACE_METHODS` and `STRIPE_CHECKOUT_RETURN_URL` are
  misnamed and are read on EVERY rail.** Which wallets a client may render, and
  where a buyer lands after authentication, are checkout facts rather than
  acquirer facts. Gating them on the resolved rail would leave a Peable
  deployment with no configured surfaces — and the handoff contract says that
  set is never empty, because a handoff with nothing to render is a checkout
  that cannot be paid. Renaming them is a task-definition change in
  `oxy-infra`, which this repository cannot make or verify, so the behaviour is
  pinned by a test instead of left to be rediscovered.

## What this does not change

D1 and D3–D12 of ADR 0001. Merchant of record, separate charges and transfers,
one payment per checkout group, immediate capture, the ledger as the sole record
of commission, the platform settlement currency, D8's transfer region, D11's
idempotency scheme, the buyer boundaries on provider metadata, and the rule that
a `return_url` redirect proves nothing.

Also unchanged: the four webhook routers mounting before `express.json()`. The
Stripe endpoints become Peable endpoints and the invariant, and the integration
test that asserts it against the real middleware chain, move with them intact.

## Consequences

- ADR 0008 becomes history. Its measurements were about how Mercaria creates
  connected accounts; that call now lives in Peable, and its two open hazards —
  the v2 event endpoint and the `card_payments` coupling that makes
  `account.updated` fire at all — travel with it. **They are not solved by
  moving.** Whoever ports `account.service.ts` must carry D2-C and D2-D across
  as one decision, because removing the "unnecessary" `card_payments` capability
  silently breaks readiness in a way that a demo passes.
- The buyer-facing change is small: three files hold the entire Stripe surface
  (`CardPaymentStep.tsx`, `CardPaymentStep.native.tsx`, `types.ts`), and
  `CheckoutPaymentHandoff.clientSecret` is already typed as rail-neutral, so the
  contract between server and client does not move.
- The native apps are the one real gap. Peable's payer SDK mounts onto the DOM;
  `@stripe/stripe-react-native`'s PaymentSheet has no equivalent yet, so iOS and
  Android either wait for one or open the hosted checkout in the system browser.
  **As built (2026-11-05):** the system browser — Peable's `/i/:pi` page, the
  secret in the fragment, the outcome read only from Mercaria's payment status.
- Mercaria's operational surface shrinks by 26 environment variables and roughly
  3,400 lines, and grows by one HTTP client. The complexity does not vanish — it
  moves to a service that has to hold it for every Oxy product rather than for
  this one.
