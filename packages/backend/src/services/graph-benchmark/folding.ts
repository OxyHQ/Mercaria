/**
 * The catalogue's three folding spaces, MEASURED rather than described
 * (#367 Workstream 5, "define language-aware tokenization/folding behavior
 * **and benchmark it**").
 *
 * ## What was missing, and why the absence was invisible
 *
 * The DEFINITION half of that box was earned: three folding spaces exist, each
 * matched write-side to read-side, each unit-tested.
 *
 * | space | write side | read side | fold |
 * |---|---|---|---|
 * | `normalized_name` | `normalizeEntityName` | the same function on the query | accents + case + punctuation + legal suffixes |
 * | `normalized_alias` | GENERATED `lower(btrim(alias))` | `normalizeAliasLookup` | case only, deliberately |
 * | `search_vector` | `to_tsvector(<config>, …)` | `websearch_to_tsquery(<config>, …)` | language stemming |
 *
 * Nothing measured any of it. #61's harness — the one place in this repository
 * that measures catalogue reads at all — builds every name from a table of
 * thirty ASCII syllables and twelve ASCII nouns, so **no shape it runs has ever
 * fed a single accented or non-Latin character to any of the three folds.** A
 * fold that stopped folding would have left every one of its shapes green,
 * because an ASCII corpus cannot tell an accent-folding space from the identity
 * function: `kavor m7k2 headset` normalizes to itself in all three.
 *
 * That is the measurement-of-nothing this module removes, and
 * {@link NON_ASCII_PROBE_FRACTION} and the accent-probe check beside it are what keep it removed — a corpus that
 * drifted back to ASCII fails the build instead of passing quietly.
 *
 * ## The three spaces DISAGREE, and that is the finding
 *
 * They are not three implementations of one fold with different bugs; they
 * answer three different questions. A benchmark whose probes could not separate
 * them would be measuring the corpus rather than the schema, so
 * {@link findFoldingVacuityViolations} carries a discrimination floor: some
 * probe must make each pair of spaces answer differently.
 *
 * ## Every probe is a WHOLE-PHRASE pair, and that is load-bearing
 *
 * `normalized_name` and `normalized_alias` are EQUALITY spaces — a reader
 * normalizes the query and compares it against a stored normalized string.
 * `search_vector` is a CONTAINMENT space — a lexeme is looked for inside a
 * document. Those answer different questions, and a corpus that paired a
 * one-word query against a multi-word document would report the two
 * normalization spaces missing everything, which is a fact about the
 * comparison shape and not about folding.
 *
 * So `stored` and `query` are the same phrase modulo the ONE property under
 * test. All three spaces are then asked the same question — "are these two
 * spellings the same thing?" — and a disagreement is attributable to the fold.
 *
 * ## Why this is NOT a `WorkloadShape`
 *
 * Two of #61's own gates say so, and both are right.
 *
 *  - `workload.test.ts` asserts every shape's `workloadItem` is one of #61's
 *    fourteen numbered entries. Folding is #367's question; it has no number
 *    there, and inventing one would file a #367 measurement under a #61 heading.
 *  - `workload.test.ts` asserts EVERY shape declares `minRowsReturned > 0`.
 *    Half of what this module measures is a read that correctly returns
 *    NOTHING — `bicyclette en bon etat` must not find `bicyclette en bon état`
 *    in the tsvector space, and that zero IS the result. A shape whose floor
 *    forbids zero rows cannot express it, and relaxing that floor to admit
 *    these would disarm it for the fourteen shapes it was built for.
 *
 * So the verdicts here are `match`/`no_match` rather than rows and
 * milliseconds, and they get their own floors. The LATENCY and PLAN half — which
 * is #61-shaped — stays in #61's harness and in `scripts/folding-benchmark.ts`.
 */

import {
  LOCALE_TEXT_SEARCH_CONFIGURATIONS,
  textSearchConfigurationForLocale,
  type PostgresTextSearchConfiguration,
  type SupportedLocale,
} from '@mercaria/shared-types';

/** The three spaces a piece of catalogue text is folded into before comparison. */
export const FOLDING_SPACES = ['normalized_name', 'normalized_alias', 'search_vector'] as const;

/** One of the three spaces. */
export type FoldingSpace = (typeof FOLDING_SPACES)[number];

