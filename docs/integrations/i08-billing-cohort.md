# I08 recurring billing adoption

Nate's authorization in OxyHQ/oxy#1519 and Peable#87 covers the five existing
BillingProvider methods for an exact Mercaria cohort, preserving its existing
Stripe platform account/mode and flow/MoR. Peable#92 supplies that contract; published @peable.to/sdk 0.2.5-oxy-one.0 (dist-tag
`oxy-one`, the first to take a `tokenProvider`) and transitive shared-types
0.3.2-oxy-one.0 are installed from npm with integrity in bun.lock.
The store is the stable billing subject. Merchant/application ownership is not
evidence of an Oxy payer identity; no optional invented payer field is added.

## Execution and routing

`services/billing/register.ts` installs the legacy provider when
`MERCHANT_BILLING_PEABLE_COHORT` is absent (the default) and the general Stripe
rail is enabled. With both absent/off it registers no provider. When present, it parses
strict JSON containing merchantId, applicationId, environment,
platformAccountId, livemode and nonempty storeIds. It checks the existing Stripe
key's actual platform account, the key mode and the Peable SDK credential's
resolved merchant/application/environment before installing any provider.
Malformed/mismatched configuration leaves no legacy fallback for that process.

An explicit cohort is registered independently of the general Stripe rail. The bounded
reader exposes only platform-account and exact-subscription GETs, checks the
existing key mode against the cohort environment, and verifies the platform
account before registering. Mercaria must have an Oxy identity before any remote
read: the ECS task role (`oxy-mercaria-task`, oxy ADR 0026), or a full
`OXY_APPLICATION_KEY`/`OXY_APPLICATION_SECRET` pair off ECS. The Peable SDK is
handed that identity as its `tokenProvider` (SDK 0.2.5-oxy-one.0); there is no
Peable credential, and the gateway resolves the merchant from the token's
application id and environment. `PEABLE_APP_PUBLIC_KEY`/`PEABLE_APP_SECRET` are
no longer read, and a release removes them from the task definition.
The general client and direct legacy Stripe mutations remain disabled while the
general Stripe rail is off — which, since it has no switch, means while
`STRIPE_CONNECT_WEBHOOK_SECRET` (or another of its three values) is absent —
including stores outside the cohort. **Once all three are present the general rail
is ON and the store allowlist no longer bounds merchant billing.** A malformed cohort
also rejects startup in that state. This alone does not enable checkout actions:
they also need `MERCHANT_BILLING_RETURN_URL` (see below). See the
[cohort registration proof](../audits/2026-10-04-cohort-independent-rail/README.md).

The cohort is durable routing configuration, separate from whether actions are
available. Retain it when actions are paused (unset `MERCHANT_BILLING_RETURN_URL`)
or a deployment is rolled back; removing a store that already belongs to it
requires a separately verified transfer of ownership, not a configuration toggle. Existing bindings stay in
Mercaria and Peable. No new Mercaria migration or history rewrite is needed.

The provider keeps id `stripe`: it is still the same financial rail and object
namespace. Store-scoped calls select by configured store; portal selects by SQL
billing customer; subscription reads/cancellation select by SQL subscription.
Before the first local subscription row, a read of the exact Stripe subscription
ID identifies its customer, then the existing SQL customer→store binding selects
the owner. Metadata never attributes a subject. Unknown/mismatched references
fail closed; gateway failures never retry on the legacy mutator. Peable verifies
its own authenticated namespace, provider bindings and deployed platform account;
its platform configuration must also be checked during activation, because its
merchant DTO does not attest a Stripe account.

Peable executes customer/Checkout/Portal/cancellation mutations for the cohort.
Mercaria's existing signed Stripe webhook, deduplication, subscription projection
and invoice settlement reader remain the transitional ingress. Current state is
re-read through BillingProvider, including after an older event; receipt and
subscription_revenue ledger attribution use existing SQL history. Marketplace,
connected accounts, referral payouts and entitlement policy are unchanged.
This is not a claim that all Stripe ingress has moved to Peable.

## Caller intents and compatibility

The existing HTTP routes accept `Idempotency-Key`. Legacy callers can omit it;
cohort checkout/portal/cancellation require it before domain effects. The
customer key remains derived from the store. SDK mutations pass the key through
unchanged. After a lost response the caller explicitly retries the same intent;
no fallback or extra POST is introduced by this adapter.

