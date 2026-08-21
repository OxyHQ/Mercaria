/**
 * The locale → PostgreSQL text-search-configuration map (#367 Workstream 5).
 *
 * The map decides two things that must agree byte for byte: which analyser the
 * generated column on `listing_localizations` uses for a row, and which one
 * `listingRepository.textMatch` builds its `tsquery` with. Two stemmers
 * sometimes agree on a word and sometimes do not, so a vector and a query
 * analysed differently punch UNPREDICTABLE holes in a result set — and the case
 * this domain exists for is one of them, which is why a disagreement here is a
 * search that silently returns nothing for exactly the query it was built for.
 *
 * What lives HERE is what can be settled without a server: the map's shape, its
 * totality, the prohibition, and the deterministic rendering the DDL depends on.
 * What the map actually PRODUCES in Postgres, and whether the deployed columns
 * agree with it, is `listing-localization.realdb.test.ts` — a source-to-source
 * comparison would agree with itself even if the database said otherwise.
 */

import { describe, expect, it } from 'vitest';
import {
  LISTING_BASE_TEXT_SEARCH_CONFIGURATION,
  LOCALE_TEXT_SEARCH_CONFIGURATIONS,
  MERCARIA_BASE_LOCALE,
  POSTGRES_TEXT_SEARCH_CONFIGURATIONS,
  SUPPORTED_LOCALES,
  UNANALYZED_TEXT_SEARCH_CONFIGURATION,
  asSupportedLocale,
  baseLocaleTextSearchConfiguration,
  localesByTextSearchConfiguration,
  textSearchConfigurationForLocale,
  type SupportedLocale,
} from '@mercaria/shared-types';

/** The language half of a lowercase BCP 47 tag. */
function language(locale: string): string {
  return locale.split('-')[0];
}

describe('the map is total, and its value space is closed', () => {
  it('names a configuration for every supported locale and for nothing else', () => {
    const mapped = Object.keys(LOCALE_TEXT_SEARCH_CONFIGURATIONS).sort();
    expect(mapped).toEqual([...SUPPORTED_LOCALES].sort());

    // The FLOOR. A `Record<SupportedLocale, …>` already fails `tsc` on a missing
    // key, but a walk that found nothing would satisfy the equality above
    // against an empty tuple, and `SUPPORTED_LOCALES` is imported rather than
    // literal.
    expect(mapped.length, 'the locale tuple collapsed').toBeGreaterThanOrEqual(30);
  });

  it('uses only configurations the closed tuple declares, and declares none it does not use', () => {
    const used = new Set<string>(Object.values(LOCALE_TEXT_SEARCH_CONFIGURATIONS));
    const declared = new Set<string>(POSTGRES_TEXT_SEARCH_CONFIGURATIONS);

    // Both directions. A used-but-undeclared value would reach DDL through a
    // tuple nobody reviewed; a declared-but-unused one is a configuration this
    // deployment claims to support and never exercises, which is exactly the
    // list that rots into naming something PostgreSQL does not ship.
    expect([...used].filter((value) => !declared.has(value))).toEqual([]);
    expect([...declared].filter((value) => !used.has(value))).toEqual([]);
  });

  it('routes every locale of one language to one configuration', () => {
    // Regional tags are a MARKET distinction, not a morphological one: `fr-ca`
    // is analysed by the French stemmer because Canadian French is French. A
    // per-market analyser would be a second answer to a question the language
    // already settles.
    const byLanguage = new Map<string, Set<string>>();
    for (const locale of SUPPORTED_LOCALES) {
      const bucket = byLanguage.get(language(locale)) ?? new Set<string>();
      bucket.add(LOCALE_TEXT_SEARCH_CONFIGURATIONS[locale]);
      byLanguage.set(language(locale), bucket);
    }
    const split = [...byLanguage.entries()]
      .filter(([, configurations]) => configurations.size > 1)
      .map(([lang, configurations]) => `${lang}: ${[...configurations].join(', ')}`);
    expect(split).toEqual([]);
    expect(byLanguage.size, 'the language census found almost nothing').toBeGreaterThanOrEqual(10);
  });
});

