# Catalog localization (#367, ADR 0007 D4)

How a category, a product type and a controlled value are presented in a
shopper's language — and, much more of the work, what stops a translation
becoming a second answer to what those concepts ARE.

**Binding decisions:** ADR 0007 D4, with D1 (identity is `id` + `key`, never a
label or a slug) and D13 (what is retained, extended and retired) constraining
it. **Schema decisions:** `packages/backend/src/db/schema/CONVENTIONS.md`.

| Piece | Path |
| --- | --- |
| Vocabulary, field registry, resolution DTOs | `packages/shared-types/src/catalog-localization.ts` |
| Four tables | `packages/backend/src/db/schema/catalogLocalization.ts` |
| Repositories | `packages/backend/src/db/catalogLocalization/` |
| Pure resolver | `packages/backend/src/services/catalog-localization/resolve.ts` |
| Batched reads | `packages/backend/src/services/catalog-localization/read.service.ts` |
| Static gates | `packages/backend/src/db/__tests__/catalog-localization.test.ts` |
| Real-server gates | `packages/backend/src/db/__tests__/catalog-localization.realdb.test.ts` |
| Migration | `packages/backend/drizzle/0091_slimy_the_fury.sql` (`pre`) |

The failure mode that shapes all of it: **a shopper reading a raw key, a stale
translation quietly replaced by a machine, and a shared link that stopped
working because somebody edited a slug.** All three are silent — every page
still renders — and only the third is ever reported.

## Four tables, and the family they belong to

`category_localizations`, `category_localized_slugs`,
`product_type_localizations`, `attribute_value_localizations`. A single
polymorphic `(entity_type, entity_id, locale, field, value)` table was rejected
by the ADR: `entity_id` could carry no foreign key, so an orphaned translation
of a deleted category would be invisible — no constraint could refuse it and no
join could find it.

The cost of per-entity tables is that four shapes can drift into four slightly
different ones, which is the census a polymorphic table gets for free.
`LOCALIZATION_FAMILY_COLUMNS` states the shape once, and
`catalog-localization.test.ts` walks the real drizzle tables and fails the build
on a member that drifted, on a `_localizations` table nobody registered in
`CATALOG_LOCALIZATION_TEXT_TABLES`, and on an exemption list that grew.