/**
 * What one probe's stored form and query form differ BY.
 *
 * The kind is what makes a disagreement readable: "these two spaces answer
 * differently" is a curiosity, and "these two spaces answer differently about
 * an ACCENT" is a fact somebody can act on.
 */
export const FOLDING_DIFFERENCES = ['accent', 'inflection', 'case'] as const;

/** One of the three differences a probe isolates. */
export type FoldingDifference = (typeof FOLDING_DIFFERENCES)[number];

/**
 * A probe's answer in one space.
 *
 * String members and not a boolean, because this backend compiles with
 * `strict: false`: without `strictNullChecks` TypeScript does not narrow a
 * union on the TRUTHINESS of a boolean-literal discriminant, so `if (!x.match)`
 * would leave a caller holding the whole union. The finding #68 recorded.
 */
export type FoldingVerdict = 'match' | 'no_match';

/** One (stored, query) pair, and what each space is DEFINED to answer about it. */
export interface FoldingProbe {
  /** Stable handle, quoted by the report and by the realdb gate. */
  readonly id: string;
  readonly difference: FoldingDifference;
  /**
   * The locale whose analyser reads this text.
   *
   * It selects the `search_vector` configuration through the ONE map
   * `listing_localizations.search_vector` is generated from, so a probe cannot
   * name a configuration directly and therefore cannot disagree with the
   * deployed column.
   */
  readonly locale: SupportedLocale;
  /** What a seller wrote. */
  readonly stored: string;
  /** What a shopper typed — the same phrase, modulo {@link difference}. */
  readonly query: string;
  /** What each space answers. Every value below was measured before it was written. */
  readonly expected: Readonly<Record<FoldingSpace, FoldingVerdict>>;
  /** Why the answer is what it is — a sentence, not a restatement of the table. */
  readonly note: string;
}

/**
 * What fraction of the corpus must carry a character outside ASCII.
 *
 * THE floor of this module, and it is a PROPORTION rather than a count on
 * purpose.
 *
 * #61's SEEDED CATALOGUE TEXT is pure ASCII — measured at the seed inputs
 * rather than at the files, because the files themselves hold plenty of
 * non-ASCII and all of it is prose: `SYLLABLES` (30 entries) and `NOUNS` (12)
 * carry none, and the single free-text literal any shape sends is `'bicycle'`.
 * Positive-controlled against the 42 em-dashes in `dataset.ts`, so that zero is
 * a real zero and not an instrument that cannot read UTF-8. Which is exactly
 * why nothing there could ever have failed on a broken fold.
 *
 * A COUNT floor set to whatever the corpus happens to hold is fitted to its own
 * subject and can never fail; a count floor with headroom is diluted by every
 * ASCII probe somebody adds afterwards. A proportion is neither: adding ASCII
 * probes moves the corpus toward the floor rather than away from it.
 *
 * The gate that actually guarantees detection is
 * {@link findFoldingVacuityViolations}' FIRST check — every `accent` probe must
 * carry a non-ASCII character, which is a semantic necessity (an accent
 * difference spelled entirely in ASCII is not an accent difference) and cannot
 * be satisfied by padding. This proportion is the drift tripwire beside it.
 */
export const NON_ASCII_PROBE_FRACTION = 0.5;

/**
 * How many distinct text-search configurations the corpus must exercise.
 *
 * One configuration proves the map is wired; it cannot prove the map
 * DISCRIMINATES. `simple` is separately required by name below, because it is
 * the answer for every language PostgreSQL cannot analyse and therefore the arm
 * a misrouting bug sends everything to.
 */
export const CONFIGURATION_COVERAGE_FLOOR = 5;

/** Anything outside ASCII, for the floor above. */
function hasNonAscii(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point !== undefined && point > 127) return true;
  }
  return false;
}

