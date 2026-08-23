# External taxonomy, attribute and value mappings (#367 Workstream 11)

> Binding decisions: **ADR 0007** (`docs/adr/0007-universal-catalog-taxonomy-and-authoring.md`),
> D1 (identity is an id and a stable machine key — never a name), D13 (retained,
> extended, retired) and D14 (JSONB is bounded and named). Schema decisions that
> would normally sit in `packages/backend/src/db/schema/CONVENTIONS.md` are in
> §"Schema decisions" below; see §"What is still owed" for why.

An external provider — a marketplace, an affiliate network, a merchant feed —
publishes its own classification. `Apparel > Shoes > Sneakers`. A field called
`memory_size`. A value spelled `Cor`. A unit written `GB`. A size chart called
`EU`. This domain is how one of those tokens becomes a Mercaria concept, and —
much more of the code — how it is stopped from becoming one by accident.

**Mercaria never exposes a provider's structure as its canonical model.** The
mapping points INWARD: an external key resolves to a Mercaria category id, a
Mercaria attribute key, a Mercaria controlled value, a Mercaria unit. No table
here can hold a provider's tree as Mercaria's, and no read returns one.

## What this is built on, and what it does not re-model

#62's ingestion framework already owns source registration (`catalog_sources`),
observations (`source_records`), current object state
(`catalog_source_objects`), rights policies (`catalog_source_policies`) and
provenance. **None of that is duplicated here.** This domain foreign-keys into
`catalog_sources` and `source_records` and adds the layer nobody owned: a
versioned, reviewed, dated statement about what one source's token MEANS.

| Layer | Owner |
| --- | --- |
| Which sources exist, what rights they carry, what they published | #62 |
| Which canonical product an observation attaches to | #58 (matching) |
| What an attribute MEANS, and its enum values | #94 (registry) |
| What one source's token maps ONTO, with governance | **this domain** |

## The five tables

| Table | What it holds |
| --- | --- |
| `catalog_external_mappings` | One versioned, reviewed mapping. Five dimensions, one discriminated target. |
| `catalog_external_mapping_reviews` | The queue for a token nobody has decided. One OPEN row per token. |
| `catalog_external_token_observations` | Which subject carried which token and what it resolved to. The row IS the reprocessing job. |
| `catalog_external_mapping_runs` | One reprocessing pass, `dry_run` or `apply`. |
| `catalog_external_mapping_run_items` | What a run concluded about one subject. Append-only. |

### Why ONE table for five dimensions

A product-type mapping, an attribute mapping, a controlled-value mapping, a unit
mapping and a size-system mapping are the same row with a different pointer: an
external key, a target, a confidence, a provenance, a review state, a validity
window and a version. Five tables would be five copies of that governance, five
copies of the fan-out rule and five copies of the reprocessing machinery — and
the copy that drifted would be the one nobody was reading.

The target is discriminated by `catalog_external_mappings_target_shape_check`,
which forces every non-selected pointer NULL — ADR 0007 D3's `navigation_nodes`
device. Its `else false` branch is load-bearing: a sixth dimension added to
`CATALOG_EXTERNAL_MAPPING_DIMENSIONS` without a branch here fails every write
loudly rather than admitting a row with no target.

### The category dimension

**There is none here, deliberately.** ADR 0007 D2 names
`category_external_mappings` under "New tables, each owned by the taxonomy
module", and the taxonomy workstream built it (PR #401,
`db/schema/taxonomy.ts`) — versioned, with confidence, review state, validity
dates, `UNIQUE(source_id, external_key, version)` and a partial
`UNIQUE(source_id, external_key) WHERE valid_to IS NULL`. Adding a `category`
member to this domain's tuple would be the rival table the epic exists to
remove, and `external-mapping-isolation.test.ts` fails the build on the tuple
member OR on any column matching `/category/i`.

**The cost of the split is real and is stated rather than hidden.** It is not
"two mechanisms" — nothing is duplicated today, because this domain simply does
not carry the dimension. It is that ONE dimension is modelled in the taxonomy
module's shape and FIVE in this one, and the two are free to diverge on
confidence, review state, validity and provenance from the moment both exist.