**`attribute_labels` (#94) is the family's fourth text member and is ADOPTED,
not duplicated.** It predates D4 and lives in `db/schema/attributeRegistry.ts`,
which #94's owner holds, so it does not yet carry `status`, `provenance`,
`source_locale`, `source_revision`, `reviewed_by_oxy_user_id` or `reviewed_at`.
That is recorded as the single entry in
`LOCALIZATION_FAMILY_COLUMN_EXEMPTIONS`, the exemption count is asserted at
exactly one, and the gate additionally asserts the exemption is REAL — the day
that table gains the columns, the assertion goes red and the entry is deleted
rather than left behind. Until then `attribute_definition` is deliberately not a
`LocalizedEntityKind`: a `LocalizationCandidate` built from an `attribute_labels`
row would have to invent a status and a provenance, and a resolver reporting a
machine translation as approved is worse than one that cannot answer.

## The base locale is not a row, and that is a CHECK

`categories.name` IS the base-locale name. `<table>_locale_not_base_check` is
rendered from `MERCARIA_BASE_LOCALE`, so a localization row carrying the base
locale has no row shape at all — there is exactly one place each base string
lives, and nothing to disagree with it.

The consequence shows up in the resolver's signature: `baseValue` is passed IN,
read from the entity's own column, because it is the only place the base step
can be answered from. `category.description` is passed `null` for the same
reason and this is honest rather than a gap — `categories` carries no
description column, so a category nobody described has no description, and
deriving one from the name is how a catalogue starts asserting things nobody
wrote.

`MERCARIA_BASE_LOCALE` is `en`, a LANGUAGE and not a market: base catalog copy
is not United States English, and picking `en-us` would make every other English
market a fallback from one market's copy.

## `SUPPORTED_LOCALES` is derived, not invented

Forty lowercase BCP 47 tags, and they are exactly the set the storefront's own
`lib/i18n/index.ts` can present — its twelve translation bundles plus every
regional tag it aliases onto one. A catalog translation in a locale no Mercaria
client can render is a translation nobody reads; a market tag the client CAN
carry (`es-mx`) has to be storable or the ADR's own fallback example has nothing
to fall back from.

Stored **lowercase**, which is `attribute_labels`' existing decision one table
over: BCP 47 tags are case-insensitive, so `zh-Hans` and `zh-hans` are one tag,
and two spellings of one tag in one column is a lookup that misses rather than
an error anybody sees. Canonical casing is presentation and belongs at the
`Intl` boundary, which accepts the folded form unchanged.

## The fallback chain

exact locale → the supported truncations of that locale → the base locale.

```
es-mx  →  es-mx, es, en
es-cl  →  es, en          (es-cl is not authored; only its truncation is)
sw-ke  →  en
```

Truncation is mechanical rather than a hand-maintained per-tag map, and that is
deliberate: a second list is one more thing to keep in step with
`SUPPORTED_LOCALES`, and a stale entry fails silently by falling back to a
locale nobody authors. The truncations are FILTERED to supported tags, so no
step of the chain can name a locale with no row shape.

The resolution carries the **effective locale, the step and the translation
status** beside the string. An internal client debugging "why is this English"
needs the step; a public client needs the status to decide whether to badge a
machine translation. `base` is reported in preference to `language` when the two
coincide (`en-us` → `en`), because "we fell all the way back" is the fact a
reader needs and "the language happened to be the base" is not.

**A resolution that found nothing has no `value` to render.**
`LocalizedResolution` is a discriminated union on a STRING (`outcome`) — the
backend compiles with `strict: false`, and without `strictNullChecks`
TypeScript does not narrow on a boolean-literal discriminant — and its
`unavailable` branch has no `value`, no `effectiveLocale` and no `status`. "A
public client never renders a raw key" is a property of the type.

### Legal and seller-authored text never falls back across markets

D4 excludes them, and the exclusion is a property of the FIELD rather than a
discipline every caller has to remember:

- `LOCALIZED_FIELD_CLASSES` is `catalog_presentation | legal_text |
  seller_authored`.
- `CROSS_MARKET_FALLBACK_FIELD_CLASSES` is a GRANT list containing only the
  first. A class added later is excluded by omission and shows nothing rather
  than showing somebody else's market's copy; the inverse spelling — a list of
  excluded classes — makes a new class fall back by default, which is exactly
  backwards for the one thing this rule protects.
- `fallbackPolicyForFieldClass` is the ONE derivation, and no descriptor states
  a policy.
- `resolveLocalizedField` takes a `LocalizedFieldKey` — a literal union — and
  reads the policy out of `CATALOG_LOCALIZED_FIELDS` itself. There is no
  parameter a caller could pass, and an unregistered field is a compile error.

An `exact_locale_only` field answers `unsupported_locale` for a market Mercaria
does not author it in, which is the correct answer rather than a failure.

**Stated plainly: no field in today's registry carries `legal_text` or
`seller_authored`.** All six are `catalog_presentation`. The derivation is
unit-tested for both policies and the chain is unit-tested under both, so the
mechanism is measured rather than assumed — but no registered field exercises
`exact_locale_only` end to end yet. The first that will are ADR 0007 D3's
navigation and campaign copy (#367 merge-order step 7) and D6/D7's
seller-authored listing text.

Because every registered field shares one policy today, a resolver that ignored
the descriptor and hardcoded `'language_then_base'` would pass every
behavioural test in the file. That is closed by an anchored source census over
`resolve.ts`: every `localeFallbackChain(...)` CALL SITE must take its policy
from `descriptor.fallback` or from `fallbackPolicyForFieldClass(...)`. It
carries a floor of two call sites and a mutation self-test, and it was verified
by mutation — hardcoding the literal in the real file turns it red.

## Two rules the database holds, because a service would forget them

### Machine translation may never overwrite reviewed or approved text

Three mechanisms, and none of them covers the others:

| Mechanism | Refuses |
| --- | --- |
| `mercaria_localization_machine_write_guard` (trigger, on all three text tables) | the TRANSITION — a machine UPDATE landing on `reviewed`/`approved` |
| `<table>_machine_status_check` | the ROW — `provenance = 'machine'` beside `status in ('reviewed','approved')`, which an INSERT would otherwise write with no UPDATE trigger to fire |
| `<table>_machine_reviewer_check` | a machine row wearing somebody else's review — the case a machine write that ALSO downgraded the status would otherwise slip through |

**`stale` is deliberately NOT a refused status, and it is the case worth reading
twice.** A stale row is human text that no longer describes the source, so a
fresh machine translation of the NEW source legitimately replaces it — a
reviewer's decision about text that has since changed is not a decision about
the text that changed it. D4's trigger names `reviewed` and `approved` and this
is that reading, made explicit so nobody "fixes" it.

### A source-semantics change marks dependents `stale`, and never blanks them

`mercaria_categories_localization_stale` fires on `categories.name` changing;
`mercaria_attribute_enum_values_localization_stale` fires on
`attribute_enum_values.label` OR `.value` changing (one is the source text every
translation was made from, the other is the meaning). Both rewrite only
`machine_translated | reviewed | approved` — `missing` has nothing to stale and
`deprecated` is text somebody withdrew, so restating either would turn a source
edit into a status a reviewer has to undo.

**A stale translation is still the best text available.** Withdrawing it would
show raw keys to shoppers, which is the failure the whole family exists to
prevent, so the trigger moves the status and leaves the string exactly where it
was. `source_revision` is recorded by the writer and is deliberately NOT what
the trigger compares: `categories` carries no revision column, so a comparison
against it would be a check that can never fire.

Both triggers are mutation-tested: removing either from the migration turns
exactly the cases that name it red, and nothing else.

## A product-type version bump: copy forward, stale only what changed

Localization is per VERSION, not per key — `UNIQUE(product_type_definition_id,
locale)`. Confirmed against what D5 actually built:
`product_type_definitions_key_version_key` is unique on `(key, version)` and
`product_type_definitions_one_published_per_key` is a partial unique, so a
version IS a row with its own `id`. The grain follows from the freeze: a
published version's meaning is immutable, and a translation is of a meaning, so
a v2 that changed what a field asks for must not present v1's help text
describing a question nobody is being asked any more. That failure renders
perfectly.

**The consequence, designed for here rather than discovered later.** Per-version
grain means publishing v2 starts every locale at nothing — including for the
fields v2 never touched — so a new version ships untranslated in every market,
and the fix somebody reaches for is "read the previous version's text when this
one has none". That is exactly the inheritance the freeze forbids, arriving
through a side door.

`copyForwardProductTypeLocalizations` is the shape that gives both. Rows are
COPIED, so each version owns its own text and nothing is read through a pointer
at another version, and only the rows whose text no longer describes the version
are marked `stale` — which already means "still the best text available, needs
review", exactly the state an unchanged field's translation is in.

**This domain does not compute what changed, and the type makes saying so
mandatory.** A diff of two product-type versions is D5's (its schema diff and
impact preview); a copy forward that guessed would either stale everything —
making every bump a full re-translation, the symptom — or stale nothing, which
is the inheritance. `ProductTypeSemanticChange` is a two-member union:

- `{ kind: 'diffed', changedFields }` — the localized fields whose meaning moved.
  `changedFields` MAY be empty, and that is a real claim: a version that
  reordered fields or tightened a validation rule changes nothing about what its
  NAME means, and its translations carry forward `approved`. A diff that returns
  empty because it is BROKEN is a bug in the diff and belongs there — only the
  code comparing two versions can tell a genuine "nothing changed" from a
  comparison that failed.
- `{ kind: 'unknown' }` — a caller that cannot diff must be able to say so, and
  saying so stales EVERYTHING. The safe direction for a claim about somebody
  else's text.

There is deliberately no way to omit the parameter. A copy forward defaulting to
"nothing changed" is the silent inheritance arriving through an argument nobody
passed.

Four properties worth knowing, each pinned by a realdb case:

- **Granularity is per FIELD and per ROW.** A row carries all three localized
  fields, so a naive "any field changed ⇒ stale" collapses the whole
  distinction. The rule asks whether the row holds TEXT for a field that
  changed: a locale with no help text is not staled by the help text being
  rewritten, because nothing it holds stopped being true. Mutation-tested —
  removing that condition turns exactly that case red.
- **`ON CONFLICT DO NOTHING`,** because a publish path may be retried and by the
  second attempt a translator may already have written the new version's
  Spanish. Overwriting fresh work with older text is worse than doing nothing,
  and the skipped locales are COUNTED so a caller can see it happened.
- **`deprecated` rows are not carried.** A withdrawal was a decision about the
  old version's text; resurrecting it against a new meaning would re-publish
  something somebody removed. The successor having no row reads correctly as
  "not translated".
- **The reviewer travels with the text.** A `stale` row keeps
  `reviewed_by_oxy_user_id` — which is why `_reviewed_audit_check` is one-way
  rather than a biconditional — so whoever picks the queue up can see who
  settled the sentence they are being asked to re-read.

`staleOnArrival` counts rows that ARE stale, not rows this call staled: a source
row already stale before the bump carries its status across and is counted too.
That is the number a caller wants — "how much review did this bump create" — and
it is counted off what was WRITTEN, so it cannot report a copy that never
happened.

**Owed by D5's branch:** calling this from the publish transaction with a real
diff. Nothing else here changes.

## Localized slugs are their own rows

`category_localized_slugs`, with two uniques and the full one doing the
interesting work:

- `UNIQUE(locale, slug)` covers RETIRED rows too, so a slug retired from
  category A can never be reissued to category B. Without it every link to A's
  old URL would resolve to B — a redirect that silently lies, which is worse
  than a 404.
- `UNIQUE(category_id, locale) WHERE superseded_at IS NULL` makes "the current
  slug" a single row rather than a query with a bug in it.
- `mercaria_category_localized_slug_frozen` refuses an UPDATE of the category,
  the locale or the slug. A slug change is a NEW row plus a redirect, so a link
  somebody shared cannot be broken by an edit.

**No `status` column.** `superseded_at` already answers the only lifecycle
question a slug has, and a `deprecated` status beside it would be a second
answer to it. `provenance` stays, because "a person chose this URL" and "it was
generated from the localized name" are genuinely different facts.

Issuing a slug is three statements in one transaction and their ORDER is the
constraint: the partial unique means the outgoing slug is retired BEFORE the
incoming one exists, so the successor pointer is written last. The opening read
takes `FOR UPDATE` — without it two concurrent renames both retire the live slug
and the loser rolls back having briefly left the category with no URL.

Re-issuing a slug a category used to have REVIVES the original row rather than
minting a second, which is not a workaround for the unique but the correct
answer: the row every old link resolves through becomes current again.

The base-locale slug is `categories.slug`, unchanged. Whether that column is
eventually retired is the taxonomy owner's decision (ADR 0007 D2/D13) and this
table does not pre-empt it. Composing a redirect from a retired hit is
`category_redirects`' job, also the taxonomy module's;
`findCategoryByLocalizedSlug` answers WHICH category and nothing about what to
send back.

## Reads

`readLocalizedCategories(ids, locale)` is three statements for a whole page —
the categories, their localizations and their current localized slugs — and
resolves each field through the pure resolver. A per-row resolution is an N+1
the moment a category list grows past one screen.

The locale narrowing uses the `language_then_base` chain, which is a SUPERSET of
the `exact_locale_only` one for the same request, so a field whose class forbids
cross-market fallback is still READ and still REFUSED by the resolver walking
its own shorter chain. Narrowing on the shorter chain would be the dangerous
direction: the resolver would answer `no_text_in_locale` for text that exists,
and nothing would say so.

`readLocalizedAttributeValues` does the same for #94's controlled values, and
resolves the LABEL only. `attribute_enum_values.value` is the canonical string
every assignment stores and every alias resolves to; a per-locale value would
make a stored fact mean different things in different markets, which is the
identity failure ADR 0007 D1 exists to prevent. There is no column anywhere here
that could hold one.

## What is deliberately absent

- **A `(locale, status)` index.** It is the obvious index for "every category
  still owing a Spanish name", and nothing reads that question today — the
  translation desk that asks it is #367 merge-order step 10. Three indexes over
  three tables each carrying roughly (entities × locales) rows is a real write
  cost paid on every translation save; adding one later is a one-statement
  additive migration, and one whose reader never arrives is permanent.
- **A `localization_coverage_runs` table.** "How much of the catalogue is
  translated" is a query over these rows, and storing its answer would be a
  second representation going stale the moment a translator saves.
  `attribute_coverage_runs`' absence one file over is the precedent.
- **A rollout flag, and the prediction below was RESOLVED the other way.** This
  bullet used to say D12's `CATALOG_LOCALIZATION_ENABLED` "lands with the first
  surface that serves these reads". Two surfaces now serve them —
  `services/facets/facet.service.ts` and
  `services/catalog-authoring/schema.service.ts` — and **the flag was never
  built, deliberately**: both consumers sit behind their own mounts
  (`FACETS_ENABLED`, `CATALOG_AUTHORING_ENABLED`), so localized reads are
  transitively contained and turning those two off leaves no public surface
  serving a localized label. D12 has been corrected to say so. **The condition
  that would flip it:** a THIRD consumer of `readLocalizedCategories` or
  `readLocalizedAttributeValues` on an unconditionally-mounted route makes
  localized reads un-rollbackable, and **nothing gates against that** — there is
  no isolation test for this domain. Such a consumer means either building the
  lever or gating the new route. See
  [catalog-migration-operations.md](catalog-migration-operations.md).
- **Any jsonb.** Every localized string, its status, its provenance and its
  review audit are real columns with real constraints (ADR 0007 D14).

## Seams, each named rather than stubbed

- **#367 step 3 (product types).** Three things, none of them a stub.
  `product_type_localizations.product_type_definition_id` carries no foreign key
  yet: the relation IS decided (`cascade`) and is ledgered in
  `DEFERRED_FOREIGN_KEYS`, and `schema-conventions.test.ts` REFUSES that
  deferral the moment `product_type_definitions` enters the barrel — that branch
  merges FIRST, so the conversion happens in this branch's own rebase rather
  than being discovered as a red build. It also owes the stale trigger on its
  own source table, in the shape the two here already take, and the call to
  `copyForwardProductTypeLocalizations` from its publish transaction with a real
  diff (see the version-bump section above; the function is complete and
  exercised).
- **#94's owner (`db/schema/attributeRegistry.ts`).** `attribute_labels` owes
  the six family columns and the machine-write trigger, plus the deletion of the
  one exemption entry.
- **#367 step 1 (taxonomy).** `category_redirects` and the decision about
  `categories.slug`'s future.
- **#367 step 7 (navigation).** `navigation_node_localizations` joins the family
  — its name must be added to `CATALOG_LOCALIZATION_TEXT_TABLES` or the census
  fails the build, which is the point — and its campaign copy is the first
  plausible `legal_text` / `seller_authored` member of the field registry.
- **#367 step 10 (dashboard).** The translation desk, and the coverage index it
  justifies.
