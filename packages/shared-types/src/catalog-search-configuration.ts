/**
 * Which PostgreSQL text-search configuration analyses a locale's catalogue text
 * (#367 Workstream 5, "define language-aware tokenization/folding behavior").
 *
 * ## The defect this module exists to remove
 *
 * `listings.search_vector` is generated with `to_tsvector('english', …)` and
 * `listingRepository`'s base predicate asks `websearch_to_tsquery('english', …)`.
 * Consistent, and correct for the base locale — and until #367 Workstream 5 it
 * meant **a listing found by its English title was not found by its French
 * one**, in an epic whose subject is a multilingual catalogue.
 *
 * `listing_localizations` now carries its OWN `search_vector`, analysed by the
 * configuration this module names for the row's own locale, with the query side
 * reading the SAME map. The base vector is untouched and the predicate unions
 * with it.
 *
 * ## Both sides must move together, and the reason is UNRELIABILITY, not loss
 *
 * Two stemmers sometimes agree on a word and sometimes do not, so a `tsvector`
 * and a `tsquery` built under different configurations do not degrade a result
 * set — they punch unpredictable holes in it. Measured on PostgreSQL 17 over the
 * ten configurations below and three inflected word pairs: a query built under
 * the vector's OWN configuration matched 22 of 30 pairings, and one built under a
 * DIFFERENT configuration matched 96 of 270. So a mismatch is neither "always
 * broken" (which somebody would notice) nor "slightly worse" (which would be
 * tolerable) — it is arbitrary.
 *
 * The case this module exists for is one of the holes:
 * `to_tsvector('french', 'une bicyclette') @@ websearch_to_tsquery('english',
 * 'bicyclettes')` is FALSE, measured. That failure is silent and looks exactly
 * like "no results for that term" — which is the bug being removed, wearing a
 * new hat. So there is ONE map, both sides read it, and
 * `listing-localization.realdb.test.ts` pins the agreement against a live server
 * rather than against these two source files.
 *
 * ## `simple` is the answer for a language PostgreSQL cannot analyse — never `english`
 *
 * PostgreSQL ships a fixed set of configurations (`pg_ts_config`). Measured on
 * `postgis/postgis:17-3.5`, the image CI and local development pin, it holds
 * twenty-nine of them, and three of Mercaria's twelve catalogue languages are
 * not among them: Bengali, Japanese and Chinese.
 *
 * Those locales get {@link UNANALYZED_TEXT_SEARCH_CONFIGURATION} — `'simple'`,
 * which folds case and splits on token boundaries and does nothing else. That
 * is the same choice #70's canonical lexical stage already makes for every
 * entity name (ADR 0002 D21), for the same reason: an analyser that does not
 * know the language is worse than no analyser, because it stems and stop-words
 * confidently and wrongly.
 *
 * The one answer that is never given is `'english'`. Falling an unsupported
 * locale back to the base configuration is the exact defect being removed, and
 * it is worse in the localized table than it was in the base one: a Japanese
 * title stemmed by the English Snowball stemmer produces lexemes no Japanese
 * query will reproduce, so the row indexes and never matches — a search that
 * measures nothing while looking like it works.
 * `catalog-search-configuration.test.ts` asserts `'english'` is reachable from
 * exactly the `en*` locales, with an unknown-locale control.
 *
 * ## What this does NOT fix, stated rather than discovered
 *
 * **Accents are not folded.** `unaccent` is an extension this deployment may
 * not have (`services/catalog-governance/quality.service.ts` says so for the
 * duplicate-category scan and this module inherits the same constraint), so
 * `to_tsvector('french', 'en bon état')` indexes `état` and
 * `websearch_to_tsquery('french', 'etat')` asks for `etat` — measured, they do
 * not match. Spanish is the same (`niños` → `niñ`, `ninos` → `nin`). This is not
 * a regression: the base English vector has always behaved this way. Installing
 * `unaccent` and wrapping both sides in it is a separate change, and it is a
 * BOTH-SIDES change for the reason above.
 *
 * **`simple` does not segment CJK.** Japanese and Chinese are written without
 * spaces, so `to_tsvector('simple', …)` emits one lexeme per whitespace-
 * delimited run. Those locales therefore get phrase-ish matching on whatever the
 * seller separated, plus reliable matching of Latin brand names and model
 * numbers inside the text — strictly more than today, and honestly less than a
 * segmenting analyser would give. Closing that means a segmentation extension
 * (`pg_bigm`, `zhparser`, MeCab), which is an infrastructure decision with
 * numbers attached and belongs to `oxy-infra` rather than to this map.
 */