Folding it in is a legitimate ADR 0007 amendment, and the shape it must take is
settled: **the amendment and the move migration land in ONE pull request**, so
there is never an interval in which a decision exists and its migration does
not. If that happens, this domain inherits the taxonomy table's column shape as
the starting point rather than inventing a rival one — in particular its two
uniques and its two SEPARATE biconditional CHECKs on `reviewed_by` /
`reviewed_at` (a single CHECK over their conjunction is satisfied by an
`approved` row carrying one half of its audit). The one thing that would not
survive the fold unchanged is the live-primary-key predicate, because the
taxonomy table has no fan-out concept and this one's partial unique is what makes
a silent one-to-many impossible.

The taxonomy workstream has committed to adding no second external/source
dimension to any other taxonomy table, so the fold is one schema block plus
`openCategoryExternalMapping` in `db/taxonomy/taxonomyRepository.ts`, and nothing
else moves.

## The rules that are load-bearing

### A name can never establish a mapping

ADR 0007 D1's single invariant. The TARGET side of a mapping is an id or a stable
machine key and nothing else: there is no `target_name`, `target_label` or
`target_slug` column anywhere in the domain, and
`external-mapping-isolation.test.ts` fails the build if one appears (with a floor
on the number of target columns it found, so the scan cannot pass by finding
none).

`CATALOG_EXTERNAL_MAPPING_FORBIDDEN_PROVENANCES` states the same prohibition as a
VALUE — nine bases on which a mapping may never be established, DISJOINT from the
five permitted provenances by a test. `name_match` and `slug_match` are the first
two; `machine_translation` is there because a translation of a label is a name
match with an extra step (a model may still PROPOSE, as `heuristic_suggestion`,
which still needs approval). The last five are commercial: a mapping that could
be bought is a taxonomy that can be bought, and #74 keeps ranking behind a
versioned policy precisely so no other domain becomes a quieter place to put a
thumb on the scale.

This is #55's `verification_method` device. The reason that domain has no
`name_match` member is the reason this one does not either.

### A source-supplied string is never executed

A transformation is a REFERENCE to a rule Mercaria ships, by key and version, and
`services/catalog-external-mappings/transform-rules.ts` is the whole registry.
Every rule has the signature `(value: string) => CatalogExternalTransformOutcome`
— there is nowhere to pass a pattern, a template, a delimiter or a lookup table,
so the ten shapes in `CATALOG_EXTERNAL_FORBIDDEN_TRANSFORMS` are unrepresentable
rather than refused. #63 states the reason: **a source-supplied pattern is a
small language and a DoS primitive**, which is why its own transform vocabulary
excludes `regex_replace`. `lookup_table_from_row` is the subtle prohibition — a
mapping row carrying its own value table would be a second, ungoverned mapping
layer hiding inside the governed one.

The gate scans for `eval`, `new Function`, `node:vm`, six template engines, a
`new RegExp(` and a dynamic `import(`. Every regular expression in the domain is
a literal in that one file.

An unregistered `(rule, version)` pair is `rule_not_registered` and **never
silently `identity`**: a transformation that quietly did nothing is how a
magnitude in grams gets stored as kilograms.

### Confidence is information, never an authority

`resolution.service.ts` does not read the `confidence` column at all, and a gate
asserts the word does not appear in the file. There is no confidence at which a
mapping applies without approval. #58's failure mode is the reason — a false
merge looks exactly like a correct one, contaminates every page downstream, and
is discovered by a customer.

### Many-to-one is ordinary; one-to-many is a reviewed decision

Several external keys mapping onto one Mercaria concept needs no ceremony: the
rows differ in their key, nothing collides.

One external key fanning out onto several is refused **by the database**.
`catalog_external_mappings_live_primary_key` is a partial unique over
`(catalog_source_id, dimension, external_key_normalized)` restricted to
`state = 'approved' AND valid_to IS NULL AND fan_out_approved_at IS NULL`. So at
most ONE live mapping per token may exist without a fan-out approval, and the
only way to add a second is to record one — which
`catalog_external_mappings_fan_out_four_eyes_check` prices at a second operator:

```sql
fan_out_approved_by_oxy_user_id is null
  or (approved_by_oxy_user_id is not null
      and fan_out_approved_by_oxy_user_id <> approved_by_oxy_user_id)
```

The `approved_by_oxy_user_id is not null` conjunct is not decoration. `x <> NULL`
is NULL and a CHECK rejects only FALSE, so the obvious spelling would admit a
fan-out approval on a mapping nobody had approved.

The READ side keeps them apart with a third branch:
`CatalogExternalResolution` is `resolved | fanned_out | unresolved`, so a caller
written for the ordinary case cannot take `targets[0]` and drop the rest — it
fails `tsc`. That is the silent fan-out the review exists to prevent, made a
compile error.

