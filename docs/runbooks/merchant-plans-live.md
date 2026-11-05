# Runbook: opening merchant plans (#89) for sale in production

This covers the steps between "the billing rail works" and "a merchant can buy a
plan". Background is in [`../merchant-plans.md`](../merchant-plans.md) (the
design and its production-readiness checklist) and ADR 0009 D17 (the rail).

**Owner:** the product owner decides prices, plans, tax and terms. The
engineering steps below come after those decisions and are mechanical.

---

## 1. State on 2026-11-05

**Live:**

- **Routing.** Mercaria's Peable merchant `merch_bd106296a0fef49a861ee6b7` is
  `first_party`. Peable's charge routing therefore makes every plan charge a
  platform charge on Oxy Platforms, Inc.'s live Stripe account
  (`acct_1USWGhAofUef123L`). The owner decided on 2026-11-05 that merchant-plan
  revenue goes to Oxy Platforms, Inc., so this routing is intended. No Mercaria,
  Inc. Stripe account is involved.
- **Events.** Peable webhook endpoint `we_82b5f363eb495108b252e607` sends to
  `POST https://api.mercaria.co/webhooks/peable`. It carries the seven
  merchant-plan types: `customer.subscription.created`, `.updated`, `.deleted`,
  `.paused` and `.resumed`, plus `invoice.paid` and `invoice.payment_failed`.
  Mercaria's own workload identity created it. Its secret is in SSM as
  `/oxy/mercaria/PEABLE_WEBHOOK_SECRET` and the task names it as
  `PEABLE_WEBHOOK_SECRET`, so `/webhooks/peable` and its drain run in
  production. A `webhook_endpoint.test` delivery was verified end to end.
