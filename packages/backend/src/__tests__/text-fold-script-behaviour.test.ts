/**
 * What every pure text fold in this repository actually DOES to each script the
 * product ships copy in (#833).
 *
 * `script-coverage-census.test.ts` asserts that a fold HAS fixtures. This file
 * is those fixtures for the folds that are pure functions, and it is one file
 * rather than twenty because the value is in the COMPARISON: the same eight
 * words through every fold, so "this one eats Devanagari vowel signs and that one
 * does not" is a line in a table instead of an archaeology exercise.
 *
 * ## Every expectation here was MEASURED, then reviewed
 *
 * None of it is a guess about what Unicode ought to do. The outputs were taken
 * from the real functions on `99cd1369` and then read one by one, which is what
 * turned up the three defects below. An expectation that merely re-states
 * whatever the code returned would be a tautology; what makes these real is that
 * each one is either the behaviour the fold is FOR, or is listed as a defect with
 * an issue number.
 *
 * ## The two groups, and why a fold moves between them
 *
 * {@link MARK_PRESERVING_FOLDS} keep a script's combining marks, so two words
 * that differ only in marks stay different. {@link MARK_LOSING_PAIRS} names the
 * (fold, script) combinations that do not — the #830 defect. Fixing one is a
 * ONE-LINE diff here: delete its entry. That is deliberate. A fix that did not
 * have to touch this file would be a fix nobody could see.
 *
 * **#838 emptied the second list**, and the assertions did not go with it: the
 * mark-loss MECHANISM check the losing group carried is now applied to every
 * member of the preserving one, on whichever half of each pair actually carries
 * a mark. Otherwise fixing the bug would have deleted the only test that could
 * detect it coming back.
 *
 * ## #367 line 202 refilled it, and what that exposed about this file
 *
 * The register is no longer empty: `normalizeCatalogAlias` and `foldPhrase`
 * carry #854, and BOTH were sitting in the preserving list claiming a property
 * they do not have. Nothing was wrong with the assertions — the SUBJECTS were
 * wrong. `MARK_BEARING` was the literal `['Bengali', 'Devanagari']`, and those
 * two folds pass both of those scripts, so the only scripts they were ever asked
 * about were the two they get right.
 *
 * Two things changed as a result, and the first is the general lesson:
 *
 * 1. **The mark-bearing scripts are now DERIVED** from `script-corpus.ts`'s
 *    `markPair` field. A hand-written list of subjects is a list of the mistakes
 *    somebody had already thought of, and a fold cannot be caught being wrong
 *    about a script nobody measured it against.
 * 2. **The register is keyed on (fold, SCRIPT), not on the fold.** #838's three
 *    turned every `\p{M}` into a space and were broken everywhere at once;
 *    #854's two strip `U+0300–U+036F` only, so they eat Cyrillic and Greek marks
 *    and genuinely preserve Devanagari, Bengali and Japanese ones. Recording
 *    them as wholly broken would have thrown away the coverage they do earn.
 *    Only the CYRILLIC half is gated, and {@link MARK_LOSING_PAIRS} says why.
 */

import { describe, expect, it } from 'vitest';
import {
  SCRIPT_CORPUS,
  type ScriptFamily,
  markBearingScripts,
  scriptMarkPair,
  scriptSample,
  scriptVariant,
} from './script-corpus.js';
import { slugify } from '../utils/slug.js';
import { normalizeEntityName } from '../services/canonical/normalization.js';
import { normalizeCatalogAlias } from '../services/taxonomy/alias-normalization.js';
import { normalizeSearchQuery } from '../services/search/normalize.js';
import { redactSupplierOrderMessage } from '../services/supplier-orders/redact.js';
import { redactSupplierProviderMessage } from '../services/supplier-preflight/redact.js';
import { redactSearchQuery, normalizeQueryTokens } from '../services/analytics/redact-query.js';
import { marketplaceSellerSlugSegment } from '../services/ingestion/seller-identity.js';
import { normalizeCheckoutAddress } from '../services/checkout/contact.js';
import { sanitizeUploadFilename } from '../services/feed-import/upload.js';
import { redactProviderMessage } from '../services/payments/redact.js';
import {
  applyExternalTransform,
  latestTransformRuleVersion,
} from '../services/catalog-external-mappings/transform-rules.js';
import { foldPhrase } from '../services/search-intent/dictionaries.js';
import { sanitizeQueryForModel } from '../services/search-intent/injection.js';
import { titleTokens, normalizeTitle } from '../services/matching/text-similarity.js';
import { normalizeDisplayNameForComparison } from '../services/referrals/duplicate-signals.js';
import { normalizeSourceConditionLabel, wordTokens } from '@mercaria/shared-types';