/**
 * The recall matrix.
 *
 * Every `expected` value was MEASURED against PostgreSQL 17.5 on
 * `postgis/postgis:17-3.5` before it was written down, so this table is a
 * record of what the deployed folds DO. A change to any fold turns it red
 * rather than being absorbed by it.
 *
 * Two rows are worth reading before the rest:
 *
 *  - **`de-accent` and `ar-accent` fold their own diacritics.** The German and
 *    Arabic Snowball stemmers do it as part of stemming (`grüner` and `gruner`
 *    both become `grun`), so the flat sentence "accents are not folded in
 *    full-text search" — which is true of `french`, `spanish` and
 *    `portuguese`, and which `docs/catalog-search-configurations.md` states
 *    without qualification — is FALSE for two of the ten configurations. That
 *    is a property of the stemmers rather than a defect in anything Mercaria
 *    wrote, and it is pinned here so nobody rediscovers it from a support
 *    ticket.
 *  - **`analyser-french` and `analyser-simple` are the same two words under two
 *    locales**, which is the cleanest form the "does a locale's own analyser
 *    beat `simple`" question has: identical text, identical query, only the
 *    configuration differs, opposite answers.
 */
export const FOLDING_PROBES: readonly FoldingProbe[] = [
  {
    id: 'fr-accent',
    difference: 'accent',
    locale: 'fr',
    stored: 'bicyclette en bon état',
    query: 'bicyclette en bon etat',
    expected: { normalized_name: 'match', normalized_alias: 'no_match', search_vector: 'no_match' },
    note:
      'The headline disagreement. `normalizeEntityName` strips NFD combining marks, so a ' +
      'canonical NAME finds its unaccented spelling; the alias column is `lower(btrim())` and ' +
      'the French stemmer keeps `état` verbatim, so neither of those does. A French shopper ' +
      'typing without accents finds the brand and not the listing.',
  },
  {
    id: 'fr-case-control',
    difference: 'case',
    locale: 'fr',
    stored: 'Bicyclette en bon état',
    query: 'bicyclette en bon état',
    expected: { normalized_name: 'match', normalized_alias: 'match', search_vector: 'match' },
    note:
      'The control for the row above. With only the case differing, all three spaces agree — ' +
      'without it the matrix could not separate "the accent fold is missing" from "the probe ' +
      'text is wrong", because both would show the same two misses.',
  },
  {
    id: 'es-accent',
    difference: 'accent',
    locale: 'es',
    stored: 'zapatos para niños',
    query: 'zapatos para ninos',
    expected: { normalized_name: 'match', normalized_alias: 'no_match', search_vector: 'no_match' },
    note:
      'Spanish behaves as French: `niños` stems to `niñ` and `ninos` to `nin`, two different ' +
      'lexemes. A second language on the same disagreement, so the finding is not one ' +
      "stemmer's quirk.",
  },
  {
    id: 'pt-accent',
    difference: 'accent',
    locale: 'pt',
    stored: 'estações do ano',
    query: 'estacoes do ano',
    expected: { normalized_name: 'match', normalized_alias: 'no_match', search_vector: 'no_match' },
    note: 'Portuguese, with two diacritics in one word: `estações` stems to `estaçõ`, `estacoes` to `estaco`.',
  },
  {
    id: 'de-accent',
    difference: 'accent',
    locale: 'de',
    stored: 'grüner Stuhl',
    query: 'gruner Stuhl',
    expected: { normalized_name: 'match', normalized_alias: 'no_match', search_vector: 'match' },
    note:
      'THE EXCEPTION, and the reason this is a corpus rather than a sentence. The German ' +
      'Snowball stemmer folds umlauts while stemming, so BOTH spellings become `grun` and the ' +
      'tsvector space answers an unaccented query — while refusing the identical French and ' +
      'Spanish cases above.',
  },
  {
    id: 'ar-accent',
    difference: 'accent',
    locale: 'ar',
    stored: 'دراجة مستعملة',
    query: 'دراجه مستعمله',
    expected: { normalized_name: 'no_match', normalized_alias: 'no_match', search_vector: 'match' },
    note:
      'The second exception, and a different mechanism from German: the Arabic stemmer ' +
      'normalizes the taa marbuta away, so the two spellings a shopper might type both reach ' +
      '`دراج`. Note the FIRST column — `normalizeEntityName` does NOT unify them, so for ' +
      'Arabic the tsvector space folds MORE than the name space, the exact reverse of French.',
  },
  {
    id: 'fr-inflection',
    difference: 'inflection',
    locale: 'fr',
    stored: 'bicyclettes rouges',
    query: 'bicyclette rouge',
    expected: { normalized_name: 'no_match', normalized_alias: 'no_match', search_vector: 'match' },
    note:
      'The inverse disagreement, and the case #826 exists for. Only the tsvector space stems, ' +
      'so only it crosses a plural; the two normalization spaces compare strings and a plural ' +
      'is a different string. This is what a language-aware analyser BUYS.',
  },
  {
    id: 'es-inflection',
    difference: 'inflection',
    locale: 'es',
    stored: 'estaciones de tren',
    query: 'estacion de tren',
    expected: { normalized_name: 'no_match', normalized_alias: 'no_match', search_vector: 'match' },
    note: 'Spanish singular/plural, which also drops an accent in the singular (`estación`).',
  },
  {
    id: 'de-inflection',
    difference: 'inflection',
    locale: 'de',
    stored: 'Häuser',
    query: 'Haus',
    expected: { normalized_name: 'no_match', normalized_alias: 'no_match', search_vector: 'match' },
    note:
      'German umlaut plural: `Häuser` to `Haus` is a vowel change inside the stem, not a ' +
      'suffix. The strongest single case for a language-aware analyser over `simple`.',
  },
  {
    id: 'ru-inflection',
    difference: 'inflection',
    locale: 'ru',
    stored: 'красные велосипеды',
    query: 'красный велосипед',
    expected: { normalized_name: 'no_match', normalized_alias: 'no_match', search_vector: 'match' },
    note:
      'A non-Latin script PostgreSQL DOES analyse, so the corpus covers both halves of ' +
      '"non-ASCII": a script with a stemmer, and (below) one without.',
  },
  {
    id: 'ca-inflection',
    difference: 'inflection',
    locale: 'ca',
    stored: 'bicicletes vermelles',
    query: 'bicicleta vermella',
    expected: { normalized_name: 'no_match', normalized_alias: 'no_match', search_vector: 'no_match' },
    note:
      'A MEASURED NEGATIVE, kept deliberately. The Catalan stemmer takes `bicicletes` to ' +
      '`biciclet` and `bicicleta` to `bicicl`, so it does NOT unify a real singular/plural ' +
      'pair. Stemming is not magic and the corpus should not imply it is — a matrix in which ' +
      'every analysed locale succeeds would suggest a guarantee none of them gives.',
  },
  {
    id: 'analyser-french',
    difference: 'inflection',
    locale: 'fr',
    stored: 'guitars',
    query: 'guitar',
    expected: { normalized_name: 'no_match', normalized_alias: 'no_match', search_vector: 'match' },
    note:
      'Half of the A/B that isolates the ANALYSER: identical text to `analyser-simple`, read ' +
      'under a locale the map routes to a real stemmer. The plural is crossed.',
  },
  {
    id: 'analyser-simple',
    difference: 'inflection',
    locale: 'ja',
    stored: 'guitars',
    query: 'guitar',
    expected: { normalized_name: 'no_match', normalized_alias: 'no_match', search_vector: 'no_match' },
    note:
      'The other half. The SAME two words under a locale the map routes to `simple`, which ' +
      'splits and folds case and does nothing else — so the plural is not crossed. Together ' +
      'with the row above this is the measurement of what the per-locale map buys, with ' +
      'everything except the configuration held constant.',
  },
  {
    id: 'ja-simple-case',
    difference: 'case',
    locale: 'ja',
    stored: 'ジャンク PC',
    query: 'ジャンク pc',
    expected: { normalized_name: 'match', normalized_alias: 'match', search_vector: 'match' },
    note:
      'What `simple` DOES do, so the row above is not read as "the simple arm is broken": it ' +
      'folds case, including across a script boundary, and matches the Latin model numbers and ' +
      'brand names that appear inside CJK titles.',
  },
];

