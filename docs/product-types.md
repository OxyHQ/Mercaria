# Versioned product types (#367, ADR 0007 D5)

A **product type** is the authoring contract for a class of things: which
attributes a smartphone declares, which of them a P2P seller is actually asked
for, which may define variants, in what order a form shows them, and under what
condition a field appears at all.

It is the one genuinely new entity in the universal-catalog epic. Everything it
touches already exists and is **cited** rather than copied — #94's attribute
registry says what a value *means*, `categories` says where a type may be used,
and ADR 0007 D10's authoring service is what joins them into the schema a
dashboard renders. This domain owns the part nobody owned: which attributes,
asked of whom, in what shape.

**Code:** `packages/backend/src/db/schema/productTypes.ts` (4 tables) ·
`db/productTypes/` (2 repositories) · `services/product-types/` (3 modules) ·
`packages/shared-types/src/product-type.ts`.
**Schema decisions:** `db/schema/CONVENTIONS.md`.
**Binding decisions:** ADR 0007 D1, D5, D6, D8, D9, D13, D14.

---

## The five tables

| Table | What one row is |
|---|---|
| `product_type_definitions` | One **version** of one product type's contract. `(key, version)` unique; at most one `published` per key. |
| `product_type_category_scopes` | This version may be used under this category (optionally its subtree). |
| `product_type_field_groups` | An ordered section of the form and the spec table. |
| `product_type_fields` | One attribute, in one authoring flow, of one version. |
| `product_type_field_allowed_values` | One value of the cited attribute that THIS field permits (#367 line 235). |

### Identity: two stable identifiers and no third (D1)

`id` is the opaque uuid every foreign key references. `key` is the stable machine
name a seed, a fixture, an export or an operator uses
(`smartphone`, `electronics.phones.smartphone` — dots are permitted here and not
on an attribute key, because D1 gives catalog concepts a documented namespace and
#94 shipped without one).

`key` and `version` are **frozen from INSERT**, not from publication, by
`mercaria_product_type_definition_immutable()`. A renamed key is
indistinguishable from a different concept to everything that cited it, and a
draft's key is exactly what a seed cites while a schema is being built. A key
that was wrong is deprecated and superseded, never renamed.

`name` and `description` are deliberately **not** frozen. The stored KEY is what
has to stay stable, and a promise that a label can never be corrected is worth
nothing to anybody.

---

## Immutable once published — the third use of one mechanism

`fee_schedules` (#88) and `attribute_definitions` (#94) both hold "editable until
published, then frozen" with a trigger plus a partial unique index. This is the
same idiom, deliberately not a new one:

- **`product_type_definitions_key_version_key`** — the exact identity an authored
  record cites.
- **`product_type_definitions_one_published_per_key`** — a partial unique on
  `key WHERE lifecycle = 'published'`. "The current schema for smartphones" is a
  single row rather than a query with a bug in it, and publication must therefore
  deprecate its predecessor **before** flipping the successor. The index refuses
  any other ordering, so the sequence in `publishProductTypeVersion` is the
  constraint's rather than a preference.
- **`product_type_definitions_immutable_once_published`** — refuses every
  semantic UPDATE and every DELETE from `published` onward.
- **`product_type_field_groups_frozen`, `product_type_category_scopes_frozen`,
  `product_type_fields_frozen`** — the children read the parent's lifecycle
  (`mercaria_attribute_enum_frozen`'s shape). A schema whose field list could
  change after publication is not a version; it is a mutable document wearing a
  version number.

**The reason is stronger here than for either precedent.** An authored listing
pins the product type version it was made under, so editing a published version
would not *correct* those listings — it would silently reinterpret them, and the
evidence that they ever meant anything else would be gone. Changing a schema is
publishing a new version, which is what makes migrating existing records a
deliberate, previewable act (D5).

`review` sits between `draft` and `published` and is **not** frozen: review is
where a schema is still being argued about.

---

## A field cites the registry and describes nothing about it

`product_type_fields` names an `attribute_definitions` row by foreign key and
carries **no value type, no unit family, no bounds, no precision and no enum
values**. #94 is the one registry. A second description of one attribute's
meaning is how the two come to disagree, and the direction they disagree in is
never the safe one. `product-type-isolation.test.ts` fails the build if a column
named `valueType`, `unitFamily`, `baseUnit`, `minValue`, `decimalPlaces`,
`cardinality`, `componentAxes` or any of fifteen spellings appears in the schema
file.

What the field DOES carry is everything the registry cannot know:

| Column | Vocabulary |
|---|---|
| `scope` | `identity · product · variant · compatibility` |
| `flow` | `merchant · p2p · operator · connector · verified_brand` |
| `requirement` | `required · recommended · optional · hidden · forbidden` |
| `value_policy` | `controlled_value · canonical_reference · typed_scalar · typed_structured · proposal_enabled` |
| `variant_capable` | may this attribute define variants for this type |
| `group_id`, `position` | layout |
| `visibility_rule` | the bounded declarative AST, or NULL |

`hidden` and `forbidden` are different facts and collapsing them loses the one
that matters: `hidden` means this flow does not ask and a value arriving another
way is kept; `forbidden` means this flow may not supply it at all — a connector
asserting a field only a verified brand may assert is refused, not quietly
dropped.

### The citation columns are a guarded denormalization, not a second authority

`attribute_key` and `attribute_definition_version` duplicate the row the foreign
key points at. They exist for exactly one reason: **the variant-axis prohibition
has to be a CHECK**, a CHECK admits no subquery, and a rule that lives only in a
service is one forgotten call site from being no rule at all.

`mercaria_product_type_field_citation()` refuses any row whose citation disagrees
with the definition its foreign key names, so divergence is unrepresentable
rather than merely unlikely. The repositories pass all three values together
deliberately: a helper that resolved the key and version from the id would move
the guarantee out of the database and into a call site, which is the opposite of
what the trigger is for.

### One row per (version, flow, attribute)

D5 has a field carry both `flow` and a requirement *per flow*, so the row is per
flow: a merchant is asked for twelve identity fields and a P2P seller for two,
and that is the whole reason the flow vocabulary exists. The cost is that
`scope`, `variant_capable` and `value_policy` are repeated across the flows of
one attribute and could in principle disagree — two flows arguing about whether
colour defines variants. That is a **cross-row** rule, so the same citation
trigger enforces it.

The alternative (a field row plus a per-flow requirement child) is recorded in
the schema file as a deliberate absence: it removes the repetition and makes D5's
own shape unrepresentable, because order and group would then have to be
identical across flows. They are not — a P2P form is a shorter form in a
different order.

---

## Allowed value subsets (epic line 235)

A phone form offers three of `storage_capacity`'s twenty values; a drive form
offers eight others. `product_type_field_allowed_values` is that narrowing, and
its whole design is decided by the clause it has to honour — *"without copying
value records"*.

**Until this landed the clause held vacuously.** `schema.service.ts` composed
`controlledValues: valuesByDefinition.get(field.attributeDefinitionId) ?? []` —
every field got the cited definition's FULL set. Nothing subsetted, so nothing
copied; the clause was satisfied by the absence of the capability rather than by
anything designed.

**A subset is a JOIN onto `attribute_enum_values.id`, never a list of value
strings.** The obvious implementation is a `text[]` of permitted spellings on the
field, and it is #56's `allowed_values text[]` again — the column that was
REMOVED rather than kept beside the value rows, because two representations of
the permitted set disagree the moment one is edited and an alias would resolve
against whichever the writer remembered. `product_type_field_allowed_values` has
no column that could hold a spelling, which a realdb case asserts over a real row
rather than over the type.

**Empty means EVERY value.** Two conventions are live in this schema and
deliberately opposed — absence in `attribute_definition_categories` means
everywhere, absence in `product_type_field_categories` means nowhere — and this
one follows the first, for a reason that is not stylistic: every field that
exists has zero subset rows, so "nowhere" would take every published version to
zero offered values on the deploy that created the table.

**Which values, never their ORDER.** No `position` column. The registry's own
`attribute_enum_values.position` orders them, and the composition filters that
ordered list, so there is one ordering authority.

**A value from another attribute is UNREPRESENTABLE.** Two NOT NULL composite
foreign keys share `attribute_definition_id` — the `match_category_gates`
device — pinning the field's cited definition and the value's owning definition
to the same row. Both needed a `unique()` on their target, and both targets are
`(id, <other column>)` over a primary key, so neither could fail to apply.

**A published version's subset is frozen with the rest of its contract**
(`mercaria_product_type_allowed_value_frozen`), which is
`mercaria_product_type_child_frozen`'s reasoning one hop further out: a schema
whose contract could change after publication is a mutable document wearing a
version number. Without it, the permitted values would be the ONE piece of a
published schema that could still move under a merchant.

**What is deliberately NOT modelled: a category-only subset.** Narrowing values
per category, independent of a product type, would be a fourth representation of
where an attribute applies, and a schema composed for one (product type,
category) pair would have to intersect the two — making the answer depend on
which was applied first.

**Carry-forward: nothing carries, because nothing clones.**
`insertProductTypeField` has one production caller, the vertical seed script;
there is no create-v2-from-v1 path and no HTTP surface that creates a field.
`ATTRIBUTE_VERSION_CARRY_FORWARD` is a census over `attribute_definitions`
columns and owes this table nothing. The rows key on `product_type_field_id`, so
a clone would carry them with the field by construction rather than by somebody
remembering.

---

## The variant-axis prohibition (D6/D8)

> A year range, a make or a model may never be stored as a variant option. One
> brake-pad SKU fits many vehicles and remains one variant.

`product_type_fields_variant_axis_check` is **two independent conjuncts**, both
local, both enforced against `psql`:

1. **An axis is a `variant`-scope field.** A compatibility target — a vehicle
   generation, a socket — has scope `compatibility` and can therefore never be
   one, whatever else is true.
2. **And its attribute key is outside `PRODUCT_TYPE_FORBIDDEN_VARIANT_AXIS_KEYS`.**
   A compatibility fact mislabelled `scope: 'variant'` — which is the mistake
   somebody actually makes — is still refused, as is any key naming a price, a
   stock level or a seller's condition.

The forbidden set is **derived, not retyped**: `RESERVED_OFFER_FACT_KEYS` (#94's
twenty offer facts) plus `PRODUCT_TYPE_COMPATIBILITY_AXIS_KEYS` (thirteen fitment
targets). The two halves answer different questions — #94 refuses to *define* an
offer fact at all, while a vehicle make is a perfectly legitimate attribute that
merely may not become an option row — and a test asserts they are disjoint and
that the rendered CHECK names **every** key. Widening the set is a code change
plus a migration, like every other rendered CHECK.

`services/product-types/variant-axis.ts` states the same rule as a pure function
so a schema author reads a sentence naming the attribute instead of a constraint
name. It is a **second** statement, not the only one:
`product-type-variant-axis.test.ts` runs the whole tuple through both and asserts
they answer identically, with a positive control (`color`, `size`,
`storage_capacity` are permitted and absent from the CHECK) so a function that
refused everything could not pass.

---

## Conditional visibility: a closed, bounded, non-Turing-complete AST (D5/D14)

A field may declare a condition under which it is shown — *ask for the storage
size only when connectivity is `cellular`*. D5 fixes the form that takes, and
`services/product-types/visibility-rule.ts` is the interpreter.

### The language

Three leaf nodes and three combinators:

```jsonc
{ "node": "compare",    "field": "ram",   "op": "gte", "value": 16 }
{ "node": "membership", "field": "ports", "op": "includes_any", "values": ["usb_c"] }
{ "node": "presence",   "field": "gtin",  "op": "is_present" }
{ "node": "all", "rules": [ … ] }
{ "node": "any", "rules": [ … ] }
{ "node": "not", "rule":  { … } }
```

Operators: `eq ne gt gte lt lte` · `in not_in includes_any` · `is_present
is_absent`.

**Presence is its own node rather than an operator on `compare`**, so "a presence
test carrying a value" has no shape at all — the JSON is refused rather than
accepted with the value ignored. `includes_any` is named for its semantics so
nobody has to guess whether it means *any* or *all*.

### What it cannot do, and why each absence is structural

- **It cannot execute anything.** No `eval`, no dynamic function construction, no
  `node:vm`, no template engine — a scanned gate with a mutation self-test fails
  the build if one appears anywhere in the domain.
- **It cannot hold a pattern.** There is no `matches`, `like` or `regex` member,
  and `PRODUCT_TYPE_FORBIDDEN_RULE_OPERATORS` names twelve such spellings so a
  candidate carrying one is refused under its **own** reason code
  (`forbidden_operator`) rather than the generic "unknown operator". Somebody
  reaching for a pattern language is a different problem from somebody making a
  typo. A source-supplied pattern is a small language and a DoS primitive —
  #63's finding about feed transforms, one domain over.
- **It cannot read anything outside the product type.** A rule names another
  field by its ATTRIBUTE KEY, validated against the registry's own key shape.
  There is no path syntax, no dot traversal and no root reference, so a rule has
  no way to spell a price, a stock level or a merchant. That is the mechanical
  version of D5's "listing, offer and inventory fields are composed, never
  modelled as product-type attributes".
- **It cannot run away.** Nodes ≤ 64, depth ≤ 6, branches ≤ 16, membership values
  ≤ 32, strings ≤ 256 characters, serialized form ≤ 4 096 bytes — all checked
  while **parsing**, before anything is evaluated. The column carries the byte
  bound independently (`octet_length(visibility_rule::text)`, not
  `pg_column_size`, which is STABLE and which PostgreSQL refuses inside a CHECK),
  so an oversized rule cannot be stored and then refused on every read.

A **cyclic** candidate trips the node counter rather than the stack, which is why
the byte bound is applied to the normalized rule the walk produced rather than to
the candidate: serializing first would throw.

### Three-valued, because two values would have to lie about absence

An authoring draft is half-finished by definition — the field a rule reads is
usually the one the author has not reached yet. `unknown` is a real outcome, not
a soft yes, and the algebra is Kleene's: a definite failure beats an unknown in
`all`, a definite success beats one in `any`. A rule reporting itself
unanswerable when its other half is already false would hide a field whose
condition has been decided.

Nothing is coerced. A numeric-looking string is not a number, because deciding
that it is would make `'010' < '9'` a fact about a product. `null` and `undefined`
are both "unanswered" and indistinguishable — a client that cleared a field and
one that never set it have said the same thing. An **empty array is an answer**:
"this has no ports" is a fact, and reading it as silence would make a rule keyed
on it never fire for exactly the products it describes.

`effectiveFieldRequirement` states the one policy decision that follows: a field
is asked for only when its condition is definitely `satisfied`; `unsatisfied` and
`unknown` both produce `hidden`. Treating `unknown` as visible deadlocks the form
— the author is told a field is required while the field whose answer would
decide that is itself not shown yet.

### Fuzz-tested, and the generator is measured too

`product-type-visibility-rule.test.ts` runs a seeded PRNG so a failure names a
reproducible case:

- **2 000 well-formed rules** — every one parses, every one is within every
  declared bound, and the parse's reported node count and depth are re-derived by
  an independent walk. 501 of them are combinator-rooted, which is the
  generator's own vacuity floor: a population of nothing but leaves would never
  exercise the recursion, the depth bound or the Kleene logic and would pass
  every assertion.
- **3 000 hostile candidates** — 2 396 refused across 10 distinct refusal codes,
  604 accepted, and every accepted one is still within every bound and evaluates
  to one of exactly three outcomes. Both populations carry a floor: the first
  version of this generator produced pure junk and accepted **11** of 3 000,
  which would have left the evaluation path essentially untested while every
  assertion passed. Mutating well-formed rules is what produces the near-valid
  population.
- **1 000 determinism cases** — evaluating twice gives the same verdict and
  mutates neither the rule nor the values.
- **Adversarial fixtures a random generator will not produce** — a cycle, a
  ten-thousand-deep chain, a `__proto__`-carrying object (every property is read
  with `hasOwnProperty`, so an inherited `node` cannot answer for a missing one),
  `NaN`/`±Infinity`, a rule read back out of jsonb that never went through the
  parser, and an unrecognised node reaching the evaluator — which answers
  `unknown`, never `satisfied`.

---

## Publication

`publishProductTypeVersion` is the only interesting operation, and everything it
does is about making the version that is about to become permanent worth having:

1. **Refuses a version scoped to no category.** An empty scope permits nothing —
   the opposite reading from `attribute_definition_categories`, whose empty scope
   means "everywhere". A scope NARROWS something otherwise general; an
   eligibility GRANTS a place, and a grant that names no destination grants none.
2. **Refuses a version that declares no field in any flow.** Both of these
   publish cleanly and then silently never apply, which is the worst failure a
   schema can have because every surface keeps working.
3. **Refuses a variant axis** the CHECK would also refuse, naming the attribute.
4. **Refuses a visibility rule that reads a field the same version and the same
   flow does not declare.** The flow matters and dropping it is the quiet
   mistake: a merchant-only field guarding a P2P field means the P2P author is
   never asked the question whose answer decides whether they see the second one,
   so the rule is permanently `unknown` and the field permanently hidden, with
   every surface reporting success.
5. **Deprecates the incumbent, then flips**, in one transaction, in that order.

These run at publication rather than at authoring because a draft is
half-finished by definition and refusing an incomplete one would make it
impossible to save work.

The lost CAS is reported rather than claimed: `setProductTypeLifecycleIfIn`
returns no row when somebody published or deprecated the version between the read
and the write, and the empty result set **is** that answer.

---

## What this domain cannot reach

`product-type-isolation.test.ts` scans both directories whole — so the walls hold
for modules nobody has written yet — with comment-stripped source, a vacuity
floor on the file count and on every file's size, and a mutation self-test that
runs a seeded positive AND a seeded negative **through the same function the real
scan calls**.

| Wall | Why |
|---|---|
| No payment, inventory or ranking import | D5: listing, offer and inventory fields are composed, never modelled. Ranking is #74's, behind its versioned policy. |
| No code-execution primitive, no `new RegExp` | The interpreter is the one place a stored row's content is interpreted at all. |
| No registry restatement in the schema file | #94 owns what a value means. |
| No outbound call, no `process.env`, no config import | There is no TTL, no cohort and no flag in this domain, and a config import would be the first step toward one. |

---

## Register: the one jsonb column

`product_type_fields.visibility_rule` — the **bounded declarative rule AST** D14
permits by name, one of the three sanctioned uses. A test asserts the four tables
carry **exactly** this one jsonb column: a count-based ceiling a later addition
erodes ends at "≥ 0", and the point of D14's register is that a new jsonb column
fails the build until somebody justifies it.

---

## The public specification layout

`GET /product-types/:key/specification-layout` (`routes/product-types.ts` +
`controllers/product-types.controller.ts`), mounted unconditionally. It closes the
seam that left the product type's ordered field groups reachable only through
`GET /catalog-authoring/schemas/:productTypeKey` — which is behind
`authenticateToken` plus a false-by-default flag — while `ProductTypeVersionView`
was served by no route at all. The consequence was that a product page could group
its specification table by entity scope (`product` versus `variant`) and by
nothing else.

- **It is a different TYPE from the authoring view, not a filtered one.**
  `PublicProductTypeSpecificationLayout` carries group keys, labels, positions and
  attribute keys. `PUBLIC_PRODUCT_TYPE_FORBIDDEN_LAYOUT_FIELDS` names the five
  authoring facts it may not carry — `id`, `flow`, `requirement`, `valuePolicy`,
  `visibilityRule` — gated statically by the DTO's shape and at runtime by a walk
  of a real emitted layout. `visibilityRule` is the one to read: it is a
  conditional expression over other fields, and publishing it would put the
  authoring form's branching on a product page.
- **It names no authoring FLOW, and is derived across every one of them.**
  `product_type_fields` rows are per flow — a P2P form is a deliberately shorter
  list than a merchant form — so serving one flow's grouping would make a
  shopper's spec table depend on which form the seller happened to fill in.
  `listProductTypeFieldsForEveryFlow` reads them all in one statement.
- **A cross-flow disagreement places NOTHING.** Two flows can put one attribute in
  two different groups and nothing in the schema forbids it (the citation trigger
  pins `variant_capable`, a different column). Such an attribute is reported in
  `conflictingAttributeKeys` and left in `ungroupedAttributeKeys` — #94's
  `conflicting` selection state applied to a layout, because picking one would
  make the table a function of which flow was read first. Grouped-versus-ungrouped
  counts as a disagreement too: "this belongs in Display" and "this belongs
  nowhere" are two different statements.
- **An empty group is still emitted**, because "this type declares no battery
  attributes" and "no such group exists" are different facts, and whether to render
  a heading with no rows is a display decision.
- **Only a PUBLISHED version**, through `findPublishedProductTypeDefinition` (a
  lookup, not "the newest of the published ones" —
  `product_type_definitions_one_published_per_key` is what makes it one). A key
  with no published version answers 404, and that 404 covers three states on
  purpose: no such key, drafts only, and a deprecated version with no replacement.
  Distinguishing them would report unpublished catalogue work to anybody who can
  guess a key.

The derivation is pure and is tested without a server in
`services/__tests__/product-type-specification-layout.test.ts`.

## Seams left to their owners, none of them a stub that lies

- **`product_type_aliases` has no reader, and the prerequisite is named (#732).**
  #732 reports three alias tables written and read by nothing. Two are now
  closed — `category_aliases` by the deterministic search-intent interpreter
  (`docs/taxonomy.md` §"Who reads them") and `attribute_value_aliases` by its
  enum pass — and this one is deliberately left open rather than pointed at the
  nearest available surface.

  `GET /catalog-authoring/product-types?categoryId=` is the obvious candidate
  and is the wrong one. Its answer is already narrowed to ONE category, and its
  only client (`packages/dashboard/app/(app)/products/wizard/index.tsx`) renders
  every option returned as a chip, with no search box in that step or in the
  category step above it. A `q` parameter there would be an API parameter no
  caller sends — green and inert by construction, which is the same defect #732
  files against the table. The vocabulary agrees:
  `PRODUCT_TYPE_ALIAS_KINDS` is `synonym | search_term | legacy_name |
  misspelling | transliteration | abbreviation | regional_term`, and the
  schema's own doc calls the lookup index "a shopper's word in a locale → the
  types it might mean". An authoring wizard is not a shopper.

  **What is missing is a product-type FILTER in retrieval.** `SearchFilters`
  (`packages/shared-types/src/search.ts`) has no member for one and
  `services/search/` names no product-type id or key, so a reader wired on the
  search side today could only ever answer `unsupported_by_retrieval` — a reader
  that can never resolve, which is worse than none because it makes #367's
  "a search for regional synonyms resolves to the same category/type/value" look
  answered at the type grain when it is not.

  The reasoning is a GATE rather than a paragraph:
  `db/__tests__/product-type-alias-seam.test.ts` asserts the premise (no
  product-type member in `SearchFilters`) and censuses the readers (none, with
  its two non-reader references named and required to match). The day the filter
  lands, that test goes red and names what to wire.
- **The STOREFRONT read.** The layout above exists and nothing consumes it:
  `packages/frontend/lib/catalog/specifications.ts` still reports
  `grouping: 'entity_scope'`. Closing it is a second `SpecificationGrouping`
  member plus the fetch — never a list composed on the client, which is the
  per-product-type spec list workstream 9 exists to delete.
- **ADR 0007 D10 — the authoring service.** `ProductTypeVersionView` is
  deliberately *not* called an authoring schema: D10 gives that name to a
  composition over this plus the registry versions, the controlled-value
  policies, the store permissions, the locale and the market, and it lives in
  `services/catalog-authoring/`. This domain resolves no attribute meaning at all.
- **ADR 0007 D4 — localization.** `name` and `label` here are base-locale
  presentation. `product_type_localizations` belongs to the localization family.
- **ADR 0007 D6 — typed variant axes on products.** `variant_capable` says an
  attribute *may* define variants for this type; the product's own declared axis
  list is authoritative for that product, and that list is step 4's.
- **ADR 0007 D9 — proposals.** `pending_proposal_policy` is the property of the
  version that decides whether a product may publish carrying a local claim while
  its proposal is pending. Nothing here creates or reviews a proposal.
- **ADR 0007 D12 — there is NO `PRODUCT_TYPES_ENABLED`, and that is deliberate.**
  D12 originally named the flag and it was never built; D12 has been corrected.
  `/product-types` is mounted **unconditionally**, because a published product
  type's group headings are catalogue metadata of the same kind `/categories` and
  `/catalog-attributes` already serve unconditionally, and a key with no published
  version answers 404 — so a deployment that has published nothing exposes
  nothing, which is what the lever would have bought. This domain still reads no
  configuration at all (a scanned gate, `product-type-isolation.test.ts`, which
  holds the strongest form of that wall in the epic). **Withdrawing a product type
  is an unpublish, not a lever**, and PUBLICATION is therefore the one staging
  boundary the authoring rollout actually has — see
  [catalog-migration-operations.md](catalog-migration-operations.md).
- **An operator HTTP surface.** None exists yet — the public layout read above is
  not one. When it arrives it belongs on the existing
  `CATALOG_OPERATOR_OXY_USER_IDS` allow-list — the one #54, #56, #57, #58, #60,
  #62, #68, #78 and #94 already share — and not a seventh list.
- ~~**The open item ADR 0007 records:** whether bundles, services and digital
  goods get their own product-type scopes or are excluded at launch.~~
  **CLOSED** by ADR 0007 D15 (#367 line 144) — see
  [`commerce-types.md`](./commerce-types.md). Bundles and multipacks FIT and get
  no product type of their own, because neither is a schema question: a bundle
  is its own canonical product carrying `bundle_components` rows and a multipack
  is a `pack_count` variant, both ADR 0002 D15's mechanisms. Services and digital
  goods are EXCLUDED, along with stored value, event admissions and consumer
  subscriptions.

  What that decision changed HERE is one tuple:
  `PRODUCT_TYPE_COMPOSITION_AXIS_KEYS` joins the reserved offer facts and the
  compatibility targets in `PRODUCT_TYPE_FORBIDDEN_VARIANT_AXIS_KEYS`, so a
  bundle's contents can never become an option row — D8's fitment argument
  applied to composition, and rendered into the same two CHECKs. `pack_count` is
  deliberately NOT a member and a test pins the absence; forbidding it would make
  every six-pack unrepresentable.