/** A fold under test: a name, and a `string -> string` view of it. */
interface NamedFold {
  readonly name: string;
  readonly fold: (value: string) => string;
}

/**
 * Folds that PRESERVE a script's combining marks.
 *
 * Two properties are asserted of every member: two words differing only in
 * marks fold to two different strings, AND a mark-bearing input still carries a
 * mark on the way out. The second is the MECHANISM, and it is here rather than
 * in the list below because #838 emptied that one.
 *
 * Membership is NOT a claim that a fold preserves every script's marks — that is
 * what {@link MARK_LOSING_PAIRS} exists to qualify. `normalizeCatalogAlias` and
 * `foldPhrase` are here AND registered against Cyrillic: they keep Devanagari,
 * Bengali and Japanese marks and eat Cyrillic ones, and both facts are asserted.
 *
 * `normalizeEntityName` is here because #834 put it here. The last three are
 * here because #838 did, and each names the stored key it writes, because that
 * is what made them a separate change: `condition_source_mappings.source_label_normalized`
 * (UNIQUE with `ruleset_id`), `analytics_search_queries.normalized_tokens` and
 * the `analytics_query_aggregates.normalized_query` rolled up from it (UNIQUE
 * with the bucket), and — for `strip_diacritics` — nothing at all.
 */
const MARK_PRESERVING_FOLDS: readonly NamedFold[] = [
  { name: 'normalizeEntityName', fold: normalizeEntityName },
  { name: 'wordTokens', fold: (value) => wordTokens(value).join('|') },
  { name: 'normalizeCatalogAlias', fold: normalizeCatalogAlias },
  { name: 'normalizeSearchQuery', fold: (value) => normalizeSearchQuery(value).normalized },
  { name: 'foldPhrase', fold: foldPhrase },
  { name: 'titleTokens', fold: (value) => titleTokens(value).join('|') },
  { name: 'normalizeTitle', fold: normalizeTitle },
  { name: 'normalizeDisplayNameForComparison', fold: normalizeDisplayNameForComparison },
  { name: 'sanitizeQueryForModel', fold: sanitizeQueryForModel },
  { name: 'normalizeSourceConditionLabel', fold: normalizeSourceConditionLabel },
  { name: 'normalizeQueryTokens', fold: (value) => normalizeQueryTokens(value).join('|') },
  { name: "applyExternalTransform('strip_diacritics')", fold: stripDiacritics },
];

/**
 * The rule under whatever version ships today, so the entry follows a version
 * bump rather than pinning the one that was broken. #838 retired
 * `strip_diacritics:1` and registered `:2`.
 */
function stripDiacritics(value: string): string {
  const result = applyExternalTransform(
    'strip_diacritics',
    latestTransformRuleVersion('strip_diacritics'),
    value,
  );
  return result.outcome === 'normalized' ? result.value : `refused:${result.reason}`;
}

/**
 * (fold, script) pairs where the fold is KNOWN to destroy that script's marks.
 *
 * ## Why a PAIR and not a fold
 *
 * #833's register held whole folds, because #838's three ate Devanagari matras
 * by turning every `\p{M}` into a space — a fold doing that is broken for every
 * script at once. #854's mechanism is narrower and the register had to widen to
 * hold it: `NFD` + strip `U+0300–U+036F` eats a CYRILLIC letter's breve and a
 * GREEK letter's tonos while leaving Devanagari, Bengali and Japanese marks
 * untouched, because those live in other blocks. `normalizeCatalogAlias` is
 * genuinely mark-preserving for four of the five scripts measured here.
 *
 * ## Greek is affected, is NOT gated here, and that is not an oversight
 *
 * The same strip eats a Greek tonos: measured, `έξι` and `εξι` fold onto one
 * string through BOTH of these folds, exactly as `мой` and `мои` do. It is not
 * in the register because it cannot be. Every entry names a script carrying a
 * `markPair` in `script-corpus.ts`, and that corpus is held EXACTLY equal to
 * the scripts the product ships locale bundles for — `script-coverage-census.test.ts`
 * asserts `toEqual`, not containment — so adding a Greek sample fails that
 * census. Correctly: the corpus's job is to cover what the product renders, and
 * no Greek bundle ships.
 *
 * Stated here rather than left implied, because the reader this matters to is
 * whoever takes #854. Routing both folds through `foldAccents` fixes Cyrillic
 * and Greek together (measured). A Cyrillic-specific carve-out would leave
 * Greek live with nothing in this suite red — and the prose above saying "eat
 * Cyrillic and Greek marks" is a MEASUREMENT, not a claim of coverage.
 *
 * Recording it as a whole broken fold would have cost the Devanagari and Bengali
 * coverage it does have; recording it as nothing at all is what let it sit in
 * the preserving register claiming a property it does not have. So the entry
 * names the script.
 *
 * ## These are CHARACTERISATIONS, not endorsements
 *
 * Fixing the fold turns the case below red. That is the point, and it is the
 * same contract #833 wrote for the whole-fold register: delete the entry in the
 * same diff, and the pair rejoins the preserving loop automatically because that
 * loop's subjects are derived.
 */
