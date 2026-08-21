# Language-aware full-text search over the catalogue (#367 Workstream 5)

Which PostgreSQL text-search configuration analyses a piece of catalogue text,
who decides, and why both ends of every full-text predicate have to be decided
by the same thing.

Code: `@mercaria/shared-types` `catalog-search-configuration.ts` ·
`db/schema/catalogLocalization.ts` (`listing_localizations.search_vector`) ·
`db/catalog/listingRepository.ts` (`baseTextMatch`, `textMatch`) · migration
`0131`. Tests: `db/__tests__/catalog-search-configuration.test.ts` (the map) and
`db/__tests__/listing-localization.realdb.test.ts` (everything the map does
against a real server).

## The defect

`listings.search_vector` is generated with `to_tsvector('english', …)` over the
listing's own `title`, `description` and `tags`, and `listingRepository` asked
`websearch_to_tsquery('english', …)`. Consistent, and correct for the base
locale — `MERCARIA_BASE_LOCALE` is `en` and those three columns are the seller's
base text.

`listing_localizations` (migration `0130`) then began holding the seller's French
title, and nothing indexed it. A generation expression may reference only columns
of its own row, so the base vector could not have reached it even if the
configuration had been right. **A listing found by its English title was not
found by its French one**, in an epic whose subject is a multilingual catalogue.
It was written down in three places and pinned as a measured fact — which is why
it was a known defect rather than a discovery.

## The fix, in one sentence

One `tsvector` per localization row, analysed by the configuration
`LOCALE_TEXT_SEARCH_CONFIGURATIONS` names for the ROW'S OWN locale, with its own
GIN index — plus a query side that reads the same map and unions its result with
the base vector.

## The rules that are load-bearing

- **Both sides move together, and the reason is UNRELIABILITY rather than loss.**
  Two stemmers sometimes agree on a word and sometimes do not, so a `tsvector`
  and a `tsquery` built under different configurations do not degrade a result
  set — they punch arbitrary holes in it. Measured on PostgreSQL 17 over the ten
  configurations below and three inflected word pairs: **22 of 30**
  same-configuration pairings match, **96 of 270** cross-configuration ones do.
  A mismatch is therefore neither "always broken" (which somebody would notice)
  nor "slightly worse" (which would be tolerable) — it is arbitrary, and the
  case this domain exists for is one of the holes:
  `to_tsvector('french', 'une bicyclette') @@ websearch_to_tsquery('english',
  'bicyclettes')` is FALSE. That failure is silent and looks exactly like "no
  results for that term", which is the defect above wearing a new hat, while
  neighbouring queries keep working. So there is ONE map: the generated column's
  `CASE` is rendered from
  `localesByTextSearchConfiguration()` and `textMatch` resolves through
  `textSearchConfigurationForLocale`. The realdb suite pins the agreement
  against `pg_get_expr` — the DEPLOYED expression — because a source-to-source
  comparison agrees with itself even when the database says otherwise.

- **`simple` is the answer for a language PostgreSQL cannot analyse, and
  `english` never is.** `pg_ts_config` on `postgis/postgis:17-3.5` holds
  twenty-nine configurations and three of Mercaria's twelve catalogue languages
  are not among them: Bengali, Japanese and Chinese. They take the `CASE`'s
  `ELSE`, which is `'simple'` — case folding and token splitting and nothing
  else, the choice #70's canonical lexical stage already makes for every entity
  name (ADR 0002 D21). Falling them back to the base configuration is the exact
  defect being removed, and it is worse in the localized table than it was in the
  base one: a Japanese title stemmed by the English Snowball stemmer produces
  lexemes no Japanese query reproduces, so the row indexes and never matches.
  `simple` appears in no `CASE` arm, which is what makes the default a property
  of the stored column rather than of the TypeScript map.

- **The map is a TOTAL `Record<SupportedLocale, …>`.** Adding a locale to
  `SUPPORTED_LOCALES` fails `tsc` until somebody states which analyser reads it.
  A language-prefix rule would answer for the new locale automatically, which is
  the same silent fallback about a different thing.

- **The base half is untouched and the predicate is a UNION.** A French shopper
  searching a model number, a brand, or an English word the seller left
  untranslated still has to find the listing — and only the base vector holds
  `tags`, and only the base vector exists for the very large majority of
  listings, which have no translation at all. With no locale the returned SQL is
  byte-identical to what it always was: no subquery, no join, the same plan.

- **The localized half matches the EXACT locale and never a neighbouring
  market's.** `listing.title` is `seller_authored`, so
  `fallbackPolicyForFieldClass` gives it `exact_locale_then_base`: an `es-mx`
  shopper is shown their own `es-mx` row or the seller's base text, never the
  `es` row a different seller wrote (ADR 0007 D4). Search has to find what the
  shopper will then SEE, because matching a row the page will not render sends
  them to a listing that does not contain the word they typed. `en` and every
  `en-*` short-circuit to the base half alone, since
  `listing_localizations_locale_not_base_check` makes a base-locale row
  unrepresentable and the subquery could only ever match nothing.

- **The configuration is a BOUND parameter cast to `regconfig`, not inlined
  text.** `to_tsvector(regconfig, text)` is IMMUTABLE and the cast is merely
  STABLE — which a generated column may not use and a QUERY may — so the safe
  spelling is available on the query side and nothing user-influenced reaches the
  SQL text. Measured: the planner still chooses
  `listing_localizations_search_vector_idx` for it.