/**
 * A script this repository claims to support, and whether `normalizeEntityName`
 * gives its text back.
 *
 * ## This table was a DEFECT RECORD and is now a REGRESSION GUARD (#830)
 *
 * It used to pin four corrupted languages so the corruption was visible in a
 * report instead of being discovered in a catalogue. #830 fixed the fold, so
 * every language now survives it — which retired the old anti-vacuity floor
 * ("at least one row must be `corrupted`"), because that floor is met only
 * while the bug is present and would have had to be deleted to let the fix
 * land. A floor whose cheapest green is leaving the defect in place is the
 * wrong floor.
 *
 * What replaces it keeps the evidence and gets stronger: every repaired row
 * carries `corruptedBeforeFix`, the exact string the fold returned BEFORE the
 * fix, measured rather than remembered. So the table still documents what was
 * wrong, and the test can now assert something the old one could not — that
 * the fold does NOT return the corrupt value any more. Reverting any part of
 * the fold turns these rows red naming the language, which is what a
 * regression guard is for.
 *
 * The two mechanisms it recorded, kept because they are why the fix is shaped
 * the way it is:
 *
 *  1. **The collapse ate Unicode Marks.** `[^\p{L}\p{N}]` keeps Letters and
 *     Numbers and turned everything else into a space; Indic vowel signs are
 *     category M, not L, so Hindi `साइकिल` became `स इक ल`. Two different
 *     Hindi words then collided in the space #53 generates MERGE CANDIDATES
 *     in, which is a false merge — it looks exactly like a correct match.
 *  2. **The NFD strip changed LETTERS, not accents.** Cyrillic `й` decomposes
 *     to `и` + U+0306 and Katakana `ジ` to `シ` + U+3099, so dropping the mark
 *     substituted one letter for another.
 *
 * Nothing in this module changes any fold; it only measures.
 */
