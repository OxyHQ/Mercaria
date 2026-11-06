# Runbook: the marketplace card rail in production

The buyer-facing Peable rail: what is live, how the wallet domain was set up,
and what is still needed before the first sale. The design is
[`../payments.md`](../payments.md) (its §9 is the readiness checklist); the
decisions are ADR 0001 D8 (as amended 2026-11-05) and ADR 0009.

## 1. State on 2026-11-05

The owner approved: register `mercaria.co` as a wallet domain and sell in USD.

| What | State | Evidence |
|---|---|---|
| Card rail | `PEABLE_ENABLED=true`, `PEABLE_BASE_URL=https://api.peable.to` in `deploy-aws.yml`'s `RELEASE_ENVIRONMENT`; `PEABLE_WEBHOOK_SECRET` from SSM | The release renders them onto the running revision |
| Currency | USD only: `PEABLE_PRESENTMENT_CURRENCIES` defaults to `USD` and production does not set it | Oxy Platforms' account `acct_1USWGhAofUef123L` settles USD, and a Peable transfer is in the payment's currency |
| Wallet domain | `mercaria.co` = `pmd_de5b5c1648a83fcb9e411c99`, live, enabled, `apple_pay` and `google_pay` both `active` | Registered and validated as Mercaria's workload (§3) |
| Apple Pay file | `https://mercaria.co/.well-known/apple-developer-merchantid-domain-association`, Stripe's file, from `packages/frontend/public/.well-known/` | Byte-identical to `https://stripe.com/files/apple-pay/apple-developer-merchantid-domain-association` |
| Sellers | **None `ready`.** `provider_accounts` was empty when the rail went on | Read-only count, 2026-11-05 |
| Commission | 5% + $0.30 per order on marketplace card sales in USD, processing included; none on FairCoin (ADR 0018). Stores: `marketplace-card` v1, active. Private sellers: `marketplace-card-individual` v1, active since 2026-11-06, accepted on storefront Settings → Payments (ADR 0018 D3). Its preview counted 0 payment-ready private sellers without acceptance, so activation took nobody offline | `services/fees/catalog.ts`; published by `publish-fee-schedules.yml` (§5): runs 42143645214 (preview), 42143761231 (draft), 42143881233 (activate) |

`www.mercaria.co` does not resolve, so it is not registered. Register any new
host that renders the card step (§3), or Apple Pay and Google Pay do not show
there.

## 2. What a buyer sees today