- **The rendered expression is byte-stable.** Configurations sorted, locales
  sorted within each. drizzle-kit treats ANY change to a stored generated
  expression as `DROP COLUMN` + `ADD COLUMN`, which silently takes the column's
  GIN index with it and emits nothing about the index
  (`db/schema/CONVENTIONS.md`), so an ordering that depended on iteration order
  would produce a spurious rewrite on a regeneration that changed nothing.

## The map

| Language | Locales | Configuration |
|---|---|---|
| Arabic | `ar`, `ar-ae`, `ar-eg`, `ar-ma`, `ar-sa` | `arabic` |
| Bengali | `bn`, `bn-bd`, `bn-in` | `simple` — none ships |
| Catalan | `ca`, `ca-es` | `catalan` |
| German | `de`, `de-at`, `de-ch`, `de-de` | `german` |
| English | `en`, `en-ca`, `en-gb`, `en-us` | `english` |
| Spanish | `es`, `es-ar`, `es-es`, `es-mx` | `spanish` |
| French | `fr`, `fr-be`, `fr-ca`, `fr-ch`, `fr-fr` | `french` |
| Hindi | `hi`, `hi-in` | `hindi` |
| Japanese | `ja`, `ja-jp` | `simple` — none ships |
| Portuguese | `pt`, `pt-br`, `pt-pt` | `portuguese` |
| Russian | `ru`, `ru-ru` | `russian` |
| Chinese | `zh`, `zh-cn`, `zh-hans`, `zh-sg` | `simple` — none ships |

Regional tags take their language's configuration: `fr-ca` is analysed by the
French stemmer because Canadian French is French. The market half of a tag
decides fallback and presentation and says nothing about morphology.

`catalan` and `hindi` arrived in PostgreSQL 16. Every environment that runs these
migrations is PostgreSQL 17 — the shared `oxy-postgres` RDS instance, the CI
service container and the local compose file all pin it.

## The wire

`GET /listings?q=…&locale=…`. The parameter is shape-checked and NOT
membership-checked against `SUPPORTED_LOCALES` — the spelling every other
locale-taking query parameter already uses — because a tag Mercaria does not
support is not an error a shopper can act on, their browser sent it, and refusing
the whole browse over it would turn "we have no Icelandic translations" into
"search is broken". It narrows nothing on its own and has no effect without `q`.

## What this deliberately does NOT fix

- **Accents are not folded.** `unaccent` is an extension this deployment may not
  have (`services/catalog-governance/quality.service.ts` says so for the
  duplicate-category scan and this inherits the constraint), so
  `to_tsvector('french', 'en bon état')` indexes `état` while
  `websearch_to_tsquery('french', 'etat')` asks for `etat` — measured, they do
  not match, and Spanish behaves the same (`niños` → `niñ`, `ninos` → `nin`).
  This is not a regression: the base English vector has always behaved this way.
  Installing `unaccent` and wrapping BOTH sides in it is a separate change, and
  it is a both-sides change for the reason at the top of this file.

- **`simple` does not segment CJK.** Japanese and Chinese are written without
  spaces, so `to_tsvector('simple', …)` emits one lexeme per whitespace-delimited
  run. Those locales get matching on whatever the seller separated, plus reliable
  matching of Latin brand names and model numbers inside the text — strictly more
  than before, and honestly less than a segmenting analyser would give. Closing
  it means a segmentation extension (`pg_bigm`, `zhparser`, MeCab), which is an
  infrastructure decision with numbers attached and belongs to `oxy-infra`.

- **No ranking.** The predicate is a membership test. `ts_rank` over a localized
  vector, and how it would compose with #74's policy versions, is not answered
  here and nothing in this change reaches the ranking domain.

- **Nothing else localized is indexed.** Category, product-type, attribute and
  controlled-value localizations keep the `'simple'` canonical vectors ADR 0002
  D21 chose for them; this is a listing-surface change.

- **No index decision with numbers attached.** The GIN index is asserted to exist
  and to be usable by the predicate; whether the planner would prefer it at
  production scale is #61's harness (`docs/performance/`) and not this change.
  One index on a table that holds one row per translated listing per locale is
  the same shape `listings_search_vector_idx` already has.

## How the tests can fail

Three mutations were run against the realdb suite, each with its exit code
captured, plus a green control before and after:

| Mutation | Effect | Red case |
|---|---|---|
| the query side asks in the BASE configuration | vector French, query English | *finds a listing by its French title only when the French locale is asked for* |
| the `CREATE INDEX` is removed from `0131` | no GIN index | *carries the GIN index, and the predicate can be served by it* |
| the column's French arm analyses as `english` | vector English, query French | *matches NOTHING when the query is built under the wrong configuration* and *routes EVERY supported locale to the arm the map names* |

The per-locale census carries its own vacuity floor, and it is the assertion that
makes the census mean anything: the loop compares each stored vector against its
OWN configuration's analysis, so it passes trivially for two configurations the
probe cannot tell apart. Measured — `stops running quickly`, the first probe
tried, collapses `simple`, `arabic`, `german`, `portuguese` and `spanish` onto
ONE vector, under which a bug routing `es` to `simple` is invisible.
`LOCALE_PROBE_TEXT` carries one inflected word per stemmer (`estacoes` is the
only pair found that separates Portuguese from Spanish) and the floor asserts it
separates all ten.
