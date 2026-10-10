# ADR 0014: Open reference data may seed the canonical catalogue, through backfill and a granted right

- **Status:** Accepted
- **Date:** 2026-10-10
- **Amends:** ADR 0002 D23 phase 1, which names unmatched STORE listings as the
  only thing a backfill may mint a canonical product from. Nothing else in ADRs
  0001–0013 is reopened. The matcher still never mints (#58), and adapters still
  never write the commerce graph (#62 write boundary 1).
- **Builds on:** #62 (ingestion framework, source rights), #58 (matching), #60
  (backfill), and `docs/catalog-sources/open-data-providers.md` (the keyless
  providers this decision exists for).

## Context

Mercaria is a price comparator as well as a marketplace. Its open-data providers
— Open Prices, MITECO fuel, CheapShark, GOG, Scryfall, TCGdex — publish prices
keyed on products: a GTIN, a store's game id, a card printing. The framework
materializes an offer only after #58's matcher attaches the observation to an
EXISTING canonical variant. Today the canonical catalogue is minted from one
place only: D23's phase-1 backfill, from unmatched STORE listings.

So a price for a product no Mercaria store sells has nowhere to land. On
2026-10-10, Open Prices held 570 (chain, GTIN) prices for Spain inside a year,
and almost none of those GTINs were in the catalogue. The matcher recorded
`create_new` for each of them and, correctly, stopped there. Its refusal to mint
is load-bearing: a matcher that mints on its own doubt manufactures the
duplicates it exists to prevent.

Open Food Facts and its siblings are a REFERENCE catalogue. Each record is one
trade item, identified by the GTIN its manufacturer was assigned by GS1, and it
carries a name, a brand, photos and a description maintained by a community.
That is a stronger basis for a canonical product than one seller's listing
title, which D23 already accepts as a basis for a draft.

## Decisions

### D1. A source may seed the catalogue only under a granted, reviewed right

`catalog_source_policies.may_seed_catalog` (default `false`) is a tenth right,
`seed_catalog` in `CATALOG_SOURCE_RIGHTS`. It resolves like every other right:

- only from the ACTIVE policy version;
- only while the source's status is displayable;
- only on a policy that a person reviewed and dated
  (`catalog_source_policies_active_review_check`).

A policy that grants it also asserts `may_store`. A source whose policy does
not grant it contributes observations and nothing else, which is every source
that existed before this ADR.

The right belongs to a source and not to a provider, because seeding is a
judgement about one configured feed. Open Food Facts for Spain may be granted
it while a test source of the same provider is not.

### D2. Only a backfill stage mints, and only on the matcher's own `create_new`

The `reference_products` stage of #60's backfill examines `catalog_source_objects`
from sources whose active policy grants `seed_catalog`, in state `unmatched`.
For each object it reads the observation's GTIN and mints a canonical product
only when ALL of these hold:

1. the matcher's latest decision for the object is `create_new`. A
   `manual_review` decision is `blocked_by_decision`, and an object with no
   decision is `awaiting_match_decision` — D23's ordering, in which identifier
   matching precedes creation;
2. the observation asserts a GTIN that validates. A record without one is
   `reference_no_identifier`, because a name alone is not identity;
3. no canonical variant already owns that GTIN. If one does, the stage reports
   `identifier_already_owned` and mints nothing; the object attaches on its
   next re-advance (D4).

The mint goes through `CanonicalGraphWriter`, like every backfill write: a
`draft` product and variant, plus the GTIN through `assignIdentifier` with the
observation as `source_record_id`. A collision is `identifier_disputed`, and
the newcomer never steals the identifier (ADR 0002 D14). The product's slug is
the name's slug suffixed with the GTIN, because product names are not unique
and a slug collision is a refusal, never a suffix chosen at random.

The stage writes NO source link and changes no object state. Attaching an
observation to a product remains the matcher's decision alone.

### D3. Seeded products are drafts until something can be compared

A seeded product is `draft`, which no shopper sees
(`SHOPPER_VISIBLE_CATALOG_STATUSES`). The `reference_promotion` stage makes it
`active` only when ALL of these hold:

- it was minted by `reference_products` (its backfill record says so);
- it still has an active identifier;
- at least one active offer of it may display a price.

A reference record with no price anywhere stays a draft: a catalogue page with
nothing to compare is not a comparison. Promotion goes through
`updateCanonicalProduct`, which records the review stamp.

### D4. Re-advance re-asks the matcher; it does not bypass it

An object stored `unmatched` before its GTIN existed in the catalogue is never
matched again on its own. The ingestion pipeline skips an unchanged
observation before it reaches the matcher, and that is correct for every
unchanged redelivery.

The `source_readvance` stage re-runs #62's own `advanceObject` — match, link,
materialize — over `unmatched` objects. This is the ingestion path's own code,
exported once (`readvanceSourceObject`), not a second implementation. It is how
a Mercadona price from Open Prices becomes an offer on a product that Open Food
Facts seeded an hour earlier.

It re-asks only objects whose current observation asserts a GTIN that an ACTIVE
canonical identifier now holds. Every other unmatched object would get the same
`create_new` again, once per object per pass. The record is rebuilt from the
stored payload (`normalizedFromStoredPayload`, the exact inverse of the
projection), because the adapter's own record was discarded at ingestion. The
offer it materializes carries no source run, which its column permits.

### D5. ODbL data stays traceable as its own layer

Seeded names, identifiers and images keep their `source_record_id`, so every
fact Mercaria holds from an ODbL source can be enumerated by provenance and
exported as its own database. Wherever such data is shown, the source's
attribution line is rendered. The export is deferred, as recorded in
`HANDOFF.md`. This decision is what keeps it possible without a migration.

## Consequences

- **The order for an operator** (D23's ordering, extended):
  1. ingest the reference source;
  2. let the matcher decide;
  3. `reference_products` in dry run, then apply;
  4. `source_readvance`;
  5. `reference_promotion`;
  6. `search_reindex`.
- **Sources without GTINs** (games, cards, fuel) are not seeded by this ADR.
  They need a stable cross-source identity first; a later ADR decides it.
- **Rollback** is a policy version that withdraws the right. Already-minted
  drafts stay; they are ordinary canonical products, and #59's tooling can
  merge or suppress any of them.