The dashboard retains an opaque key per store/action/parameters before sending
anything. Browser sessionStorage survives reload in that tab; native uses its
own AsyncStorage. Concurrent clicks share the in-flight operation. Unknown,
conflict and server errors retain the key; success or terminal input validation
clears it. A gateway result_expired is a controlled validation response allowing
a subsequent explicit intent. Hosted URLs, tokens and responses are never stored.
Secure randomness/storage failure prevents the action. Closing the browser tab
ends that tab's intent scope; cross-device/tab resume is not claimed.

## Activation and rollback gates

1. Compatible Peable backend and migration deployed; cohort remains absent by
   default. Publish shared-types0.3.0 then SDK0.2.2 with fresh build+pack+publish.
2. Install the published SDK in Mercaria, regenerate lockfile, and repeat the
   consumer's SQL/HTTP, type and package checks. Local candidate overrides are
   development evidence only and must not ship.
3. Verify the deployed Peable and Mercaria platform account/mode are identical;
   resolve the existing Oxy application credential/merchant/environment and
   required payments:read/write scopes. No new principal or merchant credential.
4. Import prices/customers/references only with verified cohort evidence. The
   production inventory on 2026-10-03 found six commercial tables empty: a no-op
   historical migration, not proof Stripe is empty or permission for a catalogue.
5. Review exact store allowlist, Portal configuration (no plan changes/immediate
   cancellation), callback origin and bindings before activating a test or
   commercial cohort. Sandbox fixtures do not activate a commercial cohort.
6. Pause new actions on failure while retaining cohort routing, webhook handling
   and reconciler. Roll back only to an image that understands existing cohort
   ownership; never route an unknown Peable outcome to a second writer.

## Local proof boundaries

`adapter.realdb.test.ts` runs the published SDK over HTTP, real Mercaria
controllers/domain/SQL/ledger, lost-response same-key recovery, mapping negatives,
flag-off reads, duplicate and out-of-order projection, and one balanced synthetic
invoice receipt attributed to the correct store. Oxy/store authorization,
Peable responses and Stripe reads are explicit synthetic boundaries. No real
provider/network, new payment or production activation is claimed by this suite.
Registration tests exercise account/mode/namespace rejection without network.
The real createApp CORS preflight admits Idempotency-Key only through the existing
approved-origin policy; missing-header RED and corrected GREEN are retained.
Dashboard tests exercise persistence/coalescing and failure retention.


## Merchant action availability and reconciliation

Checkout, Portal and period-end cancellation are available iff a billing rail is
configured (general Stripe, or the complete cohort plus Mercaria's Oxy identity)
AND `MERCHANT_BILLING_RETURN_URL` is set; there is no separate actions flag.
Platform webhook handling, scoped automatic event recovery, subscription reads,
invoice posting and reconciliation remain independent of it.
With general Stripe disabled, both the status projection and all three actions
require the registered store allowlist. The marketplace rails are on exactly
when configured (Stripe: key and both webhook secrets; Peable:
`PEABLE_WEBHOOK_SECRET` and an Oxy identity); enabling recurring merchant actions does not enable
marketplace checkout, Connect onboarding, transfers or referral payouts.

For the existing two-store cohort, the prospective configuration change is
`MERCHANT_BILLING_RETURN_URL=https://dashboard.mercaria.co/settings/plan`.
Keep the existing cohort, Peable credential references, Stripe platform account,
mode and restricted Portal configuration. The return origin and actual serving
configuration require operator readback before activation. This document does
not activate that configuration or authorize a purchase. No new secret,
credential, user grant, merchant, product or price is required to set it.
Checkout still requires an existing active paid plan, its exact provider
price and terms; Portal needs an existing customer, cancellation an existing
subscription. An empty catalogue does not become a paid offer by enabling actions.
The authenticated store owner still needs `store:manage`; service scopes do not
replace that permission or the caller's stable Idempotency-Key.

Reconciliation selects the registered provider/mode before the SQL page limit.
When general Stripe is off, it also selects the registered cohort before that
limit and reads nothing until registration succeeds. The timer advances a stable
ID cursor after each bounded page, including failed reads, and wraps at the end.
Its independent local grace-audit cursor visits later rows even when earlier
ones have already been announced. Local grace audit does not depend on a
registered rail; entitlement deadlines continue to resolve directly from SQL.
The default interval remains six hours and the page size fifty; this is bounded
periodic coverage, not a claim of a five-second recovery SLA.
