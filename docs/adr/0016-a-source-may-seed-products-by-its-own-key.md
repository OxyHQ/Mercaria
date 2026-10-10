# ADR 0016: A source may seed products by its own product key

- **Status:** Accepted
- **Date:** 2026-10-10
- **Amends:** ADR 0014 D2's rule that a reference record mints only under a
  validating GTIN. #58's existing-link stage, which reused only a NATIVE variant's
  attachment, now also reuses an ingested object's. Nothing else in ADRs
  0001–0015 is reopened.
- **Builds on:** ADR 0014 (reference seeding), ADR 0015 (the catalogue autopilot),
  #62 (ingestion), #58 (matching).

## Context

ADR 0014 lets a source granted `seed_catalog` mint canonical products, but only
from records carrying a GTIN. That made Spanish grocery prices comparable and
left everything else out: a Magic card, a Pokémon card, a GOG game or a product
in a Shopify store carries no GTIN. The prices were ingested, stored, structured,
and never shown, because there was no product for them to be an offer of.

Those sources do name their products. Scryfall has a card id whose foil and
non-foil prices are two records. GOG has a product id. A Shopify store has a
product id whose sizes are variants. Within one source, that id is identity: the
source asserts it.

There was a second gap behind the first. #58's stage 1 ("this exact object is
already attached") worked only for native variants. A source object gains a new
observation whenever its content changes, and a price move is a content change.
So an object attached through anything other than a GTIN would have been
re-matched from scratch on every price change and dropped.

## Decisions

### D1. A record may name its source product: `productGroupKey`

`NormalizedSourceRecord.productGroupKey` is the source's own id for the PRODUCT a
record is one variant or offer of. Records of one source sharing it are variants
of one product. It is stored in the payload and copied onto
`catalog_source_objects.product_group_key`, which is indexed by source, so an
object's siblings can be found per page. It is source-scoped and never compared
across sources.

### D2. `reference_products` mints by that key when there is no GTIN

For an object of a `seed_catalog` source whose record carries no validating GTIN
but does carry a `productGroupKey`:

1. **The product** is the one a sibling of the same key was already seeded into,
   or a previous run's, or a new DRAFT. Its variant axes are the record's option
   names, and its slug is the name plus a digest of (source, key), because names
   repeat across a source and the key never does.
2. **The variant** converges on the record's option values.
3. **The observation is anchored** to the product and the variant with
   `connector_declared` source links (the source declared the identity). The
   object is then re-advanced, so the matcher attaches it and its offer
   materializes.

The matcher's heuristic verdict does not block this path. A reprint whose title
resembles another printing goes to `manual_review` only because of that
resemblance, and within its own source the key settles the question. Joining one
product across two sources (the same game on GOG and Steam) stays #59's
curation; this decision never merges anything.

A record with neither a GTIN nor a key still mints nothing (`reference_no_identifier`).

### D3. The existing-link stage covers ingested objects

For a `source_record` subject, #58's stage 1 reuses the newest ACTIVE variant link
on ANY observation of the same (source, type, external id). A price change keeps
its product. An operator who detached the object left that link inactive, so
nothing is reused.

### D4. Promotion accepts an anchor as identity

`reference_promotion` promotes a seeded draft that holds an active identifier
OR an active variant source link and has at least one active priced offer.

### D5. Mercaria's own extraction provider: Shopify storefronts

`shopify_storefront` reads a Shopify store's `/products.json` (the stores behind
shop.app) and is the first provider declared `extraction: true`. #62 refuses it
unless the source's policy grants extraction, so its declared policy is
`robots_respecting` with a daily request budget and Mercaria's User-Agent. The
provider enforces the word: each pass first reads the store's `robots.txt`
(RFC 9309, `services/open-data/robots.ts`) and stops with a configuration error
if `/products.json` or `/meta.json` is disallowed. Carts, checkouts and accounts
are never requested. One source per store, bound to that store's merchant; the
store's currency comes from its own `/meta.json`.

## Consequences

- Scryfall, TCGdex, GOG and fifteen Spanish Shopify stores become comparable
  products with prices, declared in `services/open-data/sources.ts` and run by
  the autopilot.
- Products of different sources are not joined automatically. Two sources
  selling one game show two products until #59 merges them.
- The matcher's review queue receives `manual_review` decisions for reprints
  and same-named products of one source. Each is superseded the moment its
  object is anchored and re-advanced.
