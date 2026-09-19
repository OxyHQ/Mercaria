# Signing a shop directly, and earning from it

The path that needs **no network's approval**: Mercaria contracts with a shop,
the shop supplies a product feed and its own tracking URL, and Mercaria sends it
shoppers and is paid a commission under that contract.

Everything below is read off the shipped code. **Nothing here has been run
against a real deployment**, and this sentence stays until step 7 has been
completed once — the `HANDOFF.md` rule, for the same reason.

The operator half of step 2 and step 4 lands with #987; before it, a
platform-owned feed configuration is reachable from no route at all (#986).

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

## 2. Create the feed configuration, and with it the source

`POST /internal/feed-imports/platform` — the operator surface, on
`CATALOG_OPERATOR_OXY_USER_IDS`:

```json
{
  "sourceName": "<Shop> product feed",
  "label": "<Shop>",
  "identityKeyFields": ["id"],
  "sourceKind": "affiliate_network",
  "merchantId": "<merchant id>",
  "fetchCadenceSeconds": 86400,
  "freshnessTtlSeconds": 172800
}
```

**One request creates both**: `createFeedConfiguration` calls
`configureIngestionSource` itself, so there is no separate "create the source"
step and `sourceAccountRef` is wired for you. `storeId` is null because this is
a platform-owned feed — the owner scope is declared by the router, never
inferred.

**`sourceKind: 'affiliate_network'` is not cosmetic and cannot be corrected
later.** `offerKindFor` grants the `affiliate` offer kind only on that source
kind, and `commercial-presentation` derives `affiliateDisclosureRequired` from
the offer kind — so a feed that earns a commission under a `feed` source shows
the shopper NO affiliate disclosure. And `ensureCatalogSource` is
`onConflictDoNothing` on the source's name: a source created `feed` stays `feed`
forever, and no later call updates it. Get it right here or delete the
configuration and start again.

The field is absent from the merchant surface by design: a store may not declare
its own catalogue an affiliate relationship.

`identityKeyFields` is **frozen** once written — re-keying a feed re-mints every
object and retires the catalogue behind the old ids.

## 3. Publish the rights on the source it created

Read the configuration back for its `sourceId`, then
`POST /internal/ingestion/sources/:sourceId/policies`, granting at least:

| Right | Why |
|---|---|
| `store`, `cache`, `display_price`, `display_media` | to show the product at all |
| `outbound_link` | without it the offer is `informational` and a CHECK refuses it a destination |
| `affiliate_params` | without it no tracking URL is stored, the offer is `external`, and the plain link is handed over — the honest degradation, and no commission |

Then `POST /internal/ingestion/sources/:sourceId/status` with `active`.

## 4. Map the feed and activate it

`POST /internal/feed-imports/platform/:configurationId/versions` to draft the
mapping, `.../versions/:versionId/validate` to produce the report an activation
must cite, then `.../versions/:versionId/activate`.

The shop's tracking URL maps onto `affiliateUrl` and its plain product URL onto
`sourceUrl`. `ingest.service.ts` writes the first to
`affiliate_tracking_template` and the second to `destination_url`, and **never
composes or rewrites either** — the URL handed over at redirect time is the
provider's own, verbatim.

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
| A platform-owned feed carries the source kind it asked for | `feed-import-writes.realdb.test.ts` (#987) |
| The platform's feeds list for the platform and not for a store | same file, mutation-checked on `isNull` |
| `direct` may name a commission record | `reconciliation.realdb.test.ts`, with a negative control on the CHECK |
| The redirect admits an `external` offer too | `destination.ts`'s own docblock |
| Everything else here | read off the code; **not run** |
