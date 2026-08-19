# The translation desk (#367 merge-order step 10)

What is translated, what is owed, which of the gaps a launched market will hit,
and what a reviewer sees when they open one.

`catalog-localization.md` owns what a localization IS. This owns the questions
asked ABOUT the set of them. Code:

| Thing | Where |
|---|---|
| Measurement vocabulary | `@mercaria/shared-types` `catalog-localization-desk.ts` |
| The queries, with their denominators | `db/catalogLocalization/completenessRepository.ts` |
| Report + alerts | `services/catalog-localization/completeness.service.ts` |
| Side-by-side review | `services/catalog-localization/side-by-side.service.ts` |
| Operator surface | `routes/internal-catalog-localization.ts` (3 GETs) |
| Gates | `db/__tests__/catalog-localization-desk.test.ts`, `services/__tests__/localization-completeness.realdb.test.ts` |

## The one figure that can lie

A coverage percentage computed over the localization ROWS is vacuous. A locale
nobody has started has no rows, so every ratio over them is `0/0`, and **"we
found nothing" reads identically to "there is nothing to find"**.

So every denominator here is counted from the ENTITY table — a count no
localization row participates in, and one the translation work cannot move:

| Domain | Owed population |
|---|---|
| `category` | `categories` where `lifecycle = 'published'` |
| `product_type` | `product_type_definitions` where `lifecycle = 'published'` |
| `product_type_field` | fields of a published version carrying at least one base-locale string |
| `attribute_value` | `attribute_enum_values` whose definition is `active` |

Three domains, four different rules, and **none of them is derivable from a
localization row** — which is exactly why a report built only from those tables
cannot have a denominator at all.

`LocalizationCompleteness` then makes the residual case unrepresentable rather
than merely handled: its `no_population` branch carries **no `settledBps`
property**, so a renderer cannot print `100%` for a domain with nothing in it.
That matters most on a fresh deployment, where every domain is empty and a
percentage-shaped answer would report the catalogue fully translated before
anybody had written a word.

### `absent` and `missing` are different facts

The schema's `<table>_missing_text_check` makes `missing` a row somebody OPENED
to say a translation is owed. `absent` is no row at all — and it is the figure a
`group by` over the localization tables structurally cannot produce.

A desk that has triaged its whole backlog and one that has triaged none of it
have the same TOTAL and completely opposite next actions, so the two are
returned separately and a caller adds them if it wants to.

## Staleness is detected four ways and a summed `stale` adds four facts

`LOCALIZATION_STALENESS_DETECTIONS` publishes, per domain, what marks its
translations stale, what that mechanism watches, and — the half that matters —
what it therefore cannot see. The descriptors travel in the report PAYLOAD and
on each individual alert, because a caveat a consumer has to look up is one three
consumers render three ways and two of them omit.

| Domain | Mechanism | Blind spot |
|---|---|---|
| `category` | trigger `mercaria_categories_localization_stale` | watches `name` ALONE — a `categories.description` edit marks NOTHING stale, and `category.description` is a registered localized field |
| `attribute_value` | trigger on `label` + `value` | none |
| `product_type_field` | trigger on all four base columns | none for in-place edits |
| `product_type` | service `copyForwardProductTypeLocalizations` | a `draft`/`review` version's source text can be edited with nothing marking its translations stale |

`catalog-localization-desk.test.ts` reads the trigger SQL back and asserts every
claimed `watches` column appears in the WHEN clause **and every claimed blind
spot does not** — so a caveat cannot warn about a case that is actually covered.
It also asserts the mechanisms are not all one value, which is what fails if
somebody "simplifies" the asymmetry away.

### The other question: what survives a version bump

`carriesForwardOnVersionBump` is a separate field because it is a separate
failure. `product_type_field` answers **`no`** and names **#650**:
`product_type_field_localizations` hangs off a FIELD, `product_type_fields` rows
are frozen and re-minted per version, and the copy forward carries only
version-level text. So that domain's completeness collapses to zero for a key on
a version bump **through no translator's doing**, and a desk reading the figure
without the caveat would conclude its translators had stopped working.

## Launch locales

`LAUNCH_LOCALES` is DERIVED from `packages/ui/src/i18n/locales.ts` — the one
registry all three Expo apps consume — folded to the stored lowercase form and
minus the base locale. A catalog translation into a locale no app ships reaches
nobody; a locale an app ships and the catalog lacks is a gap a real shopper reads
in English.

It is a **code constant, not an environment variable**: which markets Mercaria
has launched is a published policy, so widening it is a commit with an author and
a date. It is not derived by IMPORTING the UI registry either — `@mercaria/ui` is
an Expo package consumed from source by Metro and the backend has no business
resolving it — so the two halves are committed together and held together by a
gate that reads the registry off disk and compares both directions.

