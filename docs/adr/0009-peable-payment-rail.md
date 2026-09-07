# ADR 0009: Peable is the payment rail — Stripe moves behind the gateway, not out of the picture

- **Status:** Accepted
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

Peable holds a `provider_connections` row carrying Mercaria's own encrypted
Stripe credentials, and calls Stripe **as Mercaria**.

The reasoning is Peable's ADR 0001 D3 and is not repeated here, but the
conclusion for this repository is what preserves ADR 0001 D1: **Mercaria remains
merchant of record and continues to bear the platform-account exposure** —
chargebacks, connected-account negative balances, the `losses.payments =
application` that separate charges and transfers forces. Nothing about
Mercaria's legal position changes, which is why this ADR does not reopen D1 and
does not need a legal review to ship.

What Mercaria gives up is direct access to those credentials. What it gains is a
rail it can change without touching its own code: SumUp, Square or a bank API
arrives as a Peable provider, and `peable-provider.ts` does not know.

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

### D17. Three things use Stripe here, and only one of them is this ADR

Recorded so the other two are decisions rather than oversights.

| Use | Where | Disposition |
|---|---|---|
| Marketplace payments | `services/payments/**` | **This ADR.** |
| Referral payouts | `services/referral-payouts/rail.ts` → `createStripeTransfer` | **Moves with the settlement work.** It transfers to connected accounts that become Peable's; leaving it behind does not keep it working, it breaks it. |
| Merchant subscriptions | `services/billing/stripe/**` (#89) | **Stays on Stripe for now**, as an explicit exception. It touches only the platform account and no connected account, so it is not broken by the move; and Peable has no subscriptions surface to receive it. It books `subscription_revenue`, which ADR 0001 D3's commission residual deliberately does not touch, so the ledger is unaffected either way. |

The exception has a cost and it is named: until billing moves, this repository
still holds a Stripe secret key and a Stripe SDK for one purpose. "Everything
goes through Peable" is not true of Mercaria until that is closed.

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

**Peable outranks Stripe** when both are configured. A deployment with both is
mid-migration by definition, and a checkout opening today should open on the
rail the migration is heading to; it also makes `PEABLE_ENABLED=false` the
complete rollback, with no second switch to remember. `undefined` — no rail —
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
- Mercaria's operational surface shrinks by 26 environment variables and roughly
  3,400 lines, and grows by one HTTP client. The complexity does not vanish — it
  moves to a service that has to hold it for every Oxy product rather than for
  this one.
