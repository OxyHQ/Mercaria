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
 * that differ only in marks stay different. {@link MARK_LOSING_FOLDS} do not —
 * they are the #830 defect. Fixing one is a ONE-LINE diff here: move it between
 * the lists. That is deliberate. A fix that did not have to touch this file
 * would be a fix nobody could see.
 *
 * **#838 emptied the second list**, and the assertions did not go with it: the
 * mark-loss MECHANISM check the losing group carried is now applied to every
 * member of the preserving one, on whichever half of each pair actually carries
 * a mark. Otherwise fixing the bug would have deleted the only test that could
 * detect it coming back.
 */

import { describe, expect, it } from 'vitest';
import { SCRIPT_CORPUS, scriptSample, scriptVariant } from './script-corpus.js';
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
 * Folds that DESTROY combining marks — the #830 mechanism.
 *
 * **EMPTY, and that is the finding rather than the absence of one.** #833 put
 * three here; #838 fixed all three and moved them up. A fourth belongs here the
 * day it is measured, with its issue, and the loop below runs again.
 *
 * The register is kept rather than deleted because an empty list is a claim —
 * "this repository has no known mark-eating fold" — and `the register is empty`
 * below is what asserts it. What it must NOT be is the only thing left standing:
 * a `for` loop over an empty array emits zero tests and reads exactly like a
 * passing suite, which is why the mechanism assertion moved into
 * {@link MARK_PRESERVING_FOLDS} instead of being deleted with these entries.
 */
const MARK_LOSING_FOLDS: readonly (NamedFold & { readonly issue: string })[] = [];

/** The scripts whose corpus entry carries a marks-only variant pair. */
const MARK_BEARING = ['Bengali', 'Devanagari'] as const;

describe('a fold that keeps combining marks keeps two words apart', () => {
  for (const { name, fold } of MARK_PRESERVING_FOLDS) {
    it(`${name} distinguishes singular from plural in every mark-bearing script`, () => {
      for (const script of MARK_BEARING) {
        const sample = scriptSample(script);
        // The corpus guarantees these differ ONLY in marks, so a fold that
        // collapses them has eaten the marks and nothing else could explain it.
        const variant = scriptVariant(script);
        expect(
          fold(sample.noun),
          `${name} collapsed ${script} "${sample.noun}" (${sample.nounGloss}) onto "${variant}" (${sample.variantGloss})`,
        ).not.toBe(fold(variant));
      }
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
        const sample = scriptSample(script);
        for (const input of [sample.noun, scriptVariant(script)]) {
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
      // Measured on the corpus #833 ships — Devanagari contributes both halves,
      // Bengali only its variant.
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

describe('the register of folds that still destroy combining marks (#830)', () => {
  for (const { name, fold, issue } of MARK_LOSING_FOLDS) {
    it(`${name} collapses Devanagari singular and plural onto one key — ${issue}`, () => {
      // A CHARACTERISATION, not an endorsement. Fixing the fold makes this red,
      // which is the point: move the entry into MARK_PRESERVING_FOLDS in the same
      // diff and the loss stops being invisible.
      const hindi = scriptSample('Devanagari');
      expect(fold(hindi.noun)).toBe(fold(scriptVariant('Devanagari')));
      // …and the MECHANISM is mark loss rather than a coincidence of these two
      // words. Deliberately not "the output is shorter": the folds this held
      // replaced each mark with a SPACE, so the codepoint count is unchanged and
      // a length assertion passes while measuring nothing.
      expect(/\p{M}/u.test(hindi.noun), 'the fixture carries no combining mark').toBe(true);
      expect(/\p{M}/u.test(fold(hindi.noun)), 'the marks survived — has this been fixed?')
        .toBe(false);
    });
  }

  it('is empty — no fold in this repository is known to eat combining marks', () => {
    // #833 measured three and #838 fixed all three. This assertion is the claim
    // that the count is now zero; it is not the gate. The gate is the pair of
    // properties every entry in MARK_PRESERVING_FOLDS is held to, which is where
    // the three went and where a regression in any of them turns red.
    expect(MARK_LOSING_FOLDS.map((entry) => entry.name)).toEqual([]);
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
