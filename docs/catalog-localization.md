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
| The family tables | `packages/backend/src/db/schema/catalogLocalization.ts` |
| Repositories | `packages/backend/src/db/catalogLocalization/` |
| Pure resolver | `packages/backend/src/services/catalog-localization/resolve.ts` |
| Batched reads | `packages/backend/src/services/catalog-localization/read.service.ts` |
| Static gates | `packages/backend/src/db/__tests__/catalog-localization.test.ts` |
| Real-server gates | `packages/backend/src/db/__tests__/catalog-localization.realdb.test.ts` |
| Listing localization (#367) | `packages/backend/src/db/__tests__/listing-localization.realdb.test.ts` |
| Migration | `packages/backend/drizzle/0091_slimy_the_fury.sql` (`pre`), `0129_curvy_rhino.sql` (`pre`, listings) |

The failure mode that shapes all of it: **a shopper reading a raw key, a stale
translation quietly replaced by a machine, and a shared link that stopped
working because somebody edited a slug.** All three are silent — every page
still renders — and only the third is ever reported.

## Native listing localization (#367 Translation model, ADR 0007 D6/D7)

`listing_localizations` is the family's first `seller_authored` member and the
first table anywhere that exercises `exact_locale_then_base`. Its shape is the
family's, unchanged; what differs is whose words it holds, and three decisions
follow from that.

- **No cross-market fallback, but the seller's own base text still answers.** An
  `es-mx` request is never answered from a stranger's approved `es` row — that
  row is another market's copy — and is answered from `listings.title`, which is
  `NOT NULL`, so `exact_locale_only` would have rendered a page with no title.
- **It is deliberately OUTSIDE the translation desk's coverage.**
  `LOCALIZATION_COVERAGE_DOMAINS` stopped being an alias for
  `LOCALIZED_ENTITY_KINDS` and became a derivation over field class: Mercaria
  owes a translation of its own catalog copy and does not owe one of a seller's
  own words, so there is no owed population to be a denominator. Left measured,
  `alertsForRow` would raise a permanent **blocking** `untranslated` alert in
  every launch locale counting every active listing, for work nobody can action
  — a gate whose cheapest green is deleting the alert. The exclusion is recorded
  in `LOCALIZATION_COVERAGE_UNCOVERED_TABLES`, and a desk test asserts every
  uncovered kind appears there AND that the derivation's reason really is the
  field class.
- **Nothing needs to carry these rows forward, and that is measured rather than
  assumed** (the #650 question). A listing is not versioned; `archived` is a
  status on the SAME row, so a restore finds its translations untouched; and
  `listings` is not one of `MERGEABLE_ENTITY_TYPES`, so no merge disposition is
  owed and `merge-plan-census.test.ts` does not cover it. `cascade` is
  load-bearing for a different reason: production never hard-deletes a listing,
  but around twenty realdb suites do in teardown, and `restrict` would turn every
  one of them into a `23503` in a file that never mentioned localization.

**The stale trigger watches `title` AND `description`**, deliberately not
repeating `mercaria_categories_localization_stale`'s `name`-alone blind spot —
which is published as a caveat precisely so it stops being inherited. An archive
changes no localized source column, so it stales nothing.

**Full-text search does not see this text, and that is stated rather than
discovered.** `listings.search_vector` is `GENERATED ALWAYS AS … STORED` over
that row's own `title`, `description` and `tags`; a generation expression may
reference only columns of its own row, so a sibling table cannot enter it. Both
the vector and `listingRepository`'s query side are additionally pinned to the
`'english'` configuration, so French stemmed by the English analyser would index
worse than being absent. **A listing found by its English title is not found by
its French one.** The shape a fix takes is a per-locale vector on
`listing_localizations` with its own configuration and its own GIN index plus a
locale-aware query side — an index decision with numbers attached (#61's rule),
belonging with #70's canonical search, whose lexical stage already runs on
`'simple'` for exactly this reason. `listing-localization.realdb.test.ts` pins
the limitation as a measured fact, with the base-locale term as its positive
control, so it cannot quietly stop being true.

**No accessibility-label column, and that is the answer to #367's box rather
than a gap.** `navigation_node_localizations` carries one legitimately because
`navigation_nodes` has no label column at all — the label IS the localization
row — so its accessible name has no catalogue string a client could compose
from. Every entity in this family has one, and the clients already compose
correctly: `@mercaria/ui`'s `CategoryCard` renders
`t(CATEGORY_BROWSE_KEY, { category: category.name })` and `ConditionBadge`
renders `t(CONDITION_A11Y_LABEL_KEY, { label })` — a translated template from
the app's own bundle with the already-localized catalogue string interpolated. A
column here would be a second representation of that string in the same row,
drifting from it silently while rendering perfectly, audible only to a
screen-reader user. `catalog-localization.test.ts` censuses the family for one,
with navigation as the positive control that proves the detector can see one.

## The tables, and the family they belong to

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

### Two places, not one list

`localeFallbackPlan(locale, policy)` returns `{rowLocales, baseText}` rather
than a flat list, and the split is load-bearing. **The base step is not a locale
whose row may answer** — a base-locale localization row is unrepresentable
(`<table>_locale_not_base_check`), so the base string lives on the entity's own
column and is passed in. A flat list cannot say whether its last entry means a
row or a column, and that is exactly the distinction `exact_locale_then_base`
below exists to make.

`localeFallbackChain(locale, policy)` still exists, is DERIVED from the plan,
and answers a **different question**: which locales a QUERY should narrow on. It
keeps the base locale, because `attribute_labels` predates D4 and deliberately
carries no base-locale CHECK — its own schema comment names "a stray `en` row"
— so a base-locale row IS readable there. **Callers resolve with the plan and
narrow with the chain**; `catalog-localization.test.ts` asserts `resolve.ts`
contains ZERO call sites of the chain, with a positive control proving the
census can see one.

The resolution carries the **effective locale, the step, the basis and the
translation status** beside the string. An internal client debugging "why is
this English" needs the step; a public client needs the status to decide whether
to badge a machine translation. `base` is reported in preference to `language`
when the two coincide (`en-us` → `en`), because "we fell all the way back" is
the fact a reader needs and "the language happened to be the base" is not.

**A resolution that found nothing has no `value` to render.**
`LocalizedResolution` is a discriminated union on a STRING (`outcome`) — the
backend compiles with `strict: false`, and without `strictNullChecks`
TypeScript does not narrow on a boolean-literal discriminant — and its
`unavailable` branch has no `value`, no `effectiveLocale` and no `status`. "A
public client never renders a raw key" is a property of the type.

### A translation and the author's own words are different answers

The `resolved` outcome is discriminated again on `basis`, and the branches
differ in their PROPERTY SETS — `PriceHistoryValue`'s shape (#78), for its
reason:

| `basis` | Answered by | Carries |
| --- | --- | --- |
| `localization_row` | a row somebody authored FOR a locale | `status` **and** `provenance` |
| `authored_base_text` | the entity's OWN base-locale column | `status` only |

The base branch has **no `provenance` property at all**. Before
`exact_locale_then_base` every base answer was Mercaria's own catalog copy, so
reporting `mercaria` was true; it stops being true the moment a
`seller_authored` field is registered, because the base string is then the
SELLER'S own words. Removing the property is what makes the false claim
unrepresentable — a flag beside it would not, and a storefront that cannot tell
a translation from an untranslated original will eventually label one as the
other. `status` stays on both: it answers "is this text current", not "who wrote
it".

`LocalizedSlugResolution` is a separate type and its base branch DOES report
`provenance`. That asymmetry is a fact rather than an oversight: a slug is
always `catalog_presentation`, so its base is `categories.slug` — a URL Mercaria
minted — and `resolveLocalizedSlug` names its own field class, so no policy can
make a slug seller-authored.

### No text ever falls back across MARKETS, and only one class falls back at all

D4's exclusion is a property of the FIELD rather than a discipline every caller
has to remember:

- `LOCALIZED_FIELD_CLASSES` is `catalog_presentation | legal_text |
  seller_authored`, and there are THREE policies:

  | Class | Policy | Reaches |
  | --- | --- | --- |
  | `catalog_presentation` | `language_then_base` | the truncation chain, then the base column |
  | `seller_authored` | `exact_locale_then_base` | the requested locale's row, then the base column |
  | `legal_text` | `exact_locale_only` | the requested locale's row, and nothing else |

- **Two GRANT lists, asserted disjoint.**
  `CROSS_MARKET_FALLBACK_FIELD_CLASSES` grants another LOCALE'S row;
  `AUTHORED_BASE_FALLBACK_FIELD_CLASSES` grants the entity's OWN base text. A
  class in neither gets `exact_locale_only`, the narrowest, so a class added
  later reaches nothing by default. The inverse spelling — a list of EXCLUDED
  classes — makes a new class fall back by default, which is exactly backwards
  for the one thing this rule protects. Disjointness matters because two
  overlapping grant lists would make the policy a function of which `if` in
  `fallbackPolicyForFieldClass` was written first.
- `fallbackPolicyForFieldClass` is the ONE derivation, and no descriptor states
  a policy.
- `resolveLocalizedField` takes a `LocalizedFieldKey` — a literal union — and
  reads the policy out of `CATALOG_LOCALIZED_FIELDS` itself. There is no
  parameter a caller could pass, and an unregistered field is a compile error.

An `exact_locale_only` field answers `unsupported_locale` for a market Mercaria
does not author it in, which is the correct answer rather than a failure.

**Why `seller_authored` is not `exact_locale_only`.** That policy exists so a
shopper never sees ANOTHER MARKET'S copy — a market-specific claim, price copy
written for somebody else. The seller's own base text is not another market's
copy: same seller, same listing, the words they actually wrote. Withholding it
protects nobody and empties the page, because `listings.title` is NOT NULL and a
French shopper on a listing with no French row got `unavailable` and no title at
all. `legal_text` stays excluded and must not be moved: a statement about one
market's law is not made true by the same company having written it.

**`exact_locale_then_base` may never walk the chain**, or it is
`language_then_base` under a new name and the cross-market exclusion is gone.
Three mechanisms, none a convention:

1. Both exact policies read ONE row-locale producer,
   `onlyTheRequestedLocale`, whose return type is
   `readonly [SupportedLocale] | readonly []` — a tuple that cannot hold two.
2. Because they SHARE it, widening the new policy widens `exact_locale_only` in
   the same edit and turns its `unsupported_locale` tests red.
3. A population census over every supported locale plus unsupported tags with
   and without a supported truncation asserts the new policy reaches at most one
   row locale and EXACTLY what `exact_locale_only` reaches, `baseText` being the
   whole difference. It carries a positive control (`language_then_base` must
   reach strictly further somewhere — `es-cl` is the named case) and a mutation
   self-test that feeds a chain walk in and confirms both assertions fall over.

`localeFallbackPlan`'s `switch` ends in a `never` assignment, so a FOURTH policy
fails the build there rather than returning `undefined`: gating the tuple does
not gate its readers.

**Stated plainly, and counted rather than claimed: 18 fields are registered, 16
`catalog_presentation` and 2 `seller_authored`.** The two are `listing.title`
and `listing.description` (#367 Translation model, ADR 0007 D6/D7), and they are
the first fields anywhere to resolve under `exact_locale_then_base` — the policy
was added for exactly them and, until `listing_localizations` existed, was
enforced against no registered field at all.

`legal_text` is still unexercised, so `exact_locale_only` remains a mechanism
with no production data behind it. The member that will exercise it is ADR 0007
D3's navigation and campaign copy (#367 merge-order step 7).

**The positive control MOVED with the emptiness rather than being deleted.** It
used to guard `exact_locale_then_base`, because "0 fields on the new policy" and
"the census cannot read `fallback` at all" produce the same green; that bucket
now holds two real fields, so the real data is its own control and the synthetic
descriptor was re-pointed at `exact_locale_only`. Deleting it instead would have
left the remaining zero unguarded, which is how a census quietly stops being
one. The three buckets are also asserted to PARTITION the registry, so three
individually-correct counts cannot hide a fourth policy nobody is measuring.

**The total is expected to move — 14 before #712 registered
`attribute_definition.label` and `.description`, 16 before #367's Translation
model registered the two listing fields — and the exact pin in
`catalog-localization.test.ts` is how it gets noticed. Re-derive it by RUNNING
the census against the BUILT registry, never by adding the new keys to the old
total.** That is how 18 was obtained: the pin reported `expected 18 to be 16`
and the number came from the census rather than from arithmetic. Every descriptor is constructed through `describeField`, so a census
over the source literal is blind to it; and the arithmetic is right only when
nothing else changed, which is the assumption a census exists to stop you
making — a key that MOVED class, or one deleted in the same window, does not show
up in it. The claim does not rest on the total anyway: it rests on the
distribution across the three policies, which is why those are asserted
separately.

Because every registered field shares one policy today, a resolver that ignored
the descriptor and hardcoded `'language_then_base'` would pass every
behavioural test in the file. That is closed by an anchored source census over
`resolve.ts`: every `localeFallbackPlan(...)` and `localeFallbackChain(...)`
CALL SITE must take its policy from `descriptor.fallback`, from
`fallbackPolicyForFieldClass(...)` or from a forwarded `policy` parameter, and
none may name a string literal. It carries a floor across both tokens and a
mutation self-test per token, and it was verified by checking out the pre-fix
tree: 17 of the 57 cases in the file are red against it.

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

**What `publishProductTypeVersion` supplies (#650), and why it is not
`unknown`.** `deriveProductTypeSemanticChange` compares the two definition rows
and always reports `product_type.help_text` as changed. That asymmetry is a fact
about the schema rather than a judgement: `product_type_definitions` carries
`name` and `description` and **no `help_text` column at all**, so a publish holds
both strings for the first two and none for the third. Reporting the third
unchanged would leave help text describing the old question sitting at
`approved`; reporting `{ kind: 'unknown' }` instead would stale a locale holding
nothing but a name that demonstrably did not move — the "every bump is a full
re-translation" symptom this section already names. Deriving is strictly sharper
than `unknown` and never under-claims.

**The PER-FIELD grain needs no such parameter**, and the reason is the same fact
read the other way: all four of `product_type_field_localizations`' localized
columns DO have a base on `product_type_fields`, so
`copyForwardProductTypeFieldLocalizations` compares the two values directly.
A NULL → text move counts — absent means "use the cited attribute's own
wording", so a field that gained an override is asking a different question in
the same box. A field whose base text is absent on BOTH sides inherits
`attribute_labels`, which carries no `status` and no `provenance`, so there is no
staleness there to propagate; that boundary is stated rather than crossed.

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
the `exact_locale_then_base` and `exact_locale_only` ones for the same request,
so a field whose class forbids cross-market fallback is still READ and still
REFUSED by the resolver applying its own shorter plan. Narrowing on the shorter
one would be the dangerous direction: the resolver would answer
`no_text_in_locale` for text that exists, and nothing would say so.

`readLocalizedAttributeValues` does the same for #94's controlled values, and
resolves the LABEL only. `attribute_enum_values.value` is the canonical string
every assignment stores and every alias resolves to; a per-locale value would
make a stored fact mean different things in different markets, which is the
identity failure ADR 0007 D1 exists to prevent. There is no column anywhere here
that could hold one.

## The translation desk (#367 step 10)

Full reference: **[translation-desk.md](translation-desk.md)**. What is worth
knowing from here:

- The desk is `services/catalog-localization/completeness.service.ts` +
  `side-by-side.service.ts` over
  `db/catalogLocalization/completenessRepository.ts`, read through
  `/internal/catalog-localization/*` behind the SAME
  `CATALOG_OPERATOR_OXY_USER_IDS` allow-list.
- **The `(locale, status)` indexes landed with it** (migration `0114`, `pre`) —
  the reader the absence below was waiting for. All four tables carry one.
- **`localization_coverage_runs` is still absent and the desk did not change
  that.** Every figure is derived at read time, so a translation settled a
  second ago is in the next answer with no sweep having run.
- **Side-by-side review deliberately does not use `resolve.ts`.** The resolver
  falls back so a shopper never sees a raw key; a reviewer asking "is the Spanish
  approved" must never be shown the English that would be served in its place.
  It reads the exact-locale row or none.

## What is deliberately absent

- **A `localization_coverage_runs` table.** "How much of the catalogue is
  translated" is a query over these rows, and storing its answer would be a
  second representation going stale the moment a translator saves.
  `attribute_coverage_runs`' absence one file over is the precedent. The
  translation desk (#367 step 10) reads it live and stores nothing.
- **A route that settles a translation on the desk's own surface.**
  `POST /internal/catalog-governance/reviews/localization` owns that decision,
  behind the same gate and narrowed by the `translate` role grant, writing the
  audit trail. A second route to one decision is how two surfaces come to
  disagree about what it meant.
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
- **#367 step 10 (dashboard).** The translation desk LANDED — see
  [translation-desk.md](translation-desk.md) — and with it the coverage indexes
  it justifies. What is still owed is the dashboard SCREEN: every endpoint it
  needs exists and nothing in `packages/dashboard` consumes them.
- **#650 (per-field carry-forward). CLOSED.** It was the seam this list
  described as "the closing condition is a join on `attribute_key`, not on the
  row id", and that is exactly what closed it —
  `copyForwardProductTypeFieldLocalizations` matches on `(flow, scope,
  attribute_key)`, the identity `catalog-governance/diff.ts` already uses, and
  `product-type-field-identity.test.ts` pins the two against the diff's real
  output. `LOCALIZATION_STALENESS_DETECTIONS` now answers
  `carriesForwardOnVersionBump: 'yes'` for `product_type_field` with no
  `knownGapIssue`.