import { MERCARIA_BASE_LOCALE, SUPPORTED_LOCALES, type SupportedLocale } from './catalog-localization';

/**
 * Every PostgreSQL text-search configuration Mercaria names.
 *
 * A closed tuple rather than a free string, because these values are
 * interpolated into DDL (the generated column's `CASE`) and bound into a
 * `::regconfig` cast at query time. A configuration that does not exist on the
 * server raises `text search configuration "x" does not exist` — loudly, which
 * is the right failure — but a value that could come from a request must never
 * reach either position, and a closed tuple is what makes that structural
 * rather than remembered.
 *
 * Verified present on `postgis/postgis:17-3.5`:
 * `select cfgname from pg_ts_config` lists all ten. `catalan` and `hindi`
 * arrived in PostgreSQL 16, which is why the floor is stated: every environment
 * that runs these migrations is PostgreSQL 17 (the shared `oxy-postgres` RDS
 * instance, the CI service container and the local compose file all pin it).
 */
export const POSTGRES_TEXT_SEARCH_CONFIGURATIONS = [
  'arabic',
  'catalan',
  'english',
  'french',
  'german',
  'hindi',
  'portuguese',
  'russian',
  'simple',
  'spanish',
] as const;

/** A PostgreSQL text-search configuration Mercaria may analyse text with. */
export type PostgresTextSearchConfiguration = (typeof POSTGRES_TEXT_SEARCH_CONFIGURATIONS)[number];

/**
 * The configuration for a language PostgreSQL cannot analyse.
 *
 * Named rather than spelled `'simple'` at each site, so the decision is one
 * value a reader can follow — and so the gate that asserts no unsupported
 * locale reaches `'english'` has something to compare against.
 */
export const UNANALYZED_TEXT_SEARCH_CONFIGURATION: PostgresTextSearchConfiguration = 'simple';

/**
 * The configuration `listings.search_vector` is GENERATED with, and therefore
 * the only configuration its query side may ask in.
 *
 * It is `'english'` and it is not changing: `listings.title` and
 * `listings.description` are the seller's own base text, `MERCARIA_BASE_LOCALE`
 * is `en`, and rewriting a stored generated expression drops every index on the
 * column (`db/schema/CONVENTIONS.md`). What this constant adds is the BINDING:
 * before it, `db/schema/catalog.ts` and `db/catalog/listingRepository.ts` each
 * spelled `'english'` independently with nothing tying them, which is the same
 * two-representations hazard the localized side is built to avoid.
 *
 * The binding is asserted against the LIVE database rather than against these
 * files — `listing-localization.realdb.test.ts` reads the generated column's
 * definition out of `pg_get_expr` and asserts the configuration inside it is
 * this value. A source-to-source comparison would agree with itself even if the
 * deployed column said something else.
 */
export const LISTING_BASE_TEXT_SEARCH_CONFIGURATION: PostgresTextSearchConfiguration = 'english';

/**
 * One PostgreSQL text-search configuration per supported locale.
 *
 * A TOTAL `Record` over {@link SupportedLocale} and not a language-prefix
 * lookup: adding a locale to `SUPPORTED_LOCALES` then fails `tsc` here until
 * somebody states which analyser reads it. A prefix rule would answer for the
 * new locale automatically, which is exactly the silent fallback this module
 * exists to remove — it would just be silent about a different thing.
 *
 * Regional tags map to their language's configuration. `fr-ca` is analysed by
 * the French stemmer because Canadian French is French; the market half of the
 * tag decides fallback and presentation (ADR 0007 D4) and says nothing about
 * morphology.
 */
export const LOCALE_TEXT_SEARCH_CONFIGURATIONS: Readonly<
  Record<SupportedLocale, PostgresTextSearchConfiguration>
> = {
  ar: 'arabic',
  'ar-ae': 'arabic',
  'ar-eg': 'arabic',
  'ar-ma': 'arabic',
  'ar-sa': 'arabic',
  // Bengali: no PostgreSQL configuration ships for it.
  bn: 'simple',
  'bn-bd': 'simple',
  'bn-in': 'simple',
  ca: 'catalan',
  'ca-es': 'catalan',
  de: 'german',
  'de-at': 'german',
  'de-ch': 'german',
  'de-de': 'german',
  en: 'english',
  'en-ca': 'english',
  'en-gb': 'english',
  'en-us': 'english',
  es: 'spanish',
  'es-ar': 'spanish',
  'es-es': 'spanish',
  'es-mx': 'spanish',
  fr: 'french',
  'fr-be': 'french',
  'fr-ca': 'french',
  'fr-ch': 'french',
  'fr-fr': 'french',
  hi: 'hindi',
  'hi-in': 'hindi',
  // Japanese: no PostgreSQL configuration ships for it, and none of the bundled
  // ones segments a script written without spaces.
  ja: 'simple',
  'ja-jp': 'simple',
  pt: 'portuguese',
  'pt-br': 'portuguese',
  'pt-pt': 'portuguese',
  ru: 'russian',
  'ru-ru': 'russian',
  // Chinese: as Japanese.
  zh: 'simple',
  'zh-cn': 'simple',
  'zh-hans': 'simple',
  'zh-sg': 'simple',
};