describe('an unsupported locale is never analysed as English', () => {
  it('reaches `english` from EXACTLY the English locales', () => {
    const english = SUPPORTED_LOCALES.filter(
      (locale) => LOCALE_TEXT_SEARCH_CONFIGURATIONS[locale] === 'english',
    );
    expect([...english].sort()).toEqual(
      SUPPORTED_LOCALES.filter((locale) => language(locale) === 'en').sort(),
    );
    expect(english.length, 'no locale maps to `english` at all').toBeGreaterThan(0);

    // The MUTATION SELF-TEST. Without it the equality above passes for any map
    // whose `english` set happens to equal its `en*` set — including one that
    // routes a non-English locale to `english` and an English locale away from
    // it. This is the shape the assertion has to be able to fail in.
    const mutated: Record<string, string> = { ...LOCALE_TEXT_SEARCH_CONFIGURATIONS, ja: 'english' };
    const mutatedEnglish = SUPPORTED_LOCALES.filter((locale) => mutated[locale] === 'english');
    expect(
      [...mutatedEnglish].sort(),
      'the detector must NOT accept a non-English locale routed to `english`',
    ).not.toEqual(SUPPORTED_LOCALES.filter((locale) => language(locale) === 'en').sort());
  });

  it('answers `simple` for every language PostgreSQL ships no configuration for', () => {
    // Bengali, Japanese and Chinese, measured against `pg_ts_config` on
    // `postgis/postgis:17-3.5` rather than remembered.
    const unanalysed = SUPPORTED_LOCALES.filter(
      (locale) => LOCALE_TEXT_SEARCH_CONFIGURATIONS[locale] === UNANALYZED_TEXT_SEARCH_CONFIGURATION,
    );
    expect([...new Set(unanalysed.map(language))].sort()).toEqual(['bn', 'ja', 'zh']);
    expect(UNANALYZED_TEXT_SEARCH_CONFIGURATION).not.toBe(LISTING_BASE_TEXT_SEARCH_CONFIGURATION);
  });

  it('answers `simple` for a tag Mercaria does not support at all', () => {
    for (const tag of ['is', 'sw', 'eu', 'xx-yy', '', 'english']) {
      expect(asSupportedLocale(tag)).toBeUndefined();
      expect(textSearchConfigurationForLocale(tag)).toBe(UNANALYZED_TEXT_SEARCH_CONFIGURATION);
      expect(
        textSearchConfigurationForLocale(tag),
        `an unsupported tag (${tag || 'empty'}) must never fall back to the base configuration`,
      ).not.toBe(LISTING_BASE_TEXT_SEARCH_CONFIGURATION);
    }

    // The CONTROL: a supported tag really does resolve, so the loop above is
    // about the tags being unsupported and not about the function answering
    // `simple` unconditionally.
    expect(textSearchConfigurationForLocale('fr')).toBe('french');
  });

  it('folds case, because a BCP 47 tag off the wire is case-insensitive', () => {
    // `listing_localizations.locale` stores the lowercase form, so `fr-CA` and
    // `fr-ca` are one tag and a raw comparison would miss.
    expect(asSupportedLocale('fr-CA')).toBe('fr-ca');
    expect(asSupportedLocale('  ZH-Hans ')).toBe('zh-hans');
    expect(textSearchConfigurationForLocale('fr-CA')).toBe('french');
    expect(textSearchConfigurationForLocale('PT-BR')).toBe('portuguese');
  });
});

describe('the DDL rendering is a partition, and it is deterministic', () => {
  it('renders every non-`simple` locale into an arm and every `simple` one into none', () => {
    const arms = localesByTextSearchConfiguration();
    const inArms = arms.flatMap((arm) => [...arm.locales]);

    // Derive the EXCLUSION rather than restating the inclusion: whatever is not
    // in an arm must be exactly what the map sends to the `ELSE`.
    const elseBranch = SUPPORTED_LOCALES.filter(
      (locale) => LOCALE_TEXT_SEARCH_CONFIGURATIONS[locale] === UNANALYZED_TEXT_SEARCH_CONFIGURATION,
    );
    expect([...inArms].sort()).toEqual(
      SUPPORTED_LOCALES.filter((locale) => !elseBranch.includes(locale)).sort(),
    );
    expect(inArms.filter((locale) => elseBranch.includes(locale as SupportedLocale))).toEqual([]);

    // A partition, so the two halves plus nothing else account for the whole
    // tuple — and neither half is empty, or one of the two directions above is
    // vacuous.
    expect([...inArms, ...elseBranch].sort()).toEqual([...SUPPORTED_LOCALES].sort());
    expect(inArms.length).toBeGreaterThan(0);
    expect(elseBranch.length).toBeGreaterThan(0);

    // `simple` may never appear as an arm: it is the `ELSE`, which is what makes
    // "an unclassified locale is analysed by `simple`" true of the stored column
    // and not only of this map.
    expect(arms.map((arm) => arm.configuration)).not.toContain(
      UNANALYZED_TEXT_SEARCH_CONFIGURATION,
    );
  });

  it('is byte-stable across calls, because an unstable expression rewrites the column', () => {
    /*
     * drizzle-kit treats ANY change to a stored generated expression as DROP
     * COLUMN + ADD COLUMN, which silently takes the column's GIN index with it
     * and emits nothing about the index. So a rendering that depended on
     * iteration order would produce a spurious rewrite on a regeneration that
     * changed nothing.
     */
    const once = JSON.stringify(localesByTextSearchConfiguration());
    const twice = JSON.stringify(localesByTextSearchConfiguration());
    expect(once).toBe(twice);

    const arms = localesByTextSearchConfiguration();
    expect(arms.map((arm) => arm.configuration)).toEqual(
      [...arms.map((arm) => arm.configuration)].sort(),
    );
    for (const arm of arms) {
      expect([...arm.locales], `${arm.configuration}'s locales are not sorted`).toEqual(
        [...arm.locales].sort(),
      );
    }
  });

  it('agrees with the base locale about the base vector’s configuration', () => {
    // Two facts: what `listings.search_vector` IS generated with, and what the
    // map says the base locale should be analysed with. If the base locale ever
    // moves off `en`, the generated column has to move with it in the same
    // change, and this is where that gets noticed.
    expect(baseLocaleTextSearchConfiguration()).toBe(LISTING_BASE_TEXT_SEARCH_CONFIGURATION);
    expect(textSearchConfigurationForLocale(MERCARIA_BASE_LOCALE)).toBe(
      LISTING_BASE_TEXT_SEARCH_CONFIGURATION,
    );
  });
});