## The alerts are findings, not a transport

Mercaria has no outbound mail transport. `services/guest-portal/transport.ts` is
an empty registry and `services/price-alerts/transport.ts` is another, both
failing closed and visibly. This surface does the same: it produces a readable
finding and **sends nothing**. A `console.log` transport would look like a
working feature in every test and deliver nothing in production, which is worse
than the honest absence.

Four kinds, and there is deliberately no `ok` member — an alert set is the
findings, and a "no problem" finding is how a list of problems acquires padding
that hides the real ones:

- `untranslated` — **blocking**. A launched market whose shopper reads English.
- `stale` — warning. Still served, still the best available.
- `machine_only` — warning. Servable text nobody has settled.
- `unmeasurable` — the vacuity finding: rows exist for a locale whose owed
  population is zero, so the denominator rule and the data disagree.

`evaluatedPairs` is in the PAYLOAD, not a log line: an empty `alerts` array from
a run that examined nothing is byte-identical to one from a run that examined
everything and found nothing wrong, and this count is the only thing that tells
them apart. It is computed from `domains × launchLocales` rather than from the
rows returned, so a repository that silently returned fewer could not lower its
own floor to match.

## Side-by-side review does not resolve

This is the one localized read that deliberately does NOT go through
`resolve.ts`. The resolver's whole job is to fall back so a reader never sees a
raw key; a reviewer asking "is the Spanish approved" must never be shown the
English that would be served in its place and told it is the Spanish. That is the
one question fallback makes unanswerable.

So: the exact-locale row or none. `LocalizedFieldTarget`'s `absent` branch
carries no text, no status and no provenance, so a fallback has no field to be
rendered into — and neither `localeFallbackChain` nor `LocalizationCandidate` is
imported by that module, which keeps it true for whoever edits it next.
`declared_missing` is a third branch rather than a ternary, because only that
state means a person has already looked.

`LOCALIZED_FIELD_BASE_SOURCES` records where each registered field's base text
lives, and that three of them have nowhere: `categories` has no description and
`product_type_definitions` has no help text. The descriptor travels on every
comparison so an empty source box is explained rather than reading as "the source
was blank". A gate walks the real drizzle columns in BOTH directions, so a base
column added later fails the build rather than leaving the desk reporting "no
source" for a field that now has one.

## Why this is not a sixth completeness query

`services/catalog-governance/quality.service.ts` already answers translation
completeness — for CATEGORIES per locale (`measureLocaleCompleteness`), and for
product types at a different grain entirely (`measureProductTypeCompleteness` is
keyed by product-type KEY with every supported locale as its denominator, so it
cannot answer "how complete is Spanish for product types"). Neither covers
`attribute_value` or `product_type_field` at all.
`catalog-observability`'s `tallyLocalizationStatuses` counts ROWS by status with
no denominator.

What is new is the uniform (domain × locale) grain, the `absent` split, and the
denominators. Where the grains coincide — category × locale — the two must not
disagree, and that is held by a gate rather than a promise: the realdb suite runs
both against one database and asserts the same `owed`, the same human-settled
count and the same `stale` count per locale.

## The route set is closed and read-only

Three GETs on `/internal/catalog-localization`, behind
`CATALOG_OPERATOR_OXY_USER_IDS` (empty ⇒ not mounted, 404 never 401). The
omissions are the design — there is no route that settles a translation
(governance owns that decision), requests a machine translation, recomputes a
report (nothing is stored), or marks something stale (that would be a fourth
mechanism disagreeing with the four that detect it). The set is asserted exactly
off the router's own stack, and that it registers no write verb.

## Deferred, each named rather than stubbed

- **Diff, history and rollback of a translation's TEXT.** Not built, and it is
  not a small gap: translations are upserted in place, so the current row is the
  only copy and history is not derivable. `catalog_governance_audit_events`
  records THAT a translation's status changed and deliberately omits the text
  ("a translation body in an audit row is a copy of the text a correction can
  never reach" — `services/catalog-governance/review.service.ts`), and
  `CATALOG_GOVERNANCE_SUBJECT_KINDS` has no `localization` member. So this needs
  either a widened closed tuple plus a migration, or its own append-only
  revision table. It is a separate PR and it owes a decision about which.
- **The dashboard screen.** Every endpoint it needs exists;
  `packages/dashboard` consumes none of them.
- **An outbound transport for the alerts**, per the section above.
- **`attribute_labels` and `navigation_node_localizations`**, both named in
  `LOCALIZATION_COVERAGE_UNCOVERED_TABLES` with the reason and the owner. The
  census asserts covered ∪ uncovered equals the whole family EXACTLY, so a new
  member fails the build until somebody decides.
