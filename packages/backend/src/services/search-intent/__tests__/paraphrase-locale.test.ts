/**
 * A shopper is described back in their own language (#367 line 590, #946 piece 2).
 *
 * `deterministic.ts` already MATCHED a typed phrase against every localized
 * label a definition carries — that is how `memoria` finds the RAM attribute.
 * What it did not do is describe the result under the label it matched: every
 * explanation was built from `definition.row.label`, the BASE label. So a
 * shopper who typed `memoria` was told **"RAM is at least 16 GB"** in English,
 * having been understood perfectly.
 *
 * ## What this covers, and what it deliberately does not
 *
 * **Labels only.** The attribute name inside the sentence, and the category name
 * in the paraphrase's category line. The English TEMPLATE sentences around them
 * — *"is at least"*, *"we treated it as a preference"* — are #946 piece 3 and a
 * product decision; nothing here touches them, and a case asserting a fully
 * Spanish sentence would be asserting behaviour nobody has decided on.
 *
 * **And no number formatting.** `describeBudget`'s docblock
 * (`paraphrase.ts:171-172`) records that grouping and locale-aware rendering
 * belong to the client, which knows the shopper's locale and has `formatMoney`.
 * That decision is about a MONEY AMOUNT and it is real; it does not cover
 * labels, which is why this fix is available and that one is not.
 *
 * ## The fixture is the lead's own example, and it already existed
 *
 * `BENCHMARK_LAPTOP_DEFINITIONS` carries `{ locale: 'es', label: 'memoria' }` on
 * the RAM attribute — so the case runs through the real interpreter over the
 * real registry, with no fixture minted for it.
 */

import { describe, expect, it } from 'vitest';
import { interpretDeterministically } from '../deterministic.js';
import { labelForLocale } from '../locale.js';
import { BENCHMARK_LAPTOP_DEFINITIONS } from '../benchmark/registry.js';

const read = (query: string, locale: string) =>
  interpretDeterministically({ query, locale, definitions: BENCHMARK_LAPTOP_DEFINITIONS });

const ramExplanation = (query: string, locale: string): string | undefined =>
  read(query, locale).requirements.find((requirement) => requirement.attributeKey === 'ram')
    ?.explanation;

describe('the explanation names the attribute in the shopper’s language', () => {
  it('describes a Spanish query in Spanish', () => {
    const explanation = ramExplanation('portátil con al menos 16 GB de memoria', 'es-ES');
    expect(explanation, 'no RAM requirement was read at all').toBeDefined();
    expect(explanation).toContain('memoria');
    // The label, not the sentence. The English template around it is #946
    // piece 3 and is deliberately still here.
    expect(explanation).not.toContain('RAM');
  });

  it('leaves an English query exactly as it was', () => {
    // The regression half. A change that localized everything would also change
    // what an English shopper reads, and the benchmark's recorded thresholds
    // were measured against these strings. `Memory` is the BASE label here —
    // read off the registry rather than assumed, after a first draft of this
    // case asserted `RAM` and went red.
    const explanation = ramExplanation('laptop with at least 16 GB of memory', 'en-GB');
    expect(explanation).toContain('Memory');
    expect(explanation).not.toContain('memoria');
  });

  it('describes a German query in German — the second language, not the first', () => {
    // The registry carries `de` as well as `es`, which a first draft of this
    // file did not check before asserting German had no translation. Keeping
    // the case as a POSITIVE one is better than moving to a locale with no row:
    // it proves the picker selects per request rather than returning whichever
    // localization it finds first.
    const explanation = ramExplanation('Laptop mit mindestens 16 GB Arbeitsspeicher', 'de-DE');
    expect(explanation).toContain('Arbeitsspeicher');
    expect(explanation).not.toContain('memoria');
  });

  it('falls back to the base label for a locale the registry has no row for', () => {
    // Italian has no row on this attribute — verified against the fixture in
    // the self-test below. The base label is the answer, never another
    // language's, which is the narrowing the picker exists for.
    const explanation = ramExplanation('laptop con almeno 16 GB di memory', 'it-IT');
    expect(explanation).toContain('Memory');
    expect(explanation).not.toContain('memoria');
    expect(explanation).not.toContain('Arbeitsspeicher');
  });
});

describe('labelForLocale, branch by branch', () => {
  const labels = [
    { locale: 'es', label: 'memoria' },
    { locale: 'es-MX', label: 'memoria RAM' },
    { locale: 'fr', label: 'mémoire' },
  ];

  it('prefers the exact tag over the bare language', () => {
    expect(labelForLocale('RAM', labels, 'es-MX')).toBe('memoria RAM');
  });

  it('falls back from the tag to the language', () => {
    expect(labelForLocale('RAM', labels, 'es-AR')).toBe('memoria');
  });

  it('takes the bare language when that is what was asked for', () => {
    expect(labelForLocale('RAM', labels, 'es')).toBe('memoria');
  });

  it('never returns ANOTHER language, only the base', () => {
    // The narrowing that matters. A French row is not a better answer for a
    // German reader than the base one, and "whatever localization exists" is
    // how a German shopper gets Portuguese.
    expect(labelForLocale('RAM', labels, 'de-DE')).toBe('RAM');
  });

  it('treats a blank localized label as absent', () => {
    // A row somebody left empty is not a translation, and rendering it would
    // replace a real English word with nothing.
    expect(labelForLocale('RAM', [{ locale: 'es', label: '   ' }], 'es-ES')).toBe('RAM');
  });

  it('is case- and separator-insensitive about the tag', () => {
    expect(labelForLocale('RAM', [{ locale: 'ES-mx', label: 'memoria RAM' }], 'es_MX')).toBe(
      'memoria RAM',
    );
  });

  it('returns the base when there are no labels at all', () => {
    expect(labelForLocale('RAM', [], 'es-ES')).toBe('RAM');
  });
});

describe('the fixture can tell the two apart (self-test)', () => {
  it('the registry really carries a Spanish RAM label, and it differs from the base', () => {
    // Without this, every case above passes on a registry whose Spanish label
    // happened to equal the base — which is the shape that makes a localization
    // test vacuous while reading as thorough.
    const ram = BENCHMARK_LAPTOP_DEFINITIONS.find((definition) => definition.row.key === 'ram');
    expect(ram, 'no `ram` definition in the benchmark registry').toBeDefined();
    const spanish = ram?.labels.find((label) => label.locale === 'es');
    expect(spanish?.label, 'the registry has no Spanish RAM label').toBe('memoria');
    expect(spanish?.label).not.toBe(ram?.row.label);
    // And the locales the cases above ASSERT ARE ABSENT really are. A fallback
    // case pointed at a locale the registry actually carries is a case that
    // proves the opposite of what it says — measured: the first draft used
    // `de-DE`, which has a row.
    expect(ram?.labels.map((label) => label.locale).sort()).toEqual(['de', 'es']);
    expect(ram?.row.label).toBe('Memory');
  });
});
