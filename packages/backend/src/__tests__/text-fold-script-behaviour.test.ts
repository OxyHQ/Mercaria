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
 * they are the #830 defect, still live, in three more places than #830 fixed.
 * Fixing one is a ONE-LINE diff here: move it between the lists. That is
 * deliberate. A fix that did not have to touch this file would be a fix nobody
 * could see.
 */

import { describe, expect, it } from 'vitest';
import { SCRIPT_CORPUS, scriptSample, scriptVariant } from './script-corpus.js';
import { slugify } from '../utils/slug.js';
import { normalizeEntityName, wordTokens } from '../services/canonical/normalization.js';
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
import { normalizeSourceConditionLabel } from '@mercaria/shared-types';

/** A fold under test: a name, and a `string -> string` view of it. */
interface NamedFold {
  readonly name: string;
  readonly fold: (value: string) => string;
}

/**
 * Folds that PRESERVE a script's combining marks.
 *
 * The property asserted of all of them: two words differing only in marks fold
 * to two different strings. `normalizeEntityName` is here because #834 put it
 * here — before that fix it belonged in the list below.
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
];

/**
 * Folds that DESTROY combining marks — the #830 mechanism, still live.
 *
 * All three replace or split on a class built from `\p{L}`/`\p{N}` without
 * `\p{M}`, or decompose with NFD and strip everything that decomposed. Each is
 * filed; none is fixed here, and the reason is the same for all three: every one
 * of them writes a STORED lookup key
 * (`condition_mapping_rules.source_label_normalized`,
 * `analytics_search_queries.normalized_tokens`, and an external mapping's
 * comparison value), so changing the fold re-keys existing rows and needs a
 * backfill migration. That is a separate change with a separate review.
 */
const MARK_LOSING_FOLDS: readonly (NamedFold & { readonly issue: string })[] = [
  {
    name: 'normalizeSourceConditionLabel',
    issue: '#838 — [^\\p{Letter}\\p{Number}]+ in @mercaria/shared-types',
    fold: normalizeSourceConditionLabel,
  },
  {
    name: 'normalizeQueryTokens',
    issue: '#838 — split(/[^\\p{L}\\p{N}]+/u) in analytics/redact-query.ts',
    fold: (value) => normalizeQueryTokens(value).join('|'),
  },
  {
    name: "applyExternalTransform('strip_diacritics')",
    issue: '#838 — NFD + strip every mark, in catalog-external-mappings',
    fold: (value) => {
      const result = applyExternalTransform(
        'strip_diacritics',
        latestTransformRuleVersion('strip_diacritics'),
        value,
      );
      return result.outcome === 'normalized' ? result.value : `refused:${result.reason}`;
    },
  },
];

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
  }
});

describe('the folds that still destroy combining marks (#830, three more sites)', () => {
  for (const { name, fold, issue } of MARK_LOSING_FOLDS) {
    it(`${name} collapses Devanagari singular and plural onto one key — ${issue}`, () => {
      // A CHARACTERISATION, not an endorsement. Fixing the fold makes this red,
      // which is the point: move the entry into MARK_PRESERVING_FOLDS in the same
      // diff and the loss stops being invisible.
      const hindi = scriptSample('Devanagari');
      expect(fold(hindi.noun)).toBe(fold(scriptVariant('Devanagari')));
      // …and the MECHANISM is mark loss rather than a coincidence of these two
      // words. Deliberately not "the output is shorter": two of these three
      // replace each mark with a SPACE, so the codepoint count is unchanged and a
      // length assertion passes while measuring nothing.
      expect(/\p{M}/u.test(hindi.noun), 'the fixture carries no combining mark').toBe(true);
      expect(/\p{M}/u.test(fold(hindi.noun)), 'the marks survived — has this been fixed?')
        .toBe(false);
    });
  }

  it('names exactly the sites measured, so a fourth is a deliberate addition', () => {
    expect(MARK_LOSING_FOLDS.map((entry) => entry.name)).toEqual([
      'normalizeSourceConditionLabel',
      'normalizeQueryTokens',
      "applyExternalTransform('strip_diacritics')",
    ]);
  });

  it('strip_diacritics also strips the Japanese dakuten, which changes the word', () => {
    // `じ` is `し` plus a dakuten. Removing it does not "remove an accent" — it
    // yields a different, meaningless word. The rule is documented as being for a
    // source that varies on ACCENTS, and Latin is the only script where that
    // description holds.
    const hiragana = scriptSample('Hiragana');
    const stripped = applyExternalTransform(
      'strip_diacritics',
      latestTransformRuleVersion('strip_diacritics'),
      hiragana.noun,
    );
    expect(stripped.outcome).toBe('normalized');
    expect(stripped.outcome === 'normalized' && stripped.value).toBe(scriptVariant('Hiragana'));
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