- **Transport.** `api.mercaria.co` has no Route53 private hosted zone, so inside
  the VPC it resolves to Cloudflare's public address and Peable delivers over
  `safeFetch`. (`api.oxy.so` is different: its private zone is why Oxy's own
  endpoint needs Peable's OxyServer lane.) If someone ever adds a private zone
  for `api.mercaria.co`, every delivery will be refused as a private address.
  The fix then belongs in the first-party URL decision (`isFirstPartyServiceUrl`
  in OxyHQ/oxy and Peable's `webhookDeliveryLane`), not in a hostname allowlist.

**Not live:** `MERCHANT_BILLING_ENABLED` is unset (off) because there is nothing
to sell yet:

| Missing | Where it shows |
|---|---|
| No paid capability is implemented | All eight `MERCHANT_CAPABILITY_CATALOG` entries are `postponed`, and `activateMerchantPlan` refuses a version that names one (#89: never sell a placeholder plan) |
| No approved price | `merchant-plans.md` §4 says "none are set". The plan designs (`packages/dashboard/lib/merchant-plan-designs.ts`) carry no amount, currency or cadence |
| No Orbit catalog | Mercaria's merchant has 0 products and 0 prices (read live as that merchant, 2026-11-05) |
| No published plan | Production had 0 `merchant_plans` rows (Mercaria#1178 evidence) and no free version is active |
| No terms version | A version names a terms document, and acceptance records it |

Turning the flag on in this state would sell nothing. Every checkout would fail
because there is no active paid version.

## 2. What the owner must decide

1. **Which plan sells first, and what it unlocks.** At least one capability
   from its design has to be built and moved to `available`
   (`services/entitlements/catalog.ts`). That is engineering work, and it
   should land before or with the plan.
2. **Its prices.** For each price: amount, currency, cadence (month and/or
   year), and whether tax is included in the amount or added on top. Use the
   same per-market list for every market the plan is sold in. Engineering never
   picks these.
3. **Trial.** Native subscription checkout cannot start a trial. A version with
   `trial_days > 0` is refused (`trial_not_supported`), so the first version
   must have no trial.
4. **Grace period** after a failed renewal (`grace_period_days` on the version).
5. **Terms.** The terms document and its version that merchants accept.
6. **Tax on plan sales.** Mercaria's plan checkout
   (`services/billing/peable/native-billing.ts`) does **not** send
   `automatic_tax`. As built, Peable charges plan invoices with **no tax**, and
   `tax_settings_not_active` cannot block it. Plan revenue is Oxy Platforms,
   Inc.'s, so if it is taxable:
   - **The owner, in Orbit:** go to orbit.peable.to, open the Mercaria merchant,
     then Tax. Enter the legal name and head-office address of the selling
     entity (Oxy Platforms, Inc.) and the default tax behaviour (inclusive or
     exclusive, matching item 2), then approve. This is owner-only and nobody
     else may approve it.
   - **Engineering:** send `automatic_tax: { enabled: true }` on the
     subscription Checkout Session, with tests. Do this only after the approval
     above: until then Peable answers `400 tax_settings_not_active` and no
     checkout can be created. With no tax registrations, approved settings
     record each sale as `not_registered` (zero tax) until a registration is
     approved.

## 3. Engineering steps, once §2 is decided

Do them in this order. Each one is reversible until step 6.

1. **Implement the capability** and move it to `available`. Deploy.
2. **Orbit catalog.** Create one product per plan and one recurring price per
   approved (currency, cadence) on Mercaria's merchant, in live mode. The call
   must be made as Mercaria's workload identity: the task role `oxy-mercaria-task`
   can be assumed only by ECS, so use a one-off ECS task on the running
   `oxy-mercaria` revision. Do a dry run first that lists the existing products
   and prices, then the create with an idempotency key per price. Record the
   `prod_…` and `price_…` ids.
3. **Plan versions.** Use `/internal/payments/merchant-plans/*` (the
   `payments.operate` key):
   `POST /definitions/sync`, then draft and activate the free version (no
   entitlements), then draft the paid version (its entitlements, `trial_days`
   0, its grace period and terms version), then publish its prices with the
   `price_…` ids, then activate it.
4. **Return URL.** Add `MERCHANT_BILLING_RETURN_URL` to `RELEASE_ENVIRONMENT`
   in `.github/workflows/deploy-aws.yml`. Point it at the dashboard plan screen
   (`https://dashboard.mercaria.co/settings/plan`).
5. **Verify with no real money.** As a store owner, start a checkout
   (`POST /admin/stores/:storeId/plan/checkout`) with billing enabled on a
   staging deployment. In production, create the same session as Mercaria's
   workload instead: a Peable Checkout Session in `mode: 'subscription'` over
   the live price. Its `url` must open in Peable's checkout and answer 200.
   Then expire it (`POST /v1/checkout_sessions/:id/expire`).
6. **The flip** (one step). Add `"MERCHANT_BILLING_ENABLED": "true"` to
   `RELEASE_ENVIRONMENT` in `deploy-aws.yml` and merge. The release renders it
   onto the running revision. `PEABLE_WEBHOOK_SECRET` is already present, so the
   half-configuration guard in `config/index.ts` will not hold it off. Also
   mirror it in oxy-infra's `module "mercaria"` environment for the record, and
   remove that repo's test assertion that it is absent.

**What one real purchase confirms** (and nothing short of it does):

- the payer completes Peable's checkout with a real card and Oxy Platforms'
  Stripe account takes the charge;
- `customer.subscription.created` and `invoice.paid` arrive, verify, and are
  applied by re-reading the subscription and invoice;
- `merchant_subscriptions` reaches `active` on the paid version, and the store's
  entitlements resolve to it;
- the invoice is booked once to `subscription_revenue` / `provider_clearing`
  (no fee leg; a stated gap);
- cancelling through Peable's portal sets `cancel_at_period_end`.

Refund the purchase as an operator `adjustment` if it was a test (§6 of
`merchant-plans.md`: subscriptions issue no refunds).

## 4. Event endpoint operations

- **One endpoint, one secret.** Mercaria verifies with `PEABLE_WEBHOOK_SECRET`
  (plus `PEABLE_WEBHOOK_SECRET_PREVIOUS` during a rotation). A new event type,
  including the marketplace rail's, is added to `we_82b5f363eb495108b252e607`
  (`POST /v1/webhook_endpoints/:id` with the full `enabled_events`). Never
  create a second endpoint whose secret Mercaria does not hold.
- **Rotation.** `POST /v1/webhook_endpoints/:id/roll_secret` with
  `expires_in_seconds` (at most 86400). Put the new secret in
  `PEABLE_WEBHOOK_SECRET` and the old one in `PEABLE_WEBHOOK_SECRET_PREVIOUS`,
  roll the service, and remove the previous one after it expires. The secret
  appears only in the roll answer. Move it into SSM without a terminal: have the
  one-shot encrypt it to an operator RSA public key, decrypt locally straight
  into `aws ssm put-parameter --value file:///dev/stdin`, then shred the key.
- **Test delivery.** `POST /v1/webhook_endpoints/:id/test` (as Mercaria's
  workload) answers the delivery after its first attempt. Mercaria stores the
  event, has no handler for `webhook_endpoint.test`, and answers 200.