export interface ScriptIntegritySample {
  readonly language: string;
  readonly locale: SupportedLocale;
  /** A real word in that language. */
  readonly input: string;
  /** What `normalizeEntityName` returns TODAY. Measured, not predicted. */
  readonly normalized: string;
  /**
   * What the fold returned BEFORE #830, for a script the defect corrupted.
   * `null` exactly when `verdict` is `unaffected` — the defect never touched
   * this script, so there is no earlier value to record.
   */
  readonly corruptedBeforeFix: string | null;
  /**
   * `unaffected` — the two #830 mechanisms could not reach this script, so it
   * reads the same before and after; it is the CONTROL half of the table.
   * `repaired` — #830 corrupted it and the fix restored it.
   */
  readonly verdict: 'unaffected' | 'repaired';
  readonly note: string;
}

/** The measured integrity of each script under `normalizeEntityName`. */
export const SCRIPT_INTEGRITY_SAMPLES: readonly ScriptIntegritySample[] = [
  {
    language: 'French',
    locale: 'fr',
    input: 'état',
    normalized: 'etat',
    corruptedBeforeFix: null,
    verdict: 'unaffected',
    note: 'The fold doing exactly what it was designed for: a Latin diacritic dropped.',
  },
  {
    language: 'Arabic',
    locale: 'ar',
    input: 'دراجة',
    normalized: 'دراجة',
    corruptedBeforeFix: null,
    verdict: 'unaffected',
    note: 'Unharmed — the letters carry no decomposable marks, so both mechanisms miss it.',
  },
  {
    language: 'Chinese',
    locale: 'zh',
    input: '自転車',
    normalized: '自転車',
    corruptedBeforeFix: null,
    verdict: 'unaffected',
    note: 'Han characters are Letters and decompose to nothing, so they pass through intact.',
  },
  {
    language: 'Hindi',
    locale: 'hi',
    input: 'साइकिल',
    normalized: 'साइकिल',
    corruptedBeforeFix: 'स इक ल',
    verdict: 'repaired',
    note:
      'Mechanism 1, repaired. The matras U+093E and U+093F are Marks, not Letters, so each ' +
      'became a space and a four-syllable word came back as three fragments with its vowels ' +
      'removed. `wordTokens` keeps `\\p{M}`, so it is whole again.',
  },
  {
    language: 'Bengali',
    locale: 'bn',
    input: 'সাইকেল',
    normalized: 'সাইকেল',
    corruptedBeforeFix: 'স ইক ল',
    verdict: 'repaired',
    note:
      'Mechanism 1 again, so the defect was Indic-wide rather than one language — which is ' +
      'why the fix is a character class and not a per-script special case.',
  },
  {
    language: 'Japanese',
    locale: 'ja',
    input: 'ジャンク',
    normalized: 'ジャンク',
    corruptedBeforeFix: 'シ ャンク',
    verdict: 'repaired',
    note:
      'Both mechanisms, and the reason the fold is now conditional. `ジ` decomposes to `シ` + ' +
      'U+3099; the old strip was a no-op there (U+3099 is outside U+0300-U+036F) and the ' +
      'collapse then turned the orphaned mark into a space, so the word read `shi anku` where ' +
      'the seller wrote `janku`. Marks survive and the result is recomposed to NFC.',
  },
  {
    language: 'Japanese',
    locale: 'ja',
    input: 'じてんしゃ',
    normalized: 'じてんしゃ',
    corruptedBeforeFix: 'し てんしゃ',
    verdict: 'repaired',
    note:
      'The SAME mechanism in the other Japanese script, and the reason Japanese has two rows ' +
      '(#833). `じ` decomposes to `し` + U+3099 exactly as `ジ` does, so hiragana broke too — ' +
      'and every fixture in this repository reached for katakana, which is what let the ' +
      'commonest script in a Japanese title go unmeasured through the whole of #830.',
  },
  {
    language: 'Russian',
    locale: 'ru',
    input: 'красный',
    normalized: 'красный',
    corruptedBeforeFix: 'красныи',
    verdict: 'repaired',
    note:
      'Mechanism 2 alone. `й` is a distinct Cyrillic letter that happens to decompose to ' +
      '`и` + a breve, so the fold silently substituted one letter for another and collided ' +
      '`мой` with `мои`. Accents are now folded only off a LATIN base, so `й` and `ё` both ' +
      'survive — `ё` deliberately, though Russians do type `е` for it, because that is a ' +
      'language policy and the function has no locale.',
  },
];

