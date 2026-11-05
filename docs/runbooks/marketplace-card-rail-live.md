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
| Commission | None. `services/fees/catalog.ts` has one EUR-scoped schedule, never provisioned | `fee_schedules` empty, 2026-11-05 |

`www.mercaria.co` does not resolve, so it is not registered. Register any new
host that renders the card step (§3), or Apple Pay and Google Pay do not show
there.

## 2. What a buyer sees today

Every native checkout names sellers, and none is `ready`, so
`assertSellerGroupsPaymentReady` refuses it with a 409 before any stock is
reserved: "These sellers cannot accept payment right now: … Remove them from
your order to check out with the rest." Nothing is charged and nothing is held.
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
3. **Commission, if any.** Decide a USD rate. Engineering then adds it as a new
   version in `services/fees/catalog.ts` and provisions it; every live store
   accepts it, and then it is activated. Until then a sale carries no
   commission.
4. **One real USD sale**, then a refund of it, as `docs/payments.md` §9 "What
   the first real sale confirms" lists. Nothing short of that verifies the
   rail end to end.
