/**
 * The deterministic interpreter (#95 "Deterministic fallback").
 *
 * These are the cases that decide whether the FLOOR is a real search box or a
 * placeholder, so they assert behaviour rather than shape: what a phrase
 * becomes, what it deliberately does not become, and what is reported when
 * neither is safe.
 *
 * The FIXTURES exercise the distinction each rule exists to make, which is the
 * house law about fixtures: a case-insensitive comparison needs a mixed-case
 * input, a locale-dependent number needs one that reads differently under the
 * other convention, and a hard/soft rule needs both a bounded and an unbounded
 * magnitude. A fixture on the same side of the distinction as every other one
 * would pass under a rule that had been inverted.
 */

import { describe, expect, it } from 'vitest';
import { interpretDeterministically } from '../deterministic.js';
import { BENCHMARK_LAPTOP_DEFINITIONS, BENCHMARK_REGISTRIES } from '../benchmark/registry.js';

const laptops = BENCHMARK_LAPTOP_DEFINITIONS;

const read = (query: string, locale = 'en-GB', currency?: 'EUR' | 'USD' | 'GBP') =>
  interpretDeterministically({
    query,
    locale,
    ...(currency === undefined ? {} : { currency }),
    definitions: laptops,
  });

describe('magnitudes against #94 registry', () => {
  it('reads a bounded magnitude as a HARD requirement', () => {
    const draft = read('laptop with at least 16 GB of memory');
    const ram = draft.requirements.find((requirement) => requirement.attributeKey === 'ram');
    expect(ram?.strength).toBe('hard');
    expect(ram?.predicate.op).toBe('gte');
  });

  it('reads an UNBOUNDED magnitude as a preference, not a hard requirement', () => {
    // The distinction the previous case cannot make on its own: same attribute,
    // same unit, same number, no bound word. Reading this as hard would exclude
    // every 32 GB machine from a query that plainly wanted them, which is the
    // false hard constraint the benchmark measures.
    const draft = read('16 GB memory laptop');
    const ram = draft.requirements.find((requirement) => requirement.attributeKey === 'ram');
    expect(ram?.strength).toBe('preference');
    expect(ram?.predicate.op).toBe('eq');
  });

  it('an explicit strength word overrides the default', () => {
    const draft = read('laptop that must have 16 GB of memory');
    const ram = draft.requirements.find((requirement) => requirement.attributeKey === 'ram');
    expect(ram?.strength).toBe('hard');
  });

  it('resolves by the attribute NAME when several share a unit family', () => {
    const draft = read('laptop with a 14 inch screen');
    expect(draft.requirements.map((requirement) => requirement.attributeKey)).toContain(
      'screen_size',
    );
    expect(draft.ambiguities).not.toContain('attribute_disambiguation');
  });

  it('REFUSES to choose when the family fits several and nothing named one', () => {
    const draft = read('laptop 14 inches');
    expect(draft.ambiguities).toContain('attribute_disambiguation');
    expect(draft.requirements.map((requirement) => requirement.attributeKey)).not.toContain(
      'screen_size',
    );
    expect(draft.attributeAmbiguities[0]?.candidates.map((candidate) => candidate.key)).toEqual(
      expect.arrayContaining(['screen_size', 'width', 'depth']),
    );
  });

  it('a previously ANSWERED disambiguation resolves the same query', () => {
    const draft = interpretDeterministically({
      query: 'laptop 14 inches',
      locale: 'en-GB',
      definitions: laptops,
      preferredAttributeKeys: ['screen_size'],
    });
    expect(draft.ambiguities).not.toContain('attribute_disambiguation');
    expect(draft.requirements.map((requirement) => requirement.attributeKey)).toContain(
      'screen_size',
    );
  });

  it('degrades a hard requirement on an attribute #94 forbids excluding on', () => {
    const draft = interpretDeterministically({
      query: 'phone with at least 5000 mAh battery',
      locale: 'en-GB',
      definitions: BENCHMARK_REGISTRIES.smartphones ?? [],
    });
    const battery = draft.requirements.find(
      (requirement) => requirement.attributeKey === 'battery_capacity',
    );
    expect(battery?.strength).toBe('preference');
    expect(draft.unresolved.map((entry) => entry.kind)).toContain('unsupported_by_retrieval');
  });

  it('reports an unknown unit rather than guessing an attribute', () => {
    const draft = read('laptop with at least 16 zorks of memory');
    expect(draft.unresolved.map((entry) => entry.kind)).toContain('unknown_unit');
    expect(draft.requirements).toEqual([]);
  });

  it('reads a localized attribute LABEL from the registry', () => {
    const draft = read('portatil con al menos 16 GB de memoria', 'es-ES');
    expect(draft.requirements.map((requirement) => requirement.attributeKey)).toContain('ram');
  });
});