/** One measured cell of the recall matrix. */
export interface FoldingCell {
  readonly probeId: string;
  readonly space: FoldingSpace;
  readonly expected: FoldingVerdict;
  readonly actual: FoldingVerdict;
  /** What the space actually held — a normalized string, or a lexeme list. */
  readonly evidence: string;
}

/** Everything a folding run measured. */
export interface FoldingMatrix {
  readonly cells: readonly FoldingCell[];
}

/** The configuration a probe's text is analysed under. */
export function configurationForProbe(probe: FoldingProbe): PostgresTextSearchConfiguration {
  return textSearchConfigurationForLocale(probe.locale);
}

/** The distinct configurations a corpus reaches, sorted. */
export function probedConfigurations(
  probes: readonly FoldingProbe[] = FOLDING_PROBES,
): readonly PostgresTextSearchConfiguration[] {
  const seen = new Set<PostgresTextSearchConfiguration>();
  for (const probe of probes) seen.add(configurationForProbe(probe));
  return [...seen].sort();
}

/**
 * Configurations in the map that no probe exercises.
 *
 * Reported rather than floored: a floor demanding all ten would be met by
 * padding, and what the report needs beside the matrix is an honest coverage
 * statement.
 */
export function unprobedConfigurations(
  probes: readonly FoldingProbe[] = FOLDING_PROBES,
): readonly PostgresTextSearchConfiguration[] {
  const reached = new Set(probedConfigurations(probes));
  const all = new Set<PostgresTextSearchConfiguration>();
  for (const configuration of Object.values(LOCALE_TEXT_SEARCH_CONFIGURATIONS)) {
    all.add(configuration);
  }
  return [...all].filter((configuration) => !reached.has(configuration)).sort();
}

/**
 * Every way this CORPUS could have failed to measure anything, as sentences.
 *
 * `findVacuityViolations`' shape applied to a recall matrix instead of a plan,
 * and a LIST rather than a throw for its reason: one run covers three spaces
 * and reporting the first failure hides the rest.
 *
 * These floors are about the PROBES and not about the results, so they run
 * before a connection is opened — a corpus that could not distinguish a working
 * fold from a broken one is refused rather than executed.
 */