interface MarkLosingPair {
  /** Must match a {@link MARK_PRESERVING_FOLDS} entry's `name`. */
  readonly name: string;
  readonly script: ScriptFamily;
  readonly issue: string;
}

/**
 * The register. **#854 is open, so it is no longer empty.**
 *
 * Both entries perform the identical `NFD` + strip; `alias-normalization.test.ts`
 * pins the two to each other on every fixture, which is why neither can be fixed
 * alone. `foldAccents` in `@mercaria/shared-types` is the CORRECTED spelling of
 * the same fold and is what they adopt when #854 is taken — it drops a mark only
 * when it is a Latin combining diacritic sitting on a Latin base.
 *
 * `normalizeCatalogAlias` is the one that costs money: its output is STORED as
 * `category_aliases.normalized_alias`, under
 * `category_aliases_category_locale_normalized_key`, so two distinct Russian
 * aliases for one category in one locale do not merely match loosely — the
 * second fails its write.
 */
const MARK_LOSING_PAIRS: readonly MarkLosingPair[] = [
  { name: 'normalizeCatalogAlias', script: 'Cyrillic', issue: '#854' },
  { name: 'foldPhrase', script: 'Cyrillic', issue: '#854' },
];

const isKnownLosing = (name: string, script: ScriptFamily): boolean =>
  MARK_LOSING_PAIRS.some((pair) => pair.name === name && pair.script === script);

/**
 * The scripts whose corpus entry carries a marks-only pair — DERIVED.
 *
 * This was `['Bengali', 'Devanagari']`, written out, and that literal is the
 * whole of why #854 was invisible here: `normalizeCatalogAlias` and `foldPhrase`
 * pass both of those scripts and were therefore never asked about the one they
 * fail. A fold cannot be caught being wrong about a script nobody measured it
 * against, and a hand-maintained list of subjects is a list of the mistakes
 * somebody had already thought of.
 */
const MARK_BEARING = markBearingScripts();

