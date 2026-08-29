# Mercaria documentation

Every domain's reference lives here, one file per domain. The binding decisions
are the ADRs; the schema ledger is
`packages/backend/src/db/schema/CONVENTIONS.md`; deferred work is `HANDOFF.md`.

## Start here

| Doc | What it covers |
|---|---|
| [architecture.md](architecture.md) | Monorepo layout, the backend domain model, CORS origins, the Moovo shipping boundary |
| [postgres.md](postgres.md) | Driver/ORM, schema, migrations and deploy phases, the realdb test harness, rebasing a migration |
| [deploy.md](deploy.md) | ECS and Cloudflare Workers deploys, the Dockerfile pin, the deploy handoff |
| [currency.md](currency.md) | Multi-currency roles, `DualMoney`, FX, the enforced amount bound |
| `packages/backend/src/db/schema/CONVENTIONS.md` | The binding schema ledger — naming, keys, CHECKs, `jsonb`, foreign keys |

## Money

| Doc | What it covers |
|---|---|
| [payments.md](payments.md) | The provider-neutral payment domain, the ledger, Stripe (#46–#50), fees (#88), guest checkout (#107), retail on the card rail (#123) |
| [retail-pricing.md](retail-pricing.md) | Zero-margin `mercaria_retail` cost recovery (#120) |
| [retail-reconciliation.md](retail-reconciliation.md) | Zero-profit cost reconciliation and variance (#128) |
| [merchant-plans.md](merchant-plans.md) | Merchant plans, entitlements and subscription billing (#89) |
| [referral-rewards.md](referral-rewards.md) | Referral reward rules (#144) |

## The catalogue graph

| Doc | What it covers |
|---|---|
| [offers.md](offers.md) | The unified offer model (#57) |
| [matching.md](matching.md) | Deterministic matching (#58) |
| [curation.md](curation.md) | Review, merge, split and correction (#59) |
| [relationships.md](relationships.md) | Verified relationships and evidence (#55) |
| [attributes.md](attributes.md) | Category attributes, units and hard constraints (#94) |
| [condition.md](condition.md) | Item condition (#90) |
| [backfill.md](backfill.md) | The flag-gated catalogue backfill (#60) |
| [ingestion.md](ingestion.md) | The external ingestion framework (#62) |
| [feed-importer.md](feed-importer.md) | The universal product-feed importer (#63) |
| [offer-freshness.md](offer-freshness.md) | Freshness, refresh and catalogue health (#68) |
| [price-history.md](price-history.md) | Currency-safe offer price history (#78) |
| [catalog-sources/](catalog-sources/) | Source selection (#64), eBay Browse (#65), Awin (#66) |

## Discovery and presentation

| Doc | What it covers |
|---|---|
| [search.md](search.md) | Canonical multi-entity product discovery (#70) |
| [search-intent.md](search-intent.md) | Natural-language shopping intent (#95) |
| [offer-ranking.md](offer-ranking.md) | Offer eligibility, ranking and comparison labels (#74) |
| [product-page.md](product-page.md) | The canonical product page (#71) |
| [catalog-pages.md](catalog-pages.md) | Brand and product-family pages (#72) |
| [merchant-pages.md](merchant-pages.md) | Merchant and storefront pages (#73) |
| [seo.md](seo.md) | Public routing and SEO (#75) |
| [price-signals.md](price-signals.md) | Trustworthy price signals and merchant competitiveness (#82) |
| [comparison-basket.md](comparison-basket.md) | Grounded comparison and basket optimization (#96) |
| [commercial-presentation.md](commercial-presentation.md) | Commercial presentation (#129) |
| [analytics.md](analytics.md) | Discovery analytics and search-success measurement (#77) |
| [merchant-demand.md](merchant-demand.md) | Merchant demand analytics and acquisition (#86) |
| [performance/](performance/) | Graph query benchmarks and the indexes they justified (#61) |

## Buyers

| Doc | What it covers |
|---|---|
| [guest-commerce.md](guest-commerce.md) | Guest sessions (#103), cart ownership and merge (#104), inline checkout contact and destination (#105) |
| [orders-buyers.md](orders-buyers.md) | Order buyers, contact snapshots and order access (#106) |
| [guest-portal.md](guest-portal.md) | The guest order portal (#108) |
| [guest-claims.md](guest-claims.md) | Claiming a guest checkout into an Oxy account (#109) |
| [guest-governance.md](guest-governance.md) | Retention, abuse controls and the rollout gate (#111) |
| [guest-p2p/](guest-p2p/) | Guest checkout from an individual seller — the decision (#112) |
| [buyer-requests.md](buyer-requests.md) | Cancellations, returns and support (#110) |
| [product-saves.md](product-saves.md) | Canonical product saves (#80) |
| [watchlists.md](watchlists.md) | Private watchlists and basket tracking (#81) |
| [price-alerts.md](price-alerts.md) | Product and variant price alerts (#79) |
| [reviews.md](reviews.md) | Review scopes, eligibility and aggregates (#76) |
| [seller-profiles.md](seller-profiles.md) | Public P2P seller profiles (#92) |
| [sell-yours.md](sell-yours.md) | The canonical "Sell yours" flow (#91) |
| [moderation.md](moderation.md) | CrowdSource reports, decisions and Mercaria's enforcement levers |

## Merchants and channels

| Doc | What it covers |
|---|---|
| [channels.md](channels.md) | Sales channels and the platform connectors (#87) |
| [connector-verification.md](connector-verification.md) | The connector contract suite and what it cannot prove (#69) |
| [merchant-claims.md](merchant-claims.md) | Proving you operate a merchant (#83) |

## Mercaria retail and dropship

| Doc | What it covers |
|---|---|
| [retail-eligibility.md](retail-eligibility.md) | May Mercaria sell this at all (#121) |
| [supplier-preflight.md](supplier-preflight.md) | Live supplier preflight (#122) |
| [purchase-orders.md](purchase-orders.md) | Supplier adapters and PurchaseOrder orchestration (#124) |
| [retail-pilot.md](retail-pilot.md) | The bounded retail pilot (#125) |
| [retail-fulfilment.md](retail-fulfilment.md) | Supplier-fulfilled fulfilment and the Moovo boundary (#126) |
| [retail-service-requests.md](retail-service-requests.md) | Cancellations, returns, warranties, RMAs and refunds (#127) |
| [suppliers/](suppliers/) | Supplier selection, and Printful's provider document |

## Decisions and runbooks

- [adr/](adr/) — the binding architecture decisions (0001 Stripe Connect,
  0002 the canonical commerce graph, 0003 CommerceActor and guest identity,
  0004 Mercaria retail and dropship, 0005 the referral program,
  0006 Stripe guest checkout).
- [runbooks/](runbooks/) — operator procedures, including verifying the
  connectors against real development stores.