describe('money and locale', () => {
  it('reads a grouped Spanish amount as thousands, not as a decimal', () => {
    const draft = read('portatil hasta 1.299 EUR', 'es-ES');
    expect(draft.budget?.maxMinor).toBe(129_900);
  });

  it('reads the SAME string as a decimal under an English locale', () => {
    // The fixture that makes the previous case mean something: one string, two
    // conventions, two different numbers. A parser that ignored the locale
    // would pass one of these and fail the other.
    const draft = read('laptop up to 1.299 EUR', 'en-GB');
    expect(draft.budget?.maxMinor).toBe(130);
  });

  it('refuses an ambiguous grouped number in a language with no convention', () => {
    const draft = read('laptop 1,299 EUR', 'sw-KE');
    expect(draft.budget).toBeUndefined();
    expect(draft.unresolved.map((entry) => entry.kind)).toContain('ambiguous_phrase');
  });

  it('reports an ambiguous currency symbol rather than guessing a currency', () => {
    const draft = read('laptop under 900 $');
    expect(draft.budget).toBeUndefined();
    expect(draft.unresolved.map((entry) => entry.kind)).toContain('unknown_currency');
  });

  it("resolves the same symbol through the REQUEST's own currency", () => {
    const draft = read('laptop under 900 $', 'en-GB', 'USD');
    expect(draft.budget?.currency).toBe('USD');
    expect(draft.budget?.maxMinor).toBe(90_000);
  });

  it('reads a delivered total as a KNOWN TOTAL and asks nothing', () => {
    const draft = read('laptop under 900 EUR including shipping');
    expect(draft.budget?.basis).toBe('known_total');
    expect(draft.ambiguities).not.toContain('budget_basis');
  });

  it('asks about the basis when nothing said which', () => {
    const draft = read('laptop under 900 EUR');
    expect(draft.budget?.basis).toBe('item_price');
    expect(draft.ambiguities).toContain('budget_basis');
  });

  it('never reads a bare number as money', () => {
    const draft = read('laptop 16 GB 900');
    expect(draft.budget).toBeUndefined();
  });
});

describe('the dictionaries', () => {
  it('reads a Spanish condition phrase under an ENGLISH locale', () => {
    // Localization rule 6: a query in another language is READ in it, and
    // nothing about the response switches language.
    const draft = read('laptop 16 GB segunda mano', 'en-GB');
    expect(draft.condition?.groups).toContain('used');
  });

  it('does not read `new` inside a longer word', () => {
    // The word-boundary rule. A substring match would make `renew` a claim
    // about condition, and half a catalogue a leaning nobody expressed.
    const draft = read('laptop renewal plan');
    expect(draft.condition).toBeUndefined();
  });

  it('reads `refurbished` as refurbished rather than as used', () => {
    const draft = read('reacondicionado portatil', 'es-ES');
    expect(draft.condition?.groups).toEqual(['refurbished']);
  });

  it('reports a nearby request as UNENFORCEABLE rather than accepting it', () => {
    const draft = read('laptop cerca de mi', 'es-ES');
    expect(draft.nearby).toBe(true);
    expect(draft.unresolved.map((entry) => entry.kind)).toContain('unsupported_by_retrieval');
  });

  it('reads an official-channel request', () => {
    const draft = read('portatil de la tienda oficial', 'es-ES');
    expect(draft.officialChannelOnly).toBe(true);
  });

  it('reads the LONGEST budget bound, so a negation is not inverted', () => {
    // `no mas de` contains `mas de`, which is the OPPOSITE bound. A first-match
    // scan would show everything above the budget instead of below it.
    const draft = read('portatil no mas de 900 EUR', 'es-ES');
    expect(draft.budget?.maxMinor).toBe(90_000);
    expect(draft.budget?.minMinor).toBeUndefined();
  });
});

describe('the search text', () => {
  it('removes the phrases that became structured facts', () => {
    const draft = read('used laptop under 900 EUR');
    expect(draft.searchText.toLowerCase()).not.toContain('used');
    expect(draft.searchText.toLowerCase()).not.toContain('900');
    expect(draft.searchText.toLowerCase()).toContain('laptop');
  });

  it('leaves everything it did NOT understand exactly as typed', () => {
    const draft = read('thinkpad x1 carbon');
    expect(draft.searchText).toBe('thinkpad x1 carbon');
    expect(draft.requirements).toEqual([]);
    expect(draft.ambiguities).toEqual([]);
  });

  it('reads a bare barcode as an identifier and asks nothing', () => {
    const draft = read('5012345678900');
    expect(draft.identifiers.length).toBeGreaterThan(0);
    expect(draft.ambiguities).toEqual([]);
  });
});

describe('the interpreter never invents an entity', () => {
  it('claims no brand or merchant from a bare name', () => {
    // Resolving `lenovo` needs the catalogue, and #70's own brand stage answers
    // it. A guess here would be a hard taxonomy filter nobody asked for.
    const draft = read('lenovo laptop 16 GB');
    expect(draft.entityMentions).toEqual([]);
  });
});