describe('a fold that keeps combining marks keeps two words apart', () => {
  for (const { name, fold } of MARK_PRESERVING_FOLDS) {
    it(`${name} keeps a mark-bearing pair apart in every script not registered against it`, () => {
      let asserted = 0;
      for (const script of MARK_BEARING) {
        // A pair this fold is KNOWN to collapse is characterised below with its
        // issue, not asserted here. Skipping it silently is what the floor
        // underneath stops: a fold registered as losing for every script would
        // otherwise assert nothing and report exactly what a clean run reports.
        if (isKnownLosing(name, script)) continue;
        const pair = scriptMarkPair(script);
        asserted += 1;
        expect(
          fold(pair.marked),
          `${name} collapsed ${script} "${pair.marked}" (${pair.markedGloss}) onto `
            + `"${pair.unmarked}" (${pair.unmarkedGloss})`,
        ).not.toBe(fold(pair.unmarked));
      }
      expect(
        asserted,
        `${name} is registered as mark-losing for every mark-bearing script, so this case `
          + 'measured nothing. A fold with no script left to be right about belongs in a '
          + 'different suite, not in a green one.',
      ).toBeGreaterThan(0);
    });

    it(`${name} lets a combining mark out the other side`, () => {
      // The MECHANISM, carried over from the list #838 emptied. Distinctness
      // alone can hold while marks are eaten — two words can survive a fold that
      // destroys their marks and still differ on the letters around them — so
      // this asserts the marks THEMSELVES.
      //
      // Deliberately not "the output is shorter": the folds fixed in #838
      // replaced each mark with a SPACE, leaving the codepoint count unchanged,
      // so a length assertion passes while measuring nothing.
      let marked = 0;
      for (const script of MARK_BEARING) {
        if (isKnownLosing(name, script)) continue;
        const pair = scriptMarkPair(script);
        for (const input of [pair.marked, pair.unmarked]) {
          // Only one half of the Bengali pair carries a mark: `বই` is two
          // independent letters and the matras are in `বইগুলি`. Asserting on the
          // noun of every pair would fail on a fold doing nothing wrong.
          if (!/\p{M}/u.test(input)) continue;
          marked += 1;
          expect(
            /\p{M}/u.test(fold(input)),
            `${name} ate every combining mark in ${script} "${input}" — output ${JSON.stringify(fold(input))}`,
          ).toBe(true);
        }
      }
      // The floor: with no mark-bearing fixture the loop above asserts nothing.
      //
      // THREE, and the number is a measurement rather than a count of the
      // corpus's pairs — which is what keeps it from being circular. The corpus
      // carries FOUR mark pairs and only three of their eight members carry a
      // mark in COMPOSED form: Devanagari contributes both halves, Bengali only
      // its marked one, and Cyrillic and Hiragana contribute NOTHING because `й`
      // (U+0439) and `じ` (U+3058) are precomposed and `\p{M}` does not match
      // them as written. Those two are carried by the DISTINCTNESS case above,
      // which is the half that catches #854.
      //
      // So a fifth pair does not necessarily move this number, and a decomposed
      // fixture would. Either way it moves deliberately.
      expect(marked, 'no mark-bearing fixture reached the assertion').toBe(3);
    });
  }

  it('covers every fold that was moved out of the losing register', () => {
    // A containment check, not an exact list: this file gains preserving folds
    // routinely and an exact pin would conflict on every one. What must not
    // silently vanish is a fold that was KNOWN broken and is now claimed fixed.
    const names = MARK_PRESERVING_FOLDS.map((entry) => entry.name);
    for (const moved of [
      'normalizeSourceConditionLabel',
      'normalizeQueryTokens',
      "applyExternalTransform('strip_diacritics')",
      'normalizeEntityName',
    ]) {
      expect(names, `${moved} left the suite instead of being asserted`).toContain(moved);
    }
  });
});

