# Open-data providers: keyless catalogue and price sources

**Status:** implemented and **running by default** (ADR 0015). Every provider is
registered on every deployment; the sources Mercaria runs are declared in
`services/open-data/sources.ts` and converged at boot by the catalogue autopilot
(`services/catalog-autopilot/`). No environment variable is involved. Every provider
was exercised live against its real endpoint on 2026-10-10.

Mercaria compares prices from as many sources as it can reach. The eBay and Awin adapters
need accounts that are not approved yet (`ebay-browse.md`, `awin.md`). This kit covers the
other route: **free, keyless, public** data, under licences that allow reuse.

## Shape: a provider is a descriptor

```
services/open-data/
  provider.ts        the OpenDataProvider contract: fetchPage(context) → items + cursor
  http.ts            the ONE transport: User-Agent, per-host pacing, 429/Retry-After,
                     failure classification, conditional dump cache
  read.ts            JSON narrowing, MACHINE-decimal money, FactCollector
  catalogue.ts       THE list of providers (unique slugs, gated by a test)
  register.ts        builds the transport once; registers every provider
  sources.ts         THE sources Mercaria runs: chain, merchant, cadence, rights
  providers/*.ts     one module per provider (the Open Facts family is one factory)
services/ingestion/adapters/open-data.ts
                     any descriptor → a #62 CatalogSourceAdapter (cursor codec,
                     envelope, completeness rule, error vocabulary)
```

A descriptor returns `NormalizedSourceRecord`s and nothing else. From there it is #62's
pipeline: provenance, rights, normalization, matching, offers, freshness and price
history. `open-data-isolation.test.ts` builds the same wall around `services/open-data/`
that `ingestion-isolation.test.ts` builds around `adapters/`: no repository, no database
handle, no canonical write, no offer domain, no matcher.

## Extract everything, structured: `facts`

The fifteen normalization groups are what the matcher and the offer read. Everything else
a provider publishes goes into **`NormalizedSourceRecord.facts`** — typed (`string`,
`number`, `boolean`, `string[]`), with a unit when it has one, and keyed in the
provider's own vocabulary under a namespace:

| Namespace | Examples |
|---|---|
| `openfacts.*` | `nutriscore_grade`, `nova_group`, `ecoscore_grade`, `allergens`, `labels`, `ingredients_text`, `nutrition.sugars_100g` (`g`), `product_quantity` (`g`) |
| `open_prices.*` | `sighting_date`, `sightings`, `shops_observed`, `cities_observed`, `min_price`/`max_price`, `price_per`, `discount_type`, `shop_osm` |
| `miteco.*` | `price_exact` (`EUR/l`, three decimals), `station_id`, `latitude`/`longitude`, `opening_hours`, `province`, `data_timestamp` |
| `cheapshark.*`, `gog.*` | `steam_app_id`, `metacritic_score`, `developers`, `genres`, `release_date`, `operating_systems` |
| `scryfall.*`, `tcgdex.*` | `rarity`, `set_name`, `collector_number`, `type_line`, `legal_in`, `hp`, `attacks`, `cardmarket_trend` |