export function findFoldingVacuityViolations(
  probes: readonly FoldingProbe[] = FOLDING_PROBES,
): string[] {
  const violations: string[] = [];

  if (probes.length === 0) {
    violations.push('The folding corpus is empty — every assertion over it passes vacuously.');
    return violations;
  }

  // 1a. The SEMANTIC half of the ASCII floor, and the one that actually
  //     guarantees detection: an accent probe spelled entirely in ASCII is not
  //     an accent probe. It cannot be satisfied by padding, because it is a
  //     property of each accent row rather than a count over the corpus.
  const asciiAccents = probes.filter(
    (probe) =>
      probe.difference === 'accent' && !hasNonAscii(probe.stored) && !hasNonAscii(probe.query),
  );
  for (const probe of asciiAccents) {
    violations.push(
      `Probe ${probe.id} claims to differ by an accent and carries no character above U+007F ` +
        '— an accent difference spelled in ASCII is not one, so the row measures nothing.',
    );
  }

  // 1b. The drift tripwire beside it. #61's dataset is pure ASCII, where every
  //     fold is the identity and nothing can ever fail; a PROPORTION is what
  //     stops this corpus being diluted back to that by later additions.
  const nonAscii = probes.filter(
    (probe) => hasNonAscii(probe.stored) || hasNonAscii(probe.query),
  );
  if (nonAscii.length < probes.length * NON_ASCII_PROBE_FRACTION) {
    violations.push(
      `Only ${String(nonAscii.length)} of ${String(probes.length)} probes carry a non-ASCII ` +
        `character, floor is ${String(NON_ASCII_PROBE_FRACTION * 100)}% — an ASCII corpus ` +
        'cannot tell a folding space from the identity function, which is the defect this ' +
        'benchmark exists to remove.',
    );
  }

  // 2. A space whose expected column is constant cannot fail in either
  //    direction: all-match survives a fold that widened, all-no_match survives
  //    one that vanished.
  for (const space of FOLDING_SPACES) {
    const verdicts = new Set(probes.map((probe) => probe.expected[space]));
    if (verdicts.size < 2) {
      violations.push(
        `Space ${space} expects only "${[...verdicts].join('')}" across the whole corpus — a ` +
          'constant column cannot detect a fold that changed.',
      );
    }
  }

  // 3. The discrimination floor. If no probe separates a pair of spaces, the
  //    corpus is consistent with those two being one function, so one silently
  //    adopting the other's fold would not be measured.
  const separated = new Set<string>();
  for (const probe of probes) {
    for (const left of FOLDING_SPACES) {
      for (const right of FOLDING_SPACES) {
        if (left >= right) continue;
        if (probe.expected[left] !== probe.expected[right]) separated.add(`${left}|${right}`);
      }
    }
  }
  const pairs = (FOLDING_SPACES.length * (FOLDING_SPACES.length - 1)) / 2;
  if (separated.size < pairs) {
    violations.push(
      `Only ${String(separated.size)} of ${String(pairs)} space pairs are separated by any ` +
        'probe — the corpus cannot tell the unseparated pair apart.',
    );
  }

  // 4. Configuration coverage. One arm proves the map is wired, not that it
  //    discriminates; `simple` is named because it is the arm a misrouting bug
  //    would send everything to.
  const configurations = probedConfigurations(probes);
  if (configurations.length < CONFIGURATION_COVERAGE_FLOOR) {
    violations.push(
      `The corpus reaches ${String(configurations.length)} text-search configuration(s), floor ` +
        `is ${String(CONFIGURATION_COVERAGE_FLOOR)} — too few to show the map routing different ` +
        'locales differently.',
    );
  }
  if (!configurations.includes('simple')) {
    violations.push(
      'No probe routes to `simple` — the arm every unanalysable language takes, and the one a ' +
        'misrouting bug would send everything to.',
    );
  }

  // 5. The A/B that isolates the analyser: the same (stored, query) text under
  //    two locales whose configurations differ AND whose verdicts differ. This
  //    is the only construction in which "the locale's own analyser beats
  //    `simple`" is attributable to the configuration rather than to the words.
  const byText = new Map<string, FoldingProbe[]>();
  for (const probe of probes) {
    const key = [probe.stored, probe.query].join(' =QUERY=> ');
    const bucket = byText.get(key);
    if (bucket) bucket.push(probe);
    else byText.set(key, [probe]);
  }
  const hasAnalyserAB = [...byText.values()].some((group) =>
    group.some((left) =>
      group.some(
        (right) =>
          configurationForProbe(left) !== configurationForProbe(right) &&
          left.expected.search_vector !== right.expected.search_vector,
      ),
    ),
  );
  if (!hasAnalyserAB) {
    violations.push(
      'No two probes share their text while differing in configuration AND verdict — without ' +
        "that pair, a claim that a locale's analyser beats `simple` is attributable to the " +
        'words rather than to the configuration.',
    );
  }

  // 6. Some probe must show the tsvector space reaching a form BOTH string
  //    spaces miss, or nothing measures what stemming buys.
  if (
    !probes.some(
      (probe) =>
        probe.expected.search_vector === 'match' &&
        probe.expected.normalized_name === 'no_match' &&
        probe.expected.normalized_alias === 'no_match',
    )
  ) {
    violations.push(
      'No probe expects the tsvector space to reach a form both string spaces miss — nothing ' +
        'measures what a language-aware analyser buys.',
    );
  }

  // 7. And the reverse, or the corpus only ever shows the analyser winning,
  //    which is half the finding.
  if (
    !probes.some(
      (probe) =>
        probe.expected.normalized_name === 'match' && probe.expected.search_vector === 'no_match',
    )
  ) {
    violations.push(
      'No probe expects `normalized_name` to reach a form the tsvector space misses — nothing ' +
        'measures what accent folding buys.',
    );
  }

  return violations;
}

