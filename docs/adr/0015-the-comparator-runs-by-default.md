# ADR 0015: The comparator runs by default, driven by a catalogue autopilot

- **Status:** Accepted
- **Date:** 2026-10-10
- **Amends:** ADR 0002 D24, whose environment block ships the two canonical WRITE
  levers (`CANONICAL_GRAPH_ENABLED`, `CANONICAL_WRITE_PUBLICATION_ENABLED`) OFF and
  whose rollout is a sequence of operator steps. Nothing else in ADRs 0001–0014 is
  reopened: the levers still exist, each is still the rollback for its own blast
  radius, and every rule the services enforce still applies.
- **Builds on:** #60 (backfill), #62 (ingestion), #58 (matching), #70 (search),
  ADR 0014 (reference seeding).

## Context

On 2026-10-10 every piece of the price comparator was merged and deployed, and
production showed no new product. Each layer was correct and each was switched off
or waiting for a person:

- `CATALOG_INGESTION_ENABLED`, `CANONICAL_GRAPH_ENABLED` and
  `CANONICAL_WRITE_PUBLICATION_ENABLED` defaulted OFF, and the deployment set none
  of them.
- `CANONICAL_SEARCH` defaulted `off`, so `GET /search` answered 404. The
  storefront's search screen reads nothing else.
- No migration creates a matching policy, so the matcher skipped every subject
  with `no_active_policy`.
- Sources, their rights and their merchant bindings were to be configured through
  `/internal/ingestion`, which is not mounted where no operator list is set.
- Every backfill stage, including ADR 0014's, ran only when an operator opened a
  run.

A rollout that needs nine environment variables, an operator allow-list and a
person paging runs by hand did not happen, and a comparator that never runs
compares nothing.

## Decisions

### D1. The comparator's levers default ON

`CATALOG_INGESTION_ENABLED`, `CANONICAL_GRAPH_ENABLED`,
`CANONICAL_WRITE_PUBLICATION_ENABLED` and `CANONICAL_SEARCH` default ON. So do the
read MOUNTS that need no secret and gate nothing durable:
`CATALOG_TAXONOMY_V2_ENABLED`, `FACETS_ENABLED`, `PRODUCT_SAVES_ENABLED` (reads
stay `off`, the migration stays a dry run), `WATCHLISTS_ENABLED`,
`PRICE_ALERTS_ENABLED`, `PRICE_ALERT_EVALUATION_ENABLED` and
`NEARBY_DISCOVERY_ENABLED` (which still stays off without `GOWAY_API_URL`).

Each remains a lever: setting it OFF is the rollback, exactly as D24 describes.

Deliberately still OFF: `SEO_ROUTES_ENABLED` (turning it on without
`SEO_INDEXING_MODE` serves `noindex` and an empty sitemap; indexing the catalogue
is a product decision), `OFFER_REFRESH_ENABLED`, `OFFER_EXPIRY_SWEEP_ENABLED`,
`PRICE_HISTORY_ENABLED` (no series currencies are chosen), the price-signal levers
(they need a published policy) and every lever that needs a secret.

### D2. Sources are declared in code

`services/open-data/sources.ts` lists the sources Mercaria runs: provider, account
ref, merchant, markets, cadence and rights. The pull request that changes it is
the terms review #62 requires before a source runs. The Open Facts catalogues are
declared demand-only: they fetch the GTINs some price source saw, never a whole
country's catalogue (~370k products for Spain) into a database every Oxy product
shares. The User-Agent the providers
require is a constant (`OPEN_DATA_USER_AGENT`), and every provider is registered on
every deployment, because registering fetches nothing.

### D3. A catalogue autopilot converges and cycles

`services/catalog-autopilot/`, started on every task:

- publishes a **baseline matching policy** when none is active. It automates only
  the identifier stages, which `decideOutcome` treats as certain by construction,
  and opens no category gate, so heuristic matches still go to review;
- converges the **declared sources** on boot and hourly: merchant, configuration,
  policy, activation;
- runs **one whole-catalogue backfill cycle** after another: every stage once, in
  dependency order, in `apply` mode with cohort `all`, a new cycle 30 minutes after
  the last started. The cycle's state is the run table, so restarts and concurrent
  tasks converge.

It acts as `system:catalog-autopilot` in every actor column.

### D4. An operator's decision always wins

The autopilot activates only a source still in `draft`, and replaces only a policy
it published itself. A paused source, a revoked one, or an operator's policy stays
exactly as the operator left it. It publishes a matching policy only when none is
active. The operator surfaces are unchanged; runs can still be opened, paged and
cancelled by hand.

## Consequences

- A deployment with no catalogue configuration runs the comparator. Spanish
  grocery prices from Open Prices become products and offers without anyone
  acting.
- The backfill's dry-run-first canary (D24 phase 2) is no longer the default path.
  Its machinery is unchanged and an operator can still use it; `apply` runs are
  bounded by the same per-record isolation, idempotency and vacuity floor.
- Sources without a GTIN (fuel, games, cards) are registered but not declared,
  because nothing they ingest could become a product until a cross-source
  identity exists.