Facts are **not** options. An option is a variant axis that the matcher compares across
sources (`Finish: Foil`). A fact describes the object, and two sources may state it
differently without describing two products. Facts are stored in
`source_records.payload.facts`, bounded by normalization: 160 facts, 80-character keys,
1,000-character text, 40-item lists. A record with no facts stores exactly the payload
and content hash it always did. Mapping facts onto the attribute registry (#94) is a
later, reviewable step; adapters never do it.

## The providers

| Slug | What | Prices | Licence | `sourceAccountRef` | Modes |
|---|---|---|---|---|---|
| `open_prices` | Crowd-sourced shelf/receipt prices by GTIN, shop and date (daily dumps) | EUR, per chain | ODbL | chain: fold of the OSM brand (`mercadona`, `lidl`, `supeco`…) | snapshot, incremental |
| `open_food_facts` | Food catalogue: GTIN, name, brand, photos, ingredients, allergens, nutrition, Nutri-Score/NOVA/Eco-Score | — | ODbL (images CC BY-SA) | `demand`: only the GTINs other sources priced; empty: also the country catalogue | query_driven (DEMAND first, then country search), targeted (by GTIN) |
| `open_products_facts` · `open_beauty_facts` · `open_pet_food_facts` | The same database for general products, cosmetics and pet food | — | ODbL | — | as above |
| `miteco_fuel` | Every fuel at every public service station in Spain, refreshed every 30 min | EUR/l (exact in a fact) | Spanish public-sector reuse | station brand: fold of `Rótulo` (`repsol`, `ballenoil`…) | snapshot, incremental |
| `cheapshark` | PC game prices across ~15 digital stores | USD | provider terms | CheapShark `storeID` (`1` Steam, `7` GOG…) | incremental |
| `gog_catalog` | GOG.com's full catalogue (games, DLC, packs, extras) | EUR for ES | provider terms | — | incremental |
| `scryfall` | Every priced paper Magic card, one offer per finish | EUR (Cardmarket trend) | provider terms | — | incremental |
| `tcgdex` | Every Pokémon TCG card, localized, one offer per finish | EUR (Cardmarket trend) | provider terms | card language (`es` default) | incremental |
| `shopify_storefront` | Mercaria's own reader of the Shopify stores behind Shop (shop.app): every product, variant (size, colour), SKU, price, compare-at price, stock, images, type and tags, from the store's `/products.json`. **Extraction**: robots.txt is read and obeyed on every pass | the store's currency (`/meta.json`) | the store's own terms | the store domain (`pompeiibrand.com`) | incremental |
| `ygoprodeck` | Every Yu-Gi-Oh! card: type, attribute, ATK/DEF, level, archetype, sets, rarities, formats; TCGplayer/eBay/Amazon prices as USD facts | EUR (Cardmarket market price) | provider terms (no image hotlinking: no media stored) | — | incremental |
| `steam_store` | Mercaria's reader of Steam's store search: the top 10,000 games in relevance order for the market, with release date, review summary, platforms, tags and the discount. **Extraction**, robots.txt checked every pass; free games skipped | EUR for ES (minor units from the store) | provider terms | — | incremental |

### Demand: the reference source fetches what the prices need

A catalogue provider's `query_driven` pass first reads the catalogue's
**demand**: the GTINs that other sources observed `unmatched` and that this
source holds no object for (`listGtinDemand`). It fetches those through the
product endpoint, 12 per page at the published pace, and only then walks the
country search. So a Mercadona price seen by Open Prices makes Open Food Facts
fetch exactly that product. Then ADR 0014's `reference_products` has a reference
record to mint from, and `source_readvance` attaches the price. The demand is a
Postgres read, so `register.ts` (the composition root, the domain's only module
that reaches the database) supplies it as a function.

### Rules every descriptor follows

- **`full_snapshot` only where a pass reads the whole source.** It authorizes retiring
  what a pass did not see. Only the two dump-backed providers declare it, and a test
  pins that list. A paged API over a moving listing (sorted search, capped result
  window) can skip an item and so never claims completeness. Offer freshness (#68)
  expires what stops being refreshed.
- **One source per merchant sub-feed.** Where a provider spans retailers (Open Prices
  chains, MITECO brands, CheapShark stores), the account ref selects one. The source is
  bound to that retailer's merchant (`source_bound`). `per_record` would mint
  `marketplace_seller` merchants from free text anyone can edit, so it is rejected.
- **Money is machine-decimal.** `decimalMoney(value, currency, separator)` never reads a
  thousands separator. Open Prices' `"1.250"` is €1.25 and MITECO's `"2,095"` is €2.10.
  `feed-import/money.ts` would read both as a thousand times the price. Fuel's third
  decimal is rounded half-up on the offer and kept exact in `miteco.price_exact`.
- **Pacing is the provider's published limit**, applied by the shared transport across
  every source of that provider in the process. Open Facts allows 15 product reads and
  10 searches a minute; a targeted page is capped at 12 GTINs so it fits a 120 s lease.
  Scryfall gets 120 ms; CheapShark 1.5 s.
- **Dumps are cached and revalidated conditionally** (`OPEN_DATA_CACHE_DIR`). Twenty Open
  Prices chain sources share one download of `prices.jsonl.gz`. A dump over
  `OPEN_DATA_MAX_DOWNLOAD_BYTES` is refused, never truncated.

## Operating a source

Sources are declared, not configured by hand. `services/open-data/sources.ts` lists
each one with its provider, account ref, merchant, markets, cadence and rights; the
catalogue autopilot converges the database onto it on boot and every hour:

1. The retailer merchant exists (by slug).
2. The source is configured through #62's `configureIngestionSource`, converging on
   its name.
3. Its rights policy is the declared one, published by `system:catalog-autopilot`:
   - ODbL grants store, cache (30 days), display, index and refresh, with
     attribution required.
   - The Open Facts catalogues are bound to no merchant and grant
     `may_seed_catalog` (ADR 0014), so they mint products and never become offers.
     They are declared **demand-only** (account ref `demand`): they fetch the GTINs
     a price source saw and nothing else. Spain alone is ~370k Open Food Facts
     products, and walking them would mint drafts no price points at into a
     database every Oxy product shares.
   - Open Prices chains are bound to their retailer and `may_link_out` is off:
     there is no retailer page to send anyone to, so the offer materializes as
     `informational` (`offerKindFor`), which ranking already admits.
4. A source still in `draft` is activated.

**An operator still wins.** Pausing or revoking a source through
`/internal/ingestion` sticks: only `draft` is activated. A policy an operator
publishes sticks: only a policy the autopilot published is replaced when the
declaration changes.

Adding a chain or a provider's source is a line in `sources.ts` and a deploy. The pull
request is the terms review.

## Known limits — read before expecting offers

- **The matcher never mints a canonical product** (`create_new` is recorded and stops).
  ADR 0014 adds the route by which a price for a product no store sells becomes a
  comparison, and the catalogue autopilot runs it every 30 minutes:
  1. The reference sources (the Open Facts family) are declared with `may_seed_catalog`.
  2. The backfill stages run in a cycle: `reference_products` (it mints DRAFT products from that
     source's `create_new` objects with a valid GTIN), `source_readvance` (it
     re-asks the matcher about unmatched objects whose GTIN is now owned, so the
     Open Prices price attaches and its offer materializes) and
     `reference_promotion` (a seeded draft with a priced offer becomes `active`,
     and `/search` finds it).

  `reference-seeding.realdb.test.ts` drives that whole chain.
- **Sources without GTINs seed by their own product key** (ADR 0016). Scryfall, TCGdex,
  GOG and the Shopify stores set `productGroupKey`; `reference_products` mints one
  product per key with a variant per option set and anchors the observations.
  Products are not joined ACROSS sources (a game on GOG and on Steam is two products
  until #59 merges them). MITECO fuel and CheapShark are not declared yet.
- **Open Prices is thin for Spain.** Measured 2026-10-10: 570 (chain, GTIN) pairs in the
  365-day window across 55 chains. The largest are Supeco 141, Alcampo 76, Mercadona 69
  and Lidl 52. That is about 20 new sightings a month, out of 325k prices worldwide.
  It is one price source among many, not a catalogue.
- **CheapShark prices are USD** for the US storefront. GOG publishes EUR for Spain.

## On the storefront

A product-page row from an open-data provider carries `source` (`ProductPageOfferSource`):
- the provider's name and homepage, from its descriptor;
- the licence, with its label as data ("ODbL 1.0" is a proper noun in every
  language);
- `observedAt`, the source's own timestamp from the offer's source record. For a
  crowd-sourced price that is the day somebody saw it on the shelf.

`OfferRow` renders "Price seen on {date}" where an informational offer would
otherwise show a disabled button, and a "Data: {name} · {licence}" line under
every such row. The line is text, not a link: this surface opens nothing outside
Mercaria except through the outbound union.

## ODbL and share-alike

Open Food Facts, Open Prices and OpenStreetMap-derived facts are ODbL.
- **Showing them** (a Produced Work) requires attribution, which is the descriptor's
  `attribution` line rendered wherever the data is shown.
- **A publicly used derivative database** must itself be offered under ODbL.
  Provenance keeps every ODbL fact traceable to its `catalog_sources` row, so that subset
  can be exported on its own; the export itself is deferred.
- **Legal review** is still required before production.

## Considered and excluded

- **Supermarkets' internal APIs** (Mercadona `tienda.mercadona.es/api`, DIA, Carrefour)
  are reachable without auth but undocumented and unlicensed. The EU sui generis
  database right and site terms (CJEU *Ryanair v PR Aviation*) make bulk reuse a legal
  risk. #62 also refuses extraction adapters by policy.
- **Google Books** (anonymous quota exhausted), **BoardGameGeek** (registered token
  since 2025), **pokemontcg.io** (unreliable, moving to paid), **opengtindb** (needs an
  id): these need keys or fail.
- **iFixit** is CC BY-NC-SA, so no commercial use.
- **Not yet built, keyless, and next in line:**
  - Steam `appdetails?cc=es` (EUR, undocumented, roughly 200 requests per 5 minutes)
  - Open Library and MusicBrainz (CC0, ISBN/barcode catalogue)
  - Wikidata and name-suggestion-index (CC0/BSD brands)
  - Discogs monthly CC0 dumps

## Adding a provider

1. Record a real response as a trimmed fixture under
   `services/open-data/__tests__/fixtures/`.
2. Write `providers/<slug>.ts`: a descriptor plus a pure `toItem(s)` that reads the
   response into a `NormalizedSourceRecord`. Put everything that is not one of the
   fifteen groups into `facts` under the provider's namespace.
3. Add it to `catalogue.ts`. `open-data-isolation.test.ts` fails if a module under
   `providers/` is missing from the catalogue.
4. Add a case to `open-data-providers.test.ts` that runs the fixture through
   `canonicalizeNormalizedRecord` and `redactSourceObservation`. This proves no fact is
   dropped and the payload fits in 32 KB.
5. Add a row to the table above, with the licence and what the account ref means.