Every native checkout names sellers, and none is `ready`, so
`assertSellerGroupsPaymentReady` refuses it with a 409 before any stock is
reserved. The refusal names each seller by its public name (the store's name,
or a private seller's Oxy display name), never by `store:<id>`: "Lumen Ceramics
cannot accept payment right now. Remove their items from your order to check out
with the rest." (several sellers: "These sellers cannot accept payment right
now: A and B. …"). The keys ride `details.sellers` (`reason:
seller_not_payment_ready`, each `{ sellerKey, name? }`); the storefront renders
the sentence in the buyer's language from that field and highlights those
sellers' items in the order summary. Nothing is charged and nothing is held.
Before the flag, the same checkout said "order placed" for an order with no
payment attached.

A buyer whose display currency is not USD (the default display currency is
FAIR) gets "Card payments are not available in FAIR. Switch your currency to
USD and try again." once a seller is ready. Prices still convert from the
listing's native currency.

The incident lever is removing `PEABLE_ENABLED` from `RELEASE_ENVIRONMENT`
and releasing. Checkout then answers `none`, as before.

## 3. Wallet domains: the supported path

A wallet domain is a Peable resource on Mercaria's merchant
(`merch_bd106296a0fef49a861ee6b7`). Peable registers it with the acquirer on
the platform account, which is the account that runs Mercaria's charges
(separate charges and transfers, so no connected-account header). Never call
Stripe directly and never write Peable's database.

There are two ways in:

- **Orbit (a person):** orbit.peable.to → the Mercaria application → live mode →
  Settings → Payment methods → Wallet domains → add the host, or "check again"
  on an existing one.
- **Mercaria's workload (what was done):** the call must carry Mercaria's
  identity, and the task role `oxy-mercaria-task` can be assumed only by ECS. So
  run a one-off task on the live `oxy-mercaria` revision with
  `.github/scripts/run-ecs-task.sh`, as `publish-merchant-plans.yml` does, and
  a command override of `bun -e '<script>'`. The image's `dist/` is a bundle, so
  the script builds its own client from `node_modules`:
  `new OxyServer({ baseURL: OXY_API_URL, applicationId: '6a37d0cc5d4b5f15482a9340', serviceIdentity: 'when-anonymous', expectedAudience: 'oxy-service:6a37d0cc5d4b5f15482a9340', workloadCredentials: createAwsWorkloadCredentialProvider() })`
  then `peableForOxyService({ oxy, baseURL: 'https://api.peable.to' })`. Check
  `merchants.retrieve().id` first, then call `paymentMethodDomains.list`,
  `.create({ domain_name })` and `.validate(id)`. Print only the domain fields.

The Apple Pay association file is Stripe's, and it is the same for every Stripe
account. If Stripe changes it, replace the file, deploy the storefront, then
validate the domain again. `public/_worker.js` serves it as a plain asset: the
path has no extension, and the worker only treats an HTML request as a page.

## 4. What is left before the first sale (owner)

1. **A seller reaches `ready`.** This is a real identity check (KYC) at Peable,
   so it is the owner's own store or a consenting seller. For a store: open
   dashboard.mercaria.co → Settings → Payments & payouts → enter the two-letter
   country → Set up payouts. Finish Peable's hosted flow, then return. The page
   refreshes the account, and it must read "Ready to be paid". For a P2P seller,
   use mercaria.co → Settings → Payments, which has the same steps.
2. **The store sells in USD.** All three production stores have `FAIR` as their
   default currency, so merchant activation reports `currency_not_supported`
   until the store's default currency is USD. Change it in the dashboard under
   Settings → Store. Listings in other currencies still sell, because the cart
   converts them.
3. **Commission.** Decided in ADR 0018 and published through §5. Once it is
   active, the store's owner accepts it under Settings → Marketplace fees
   before its first card order; until they do, checkout refuses that store
   with `seller_not_activated`.
4. **One real USD sale**, then a refund of it, as `docs/payments.md` §9 "What
   the first real sale confirms" lists. Nothing short of that verifies the
   rail end to end.

## 5. Publishing the commission (ADR 0018)

The rate is `packages/backend/src/services/fees/catalog.ts`; a change is a pull
request and a new `version`. It reaches `fee_schedules` only through
**Actions → Publish fee schedules** (`.github/workflows/publish-fee-schedules.yml`),
a one-shot on the live task definition that records the live image's commit as
the author. Never write `fee_schedules` by hand.

1. Merge the catalogue change and wait for **Deploy to AWS** to finish: the task
   runs the LIVE image's catalogue. A version that reaches a seller kind for the
   first time also waits for the screen that seller accepts on (stores: the
   dashboard, **Deploy Dashboard**; private sellers: the storefront, **Deploy to
   Cloudflare**).
2. Run it with `mode: preview`. It lists every published version, which
   catalogue versions `draft` would add, and for each version not yet active
   how many payment-ready sellers have not accepted it (`readySellersWithoutAcceptance`,
   with `byOwnerType`; counts only, never an id). It writes nothing.
3. Run it with `mode: draft`. Each new version becomes a DRAFT, which charges
   nobody. A second run changes nothing.
4. Run it with `mode: activate`. It checks every draft first and refuses, and
   activates nothing, while any payment-ready seller a draft reaches has not
   accepted it, because activation would refuse that seller's checkout. With no
   such seller it activates, and each seller meets the terms as pending before
   its first card sale: a store under Settings → Marketplace fees, a private
   seller under Settings → Payments (where payout setup waits on it) and on
   `/sell`.

If `preview` reports a payment-ready seller who has not accepted, do not try to
force activation: those sellers keep selling with no fee until they accept, and a
new version cannot be accepted until it is active (`HANDOFF.md`).

From a terminal: `gh workflow run publish-fee-schedules.yml -R OxyHQ/Mercaria -f mode=preview`
(then `draft`, then `activate`), and `gh run watch` the run it starts.