describe('the register of folds that still destroy combining marks (#830, #854)', () => {
  for (const { name, script, issue } of MARK_LOSING_PAIRS) {
    const entry = MARK_PRESERVING_FOLDS.find((candidate) => candidate.name === name);

    it(`${name} collapses a ${script} mark pair onto one key — ${issue}`, () => {
      // The register names a fold by STRING, so a rename would silently empty
      // this case. Resolving it against the real list is what makes that a
      // failure instead of a skipped subject.
      if (entry === undefined) {
        throw new Error(`${name} is registered as mark-losing but is not a fold under test`);
      }
      const { fold } = entry;
      const pair = scriptMarkPair(script);

      // The premise, first: the two fixtures really are two different strings.
      // Without it a corpus edit making them identical turns everything below
      // into a comparison of a word with itself.
      expect(pair.marked, 'the corpus pair collapsed — this case would assert nothing')
        .not.toBe(pair.unmarked);

      // A CHARACTERISATION, not an endorsement. Fixing the fold makes this red,
      // which is the point: delete the register entry in the same diff and the
      // pair rejoins the preserving loop, which derives its subjects.
      //
      // The MECHANISM is stated as "the MARKED word folds to exactly the
      // UNMARKED one" rather than #833's "the input carried a `\p{M}` and the
      // output does not". `мой` is PRECOMPOSED, so that spelling would fail on
      // the premise instead of on the defect — and this one is sharper anyway:
      // the mark did not merely vanish, it took the letter's identity with it
      // and handed back a different real word.
      expect(
        fold(pair.marked),
        `${name} no longer folds ${script} "${pair.marked}" (${pair.markedGloss}) onto `
          + `"${pair.unmarked}" (${pair.unmarkedGloss}). If ${issue} is fixed, delete this `
          + 'entry from MARK_LOSING_PAIRS in the same diff so the preserving loop measures '
          + 'the pair again.',
      ).toBe(pair.unmarked);
    });
  }

  it('names exactly the folds #854 is open against, and no others', () => {
    // #833 measured three whole folds and #838 fixed all three, which emptied
    // this register. #854 refilled it with two (fold, script) pairs. An EXACT
    // pin rather than a floor: a fold added here without an issue is somebody
    // recording a defect instead of fixing it, and a fold removed without the
    // fix landing is the register quietly losing a subject.
    expect(MARK_LOSING_PAIRS.map((pair) => `${pair.name}/${pair.script}/${pair.issue}`)).toEqual([
      'normalizeCatalogAlias/Cyrillic/#854',
      'foldPhrase/Cyrillic/#854',
    ]);
  });

  it('registers no pair for a script the corpus cannot measure', () => {
    // A pair naming a script with no mark fixture would make `scriptMarkPair`
    // throw INSIDE the case above — a red build with a confusing message rather
    // than a clear one. It would also mean the preserving loop was skipping a
    // subject that never existed.
    for (const pair of MARK_LOSING_PAIRS) {
      expect(MARK_BEARING, `${pair.name} is registered against ${pair.script}, which carries no `
        + 'mark pair in the corpus').toContain(pair.script);
    }
  });

  it('strip_diacritics keeps the Japanese dakuten, which is part of the word', () => {
    // `じ` is `し` plus U+3099. Removing it does not "remove an accent" — it
    // yields a different, meaningless word, and `じてんしゃ` (bicycle) became
    // `してんしゃ` under `strip_diacritics:1`. The rule is documented as being for
    // a source that varies on ACCENTS, and Latin is the only script where that
    // description holds, so version 2 folds through `foldAccents`.
    const hiragana = scriptSample('Hiragana');
    const stripped = applyExternalTransform(
      'strip_diacritics',
      latestTransformRuleVersion('strip_diacritics'),
      hiragana.noun,
    );
    expect(stripped.outcome).toBe('normalized');
    expect(stripped.outcome === 'normalized' && stripped.value).toBe(hiragana.noun);
    // The variant is what the broken version produced, so asserting the output
    // is NOT it fails if `scriptVariant` and `noun` ever stop differing — which
    // would make the line above pass while comparing a word with itself.
    expect(scriptVariant('Hiragana')).not.toBe(hiragana.noun);
  });

  it('strip_diacritics still folds a LATIN accent — the control that must keep passing', () => {
    // Under-folding is the safe direction, but a fold that folds NOTHING is not
    // a fix, it is the rule doing nothing under its own name. `Nestlé` is #834's
    // control and it is repeated here because this is a different rule.
    const folded = applyExternalTransform(
      'strip_diacritics',
      latestTransformRuleVersion('strip_diacritics'),
      'Nestlé',
    );
    expect(folded).toEqual({ outcome: 'normalized', value: 'nestle' });
  });

  it('version 1 of strip_diacritics is RETIRED and refuses rather than folding', () => {
    // #838's decision, asserted: a mapping reviewed under the mark-eating rule
    // answers `rule_not_registered`, which `resolution.service.ts` reports as
    // `transform_refused` and routes to review. Correcting version 1 in place
    // would have changed the meaning of every approved row silently.
    expect(latestTransformRuleVersion('strip_diacritics')).toBe(2);
    expect(applyExternalTransform('strip_diacritics', 1, 'साइकिलें')).toEqual({
      outcome: 'refused',
      reason: 'rule_not_registered',
    });
  });
});

describe('slug folds discard every non-Latin script entirely', () => {
  // Not a mark bug: an ASCII-only class deletes whole words. Recorded because a
  // Hindi store handle, category slug or seller segment is not "mostly right",
  // it is empty — and nothing downstream says so.
  it('slugify yields an EMPTY slug for every non-Latin script', () => {
    for (const sample of SCRIPT_CORPUS) {
      if (sample.script === 'Latin') continue;
      expect(slugify(sample.noun), `${sample.script} produced a non-empty slug`).toBe('');
    }
    // The positive control: Latin still slugs, and accents fold rather than drop.
    expect(slugify('bicicleta')).toBe('bicicleta');
    expect(slugify('café')).toBe('cafe');
  });

  it('marketplaceSellerSlugSegment falls back to a constant for every non-Latin handle', () => {
    // Every non-Latin seller on one marketplace collapses onto the SAME segment,
    // so the segment carries no identity at all for them.
    const segments = new Set(
      SCRIPT_CORPUS.filter((sample) => sample.script !== 'Latin').map((sample) =>
        marketplaceSellerSlugSegment(sample.noun),
      ),
    );
    expect(segments).toEqual(new Set(['seller']));
    expect(marketplaceSellerSlugSegment('bicicleta')).toBe('bicicleta');
  });

  it('sanitizeUploadFilename REFUSES a non-Latin filename rather than emptying it', () => {
    // The same ASCII-only class, failing the safe way round: loud, with a message
    // the merchant can act on. Contrast the two above, which are silent.
    for (const sample of SCRIPT_CORPUS) {
      if (sample.script === 'Latin') continue;
      expect(() => sanitizeUploadFilename(sample.noun), `${sample.script} was accepted`).toThrow();
    }
    expect(sanitizeUploadFilename('bicicleta')).toBe('bicicleta');
  });
});