/**
 * Narrow an arbitrary tag to a {@link SupportedLocale}, or `undefined`.
 *
 * Folds case first, because BCP 47 tags are case-insensitive and the column
 * stores the lowercase form (`catalog-localization.ts`), so `fr-CA` off the wire
 * and `fr-ca` in the database are one tag and a raw comparison would miss.
 */
export function asSupportedLocale(tag: string): SupportedLocale | undefined {
  const folded = tag.trim().toLowerCase();
  const supported: readonly string[] = SUPPORTED_LOCALES;
  return supported.includes(folded) ? (folded as SupportedLocale) : undefined;
}

/**
 * The configuration to analyse one locale's text with.
 *
 * Takes an arbitrary `string` rather than a `SupportedLocale`, because the
 * callers that need it hold whatever a client sent. A tag Mercaria does not
 * support answers {@link UNANALYZED_TEXT_SEARCH_CONFIGURATION} — never
 * `LISTING_BASE_TEXT_SEARCH_CONFIGURATION`, which would re-introduce the defect
 * for exactly the locales that have no coverage.
 *
 * There is no locale FALLBACK here, deliberately, and it is not this function's
 * decision to make: `listing.title` is `seller_authored`, so
 * `fallbackPolicyForFieldClass` gives it `exact_locale_then_base` and an
 * `es-mx` request never reads the `es` row a different seller wrote. Search has
 * to find what the shopper will then SEE, so the query side matches the EXACT
 * locale's row plus the base vector, and never a neighbouring market's.
 */
export function textSearchConfigurationForLocale(locale: string): PostgresTextSearchConfiguration {
  const supported = asSupportedLocale(locale);
  if (supported === undefined) return UNANALYZED_TEXT_SEARCH_CONFIGURATION;
  return LOCALE_TEXT_SEARCH_CONFIGURATIONS[supported];
}

/**
 * The locales analysed by each configuration, as the DDL renders them.
 *
 * The generated column on `listing_localizations` is a `CASE` whose arms are
 * built from this, so the schema and the query side cannot describe two
 * different mappings. Configurations are ordered alphabetically and the locales
 * within each are sorted, so the rendered expression is byte-stable across
 * regenerations — an unstable expression would make `drizzle-kit generate` emit
 * a column rewrite (and silently drop the column's GIN index) on a run that
 * changed nothing.
 *
 * {@link UNANALYZED_TEXT_SEARCH_CONFIGURATION} is deliberately ABSENT from the
 * result: it is the `CASE`'s `ELSE`, which is what makes "a locale nobody
 * classified is analysed by `simple`" true of the stored column and not only of
 * the TypeScript map.
 */
export function localesByTextSearchConfiguration(): readonly {
  configuration: PostgresTextSearchConfiguration;
  locales: readonly SupportedLocale[];
}[] {
  const grouped = new Map<PostgresTextSearchConfiguration, SupportedLocale[]>();
  for (const locale of [...SUPPORTED_LOCALES].sort()) {
    const configuration = LOCALE_TEXT_SEARCH_CONFIGURATIONS[locale];
    if (configuration === UNANALYZED_TEXT_SEARCH_CONFIGURATION) continue;
    const bucket = grouped.get(configuration);
    if (bucket) bucket.push(locale);
    else grouped.set(configuration, [locale]);
  }
  return [...grouped.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([configuration, locales]) => ({ configuration, locales }));
}

/**
 * The base locale's configuration, restated as a derivation.
 *
 * `LISTING_BASE_TEXT_SEARCH_CONFIGURATION` is what the generated column on
 * `listings` actually uses; this is what the map SAYS the base locale should be
 * analysed with. They are two facts and `catalog-search-configuration.test.ts`
 * asserts they agree — if the base locale ever moves off `en`, the generated
 * column has to move with it in the same change, and the failing assertion is
 * where that gets noticed.
 */
export function baseLocaleTextSearchConfiguration(): PostgresTextSearchConfiguration {
  return LOCALE_TEXT_SEARCH_CONFIGURATIONS[MERCARIA_BASE_LOCALE];
}
