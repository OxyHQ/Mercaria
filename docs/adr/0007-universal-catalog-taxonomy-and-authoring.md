# ADR 0007: The universal, multilingual catalog — taxonomy, localization, versioned product types and typed authoring

- **Status:** Accepted, **amended 2026-08-18**, **re-amended 2026-08-21** (see
  *Corrections* below, and *Re-amendment* under it)
- **Date:** 2026-08-16
- **Issue:** epic [#367](https://github.com/OxyHQ/Mercaria/issues/367)
- **Builds on:** ADR 0002 (canonical commerce graph), and the shipped work of
  [#52](https://github.com/OxyHQ/Mercaria/issues/52),
  [#56](https://github.com/OxyHQ/Mercaria/issues/56),
  [#58](https://github.com/OxyHQ/Mercaria/issues/58),
  [#59](https://github.com/OxyHQ/Mercaria/issues/59),
  [#70](https://github.com/OxyHQ/Mercaria/issues/70),
  [#94](https://github.com/OxyHQ/Mercaria/issues/94)

## Corrections (2026-08-18)

Thirteen claims in this document were audited against the merged implementation
and did not survive. Each is corrected **in place**, beside the text it replaces,
in a blockquote that says what the old version claimed — because an amendment
reaches the next reader and never reaches the previous one, and a body that
simply reads correctly now teaches nobody that it moved.

Two kinds, and the difference is what a reader planning work needs:

**ASPIRATIONAL — decisions this epic still intends and has not delivered.**
Correcting the prose does not close them; each needs a code change.

| Where | The gap |
|---|---|
| **D5** (and D10's echo) | **CLOSED 2026-08-18 — this is no longer a gap.** The row read: *"'Every authoring write pins the exact product type version' is true of DRAFTS and false of the PUBLISHED write. `listings` has no `product_type_definition_id`; the only citation is nullable and written only when axes exist. `publish.service.ts:634` records it as owed."* [#614](https://github.com/OxyHQ/Mercaria/pull/614) landed migration `0109` **ten and a half hours after this row was written**. See the superseding note under D5. |
| **D4** | `attribute_labels` did not gain the localization family's columns. So the machine-translation trigger cannot protect attribute labels, and every one is served with a fabricated `effectiveLocale` and `status`. Needs a migration. |

**MISTAKEN — the mechanism, the count or the file named was simply wrong.** The
behaviour was always whatever the code did; only this document was incorrect.

| Where | Was | Is |
|---|---|---|
| **D2** | "a CHECK on the assignment" | a TRIGGER — a CHECK cannot read the `categories` row |
| **D5** | "enforced by trigger" (one) | two functions across four triggers; the children are the schema |
| **D6** | "a CHECK on the axis's attribute scope" | one CHECK on the KEY (33, derived) plus two trigger clauses, one of them conditional |
| **D8** | "the axis CHECK in D6" | three refusals, and this gate's reach is the LEGACY option pair |
| **D12** | levers "read in exactly one place" | **six** non-test reads; the substantive claim survives |
| **D12** | the localization reader has "two consumers" | **one**; authoring uses the pure resolver, and says why in place |
| **D12** | "the **nine** `/internal/*` catalog surfaces" | **26**, counted twice by independent parsers |
| **D13** | `listings` gains `product_type_definition_id` + version | ~~it gains neither~~ — **this correction was itself overtaken, and the ORIGINAL decision was right.** `listings` gained both on 2026-08-18 ([#614](https://github.com/OxyHQ/Mercaria/pull/614), migration `0109`). See D13 and the superseding note under D5. |

**STALE — true when written, closed since, and left standing.** D12's "for three
of the four levers it is a convention rather than a property" was overtaken by
#552, which gave all four a scanned wall. A document describing a gap its own
epic closed is the shape that reads as pending forever.

**BECAME TRUE — recorded so a reader who checked in the interval knows they read
the code correctly.** D1's item 3 named a scanned gate that did not exist for
thirteen merged layers, and D7's "a claim never becomes a canonical fact without
passing through the selection machinery" was a convention with nothing behind it.
Both are gates as of #566.

### Re-amendment (2026-08-21) — [#823](https://github.com/OxyHQ/Mercaria/issues/823)

**Four statements in this document said `listings` has no
`product_type_definition_id`. It has one, live, and has had since the same day
those statements were written.** Migration `0109_nostalgic_vengeance.sql`
([#614](https://github.com/OxyHQ/Mercaria/pull/614), merged **2026-08-18 11:59
+0300**) added the column, an `ON DELETE restrict` foreign key, a partial index
and a trigger — **10 h 34 min after** the audit above was merged at **01:25
+0300**. The four are annotated in place: the D5 row and the D13 row in the tables
above, D13's disposition table, and the measurement under D5.

**The measurement under D5 is the one worth reading**, and it is different in kind
from the other three. Those were decisions overtaken by work; that one was
*verified* and true when taken, which is precisely why nobody re-checked it. It is
retained in full with a dated superseding note rather than deleted, because a
deleted paragraph loses the reasoning that produced the migration, and a stale
paragraph standing beside a merged counter-example is worse than an absent one.
**The general rule this cost us: a measurement published without the commit or
date it was taken at cannot expire visibly.** Every figure added in this
re-amendment carries one.

**And the instrument it used could not have found the column even after it
landed** — it grepped a schema file for a snake_case name that drizzle, which
declares in camelCase, never writes for a declaration. That is set out with its
control under D5, and it is the more useful half: a stale measurement is a fact
about time, while a measurement that returns the same answer whether or not its
subject exists was never a measurement at all.

Scope: only claims about that one column were touched. Nothing else in this
document was re-audited on 2026-08-21, so an unannotated statement here still
carries its 2026-08-18 date and no more.

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
3. A scanned gate (`db/__tests__/catalog-identity-isolation.test.ts`) fails the
   build if a foreign key targets a presentation column, and if a **new** bare
   `category: string` / `productType: string` / `optionName: string` /
   `attributeName: string` appears in a catalog request schema. The gate carries
   per-shape vacuity floors and a mutation self-test per clause, per the house
   rule.

   > **This gate did not exist until #566, and for thirteen merged layers this
   > numbered item described nothing.** It is called out because a reader who
   > checked the earlier state and found no such file was right, and should be
   > able to tell that it changed rather than that they misread. Two details
   > differ from what this item originally promised. It cannot assert **zero**
   > bare identity strings — seven exist, all in pre-#367 v1 listing contracts a
   > shipped mobile build cannot be recalled from — so they are frozen as an
   > exact set and an eighth fails the build. And `value: string` is deliberately
   > **not** detected: a claim's raw value genuinely is a string (D7), so a
   > detector for it would flag the rows this ADR exists to preserve.

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
  non-selectable node is refused at the write chokepoint AND by a **trigger**,
  `mercaria_category_assignment_selectable`
  (`drizzle/0088_redundant_korvac.sql:442`, mounted on `listings` at `:461` and
  on `canonical_products` at `:465`).

  > **CORRECTED — mistaken, not aspirational.** This said "by a CHECK on the
  > assignment". It cannot be a CHECK and never was: selectability lives on the
  > `categories` row and a CHECK cannot read another row, which is the same
  > reason this decision gives for cycles and self-parenting two paragraphs
  > below. The schema's own comment at `db/schema/catalog.ts:160` named the
  > trigger correctly all along, so this line was the only artefact saying
  > otherwise. Nothing about the enforcement changed; what was wrong was the
  > mechanism named, and it matters because "add a CHECK" is what somebody would
  > have reached for on finding the constraint missing.
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
it becomes the attribute-definition member of this family.

> **CORRECTED — this was ASPIRATIONAL and was not delivered, and the consequence
> is live.** The original said `attribute_labels` "gains the columns below". It
> did not. The table is `id`, `attribute_definition_id`, `locale`, `label`,
> `description` and timestamps (`db/schema/attributeRegistry.ts:265`): **no
> `status`, no `provenance`, no `source_locale`, no `source_revision`, no
> `reviewed_by`, no `reviewed_at`.**
>
> **The consequence that matters is the trigger.** The machine-translation guard
> below is mounted on `category_localizations`, `product_type_localizations` and
> `attribute_value_localizations` (`drizzle/0091_slimy_the_fury.sql:143`, `:146`,
> `:149`) and **not** on `attribute_labels`, which appears nowhere in that
> migration — there is no `provenance` column for it to read. So a machine
> translation CAN overwrite a reviewed attribute label, which is the one thing
> D4 says a trigger rather than service discipline must prevent.
>
> The second consequence is smaller than it first looks, and the composer
> deserves the credit: because there is no `status` or `provenance` column, a
> localized attribute label cannot report its real translation status, so
> `services/catalog-authoring/schema.service.ts:625-631` reports `step: 'base'`
> and `status: 'approved'` — in its own words "the honest reading of a table that
> records neither" — and **counts it as unresolved in the coverage figure so an
> operator sees the gap rather than a confident 100%.** An earlier draft of this
> correction called that "fabricated", which was unfair: the value is a stated
> convention with a compensating counter, not an invention. What a client cannot
> do is tell a reviewed attribute label from a base one.
>
> **This ADR was the only artefact carrying the false claim.**
> `shared-types/src/catalog-localization.ts:440` records the table as a formal
> `LOCALIZATION_FAMILY_COLUMN_EXEMPTIONS` entry and
> `docs/catalog-localization.md:43` states the truth — so the code and the domain
> doc agreed with each other and disagreed with this decision, which is the worst
> direction for the disagreement to run. **Closing it needs a migration and is
> not a documentation change**; it is recorded here as outstanding rather than
> quietly reworded.

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
  community_reviewed | machine | imported_source | seller`.

> **AMENDED — 2026-08-21 (#814): `seller` joins the provenance vocabulary.**
>
> The six above were COMPLETE for the surfaces D4 covered. Every one of them is
> Mercaria's own catalogue copy — a category name, a product-type label, an
> attribute value — translated by Mercaria, by a brand under a #55 verified
> relationship, by a hired professional, by a reviewed community contributor, by
> a machine, or carried in from a feed. A seller never wrote any of them, so no
> member needed to say that one had.
>
> #809 introduced a PRODUCER none of the six describes. `listing_localizations`
> is a NATIVE LISTING's own words in one locale, and #814 gave it the write path
> it shipped without — a seller translating their own listing, through
> `/seller/listings/:id/localizations` or
> `/admin/stores/:storeId/products/:id/localizations`. Every existing member is a
> false statement about that row: `mercaria` is a false authorship claim (this
> repository refutes it three times over, including in `BASE_LOCALE_PROVENANCE`'s
> own note), `imported_source` means a feed, `professional` claims a hired
> translator, `official_brand` requires a verified relationship,
> `community_reviewed` claims a review nobody performed, and `machine` would arm
> the guard trigger against the person who wrote the text. The column is
> `NOT NULL`, so carrying none was not available.
>
> **It is `seller` and NOT `seller_authored`.** That string is already
> `LOCALIZED_FIELD_CLASSES`' third member — a FIELD's kind, which is what decides
> its fallback chain — and it sits one column away on the same row. Reusing the
> spelling would put one word in two vocabularies meaning two different things on
> a single row, which reads as agreement and is not: a Mercaria operator
> translating a seller's title writes `seller_authored` text under a `mercaria`
> provenance, and both statements are true at once.
>
> **`seller` and not `store`**, though the write path has a store-side door. The
> actor vocabulary this repository already uses for "a person editing a listing
> they own" is `ConditionActor`
> (`services/condition/condition-write.service.ts`), whose kinds are
> `seller | operator | source | migration` with no `store` member — and the
> store-side listing edit passes `{kind: 'seller'}` exactly as the P2P one does
> (`controllers/admin/products-admin.controller.ts` and
> `controllers/seller-listings.controller.ts`, both reaching
> `catalog-write.service.updateListing`). One word for one actor, measured rather
> than assumed.
>
> Migration `0132` (`pre`) widens the CHECK on ELEVEN tables, not the ten that
> render it from `LOCALIZATION_PROVENANCES`. The eleventh is
> `navigation_node_localizations`, which renders from D3's separate
> `NAVIGATION_LOCALIZATION_PROVENANCES` — a second copy of this same vocabulary
> that `catalog-localization.test.ts` holds EQUAL to the first, precisely so the
> two cannot drift. Nobody writes `seller` to a navigation node; per-table
> meaningfulness has never been this tuple's membership rule (`imported_source`
> is equally unreachable there), and a CHECK states what a column MAY hold. The
> swap D3's own tuples describe — deleting them and importing these — remains the
> real fix and remains unclaimed.
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
  deprecated`; **a published version is immutable, enforced by two trigger
  functions across four triggers**; at most one `published` version per key is
  *current*, held by a partial unique index
  (`product_type_definitions_one_published_per_key`).

  > **CORRECTED — mistaken, and understated rather than overstated.** This said
  > "enforced by trigger", singular, which reads as one mechanism somebody could
  > find and reason about. There are two functions and four triggers, and the
  > split is the whole point: `mercaria_product_type_definition_immutable`
  > (`drizzle/0089_kind_blink.sql:155`) mounted as
  > `product_type_definitions_immutable_once_published` (`:193`) freezes the
  > PARENT's `key`, `version`, `pending_proposal_policy` and audit column —
  > leaving `name`, `description` and `lifecycle` editable by design — while
  > `mercaria_product_type_child_frozen` (`:211`) is mounted three times, as
  > `product_type_field_groups_frozen` (`:235`),
  > `product_type_category_scopes_frozen` (`:239`) and
  > `product_type_fields_frozen` (`:243`). **The children are the schema**, so a
  > reader who checked only the parent trigger would conclude the fields were
  > editable after publication. A fifth trigger,
  > `product_type_fields_citation` (`:316`), is a different rule: it holds the
  > field's citation of its attribute version.
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

Drafts **pin the exact product type version and the exact attribute definition
versions** they were made under. A newer version never silently reinterprets an
older record; a migration is offered as a preview and applied deliberately.

> **CORRECTED — the DRAFT half shipped and the PUBLISHED half did not. This is
> ASPIRATIONAL: a decision the epic still intends and has not delivered, not a
> mistake about a mechanism.** The original sentence read "Canonical products,
> drafts and every authoring write pin…", and only the middle term is true.
>
> Drafts are solid. `catalog_authoring_drafts` carries `category_id`,
> `product_type_definition_id`, `locale` and `market`, all NOT NULL, and
> `mercaria_catalog_authoring_value_citation`
> (`drizzle/0098_young_lorna_dane.sql:231`, trigger `:274`) refuses a value whose
> `(attribute_key, version)` disagrees with the definition it cites. A product
> type definition id **is** a version pin, because `(key, version)` is unique and
> each version is its own row.
>
> **The published write has no product-type pin.** `listings` carries no
> `product_type_definition_id` column at all — verified, zero occurrences in
> `db/schema/catalog.ts` — and the only carrier is
> `native_listing_variant_axes.product_type_definition_id`
> (`db/schema/variantAxes.ts:159`), which is **nullable** and written only inside
> `if (axesByFieldId.size > 0)` (`services/catalog-authoring/publish.service.ts:624`,
> the value at `:639`). So a published listing that declares no variant axes
> carries no product-type version anywhere, and nothing asserts otherwise.
>
> `publish.service.ts:634-638` records it in place — "`listings` carries no such
> column **yet** — step 4's doc names that as this workstream's to add" — and
> `docs/variant-axes.md:326` states the owed change. **So the code beside this
> decision recorded the gap while this decision asserted it closed**, which is the
> worst of the three ways prose goes wrong: a stale fact is discovered, and an
> assertion that something already holds stops anybody looking. Closing it needs a
> migration adding the column plus a trigger clause comparing the axis citation
> against the listing's own — **a code change, not a documentation one** — and it
> is outstanding.
>
> ---
>
> **SUPERSEDED 2026-08-21. The gap above is CLOSED, and the measurement inside it
> expired ten and a half hours after it was taken.** Everything above this rule is
> retained deliberately: it is the reasoning that produced the migration, and a
> deleted paragraph would take that with it.
>
> **What was measured, and when.** *"`listings` carries no
> `product_type_definition_id` column at all — verified, zero occurrences in
> `db/schema/catalog.ts`"* was taken for [#597](https://github.com/OxyHQ/Mercaria/pull/597)
> and merged in `dd0dc2ad3` at **2026-08-18 01:25 +0300**. It was **true at that
> instant**. `6a1c2fc26` — [#614](https://github.com/OxyHQ/Mercaria/pull/614),
> migration `0109_nostalgic_vengeance.sql` — merged at **2026-08-18 11:59 +0300**,
> **10 h 34 min later**, and changed the answer. Nobody re-checked it, because a
> statement that says *verified* reads as settled: this is a measurement that
> outlived its subject by half a day while wearing the credibility of a proof.
> **A measurement published without the commit or date it was taken at cannot
> expire visibly** — hence every figure in this note carries one.
>
> **And the instrument could not have found the column anyway — which is the
> sharper defect.** Drizzle declares columns in **camelCase** and `@oxyhq/db`'s
> casing authority derives the snake_case name, so a schema file legitimately
> never spells `product_type_definition_id` for a *declaration*; the property is
> `productTypeDefinitionId` (`db/schema/catalog.ts:415`). Measured 2026-08-21, the
> control settles it: `listings.category_id` indisputably exists, and grepping
> `catalog.ts` for `category_id` returns **1** hit — an index-name string at
> `:559`, not the declaration at `:342`. Strip that index and a present column
> reads as **zero**. So "zero occurrences of `product_type_definition_id` in
> `db/schema/catalog.ts`" was never evidence of absence: it is the same answer
> that instrument returns for a column that is *present*. The house rule is
> usually put the other way round — *what would this check report if the thing it
> measures were absent?* — and the inverse is just as fatal: **what would it
> report if the thing were PRESENT? Same answer ⇒ it measures nothing.** The three
> snake_case hits the file carries today are two comments and an index name, so
> even the corrected count of **3** is incidental rather than structural.
>
> **What is true now (measured 2026-08-21 against a database built from all 133
> migrations, read back by NAME from the live catalogs, not from the schema
> file).** `listings.product_type_definition_id` exists — `text`, nullable
> (`information_schema.columns`) — declared at `db/schema/catalog.ts:415`, which
> names it *"D5/D10's pin for the PUBLISHED write, and D13's `listings` widening"*
> at `:389`. Beside it:
>
> - **FK** `listings_product_type_definition_id_product_type_definitions_id` →
>   `product_type_definitions(id)` `ON DELETE RESTRICT` (`pg_constraint`). Note the
>   live name is Postgres's 63-character **truncation** of the identifier `0109:39`
>   writes, so a citation that quotes the migration will not match `pg_constraint`.
> - **Partial index** `listings_product_type_definition_idx` on
>   `(product_type_definition_id) WHERE product_type_definition_id IS NOT NULL`
>   (`pg_indexes`; `db/schema/catalog.ts:618`).
> - **Trigger** `mercaria_listing_product_type_pin_not_cleared`, `BEFORE UPDATE …
>   FOR EACH ROW`, enabled (`pg_trigger`). Its **live** body was read with
>   `pg_get_functiondef` rather than trusted from `0109`, because a `CREATE OR
>   REPLACE` under an unchanged name is drift no file citation can see; it matches
>   `0109`. Its reach was then **driven rather than read** (2026-08-21, all four
>   transitions in one rolled-back transaction): `NULL → value` succeeds,
>   **`value → different value` succeeds** — so it does *not* freeze a pin to the
>   version first written, only against being cleared — `value → NULL` raises
>   `check_violation`, and an unrelated `UPDATE` (the negative control) neither
>   raises nor disturbs the pin.
>
> `publish.service.ts:280` writes it on the published listing, from
> `draft.productTypeDefinitionId`. So the count this note reports as zero is
> **3** occurrences of the string `product_type_definition_id` in
> `db/schema/catalog.ts` today.
>
> **The residual gap is smaller and differently shaped than the text above says.**
> The pin is nullable, so a listing published before `0109` — or by any writer that
> does not set it — still carries none, and only the trigger's
> already-set-then-cleared case is refused. The cross-check the paragraph above
> asks for (a trigger clause comparing the axis citation against the listing's own)
> was **not** part of `0109` and remains owed. Separately, the comment this note
> cites as `publish.service.ts:634-638` still exists — now at `:651`, inside the
> `if (axesByFieldId.size > 0)` branch — and still says `listings` *"carries no
> such column yet"*. **That comment is now stale in the code**; correcting it is a
> source change and is out of scope for this document.

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
  axes**, in three places — one CHECK on the axis's KEY and two clauses of a
  trigger.

  > **CORRECTED — mistaken about the mechanism, and the true version is both
  > stronger and narrower than what this said.** The original named "a CHECK on
  > the axis's attribute scope". No such CHECK exists and none can: `scope` lives
  > on `product_type_fields` and the axis row holds only an
  > `attribute_definition_id`, so reading a scope means reading another row, which
  > a CHECK cannot do. What actually refuses an axis is:
  >
  > 1. **`native_listing_variant_axes_forbidden_key_check`**
  >    (`db/schema/variantAxes.ts:187`) — a CHECK on the axis's `attribute_key`,
  >    rendered from `PRODUCT_TYPE_FORBIDDEN_VARIANT_AXIS_KEYS`. It is **33 keys**
  >    and, worth knowing, it is not a hand list: it is the spread of
  >    `RESERVED_OFFER_FACT_KEYS` (20) and `PRODUCT_TYPE_COMPATIBILITY_AXIS_KEYS`
  >    (13), so the two vocabularies cannot diverge from what a CHECK admits.
  > 2. **`mercaria_native_variant_axis_citation`'s `variant_defining` clause**
  >    (`drizzle/0097_uneven_hedge_knight.sql:207`) — an attribute the registry
  >    does not mark `variant_defining` may not be an axis, **unconditionally**.
  >    This is the clause doing most of the work, and the original text did not
  >    mention it.
  > 3. **The same trigger's product-type field clause** (`:215`) — the cited
  >    version must declare a `variant_capable`, `scope = 'variant'` field for that
  >    attribute. This is where the word `scope` legitimately appears, and it is
  >    **conditional**: it runs only `if new.product_type_definition_id is not
  >    null`, and that column is nullable.
  >
  > So the residual gap is real but narrow, and stating it precisely matters more
  > than stating it darkly: an attribute could become an axis despite meaning a
  > compatibility target only if its key is outside the 33 **and** an operator has
  > published a definition version marking it `variant_defining` **and** the axis
  > row cites no product type version. All three, and the middle one is a
  > deliberate act. `db/__tests__/variant-axes.realdb.test.ts` drives the
  > refusals; the repo's own test comment at
  > `services/__tests__/verticals-smartphone.realdb.test.ts:296` already stated
  > this distinction correctly, so this decision was the outlier.

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

> **Amended — this became TRUE after the fact, and it is worth saying which
> half.** The retention half was always a property: both claim tables are frozen
> by trigger (`drizzle/0097_uneven_hedge_knight.sql:512`, `:551`, `:592`), so a
> canonical selection cannot rewrite the claim that disagreed with it.
>
> "A claim never becomes a canonical fact without passing through the selection
> and provenance machinery" was **a convention until #566** — the claim tables
> were guarded, the selected fact was not, and the authoring domain's own
> isolation wall named `canonical_products`, `canonical_variants` and
> `product_identifiers` while omitting `canonical_attribute_values`. A publish
> path promoting a claim straight into the selected fact would have shipped green.
> It is now a census:
> `db/__tests__/canonical-attribute-value-chokepoint.test.ts` permits exactly
> three writers over 1610 production modules, and the authoring wall names the
> table. Recorded rather than silently upgraded, because a reader who checked in
> the interval and found no gate was reading the code correctly.

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
epic's own acceptance scenario and it is held by the three refusals in D6 plus a
scanned gate forbidding the compatibility domain from writing option rows.

> **Verified and left standing, with one thing to know about its reach.** This
> sentence is accurate: `services/compatibility/__tests__/compatibility-isolation.test.ts:251`
> forbids the domain from naming `listing_options`,
> `product_variant_option_values`, either repository or `catalog-write.service`,
> and `:593` additionally walks those tables' own COLUMNS so a
> `listing_options.vehicle_generation_id` fails the build as well — which is more
> than the sentence claims.
>
> What it does **not** cover is the TYPED axis tables (`native_listing_variant_axes`
> and its siblings), which is where an axis lives after #367 step 4. So the typed
> path is carried by D6's three refusals above rather than by this gate, and D6's
> correction states the residual precisely. Recorded because the natural reading
> of "option rows" is "any axis", and it is not: it is the legacy pair.
>
> Also corrected in passing: this said "the axis CHECK in D6", singular. D6 has
> one CHECK and two trigger clauses; see the correction there.

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

> **CORRECTED after implementation.** This decision originally named six levers.
> **Four were built**, and one lever a rollout needs was added that this decision
> did not name. The list below is the measured one; the three that do not exist
> are recorded underneath with the reason each is absent, because the three
> reasons are completely different and "removed" on its own teaches a reader
> nothing. Operational detail, the read-site census behind the durable-record
> claim, and the rollback procedure:
> [`../catalog-migration-operations.md`](../catalog-migration-operations.md) and
> [`../runbooks/catalog-rollout-rollback.md`](../runbooks/catalog-rollout-rollback.md).
>
> **CORRECTED AGAIN — one of the three absences has been closed.** The cohort
> expression this decision named `CATALOG_AUTHORING_COHORTS` now EXISTS, as
> `CATALOG_ROLLOUT_COHORTS`, and the staged rollout order below is executable.
> The rename is not cosmetic: it narrows all four levers' surfaces rather than
> authoring alone, and a variable whose name promises less than it does is the
> kind a runbook step gets wrong. The other two absences (`PRODUCT_TYPES_ENABLED`,
> `CATALOG_LOCALIZATION_ENABLED`) stand, with their reasons unchanged. Full
> reference, including the per-dimension census of what already existed elsewhere:
> [`../catalog-rollout-cohorts.md`](../catalog-rollout-cohorts.md).

**Four levers**, and the split follows the house rule that a lever gates a **loop
or a mount**, never a stored row:

- `CATALOG_TAXONOMY_V2_ENABLED` — the navigation **mount** (`/navigation`).
  Default false; with it off, `categories` answers exactly as today and the
  storefront falls back to the v1 category tree.
- `CATALOG_AUTHORING_ENABLED` — the authoring **mount** (drafts, validate,
  publish). Default false. The legacy product-creation route is untouched while
  it is off.
- `CATALOG_PROPOSALS_ENABLED` — the proposal mount. Default false.
- `FACETS_ENABLED` — the facet, filter and sort rail (`POST /facets`). Default
  false. **This decision did not name it and should have**: it is a public
  surface this epic added, it is one of the four things a rollback turns off, and
  the domain it gates owns no table and writes no row.

The four levers are read in **six** non-test places, and no repository, outbox
enqueue, loop or checkout path reads any of them.

> **CORRECTED — mistaken, and the substantive half survives.** This said "read in
> exactly one place — the `app.use` that mounts its router". The census, taken
> per lever over the config PROPERTY rather than the env-var string:
>
> | Lever | Property | Non-test reads |
> |---|---|---|
> | `CATALOG_TAXONOMY_V2_ENABLED` | `config.catalog.taxonomyV2Enabled` | `app.ts:978` |
> | `CATALOG_AUTHORING_ENABLED` | `config.catalogAuthoring.enabled` | `app.ts:258`, `services/catalog-observability/metrics.service.ts:745` |
> | `CATALOG_PROPOSALS_ENABLED` | `config.catalogProposals.enabled` | `app.ts:274` |
> | `FACETS_ENABLED` | `config.catalog.facetsEnabled` | `app.ts:737`, `metrics.service.ts:746` |
>
> Four mounts and two metrics reads, which decide whether a metric reports
> `surface_not_mounted` rather than a figure. **The claim that matters — no
> durable-record path reads a lever — is unaffected**, and `#552` gave all four a
> scanned wall (see below). What was wrong is the number, and it is worth fixing
> because "read in exactly one place" is the kind of sentence somebody verifies by
> grepping once, finding two hits, and then not knowing which of the two the ADR
> was wrong about.
>
> Two further notes. `app.ts:258` gates **two** mounts on one read (the authoring
> router and `/stores/:storeId/product-drafts`), which is why
> `routes/__tests__/catalog-rollout.realdb.test.ts:309` pins the withdrawal at
> five mounts rather than four. And
> `controllers/catalog-authoring.controller.ts` reads four SIBLING settings off
> `config.catalogAuthoring` (page sizes, the draft TTL) which are not levers and do
> not count here — a census that greps the namespace rather than the boolean
> reports ten and is measuring something else.
> `docs/runbooks/catalog-rollout-rollback.md:109` already states six.

#### The fifth lever: `CATALOG_ROLLOUT_COHORTS`

**Which slice of the deployment the four levers above are switched on FOR**, over
the five dimensions Workstream 0 names: `market`, `locale`, `store`, `category`,
`product_type` (`CATALOG_ROLLOUT_DIMENSIONS` in `@mercaria/shared-types`). Entries
are `<dimension>:<value>` or the literal `all`; **empty is the default and means
every cohort**, which is today's behaviour exactly, so adding the variable
withdraws nothing from a deployment that never sets it. It narrows a MOUNTED
surface per request, gates no loop, no repository and no stored row, and it can
only ever subtract — a cohort admits nothing `loadStore`,
`requireStorePermission` or an operator allow-list would refuse.

Three properties are worth stating here rather than only in the reference,
because each is a decision a later reader would otherwise re-litigate:

- **Entries are OR-ed, so the stages below are CUMULATIVE.** Each stage is the
  previous stage's entries plus more. A runbook that REPLACED the list at each
  step would withdraw the previous stage, which is the opposite of what "stage"
  means here.
- **A request that can answer no enabled dimension is REFUSED** — the
  `canonicalReadAllowedFor` rule, and the second reason the stages are
  cumulative: with only `store:S1` set, `/navigation` (which knows a market and a
  locale and never a store) is outside the rollout.
- **A category cohort is EXACT and does not cover a subtree**, and there is no
  percentage bucket. Both follow `SEO_CANARY_CATEGORY_IDS`, which made the same
  two choices for the same reasons.

Gated: `/navigation`, `/taxonomy`, `/facets`, `/catalog-authoring`,
`/stores/:storeId/product-drafts`, `/catalog-proposals`. A refusal is the same
**404** the lever itself gives — which the storefront already falls back from —
and it names no dimension, so a caller cannot map the switchboard one input at a
time.

#### The two levers this decision named and nobody built

- **`PRODUCT_TYPES_ENABLED` — deliberately not built, and the reasoning is
  sound.** `/product-types` is mounted unconditionally, with the argument on the
  block above it in `app.ts`: a published product type's group headings are
  catalogue metadata of the same kind `/categories` and `/catalog-attributes`
  already serve unconditionally, and a key with no published version answers 404,
  so a deployment that has published nothing exposes nothing. **The defect was
  this decision continuing to claim the lever**, and `docs/product-types.md`
  quoting the claim. Withdrawing a product type is an unpublish — a data change
  through the governance surface — not a lever.
- **`CATALOG_LOCALIZATION_ENABLED` — unnecessary *today*, because localized
  reads are transitively contained.** `services/catalog-localization/read.service.ts`
  exports two readers and has exactly **one** external production consumer:
  `services/facets/facet.service.ts:82` (behind `FACETS_ENABLED`).
  `routes/categories.ts` reads no locale at all, so with the four levers off no
  public surface serves a localized label and the base-locale behaviour this
  decision promised is what a shopper gets.

  > **CORRECTED — mistaken about the consumer set, and the containment argument
  > gets STRONGER rather than weaker.** This said "exactly two external
  > consumers", naming `catalog-authoring/schema.service.ts` as the second. That
  > module does not import `read.service.ts`. It imports the PURE resolver
  > (`catalog-localization/resolve.ts`) instead, and says why in place at
  > `schema.service.ts:695-704`: `readLocalizedAttributeValues` re-reads
  > `attribute_enum_values` for the base label, a statement the schema
  > composition has already issued, and two reads of one table in one request is
  > the N+1 that file is arranged to avoid.
  >
  > So the reader has one consumer, not two — but the authoring path **does**
  > still serve localized labels, through the resolver, behind
  > `CATALOG_AUTHORING_ENABLED`. The conclusion holds by both routes; only the
  > route named was wrong. It matters because the paragraph's whole purpose is to
  > tell a future reader **which files to check**, and it sent them to the wrong
  > one.

  **The condition under which that flips, stated so it is recognisable:** a
  SECOND consumer of either reader — or a first consumer of `resolve.ts` — on an
  unconditionally-mounted route would make localized reads un-rollbackable, and
  nothing gates against it: there is still no `catalog-localization` isolation
  test. Adding such a consumer means either building this lever or gating the new
  route.

> **`CATALOG_AUTHORING_COHORTS` was the third, and it is now BUILT** — under the
> name `CATALOG_ROLLOUT_COHORTS`, described above. What this bullet used to say,
> kept because it is the reason the lever exists: *"Authoring is all-or-nothing on
> `CATALOG_AUTHORING_ENABLED`; nothing narrows the mount to a market, a locale, a
> store, a category or a product type. So the rollout order below is not
> executable as written."* It is executable now.

Rollout order: internal users → selected stores → selected product types and
categories → locales and markets → general availability. The first three stages
are the cohort expression above; the list is CUMULATIVE, so each stage adds
entries and removes none.

**One stage boundary predates the cohorts and still matters: product-type
PUBLICATION.** A product type with no published version is invisible whatever the
levers or cohorts say, so it remains the coarsest staging control and the only
one whose rollback is a governance write with an audit trail rather than an
environment change. What the cohorts add is everything publication cannot
express: publication is per-key and all-or-nothing
(`product_type_definitions_one_published_per_key`), so it can say "this type is
not live yet" and never "authoring is on for these stores but only for these
types".

**`product_type` was the one dimension of the five with no existing mechanism
anywhere in the repository** — no flag, cohort, allow-list or enablement row
takes a product type as a scope value, and no cohort or pilot table carries a
product-type column. The other four were each expressible somewhere already,
under other names; the per-dimension census is in
[`../catalog-rollout-cohorts.md`](../catalog-rollout-cohorts.md) §"What already
existed".

Workstream 17's error, abandonment, matching, indexing and conversion metrics
remain the gate at each step — with the caveat recorded in
`catalog-observability.md` that no alert has ever fired, so every threshold is a
proposal.

**Nothing in a rollback deletes catalog evidence.** Turning every lever off
restores listing-first behaviour and leaves every row readable, because the
evidence has to be readable during the incident that turned the levers off.
**One qualification stands and one has been retired.** The readability half is
conditional on `CATALOG_OPERATOR_OXY_USER_IDS` being non-empty, since the
`/internal/*` catalog surfaces are gated on that list's LENGTH and an empty list
answers 404 — so populating it is part of the rollback plan, not an afterthought.

> **CORRECTED, twice.**
>
> **The number was wrong.** This said "the **nine** `/internal/*` catalog
> surfaces". There are **26** `app.use` mounts inside a
> `config.catalog.graphOperatorSurfaceEnabled` block in `app.ts` — `:286, 471,
> 519, 644, 724, 745, 749, 754, 755, 760, 765, 772, 782, 796, 810, 819, 823, 833,
> 844, 854, 865, 876, 886, 992, 1008, 1014` — counted twice by independent
> parsers. Nine is the length of the hand list in
> `routes/__tests__/catalog-rollout.realdb.test.ts:281`, and that test's `:421`
> asserts the length is nine and calls it a vacuity floor. **It is a floor
> computed from the list it guards**, so deleting an entry leaves that surface
> unscanned with the assertion still true, and seventeen surfaces are asserted in
> neither direction. Purely a wrong number in this document; the under-coverage
> in the test is a separate defect and is not fixed by editing prose.
>
> **The second qualification is STALE and is withdrawn.** It said the
> durable-record guarantee "is defended by one assertion over one domain's
> repository layer, so for three of the four levers it is a convention rather
> than a property". `#552` gave all four a scanned wall:
> `services/facets/__tests__/facet-isolation.test.ts:465` and
> `services/__tests__/navigation-isolation.test.ts:436` are BLANKET (the domain
> reaches no configuration at all), and the authoring and proposal gates carry
> both a lever-specific and a blanket wall. This decision was describing a gap its
> own epic had closed — which is the failure mode that reads as still-pending
> forever, and the reason it is withdrawn here explicitly rather than deleted.

### D13. Retained, extended, retired

| Existing | Disposition |
| --- | --- |
| `categories` | **Extended** in place (D2). `ancestor_slugs` retained as a v1 read contract; superseded by `ancestor_ids`, retired in a later `post` migration once no reader remains. `is_active` becomes derived from `lifecycle` and is retained as a v1 column. |
| `listings`, `product_variants` | Retained. Gained nullable `category_id` semantics under the new lifecycle rules. ~~**They did NOT gain `product_type_definition_id` or a pinned version** — see the correction under D5; the citation lives on `native_listing_variant_axes` and is nullable.~~ **Overtaken 2026-08-18: `listings` DID gain `product_type_definition_id`** (nullable `text`, `ON DELETE restrict` to `product_type_definitions`, partial index, and a trigger refusing to clear it once set) in [#614](https://github.com/OxyHQ/Mercaria/pull/614) / migration `0109`. `product_variants` still has neither. See the superseding note under D5. |
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
