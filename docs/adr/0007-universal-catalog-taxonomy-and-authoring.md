# ADR 0007: The universal, multilingual catalog — taxonomy, localization, versioned product types and typed authoring

- **Status:** Accepted
- **Date:** 2026-08-16
- **Issue:** epic [#367](https://github.com/OxyHQ/Mercaria/issues/367)
- **Builds on:** ADR 0002 (canonical commerce graph), and the shipped work of
  [#52](https://github.com/OxyHQ/Mercaria/issues/52),
  [#56](https://github.com/OxyHQ/Mercaria/issues/56),
  [#58](https://github.com/OxyHQ/Mercaria/issues/58),
  [#59](https://github.com/OxyHQ/Mercaria/issues/59),
  [#70](https://github.com/OxyHQ/Mercaria/issues/70),
  [#94](https://github.com/OxyHQ/Mercaria/issues/94)

## Context

Mercaria's canonical commerce graph exists and works. ADR 0002 gave it
identity, ADR-adjacent issues gave it matching (#58), curation (#59), search
(#70) and a versioned attribute registry (#94). What does **not** exist is the
layer a person actually authors against, and the layer a shopper actually
navigates. Between the two sits a set of free-text columns that quietly decide
identity.

Three facts about the code as it stands today, each verified rather than
assumed:

- `categories` (`db/schema/catalog.ts`) has `name`, `slug`, `parent_id`,
  `ancestor_slugs text[]`, `position`, `is_active`. It has **no stable machine
  key**, no lifecycle, no aliases, no redirects, no external mappings, no
  localization and no product-type eligibility. Crucially, **ancestry is stored
  as an array of SLUGS** — that is, the hierarchy is keyed on presentation. A
  slug is a localized, renameable string; using it as the ancestry key means a
  rename is a graph mutation.
- `listing_options.name` and `product_variant_option_values.name` / `.value`
  are plain `text`. Two stores selling the same shoe produce `Color`, `Colour`,
  `color ` and `Tono` as four distinct axes, and every filter built on them is
  built on display text.
- `attribute_definitions` and its seven sibling tables already carry versioned
  definitions, category scope, enum values, aliases, source mappings and — in
  `attribute_labels` — per-locale labels. **The registry is not the gap.** The
  gap is that nothing composes it into an authoring contract, and nothing else
  in the catalog is localized the way attributes already are.

So this epic is not "add a catalog". It is: give the classification tree a real
identity, give every catalog concept a localization record, add the one missing
entity (a versioned product type), replace the free-text option axes with
references into the registry that already exists, and put a single server-owned
authoring service in front of all of it so no React component ever again holds
category-specific truth.

This ADR binds every implementation PR of #367. It records the decisions so
that no individual PR has to invent them, and it states explicitly which
existing tables are retained, extended or retired.

## Decisions

### D1. Identity: a stable opaque id, a stable machine key, and nothing else

Every catalog concept — category, product type, attribute, controlled value,
unit, size system, navigation node, vehicle record — carries **two** stable
identifiers and no third:

- `id`: the opaque primary key (`generatedId()`, uuid v7), the only thing a
  foreign key ever references.
- `key`: a stable, immutable, lowercase machine key in a documented namespace
  (`electronics.phones.smartphones`, `smartphone`, `color.black`,
  `unit.gigabyte`). It exists so seeds, fixtures, external mappings and
  operator tooling can name a concept without embedding a uuid, and so a
  human-readable identity survives a database restore.

A **label, name, description or slug is presentation and is never identity**.
This is not a style preference; it is the single invariant the whole epic
exists to establish, and it is enforced three ways:

1. No foreign key in the catalog domain targets a `name` or `slug` column.
2. `key` is frozen by trigger after insert. A concept whose key was wrong is
   deprecated and superseded, never renamed — a renamed key is indistinguishable
   from a different concept to every seed, mapping and export that cited it.
3. A scanned gate (`catalog-identity-isolation.test.ts`) fails the build if a
   public DTO or a request schema in the catalog domain accepts a bare
   `category: string`, `optionName: string`, `attributeName: string` or
   `value: string` where an id or key is the correct input. The gate carries a
   vacuity floor and a mutation self-test, per the house rule.

Slugs remain, and they are **per-locale presentation records** (D4), not keys.

### D2. Taxonomy: `categories` is extended, never replaced

There will not be a second category table. `categories` is Mercaria's universal
classification tree and this epic widens it in place. A parallel
`taxonomy_categories` would mean every listing, collection rule, search filter
and connector mapping in the repository has two possible answers to "what is
this", which is the exact failure the epic is written against.

Added to `categories`:

- `key text NOT NULL UNIQUE` — the stable machine key (D1), frozen by trigger.
- `lifecycle text NOT NULL` — `draft | published | deprecated | merged |
  suppressed`, CHECK-constrained from a shared-types tuple. `is_active` becomes
  a **derived read**, retained as a v1 contract column (D13) and never a second
  authority.
- `selectable boolean NOT NULL DEFAULT true` — a structural node (a root, a
  grouping level) is not a valid product assignment. Assigning a product to a
  non-selectable node is refused at the write chokepoint AND by a CHECK on the
  assignment.
- `ancestor_ids text[] NOT NULL` — the ancestry, keyed on **ids**, with a GIN
  index. This supersedes `ancestor_slugs`.
- `merged_into_category_id` — set exactly when `lifecycle = 'merged'`
  (a biconditional CHECK), `restrict` on delete.
- `effective_from` / `effective_to` — nullable; a taxonomy change that needs a
  dated cutover states it here rather than in a job's memory.

New tables, each owned by the taxonomy module:

- `category_aliases` — internal and search-time alternate names, per locale,
  **separate from public names**. An alias is never rendered as the category's
  name.
- `category_redirects` — old id or old localized slug → current category, so a
  deprecated or merged node's URLs keep resolving. Append-only.
- `category_external_mappings` — `(source_id, external_key) → category_id`,
  versioned, with confidence, review state and validity dates (D11 of the
  ingestion framework's posture: unmapped goes to review, never to a guess).

**Which product types may be used under which category is
`product_type_category_scopes`, and it is owned by the PRODUCT-TYPE domain**
(D5), not by the taxonomy module. An earlier draft of this decision named it
`category_product_type_scopes` and listed it above; that was one table with two
names and two owners, and the ambiguity is corrected here rather than left for
whoever implements second. The ownership is not a coin toss: a product type
version is immutable once published, and its category eligibility is part of what
that version MEANS. Owned by taxonomy, the scope rows would sit outside the
version's freeze, so publishing a version could not freeze its own eligibility —
and the hole would be exactly where somebody later widens a published version's
scope, which is the one edit the immutability guarantee exists to refuse.

**Hierarchy strategy: materialized path of ids** (`ancestor_ids text[]` + GIN),
not a closure table and not a bare recursive CTE. Reasoning: the shape is
already in the schema and already indexed, the tree is shallow (single-digit
depth) and small (thousands of nodes, not millions), every hot read is
"descendants of X" or "breadcrumb of X" — both single-statement on a GIN'd
array — and a closure table is a second representation of one fact, which this
ADR spends most of its length avoiding. A move rewrites the subtree's arrays in
one statement inside the move's transaction.

**The benchmark has been RUN and it CONFIRMS this choice, so the provisionality
is retired** (#367 W16). `services/catalog-observability/ancestry-benchmark.ts`
seeds its own tree of 5,010 categories over six levels plus 5,760 canonical
products and measures each shape both ways — materialized path against an
equivalent `WITH RECURSIVE` over `parent_id` — with plan facts from one
instrumented run and percentiles from N uninstrumented ones. Over seven runs:

- **Deep descendants from a root, and descendants from a mid-depth node, are won
  by the materialized path on every run, by 1.56x to 6.59x.** These carry the
  decision.
- **The breadcrumb is a TIE on every run**, with the recursive CTE the marginally
  faster side (0.115-0.226 ms) held inside the tie band. The cause is a property
  of the REPOSITORY rather than of the strategy: `findCategoryAncestors` answers
  in two round trips where the CTE takes one. A single statement joining the row
  to its own `ancestor_ids` removes it, and this is the shape most likely to
  worsen where the database is a network hop away rather than a socket away.
- **The category-scoped read is CONDITIONAL on the planner choosing
  `categories_ancestor_ids_idx`**, and at this size that choice is not stable:
  with the index it scans 6,261 rows and the materialized path wins by 2.32x;
  without it, 10,771 rows, and the result is a tie or a marginal 1.18x CTE win.
  Two of the seven runs therefore came out against the materialized path on that
  shape alone.
- **The index does real work, and SELECTIVITY decides whether it is used.** A
  mid-depth subtree returning 30 of 5,010 rows (0.6%) gets a Bitmap Index Scan
  and scans 30 rather than 5,010; a root subtree returning 500 of 5,010 (10%)
  gets a sequential scan, correctly, because an index is the wrong tool for a
  tenth of a small table. So "the shape is already in the schema and already
  indexed" is right about both halves.

No index was added and none is needed. **There is no crossover row count**, and
no measurement here supports one: the harness reports which plan it got and
asserts nothing about it, because a gate on a planner preference fails on a
healthy change. What IS gated, deterministically, is that the index CAN serve
`ancestor_ids @> array[$1]` when the sequential scan is taken away, and that
dropping the index turns that assertion red naming it.

**A note on method, because it cost three attempts.** Two earlier readings of
this same measurement reached opposite confident conclusions — first that the
planner never chooses the index at this scale and that a crossover sits between
20,000 and 30,000 categories, then that it is simply chosen and the question is
settled. Both were single-condition readings of a cost-model decision, the first
taken before `ANALYZE` had settled statistics on a freshly seeded tree. **Both
were written with plan costs attached, which is what made them credible.**
Numbers are a format, not evidence. Anything re-opening this question should run
the harness repeatedly, on settled statistics, and treat a single run's verdict
as a sample.

Cycles, self-parenting and merging into a descendant are refused by a trigger,
because a CHECK cannot read another row.

### D3. Navigation and merchandising are not taxonomy

`collections`, `collection_rules` and `listing_collections`
(`db/schema/merchandising.ts`) stay exactly as they are and remain
merchandising. They are **not** given category semantics and a collection
membership never becomes a product fact.

New, in a separate module: `navigation_trees` and `navigation_nodes`. A
navigation tree is scoped to `(market, locale)`; a node targets **one** of a
category, a saved query, a product type, a brand, a family, a collection or an
external campaign destination — a discriminated target with a CHECK making the
non-selected pointers NULL, so "a node that means two things" has no row shape.
Nodes carry publication state and scheduling.

The storefront's hard-coded category constants and pills are replaced by reads
of this configuration. Nothing in navigation may write to `categories`.

### D4. Localization is a per-entity table, never one polymorphic table

Every localized string in the catalog lives in a table dedicated to its entity:
`category_localizations`, `product_type_localizations`,
`attribute_value_localizations`, `navigation_node_localizations`, and so on.
`attribute_labels` (#94) is the precedent and is **adopted, not duplicated** —
it becomes the attribute-definition member of this family and gains the columns
below.

A single polymorphic `(entity_type, entity_id, locale, field, value)` table was
rejected: `entity_id` could carry no foreign key, so every orphan would be
invisible, and every read would need a discriminator the planner cannot use.
Per-entity tables cost one migration each and buy referential integrity, real
indexes and a `cascade` that actually works.

Each localization row carries:

- `locale text NOT NULL` — a **BCP 47** tag, validated against a shared-types
  tuple of supported locales.
- the localized fields for that entity (name, description, help text,
  placeholder, example, accessibility label — whichever apply).
- `status text NOT NULL` — `missing | machine_translated | reviewed | approved |
  stale | deprecated`.
- `provenance text NOT NULL` — `mercaria | official_brand | professional |
  community_reviewed | machine | imported_source`.
- `source_locale`, `source_revision`, `reviewed_by`, `reviewed_at`.
- `UNIQUE(entity_id, locale)`.

Two rules are enforced by trigger rather than by service discipline:

- **Machine translation may never overwrite `reviewed` or `approved` content.**
  The trigger refuses an UPDATE whose incoming `provenance = 'machine'` lands
  on a row already at those statuses. A service-level check would be one
  forgotten call site away from silently degrading a human's work.
- **A source-semantics change marks dependents `stale`**, it does not blank
  them. A stale translation is still the best text available and withdrawing it
  would show raw keys to shoppers.

**Localized slugs are their own table** (`category_localized_slugs`, and the
equivalent where needed): `(locale, slug)` unique, pointing at the entity id,
with the previous slug retained in `category_redirects`. A slug change is
therefore a new row plus a redirect, never an UPDATE that breaks a link
somebody shared.

**Fallback is deterministic and stated once**: exact locale → the configured
language fallback for that locale (`es-MX` → `es`) → Mercaria's base locale.
The resolver returns the **effective locale and the translation status**
alongside the string, so internal clients can debug a fallback and public
clients never render a raw key. Legal text and seller-authored text are
**excluded from cross-market fallback** — a market's legal copy is not a
default for another market's, and there is no policy under which it may be.

`language`, `locale`, `market`, `currency`, `measurement_system`, `size_system`
and `time_zone` are seven independent request-context dimensions. They are
carried as seven fields and never collapsed into one. Canonical numeric and
unit storage is independent of formatting; formatting is `Intl`/CLDR at the
boundary.

### D5. Product types are versioned schemas, and they are the one new entity

`product_type_definitions` is added, with the exact mechanism
`fee_schedules` and `attribute_definitions` already use in this repository:

- `(key, version)` unique; `lifecycle` is `draft | review | published |
  deprecated`; **a published version is immutable, enforced by trigger**; at
  most one `published` version per key is *current*, held by a partial unique
  index.
- `product_type_category_scopes` — the eligibility mapping (D2), relational.
- `product_type_field_groups` — ordered authoring/display groups.
- `product_type_fields` — each row **references an
  `attribute_definitions` row and its exact version**. It does not restate the
  attribute's type, unit family or validation; duplicating those is how two
  descriptions of one fact come to disagree.

A field carries: `scope` (`identity | product | variant | compatibility`),
`requirement` per flow (`required | recommended | optional | hidden |
forbidden`), `flow` (`merchant | p2p | operator | connector |
verified_brand`), order, group, value policy (`controlled_value |
canonical_reference | typed_scalar | typed_structured | proposal_enabled`) and
an optional conditional-visibility rule.

**Conditional rules are data in a closed, non-Turing-complete form** — a small
declarative predicate AST (`field`, `op`, `value`, `all`/`any`/`not`) stored as
bounded JSONB and evaluated by an interpreter with no function calls, no
regexes supplied by the row and a hard node-count bound. `regex_replace`-style
open-ended transforms are unrepresentable, for the reason #63 gives: a
source-supplied pattern is a small language and a DoS primitive. The
interpreter is fuzz-tested.

**Listing, offer and inventory fields are composed into the authoring schema,
never modelled as product-type attributes.** Price, stock, availability,
condition and fulfilment stay in their own domains (a scanned gate), and the
schema references them as separate steps.

Canonical products, drafts and every authoring write **pin the exact product
type version and the exact attribute definition versions** they were made
under. A newer version never silently reinterprets an older record; a migration
is offered as a preview and applied deliberately.

### D6. Variant axes reference the registry; free text becomes a retained claim

An axis is an **attribute**, cited by `attribute_definition_id` plus its
version, not a string. `product_type_fields.variant_capable` says an attribute
*may* define variants for that type; the **product's own declared axis list is
authoritative for that product**.

- Variant signatures are deterministic and order-independent: the normalized
  set of `(attribute_definition_id, normalized_value)` pairs, hashed. Two
  variants whose axes were entered in different orders collide, by construction.
- Zero, one and many axes are all supported, and matrices are **sparse** —
  nothing generates the full Cartesian product as rows.
- Compatibility targets, seller condition, price and inventory are **refused as
  axes**, by a CHECK on the axis's attribute scope.

`listing_options.name` and `product_variant_option_values.name` / `.value` are
not deleted. They become **legacy claims**: preserved verbatim with their
provenance, and superseded by the typed axis rows for any listing migrated to a
product type. A deterministic mapping backfills the ones that resolve
unambiguously through `attribute_value_aliases`; anything ambiguous **stays
text and stays unresolved**, visible in a review queue. Inventing a
normalization for `Tono` because it looks like `Color` is exactly the false
merge #58 is shaped around.

### D7. A seller's claim and a canonical fact are different rows

`native_listing_attribute_claims` and `native_variant_attribute_claims` are
added. A merchant or a connector asserts a value there, with its source,
its raw value and its provenance. `canonical_attribute_values` (already
present) remains the **selected** fact. A claim never becomes a canonical fact
without passing through the existing selection and provenance machinery, and a
canonical fact never overwrites the claim that disagreed with it — both are
retained, which is what makes a correction auditable.

### D8. Compatibility and fitment are a relationship domain, not variants

`generic_compatibility_relations` links a product/variant to compatible
families, products, variants or typed targets, carrying type, direction,
market, conditions, validity dates, evidence and verification state, with
reverse lookup.

Automotive gets normalized records — `vehicle_makes`, `vehicle_models`,
`vehicle_generations`, `vehicle_configurations` — plus `automotive_fitments`
with position, qualifiers, exclusions, source evidence and confidence.

**A year range, a make or a model may never be stored as a variant option.**
One brake-pad SKU fits many vehicles and remains one variant; this is the
epic's own acceptance scenario and it is held by the axis CHECK in D6 plus a
scanned gate forbidding the compatibility domain from writing option rows.

### D9. A missing concept is a proposal, and a proposal is never auto-promoted

`catalog_proposals` covers a missing category, product type, brand, family,
product, variant, attribute or controlled value. Proposals carry the proposed
label **in its source locale plus normalized and search forms**, duplicate
detection before submission, rate limits and permission checks.

**A merchant proposal never becomes globally trusted data by being submitted.**
Operator actions are approve, reject, request information, merge into existing,
redirect and defer, recorded in `catalog_review_events` (append-only). On
approval the canonical entity is created or linked and affected drafts and
listings are backfilled **idempotently**.

Where the product type's policy permits it, a product may publish carrying a
local claim (D7) while its proposal is pending. Where it does not, publication
waits. Which of the two applies is a property of the product type version, so
it is versioned and reviewable rather than a per-request decision.

### D10. One server-owned authoring service; the dashboard composes nothing

`services/catalog-authoring/` is the single owner. It composes:

```
category + product type (exact version) + attribute definitions (exact versions)
        + controlled value policies + store/seller permissions
        + flow + locale + market
        = AuthoringSchema
```

`AuthoringSchema` is a versioned DTO in `@mercaria/shared-types`. It carries
stable field ids and keys, scope, type, requirement, validation, grouping,
order and value policy — and, **separately**, the localized labels, help,
placeholders and examples. The separation is the point: a client that read a
label as a rule would have no way to localize without changing behaviour.

Every response carries the effective locale, fallback metadata, market, schema
version and a **deterministic hash used as the ETag**. Caches are keyed by every
semantic dimension (product type version, category, flow, policy, locale,
market) and invalidated through **transactional outbox events**, not
process-local assumptions — Mercaria runs several ECS tasks and a process-local
cache is one task's opinion.

Routes (finalized here, per the epic's request):

```
GET    /catalog-authoring/categories
GET    /catalog-authoring/product-types?categoryId=
GET    /catalog-authoring/schemas/:productTypeKey?version=
GET    /catalog-authoring/canonical-search
POST   /stores/:storeId/product-drafts
GET    /stores/:storeId/product-drafts/:draftId
PATCH  /stores/:storeId/product-drafts/:draftId
POST   /stores/:storeId/product-drafts/:draftId/validate
POST   /stores/:storeId/product-drafts/:draftId/publish
POST   /catalog-proposals
```

Store routes sit behind the existing store-permission middleware. Publication
is **one transaction**: listing + native variants + claims + inventory + offer
state + explicit canonical links + the outbox rows. A failed sub-write rolls
the whole publish back. Publish is **idempotent** on an idempotency key.

**A directly selected canonical entity is linked directly and never re-matched.**
The link method is `merchant_declared`, a new member distinct from P2P
`seller_declared` and from `matcher`. Automated matching runs only for entities
the author did *not* resolve — running it anyway is how an explicit human
answer gets overruled by a confidence score.

Validation returns **stable machine codes and field paths**; the message is
localized at the boundary. A client never matches on message text.

`catalog_authoring_drafts` pin category, product type version, attribute
definition versions, locale and market. Draft values are stored **typed**; an
immutable schema snapshot may be retained beside them for audit and recovery,
which is the one sanctioned JSONB use here (a bounded, immutable snapshot —
D14). A newer schema version produces an **upgrade preview**, never a silent
rewrite.

### D11. The migration protocol for parallel implementation

This epic is implemented by several agents at once, and drizzle-kit's journal
is a single shared file. The measured failure (recorded in `~/Oxy/AGENTS.md`)
is that two branches generate against the same snapshot, one is renamed by
hand, and the damage appears in whoever generates next.

The protocol, binding on every #367 PR:

1. **One migration slot at a time.** A branch that needs a migration rebases on
   the current `origin/main` immediately before running `db:generate`, and its
   PR merges before the next branch generates. Branches with no migration
   proceed freely in parallel.
2. **`bun run build:shared-types` before every `db:generate`.** Every
   closed-value-set CHECK is rendered from the *built* `@mercaria/shared-types`;
   a stale `dist/` silently emits `DROP CONSTRAINT … ADD CONSTRAINT` pairs that
   narrow a sibling's tuple back. This has already cost this repository once.
3. **Never hand-rename a migration, hand-edit `meta/_journal.json` or
   hand-write a snapshot.** On a conflict: delete your `.sql` and your
   `meta/<idx>_snapshot.json`, restore `_journal.json` to main's version,
   rebuild shared-types, re-run `db:generate`, then re-apply every hand-written
   statement (triggers, functions, backfills) — regeneration drops them — and
   read the regenerated file for statements you did not intend.
4. **Exactly one `-- oxy:deploy-phase=` marker per file.** Additive work is
   `pre`; drops, renames and narrowings are `post`, and every `post` statement
   must break a write the previous image performs.
5. **Assert the journal's index set equals the set of `meta/*_snapshot.json`
   files before pushing.** A rebase can stage the deletion of an upstream
   snapshot, which breaks the *next* generator rather than you.
6. `SCHEMA_TABLE_COUNT` is counted empirically from the barrel's `PgTable`
   exports on the rebased branch. Arithmetic over PR descriptions misses tables
   that moved between files.

### D12. Rollout: flags per dimension, and no flag gates a durable record

Six levers, and the split follows the house rule that a lever gates a **loop or
a mount**, never a stored row:

- `CATALOG_TAXONOMY_V2_ENABLED` — the extended taxonomy **reads**. Default
  false; with it off, `categories` answers exactly as today.
- `CATALOG_LOCALIZATION_ENABLED` — localized reads. Default false ⇒ base locale,
  which is today's behaviour.
- `PRODUCT_TYPES_ENABLED` — product-type resolution and the authoring schema
  route. Default false.
- `CATALOG_AUTHORING_ENABLED` — the authoring **mount** (drafts, validate,
  publish). Default false. The legacy product-creation route is untouched while
  it is off.
- `CATALOG_PROPOSALS_ENABLED` — the proposal mount. Default false.
- `CATALOG_AUTHORING_COHORTS` — the rollout cohort expression
  (`market:locale:store:category:product_type`), empty meaning nobody.

Rollout order is internal users → selected stores → selected product types and
categories → locales and markets → general availability, with the error,
abandonment, matching, indexing and conversion metrics of Workstream 17 as the
gate at each step.

**Nothing in a rollback deletes catalog evidence.** Turning every lever off
restores listing-first behaviour and leaves every row readable, because the
evidence has to be readable during the incident that turned the levers off.

### D13. Retained, extended, retired

| Existing | Disposition |
| --- | --- |
| `categories` | **Extended** in place (D2). `ancestor_slugs` retained as a v1 read contract; superseded by `ancestor_ids`, retired in a later `post` migration once no reader remains. `is_active` becomes derived from `lifecycle` and is retained as a v1 column. |
| `listings`, `product_variants` | Retained. Gain nullable `category_id` semantics under the new lifecycle rules, `product_type_definition_id` + version, and the pinned definition versions. |
| `listing_options`, `product_variant_option_values` | **Retained as legacy claims** (D6). Not dropped, not silently normalized. |
| `attribute_definitions` + 7 siblings | **Retained and extended** — the one authoritative registry. `attribute_labels` becomes the attribute member of the localization family (D4). |
| `canonical_*` (17 tables) | Retained unchanged. This epic adds localization records beside them and never re-models them. |
| `collections`, `collection_rules`, `listing_collections` | Retained as merchandising only (D3). |
| Storefront category constants and filter lists | **Retired**, replaced by navigation configuration and facet metadata. Removal lands only after parity. |

Historical order, payment and refund snapshots are **never rewritten**. This is
restated here because a catalog migration is exactly the change that would be
tempted to.

### D14. JSONB is bounded and named

JSONB is permitted for three things and nothing else: a **source-shaped
payload** kept for provenance, an **immutable schema snapshot** retained for
audit and recovery, and a **bounded declarative rule AST** (D5). Every
queryable identity, classification, localization, attribute, relationship and
compatibility fact is a real column with real constraints. A scanned gate
enumerates the permitted JSONB columns exactly, so a new one fails the build
until it is justified here.

## Merge order

The dependency graph, and therefore the merge order. Items on the same line are
independent of each other; only the migration slot (D11) serializes them.

```
0. ADR (this document)
1. Taxonomy identity + lifecycle + redirects + aliases        (D1, D2)
2. Localization family + fallback resolver                    (D4)      ← needs 1
3. Product type definitions + fields + scopes                 (D5)      ← needs 1, 2
4. Typed variant axes + legacy claims + backfill              (D6, D7)  ← needs 3
5. Authoring service + drafts + AuthoringSchema DTO           (D10)     ← needs 3
6. Proposals + operator review                                (D9)      ← needs 5
7. Navigation trees + merchandising separation                (D3)      ← needs 1, 2
8. Compatibility + automotive fitment                         (D8)      ← needs 3
9. Search, facets and same-variant/same-offer semantics                 ← needs 4, 7
10. Dashboard authoring wizard                                          ← needs 5, 6
11. External taxonomy/attribute/value mappings                          ← needs 1, 3
12. Reference verticals: footwear, smartphone, brake pad                ← needs all
```

## Consequences

- The catalog gains four new domain modules (taxonomy, localization, product
  types, authoring) and roughly thirty tables. That is a large surface, and the
  alternative — extending the existing free-text columns — is what produced the
  problem this ADR exists to solve.
- Every authoring write becomes version-pinned, so a schema change can no
  longer reinterpret history. The cost is a migration path for drafts and a
  preview UI; the benefit is that "why does this product say that" has an
  answer.
- The dashboard loses all category-specific knowledge. Adding a product type
  becomes a data change, not a frontend release.
- The legacy free-text option path survives the whole rollout and is removed
  only in a separate, verified cleanup migration.
- Ambiguous legacy values are **not** resolved. They stay text, in a queue,
  visible. This is deliberate and it means the migration's output includes a
  backlog rather than a clean number.

## Non-goals

- Replacing or re-modelling the canonical commerce graph (ADR 0002).
- Building a second attribute registry beside #94's.
- Any ranking or merchandising use of catalog data — ranking is #74's, behind
  its versioned policy, and a scanned gate keeps this domain out of it.
- A general-purpose CMS. Navigation nodes target catalog concepts and campaign
  destinations; they are not a page builder.
- Machine translation as an approved source. It is a suggestion behind review,
  and D4's trigger stops it overwriting human work.

## Open items (tracked, not blocking)

- ~~The taxonomy hierarchy benchmark (D2).~~ **CLOSED** (#367 W16): the benchmark
  ran and confirms the materialized path. D2 records the numbers, the one shape
  whose result is conditional, and the breadcrumb's two-round-trip cause. The
  remaining piece of work it identified is a repository fix rather than an
  architectural one — `findCategoryAncestors` costing a round trip it does not
  need — and it is not blocking.
- Community translation contribution and its moderation rules, if enabled.
- Whether bundles, services and digital goods get their own product-type
  scopes or are excluded at launch — decided in the product-type PR, recorded
  here when it is.
