# Signing a shop directly, and earning from it

The path that needs **no network's approval**: Mercaria contracts with a shop,
the shop supplies a product feed and its own tracking URL, and Mercaria sends it
shoppers and is paid a commission under that contract.

Everything below is read off the shipped code. **Nothing here has been run
against a real deployment**, and this sentence stays until step 8 has been
completed once — the `HANDOFF.md` rule, for the same reason.

## 0. The one blocking gap, before anything else

**Step 4 has no HTTP surface.** A feed configuration whose owner is the
platform rather than a store is supported by the service —
`services/feed-import/configuration.service.ts:113` writes
`ownerKind: 'operator'` when `storeId` is null, and
`feed_configurations_owner_shape_check` admits exactly that row — and
`createFeedConfiguration`'s only caller is `routes/admin/feeds.ts`, which is
mounted under `/admin/stores/:storeId/feeds` and therefore always supplies a
store.

So a partner that is not a Mercaria store cannot have a feed configured through
any route today. This is the shape #867 item 2, #855, #863 and #864 each record:
a capability that exists at the service layer, passes its tests because they
drive it directly, and has no route a person can reach.

Two ways out, and it is a product decision rather than a mechanical one:

- **Mirror the sixteen `/admin/stores/:storeId/feeds` routes onto
  `/internal/feed-imports`** on the catalogue-operator allow-list. Complete, and
  the larger piece of work.
- **Represent each partner as a Mercaria store** and use the existing routes.
  Works mechanically — the catalog source and the feed configuration are
  separate rows, so the source can still be `affiliate_network` while the feed
  belongs to a store — but it gives every partner a store identity, a checkout
  surface and a payments onboarding path it will never use.

## 1. Deployment configuration

Task definition (`oxy-infra`, `terraform-uswest2/app-services.tf`,
`module "mercaria"`):

```
CATALOG_INGESTION_ENABLED=true
FEED_IMPORT_ENABLED=true
OFFER_MATERIALIZATION_ENABLED=true
OFFER_REFRESH_ENABLED=true
OFFER_EXPIRY_SWEEP_ENABLED=true
OUTBOUND_REDIRECT_ENABLED=true
CATALOG_OPERATOR_OXY_USER_IDS=<oxy user id>
PAYMENT_OPERATOR_OXY_USER_IDS=<oxy user id>
```

Secret, in BOTH halves — the workflow's `APP_SECRETS` allow-list and the task
definition's `secrets[]`, in that order, or it never reaches SSM:

```
OUTBOUND_TOKEN_SECRET     # openssl rand -hex 32
```

`OUTBOUND_REDIRECT_ENABLED` without the token secret stays OFF and logs once at
boot (`config/index.ts`'s half-configuration rule). Without the expiry sweep a
withdrawn offer stays on sale forever, which is the one failure a shopper sees.

## 2. Create the source

`POST /internal/ingestion/sources`:

```json
{
  "name": "<Shop>",
  "kind": "affiliate_network",
  "provider": "product_feed",
  "sourceAccountRef": "<feed configuration id from step 4>",
  "merchantId": "<merchant id>",
  "fetchCadenceSeconds": 86400,
  "freshnessTtlSeconds": 172800
}
```

**`kind: 'affiliate_network'` with `provider: 'product_feed'` is the whole
trick, and it is not a loophole.** `offerKindFor` reads
`resolved.source.sourceKind`, which `catalogSourceConfigRepository` selects from
`catalog_sources.kind` — an operator-set column. `CatalogSourceAdapter.kind` is
a separate, descriptive field and nothing compares the two. The kind is a
statement about the commercial RELATIONSHIP; the adapter is a statement about
the TRANSPORT. `ingestion-rules.test.ts` §"which offer kind a source produces"
holds the matrix, and a mutation removing the `sourceKind` condition fails it.

## 3. Publish the rights

`POST /internal/ingestion/sources/:sourceId/policies`, granting at least:

| Right | Why |
|---|---|
| `store`, `cache`, `display_price`, `display_media` | to show the product at all |
| `outbound_link` | without it the offer is `informational` and a CHECK refuses it a destination |
| `affiliate_params` | without it the offer is `external`, not `affiliate` — the plain link, which is the honest degradation |

Then `POST /internal/ingestion/sources/:sourceId/status` with `active`.

## 4. Configure the feed — SEE §0

The mapping from the shop's columns onto `NormalizedSourceRecord`. The shop's
tracking URL maps onto `affiliateUrl` and its plain product URL onto
`sourceUrl`; `ingest.service.ts` writes the first to
`affiliate_tracking_template` and the second to `destination_url`, and **never
composes or rewrites either**.

## 5. Approve the destination host

`POST /internal/affiliate/hosts`, scoped to this source, `kind: 'merchant_site'`,
naming the shop's own host.

Every comparison is EXACT on a parsed, lower-cased `URL.hostname` — never
`endsWith`, under which an approved `example.com` also admits the prepended
`notexample.com`. An unapproved host is refused at redirect time and the click
row records the refusal, so "why is this partner's button dead" is answerable.

## 6. Import

Open a run and let the page drain. Offers land bound to a canonical variant with
`kind: 'affiliate'`, a `destination_url` and an `affiliate_tracking_template`.

## 7. Traffic

The storefront's `OfferRow` already renders the outbound action for a non-native
offer, and `GET /out/:token` revalidates freshness and the source's live
`outbound_link` right at click time before redirecting. Clicks are written on
BOTH paths — a refusal that stored nothing would make the operator's question
unanswerable.

`GET /internal/affiliate/report` returns human clicks, non-human clicks and
refusals. It returns **no** conversion or commission figure and the two halves
are never divided: a network report is revisable for weeks while a click is not.

## 8. Commission

**Not bookable yet.** `resolveAffiliateReportReader('direct')` answers
`network_not_configured` and deliberately not an empty list, because an empty
list and "this shop sold nothing" are the same value.

What closes it: `POST /internal/affiliate/reports/direct` on the
payment-operator allow-list, opening a run for the window the operator states
and driving the same `applyReportedTransaction` the Awin poll drives. See
`services/outbound/reconciliation/direct.ts`.

Until then a partner's statement is reconciled outside Mercaria, and the click
counts in step 7 are what Mercaria can prove it delivered.

## What is proved, and what is read

| Claim | How it is held |
|---|---|
| `affiliate_network` + `product_feed` yields `affiliate` offers | `ingestion-rules.test.ts`, mutation-checked |
| `direct` may name a commission record | `reconciliation.realdb.test.ts`, with a negative control on the CHECK |
| The redirect admits an `external` offer too | `destination.ts`'s own docblock |
| Everything else here | read off the code; **not run** |