/** Cells whose measured verdict is not the one the corpus defines. */
export function findFoldingDisagreements(matrix: FoldingMatrix): string[] {
  return matrix.cells
    .filter((cell) => cell.actual !== cell.expected)
    .map(
      (cell) =>
        `${cell.probeId} / ${cell.space}: defined as ${cell.expected}, measured ${cell.actual} ` +
        `(the space held: ${cell.evidence || '<empty>'}).`,
    );
}

/** How a verdict reads in the report. */
function verdictLabel(verdict: FoldingVerdict): string {
  return verdict === 'match' ? 'finds it' : 'misses it';
}

/**
 * The matrix as markdown, or the refusal.
 *
 * The refusal is an EARLY RETURN and prints no table at all — `report.ts`'s
 * decision, for its reason: a run that measured nothing must not publish a grid
 * somebody can read a conclusion off.
 */
export function renderFoldingReport(
  matrix: FoldingMatrix,
  corpusViolations: readonly string[],
): string {
  const disagreements = findFoldingDisagreements(matrix);
  const lines: string[] = ['# Folding and tokenization — measured recall', ''];

  if (corpusViolations.length > 0 || disagreements.length > 0) {
    lines.push('## THIS RUN MEASURED NOTHING', '');
    lines.push(
      'The harness refuses to publish a recall matrix it cannot vouch for. Each line below is ' +
        'either a corpus that could not have detected a broken fold, or a space whose measured ' +
        'behaviour is not the behaviour this repository defines.',
      '',
    );
    for (const violation of [...corpusViolations, ...disagreements]) lines.push(`- ${violation}`);
    lines.push('');
    return lines.join('\n');
  }

  lines.push(
    `Configurations exercised: ${probedConfigurations().join(', ')}. ` +
      `Not exercised: ${unprobedConfigurations().join(', ') || 'none'}.`,
    '',
    '| probe | differs by | locale | config | stored | query | `normalized_name` | ' +
      '`normalized_alias` | `search_vector` |',
    '|---|---|---|---|---|---|---|---|---|',
  );

  const cellFor = (probeId: string, space: FoldingSpace): string => {
    const cell = matrix.cells.find((entry) => entry.probeId === probeId && entry.space === space);
    return cell ? verdictLabel(cell.actual) : '—';
  };

  for (const probe of FOLDING_PROBES) {
    lines.push(
      `| \`${probe.id}\` | ${probe.difference} | \`${probe.locale}\` | ` +
        `\`${configurationForProbe(probe)}\` | ${probe.stored} | ${probe.query} | ` +
        `${cellFor(probe.id, 'normalized_name')} | ${cellFor(probe.id, 'normalized_alias')} | ` +
        `${cellFor(probe.id, 'search_vector')} |`,
    );
  }

  lines.push(
    '',
    '## Script integrity under `normalizeEntityName`',
    '',
    'Whether a language gets its own letters back. Every row is intact since #830; the ' +
      '`before #830` column is what the fold used to return, kept so a regression is legible ' +
      'as one. See `docs/performance/folding-and-tokenization.md`.',
    '',
    '| language | locale | input | `normalizeEntityName` | before #830 | verdict |',
    '|---|---|---|---|---|---|',
  );
  for (const sample of SCRIPT_INTEGRITY_SAMPLES) {
    lines.push(
      `| ${sample.language} | \`${sample.locale}\` | ${sample.input} | ${sample.normalized} | ` +
        `${sample.corruptedBeforeFix === null ? '—' : `\`${sample.corruptedBeforeFix}\``} | ` +
        `${sample.verdict === 'repaired' ? '**repaired**' : 'unaffected'} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}