### The raw value survives the transformation

Every table that records an external token records the source's own spelling
verbatim in `external_key`, and `external_key_normalized` is a GENERATED column
(`lower(btrim(external_key))`) so the stored spelling and the lookup key cannot
disagree — the `attribute_value_aliases.normalized_alias` device. The review
queue additionally keeps `observed_raw_value`, because the whole point of the
queue is that a person can see what the source actually wrote.

**There is deliberately no TypeScript `normalizeExternalKey`.** The obvious
mirror — `key.trim().toLowerCase()` — is not the same function: `btrim` with one
argument strips ASCII spaces only while `String.prototype.trim` strips every
Unicode whitespace character, and `lower` follows the database collation where
`toLowerCase` follows the ECMAScript table. A token carrying a tab, a
non-breaking space or a dotted capital I would be stored under one key and looked
up under another, and the failure is a silent miss that reads exactly like "this
source has never published that value". Every lookup therefore compares the
indexed generated column against `lower(btrim($1))` — the same expression,
evaluated by the same engine, on both sides.

### An unmapped or ambiguous token goes to review, never to a guess

No default mapping. No nearest-match fallback. No "use the parent category" rule.
`CATALOG_EXTERNAL_UNRESOLVED_REASONS` has seven members and every one BLOCKS.

`classifyAbsence` tells `unmapped` (nobody has decided) from
`mapping_not_approved` (somebody has, and the answer is not yet yes) and
`mapping_expired` (it was yes and the window closed). Those route to three
different next actions, and collapsing them would send an operator to open a
second review for a token that already has one open — which the partial unique
would then refuse, and the refusal would look like a bug.

`registry_unavailable` keeps its own review reason rather than filing as
`unmapped`: it is a fact about the deployment, not about the token, and a
reviewer cannot fix it by choosing a target.

### Reprocessing is idempotent, resumable and previewed

- **Idempotent** — `UNIQUE(run_id, subject_key)` with `ON CONFLICT DO NOTHING`.
  A re-run of a page writes nothing for subjects already recorded, and the empty
  result is the signal not to count them again. `DO UPDATE` would let a resumed
  page double its own counters.
- **Resumable** — the cursor advances only when a page's items are committed, so
  a crash mid-page re-reads that page and the idempotency above absorbs the
  overlap.
- **Previewed** — `mode` is part of the run's identity (#60's decision), so a
  `dry_run` and the `apply` it predicted are two rows that can be compared. A
  `dry_run` calls no write: `runReprocessPage` reaches
  `applyObservationResolution` only inside `if (run.mode === 'apply')`.
- **Vacuity-floored** — `catalog_external_mapping_runs_counters_total_check` sums
  the six outcome counters to `scanned` by EQUALITY, never `<=`. A page that
  swallowed a subject cannot write a balancing row, so "the run went fine" and
  "the run read nothing" stop producing the same output. `readRunMetrics` reports
  the run's own counters beside a tally taken from its ITEMS, with `countsAgree`
  between them — #60's `scannedFromRecords` device, because a counter that only
  agrees with itself measures nothing.

An `apply` writes the observation's own resolution plus a
`reprocess_requested_at` stamp. **The row IS the job** (#48's
`payment_provider_events` decision), so there is no outbox row that could
disagree with it. Nothing drains that queue today — a gated LOOP, never a gated
record.

### Source records stay idempotent and no canonical entity can be minted here

Held by the import graph, not by discipline. `external-mapping-isolation.test.ts`
fails the build if any module in the domain reaches a canonical write service,
the matcher, an offer writer or `catalog-write.service`. This layer RESOLVES a
Mercaria concept and has no way to create one. Observation recording is an upsert
on a natural key, so a re-delivery converges rather than multiplying anything.

## The preview, and the number it refuses to print

`previewCandidateMapping` counts, exactly, over rows this domain owns:

- live mappings the candidate agrees with, and live mappings it contradicts;
- open review rows it would answer;
- recorded observations of the token, split into those resolving elsewhere
  (`retargeted`) and those resolving nowhere (`newly_mapped`);
- whether the target resolves right now, by the SAME derivation the resolver
  uses — two spellings of one rule can disagree, and here the disagreement would
  be discovered after approval;
- whether approving it needs a second operator.