describe('redactors leave ordinary non-Latin prose alone', () => {
  // #832 is that `[A-Z]`-anchored address patterns never fire on a non-Latin
  // address. The half that IS assertable without shipping a fake address is the
  // other direction: a redactor must not mangle ordinary text it should ignore.
  const redactors: readonly NamedFold[] = [
    { name: 'redactSupplierOrderMessage', fold: redactSupplierOrderMessage },
    { name: 'redactSupplierProviderMessage', fold: redactSupplierProviderMessage },
    { name: 'redactProviderMessage', fold: redactProviderMessage },
    { name: 'redactSearchQuery', fold: (value) => redactSearchQuery(value).redactedText },
  ];
  for (const { name, fold } of redactors) {
    it(`${name} passes every script through unchanged`, () => {
      for (const sample of SCRIPT_CORPUS) {
        const phrase = `${sample.adjective} ${sample.noun}`;
        expect(fold(phrase), `${name} altered ${sample.script}`).toBe(phrase);
      }
    });
  }

  it('the redaction controls still fire, so the assertions above are not vacuous', () => {
    // Without this, "passes through unchanged" is satisfied by a redactor that
    // does nothing at all.
    expect(redactSupplierOrderMessage('write to a@b.com')).not.toContain('a@b.com');
    expect(redactProviderMessage('write to a@b.com')).not.toContain('a@b.com');
    expect(redactSearchQuery('mail a@b.com').redactedText).not.toContain('a@b.com');
  });
});

describe('NFKC folding of half-width katakana is not applied consistently', () => {
  // A finding rather than a defect: `ｼﾞﾃﾝｼｬ` and `ジテンシャ` are the same word,
  // and whether a fold unifies them decides whether a Japanese buyer's query
  // matches a Japanese seller's title. Three folds unify; three do not. Pinned so
  // the inconsistency is visible to whoever next changes one of them.
  const katakana = scriptSample('Katakana');
  const halfWidth = scriptVariant('Katakana');

  it('the NFKC folds unify the two widths', () => {
    expect(normalizeSearchQuery(halfWidth).normalized).toBe(
      normalizeSearchQuery(katakana.noun).normalized,
    );
    expect(normalizeDisplayNameForComparison(halfWidth)).toBe(
      normalizeDisplayNameForComparison(katakana.noun),
    );
    expect(sanitizeQueryForModel(halfWidth)).toBe(katakana.noun);
  });

  it('the NFD and pass-through folds do NOT', () => {
    expect(normalizeEntityName(halfWidth)).not.toBe(normalizeEntityName(katakana.noun));
    expect(normalizeTitle(halfWidth)).not.toBe(normalizeTitle(katakana.noun));
    expect(foldPhrase(halfWidth)).not.toBe(foldPhrase(katakana.noun));
  });
});

describe('a delivery address survives in every script', () => {
  it('normalizeCheckoutAddress preserves the recipient, street and city verbatim', () => {
    // The one fold on this path that touches a buyer's own name and street. It
    // NFC-normalizes and trims and does nothing else, which is what it should do —
    // asserted so that a future "clean up the address" change cannot quietly turn
    // it into a slug.
    for (const sample of SCRIPT_CORPUS) {
      const normalized = normalizeCheckoutAddress({
        recipientName: sample.noun,
        line1: `12 ${sample.noun}`,
        city: sample.adjective,
        postalCode: '28001',
        country: 'ES',
      });
      expect(normalized.recipientName, `${sample.script} recipient`).toBe(sample.noun);
      expect(normalized.line1, `${sample.script} street`).toBe(`12 ${sample.noun}`);
      expect(normalized.city, `${sample.script} city`).toBe(sample.adjective);
    }
  });
});
