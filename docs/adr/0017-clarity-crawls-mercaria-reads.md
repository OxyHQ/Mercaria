# ADR 0017: Clarity crawls the stores; Mercaria reads what it keeps

- **Status:** Accepted
- **Date:** 2026-10-17
- **Supersedes:** ADR 0016 D5 (Mercaria's own extraction provider). Nothing else
  in ADRs 0001–0016 is reopened: `productGroupKey` seeding (ADR 0016 D1–D4), the
  catalogue autopilot (ADR 0015) and the canonical graph (ADR 0002) are unchanged.
- **Org-wide rule it implements:** `~/Oxy/docs/api-conventions.md`, "Cross-app
  references" — a product reads another's facts through that product's SDK.

## Context

Mercaria fetched two kinds of third-party site itself: 26 Shopify stores'
`/meta.json` and `/products.json`, and the Steam store's game search. Each
provider read `robots.txt`, kept a pace and declared an extraction policy with a
daily budget and a User-Agent. Clarity — Oxy's search engine — is the product
whose job is crawling: it already reads robots.txt for its own agent, shares an
origin's Crawl-delay across every reader, retries, caps bodies and backs off.
Two crawlers in one ecosystem would be two answers to "may Oxy read this site,
and how fast", and every new store Mercaria wanted would have grown the wrong one.

## Decisions

### D1. Clarity is Oxy's one crawler of stores

A store is a Clarity **product feed** (Clarity `docs/product-feeds.mdx`):
`shopify_storefront` by domain, `steam_store` by market. Clarity polls it under
robots.txt for ClarityBot and keeps each SOURCE DOCUMENT exactly as served — the
store's `/meta.json` and each `/products.json` product object, each Steam search
row. Clarity interprets none of it.

### D2. Mercaria reads the documents with its own mapping

`shopify_storefront` and `steam_store` stay Mercaria providers with the same
slugs, sources, merchants and rights. Only their fetch changed: each registers
its feed with Clarity (idempotent) and pages through the documents through
`@clarity.surf/sdk`, whose ONE importer is `services/clarity/product-feeds.ts`.
The documents go through the SAME `toItems` / `searchRows` + `toItem` as before,
so every source object keeps its `externalId` and its `productGroupKey`: no
product is duplicated, nothing is migrated, and the matcher's existing links hold.

### D3. Mercaria fetches no site itself

`OpenDataProvider` has no `extraction` flag any more, `services/open-data/robots.ts`
is gone, and every declared source's policy is `extractionMode: 'disallowed'`.
New crawling is a Clarity product feed, never a Mercaria provider. #62's general
gate — an extraction adapter needs the extraction right — stays, for any adapter.

### D4. Mercaria calls Clarity as itself

Its Oxy service token (`requiredOxyServiceToken`), which Oxy introspects as one
of Oxy's own applications (`tier: internal`). There is no Clarity credential and
no new environment variable.

## Consequences

- Freshness is unchanged: offers still retire through the source's
  `freshnessTtlSeconds` when a pass stops seeing them. Clarity prunes a product a
  store withdrew when its walk completes, and refuses to prune on an empty walk.
- Until Clarity has read a newly registered store once, a pass finds nothing and
  proves nothing gone (`complete: false`).
- A store's pace and robots.txt compliance are now Clarity's to keep, and its
  tests: `search/products/feeds/` in Clarity.