`coverage` is the field to read first. When this domain has never recorded an
observation for the source and dimension, it is `no_observations_recorded` and
the observation counts are zero **but must not be read as zero impact** — they
are unknown. #82's `unmeasured`, applied to an impact estimate. A confident `0`
is the one output that would get a bad mapping approved without argument.

The gap is real and named: nothing in ingestion calls `resolveExternalToken`
yet, so `catalog_external_token_observations` is empty on every deployment. See
§"Seams".

`preview.service.ts` writes NOTHING, and a gate asserts it imports no writer and
contains no `.insert(`/`.update(`/`.delete(`. A preview that could change
something is not a preview — and the tempting version ("let me record that
somebody previewed this") is the one that opens a review row for a token an
operator was only looking at.

## The `attribute_source_mappings` overlap

**#94's `attribute_source_mappings` already answers "what does this source's
field name mean"** — `(catalog_source_id, source_field) → attribute_key`, plus
`assumed_unit` and `component_axis`. That IS the external-attribute-mapping
responsibility for one of this domain's five dimensions, and it landed first.

What it does not carry is the governance Workstream 11 requires of every mapping:
**no version, no confidence, no review state, no provenance, no validity
window**. Its unique is `(catalog_source_id, source_field)` — exactly one row per
field, forever — so it cannot express a supersession, a validity window or a
reviewed fan-out even in principle. A mapping with no review state also cannot
satisfy "an unmapped or ambiguous value goes to review, never to a guess",
because there is nothing on the row that could be un-reviewed.

**This branch did not extend it, and the reason is territorial rather than
technical**: `db/schema/attributeRegistry.ts` is owned by another agent in the
parallel #367 batch (ADR 0007 D4 reshapes `attribute_labels` in that same file),
so editing it would have been a cross-branch conflict on the one file another
workstream is restructuring.

Until it is reconciled, the two coexist under three rules, all enforced:

1. **This domain never WRITES `attribute_source_mappings`.** A scanned gate,
   deliberately narrow — the domain legitimately READS it, so a gate over the
   identifier would have to be loosened until it caught nothing. What is scanned
   for is `.insert(`/`.update(`/`.delete(` against the registry tables.
2. **A governed mapping WINS.** `resolveFromLegacyRegistry` runs only when
   nothing governed answers, only for the `attribute` dimension, and marks its
   answer `origin: 'legacy_registry'` so no caller can mistake it for a reviewed
   decision. A legacy answer is recorded as UNRESOLVED in the observation table
   — deliberately, because counting it as governed coverage would make the
   migration backlog invisible in exactly the report that exists to size it.
3. **A disagreement is RECORDED, never resolved by a rule.**
   `reconcileLegacyAttributeMappings` counts `agreeing`, `legacyOnly`
   (the backlog), `governedOnly` and names every disagreement; opening review
   rows is opt-in so the report stays a pure read. Detection and repair are
   separate acts — the `payment_discrepancies` posture.

Reading the legacy table at all was considered and the alternative refused:
ignoring it would silently un-map every field a deployment had already
configured, on the deploy that adopted this domain, with no error anywhere.

**The reconciliation is filed as
[#409](https://github.com/OxyHQ/Mercaria/issues/409)**, with the three steps
written out: migrate every `attribute_source_mappings` row into
`catalog_external_mappings` as `provenance = 'imported_legacy'`,
`state = 'approved'`, `confidence = 1`, `valid_from = created_at`; narrow that
table to the one fact this domain does NOT model — `assumed_unit` and
`component_axis`, which are a per-source READING CONVENTION for a field's
*values* rather than a statement about which field means which attribute; then
delete `resolveFromLegacyRegistry`, `legacy-registry.ts`, the `legacy_registry`
resolution origin and this section.

It is a separate PR for two reasons. Step 2 is a **`post` migration that
narrows**, so it breaks a write the previous image performs and needs its own
deploy phase — folding it into a PR already carrying five tables, five trigger
functions and seven triggers would bury the one statement most needing review.
And `db/schema/attributeRegistry.ts` is contended: ADR 0007 D4 has the
localization workstream reshaping `attribute_labels` in the same file.

## Seams

Each is a named contract that FAILS CLOSED. None is a stub that lies.

| Seam | State today | What closes it |
| --- | --- | --- |
| **Product types** (ADR 0007 D5, merge-order step 3) | `conceptExists('product_type', …)` answers `unavailable`, which resolves to `registry_unavailable` and BLOCKS. `reviewed_product_type_definition_id` is in `DEFERRED_FOREIGN_KEYS`, so the id-column gate fails the build the moment `product_type_definitions` appears. | One `registerCatalogConceptRegistry` call, plus turning the deferred entry into a real `.references()`. **Not** a foreign key on `target_product_type_key` — see below. |
| **Size systems** | **CLOSED.** `services/canonical/size-systems.ts` is a code registry the `units.ts` shape, registered at boot by `registerSizeSystemConceptRegistry()`. A `size_system` mapping onto a key it holds RESOLVES; one onto a well-formed key it does not hold is `target_unresolvable`; a deployment that skipped the registration is still `registry_unavailable`. There is still no size-system TABLE and no conversion rule anywhere. | — |
| **Ingestion calls the resolver** | Nothing calls `resolveExternalToken`, so `catalog_external_token_observations` is empty and every impact preview reports `no_observations_recorded`. | #62/#63/#65/#66 calling the resolver at the point they read a source's category, field, value or unit. |
| **The reprocessing consumer** | An `apply` stamps `reprocess_requested_at`; nothing drains it. The claim columns and the partial index are on the row. | A re-normalization drain — the same one a `NORMALIZATION_VERSION` bump schedules in #62. |
| **HTTP surface** | There is no route. Every service function takes an actor id and is callable from an operator controller. | An `/internal/catalog-external-mappings/*` router on the SAME `CATALOG_OPERATOR_OXY_USER_IDS` allow-list #54/#56/#57/#58/#60/#62/#68/#70/#78 use — **not a seventh list**. |
| **Suggesters** | `heuristic_suggestion` is a permitted provenance and nothing produces one. | Whatever proposes mappings, which still cannot approve one. |

### The size-system registry, and the key namespace it mints

`services/canonical/size-systems.ts` holds the table;
`services/canonical/size-system-registry.ts` is the reader and
`index.ts` registers it before the listener opens — statically, because a
deferred registration would answer the first request `registry_unavailable`,
which is indistinguishable from a deployment that has no registry.

It IDENTIFIES and nothing else. `units.ts` may legitimately convert, because a
millimetre and an inch are two names for one length; an EU 42 and a US 9 are
not, and `size-system-non-equivalence.test.ts`'s whole-backend scan covers
these two modules like every other.

**The key is DERIVED from the four facets and never parsed** —
`size.<domain>.<region>.<audience>.<basis>`, e.g.
`size.footwear.us.mens.manufacturer_label`. The generated-composite device
(`endpoint_key`, `commercial_key`), for the reason
`shared-types/size-system.ts` opens with: the four facts a size system consists
of used to be "encoded in the SPELLING of the key", and a spelling is not a
model. A short opaque key (`size.eu` — the illustration in `DOTTED_KEY_SHAPE`'s
own docblock) names a region and is silent about audience, which is the facet
worth a full shoe size. There is deliberately no inverse function: the moment
one exists, a reader can split a key on dots and get facets that disagree with
the row, and a scanned gate fails the build on one.

Correcting a facet therefore mints a DIFFERENT key, which is ADR 0007 D1's
"deprecated and superseded, never renamed" arriving for free — if a system's
facets change it IS a different system.

**Its members are the five conventions the footwear vertical actually
publishes**, and nothing else. Seeding an apparel or ring system nothing sells
in would make a mapping RESOLVE against a convention no listing can express —
the registry-that-agrees failure in miniature, and worse than the unregistered
seam, which at least blocked visibly.

**It relates nothing to an attribute key.** `scripts/seed-verticals/footwear.ts`
declares the same five conventions as ATTRIBUTE definitions and the facets were
read off it, but that correspondence is prose: no value in either module is an
attribute key, and the gate scans comment-stripped source against the seed's own
key list. Relating the two namespaces is the value-level mapping this epic
re-scoped to an ADR amendment, and it would arrive here disguised as a
convenience. Until it lands, one convention presented under both spellings is
refused by `compareSizeDeclarations` as `no_sourced_mapping` — closed, never a
false equality.

**A pinned version answers `unavailable`.** A code table ships exactly one
revision, so `present` would claim a check nobody performed and `absent` would
deny a system Mercaria has. No caller passes a version today; the branch is
driven by a test anyway, because a defensive branch nobody drives is a claim
rather than a behaviour.

### `target_product_type_key` is FK-less by DESIGN, not by timing

This was a seam in the first draft and it is not one. `product_type_definitions`
has no unique constraint on `key` alone and will not get one: the identity unique
is `(key, version)`, and the one-live-version index is PARTIAL
(`product_type_definitions_one_published_per_key … WHERE lifecycle =
'published'`). PostgreSQL will not accept a foreign key onto a partial unique
index, and the house rule additionally forbids one onto a `uniqueIndex()` rather
than a `unique()` constraint — the product-type workstream hit exactly that wall
making `product_type_fields` cite `attribute_definitions(key, version)` and
solved it with a trigger. `attribute_definitions` is the same shape, so the
attribute and controlled-value targets are FK-less permanently too.

What makes that safe rather than merely unavoidable: `key` is frozen **from
INSERT** by a trigger on both registries (D1 rule 2 — a renamed key is
indistinguishable from a different concept to every mapping that cited it), so a
key-valued target cannot be silently re-pointed. Resolution reads the single live
version through the registry's own reader (`findPublishedProductTypeDefinition`),
never an `ORDER BY … LIMIT 1`, which is a query with a bug in it the moment two
rows exist — and fails closed when there is none.

**Which version a mapping was reviewed against is a separate fact.**
`reviewed_product_type_definition_id` records it, a CHECK confines it to
`product_type` mappings, the freeze trigger covers it, and nothing applies it.
It answers "what did the schema look like when somebody approved this", which is
what a later correction actually asks. Saying out loud that it is never the
resolution target is what stops the key and the id becoming two answers to one
question.

The port's default REFUSES rather than agreeing, which is #108's transport
decision and #124's credential decision: an unregistered dependency must fail
like an unconfigured one, visibly and with the row intact. A default that
answered "yes, that key exists" would make every mapping in those dimensions
resolve against nothing, silently, in exactly the deployments where the registry
is missing.

## Schema decisions

Also appended to `packages/backend/src/db/schema/CONVENTIONS.md` under
§"External taxonomy, attribute and value mappings (#367 Workstream 11)" — a
decision that lives only in a domain doc is one the next schema author will not
read. What follows is the fuller version; that section is the binding one.

- **No `jsonb`.** Not one column, so ADR 0007 D14's permitted-JSONB register is
  unchanged. Asserted by a test that walks the real table configs.
- **Closed value sets are `text` + CHECK rendered from a shared-types tuple**,
  never a pg enum. Ten tuples, all in
  `packages/shared-types/src/catalog-external-mapping.ts`.
- **`external_key_normalized` is a STORED GENERATED column** on all three
  token-bearing tables. Consequence for the triggers: a stored generated column
  is computed AFTER a `BEFORE UPDATE` trigger, so `NEW.external_key_normalized`
  is NULL there and a comparison against it raises on every update. Every
  immutability check compares `external_key`. This cost a real bug in #59.
- **`cardinality()`, never `array_length()`** — the latter is NULL on an empty
  array and a CHECK reads NULL as satisfied, so `array_length(col,1) >= 1` admits
  exactly the row it exists to refuse.
- **Two biconditionals, never one over their conjunction.**
  `catalog_external_token_observations` states `resolved` and `unresolved`
  separately, because the single spelling is SATISFIED by an `unresolved` row
  carrying a mapping id (both sides evaluate false). #126 and #81 each hit this.
- **Every foreign key is `restrict`** except `catalog_external_mapping_run_items
  → runs` (`cascade`: an item is meaningless without its run, and a run is never
  deleted). Nothing in this domain issues a DELETE, and three triggers refuse
  one.
- **`supersedes_mapping_id` is a SELF reference**, which drizzle-kit emits
  correctly. The one it silently drops is a CIRCULAR reference between two
  tables — measured on #66 — and this is not one.
- **Six `*_oxy_user_id` columns are registered in
  `ID_COLUMNS_WITHOUT_FOREIGN_KEY`.** Oxy owns identity; a shadow table would be
  a cache that can disagree with it.

### Triggers

**Five functions and seven triggers, applied in
`packages/backend/drizzle/0094_dizzy_makkari.sql`.** That migration is where they
live; there is no staging file and no paste still owed.

> **Correction, #831 (2026-08-21).** Until this issue, the statements were held
> as plain text in `packages/backend/src/db/schema/catalogExternalMappings.pending.sql`
> and this section said they were *"unapplied, waiting for the migration slot"*.
> The slot arrived at `0094` and the sentence stopped being true then — with the
> chain since gone on to idx 131, so it had been false for thirty-seven
> migrations. **Nothing could expire it**: the claim carried no date, the staging
> file was byte-identical to what shipped (206 lines, 9885 bytes — verified), and
> `external-mapping-schema.test.ts` read the staging file rather than the
> migration, so the gate kept the stale copy alive instead of catching it. The
> file was deleted under CONVENTIONS' two-copies rule, the close its three
> siblings already had (`catalogLocalization` → `0091`, `catalogProposals` →
> `0100`, `catalogGovernance` → `0102`), and the gate now locates the statements
> by content across the whole chain. **The `.pending.sql` staging pattern is
> retired: none survives, and one appearing again means a slot is genuinely
> pending.**
>
> The header was worse than stale, which is why it was worth a change rather
> than a note: it was an *instruction*, telling the next reader to append seven
> `CREATE TRIGGER`s that already exist. A stale fact misleads; a stale
> instruction gets executed.

**Two mechanics made the paste correct rather than plausible**, and they are kept
here because they are what a future hand-written block in this schema has to do —
`external-mapping-schema.test.ts` gates both against the shipped migration, each
one mutation-tested by breaking it and confirming the gate goes red:

- **Every block is wrapped in a NAMED marker pair**
  (`-- oxy:handwritten-begin=<name>` … `-- oxy:handwritten-end=<name>`), matched
  by name, with no name reused in the file. There are **five** blocks for seven
  triggers, because `mercaria_catalog_external_no_delete` is ONE function mounted
  on THREE tables — three blocks would have to share a name, and a repeated name
  is exactly what a marker stack cannot resolve. The markers survive in `0094`
  and are not decoration: a regeneration drops every statement between them, and
  they are what a later `db:generate` needs in order to put them back.
- **`--> statement-breakpoint` separates statements and NEVER appears inside a
  `$$ … $$` body.** The two halves are not equally important, and the obvious
  reading of the first is WRONG: an un-separated paste does **not** fail at
  apply. `migrator.js` runs each chunk through `sql.raw`, reaching postgres.js as
  `client.unsafe(query, [])`, and with no parameters postgres.js uses the SIMPLE
  protocol, which accepts multiple commands in one string (measured: un-separated
  1/1 green, separated 9/9 green). The separators are **robustness** — a failure
  names ONE statement rather than a block of twelve, and the file stops leaning
  on a fallback that a `prepare: true`, a bound parameter or a different driver
  would remove. The second half IS a defect: a separator inside a `$$ … $$` body
  is cut before anything is parsed, so the function is halved and both halves
  fail. Each breakpoint sits on the terminating `;` of a COMPLETE statement — for
  a function, the `$$;` that closes the body, never the semicolons inside it.
  With five function bodies, "one after every `;`" is precisely the wrong
  heuristic.

| Trigger | Table | What it refuses |
| --- | --- | --- |
| `mercaria_catalog_external_mapping_freeze` | mappings | Any semantic change to a mapping past `proposed`; reopening a closed `valid_to`. |
| `mercaria_catalog_external_mapping_state` | mappings | An illegal state move — `approved → proposed`, `rejected → approved`. |
| `mercaria_catalog_external_mapping_no_delete` | mappings | Every DELETE. |
| `mercaria_catalog_external_review_no_delete` | reviews | Every DELETE. |
| `mercaria_catalog_external_run_item_no_delete` | run items | Every DELETE. |
| `mercaria_catalog_external_review_subject_frozen` | reviews | Editing what a reviewer is answering; reopening a settled review. |
| `mercaria_catalog_external_run_item_immutable` | run items | Every UPDATE. |

`external-mapping-schema.test.ts` asserts each function and trigger is present in
the migration's hand-written region, asserts the trigger COUNT exactly, and
asserts the region does not contain `new.external_key_normalized`.
**Regeneration drops every hand-written statement** — three of four branches in
one measured rebase batch lost their triggers that way and would have applied
cleanly while enforcing nothing.

It finds that region by CONTENT across the whole chain and refuses anything but
**exactly one** file, which covers both directions of the same hazard: zero means
a regeneration dropped the hand-written half, and two means a later migration
re-declared a body — the drift a file citation cannot see, since migrations apply
in journal order and the LAST copy is what a from-zero apply installs. That has
happened in this repository (`docs/catalog-migration-operations.md`: `0023`
created a trigger freezing three columns, `0030` replaced it with one freezing
four, under the same name). So cite `0094` for these statements, and re-derive
the citation rather than copying it forward.

## What the realdb suite covers

`packages/backend/src/services/catalog-external-mappings/__tests__/external-mappings.realdb.test.ts`,
against a real server. Its twelve `describe` blocks are numbered to this list, so
a case here with no block there is visible.

> **Correction, #831 (2026-08-21).** This section said *"Not written yet, because
> the tables do not exist in a migration and therefore do not exist in the
> throwaway test database. It lands in the same PR as the migration."* Both
> halves stopped being true at `0094` — the same moment, and for the same reason,
> as the `NOT APPLIED` header above. The list below was already the suite's
> structure; only the sentence introducing it was stale.

The cases, so they are not re-derived:

1. `catalog_external_mappings_live_primary_key` refuses a second live approved
   mapping for one token with no fan-out approval — and PERMITS it once one is
   recorded. Mutation-test it by dropping `fan_out_approved_at is null` from the
   predicate inside a rolled-back transaction and confirming the permitted case
   goes red.
2. `catalog_external_mappings_fan_out_four_eyes_check` refuses the same operator
   approving both, AND refuses a fan-out on a mapping with a NULL approver (the
   `x <> NULL` trap).
3. `catalog_external_mappings_target_shape_check` refuses every cross-dimension
   target, and its `else false` branch refuses an unknown dimension.
4. The freeze trigger refuses a target change on an `approved` row and PERMITS a
   `valid_to` stamp — and does not raise on the generated column.
5. The state trigger refuses `rejected → approved`.
6. `catalog_external_mapping_reviews_open_key` converges two concurrent
   `upsertExternalMappingReview` calls on ONE row with `occurrences = 2`. Run
   them CONCURRENTLY: a sequential pair passes under a read-then-write that a
   real race defeats, and postgres.js pipelines onto one connection, so the
   competitor has to be a second connection holding a lock.
7. `catalog_external_token_observations` upsert converges a re-delivery and does
   NOT multiply `occurrences` per page.
8. `catalog_external_mapping_runs_counters_total_check` refuses an unbalanced
   counter set.
9. `catalog_external_mapping_run_items_outcome_shape_check` refuses each
   mismatched outcome/pointer pair.
10. A resumed run re-reads its last page and does NOT double its counters
    (the `ON CONFLICT DO NOTHING` idempotency).
11. Every DELETE trigger raises.
12. Teardown is scoped to ids the file owns; the `catalog_sources` and
    `attribute_definitions` fixtures are minted per file. No category fixture is
    needed — this domain has no category dimension.

## What is still owed

Stated rather than quietly skipped:

- **Nothing.** `SCHEMA_TABLE_COUNT` is 426, counted empirically by the gate's own
  barrel traversal on the rebased branch rather than by adding five to `main`'s
  421 — ADR 0007 D11 item 6, because tables MOVE between files in a batch like
  this one and a sum over PR descriptions misses them.
- **Nothing.** The migration is `0094_dizzy_makkari.sql` (`pre`, additive: five
  tables, five trigger functions, seven triggers), and the realdb suite is
  `external-mappings.realdb.test.ts`.
- **A row in `docs/index.mdx`.** A shared append target across the parallel
  #367 branches and not in this one's territory; one line,
  `| External mappings (#367 W11) | [catalog-external-mappings.md](catalog-external-mappings.md) |`.
- **Nothing.** The realdb suite landed with the migration; §"What the realdb
  suite covers" is retained as the reasoning behind each case rather than as a
  list of work owed. **That sentence was already here and already correct while
  two sections above still said the migration and the suite were owed** — which
  is the other half of why #831's stale header survived thirty-seven migrations.
  The refuting statement was in the same file; nothing reads a document for
  self-consistency, and the reader who needs the correction is the one who
  stopped at the first section.
- **Nothing, for the category dimension.** The consolidation is filed as
  [#410](https://github.com/OxyHQ/Mercaria/issues/410) and is not owed by this
  branch. The test that decides which state is correct is anchored to `main`
  rather than to any working tree: **if `main` carries
  `category_external_mappings`, that table stays and this domain has five
  dimensions.** It does, as of `a5b39ab`. §"The category dimension" has the shape
  a fold-in would take — the ADR amendment and the move migration in ONE pull
  request, so there is never an interval in which a decision is recorded and its
  migration is not.
- **Turning `reviewed_product_type_definition_id` into a real foreign key** on
  the rebase behind the product-type workstream, and deleting its
  `DEFERRED_FOREIGN_KEYS` entry. The gate fails the build until that happens, so
  it cannot be forgotten.
