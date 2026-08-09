/**
 * The two separations #94 asks to be STRUCTURAL rather than intended, checked
 * against the real source tree.
 *
 *  1. **A hard requirement is never quietly downgraded to a preference**
 *     (hard-constraint rule 4). Nothing outside the parse boundary may write a
 *     constraint's `strength`, and the evaluator takes no strength argument.
 *  2. **Price, shipping and availability come from current eligible offers, not
 *     from static product attributes** (rule 6). The commerce evaluator reads
 *     the offer port and no attribute storage; the attribute evaluator reads
 *     attributes and no offer storage; and the registry refuses to define a key
 *     that would let the two be confused.
 *
 * Both are static scans, and both carry the defences AGENTS.md rule (C) asks
 * for: a vacuity floor (the scan must actually find files), and a mutation
 * self-test (each pattern is proved to fire against a string that violates it,
 * so a broken regex cannot pass silently).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RESERVED_OFFER_FACT_KEYS } from '@mercaria/shared-types';

const DOMAIN_DIR = fileURLToPath(new URL('..', import.meta.url));

/** Every module in the attribute domain, tests excluded. */
function domainModules(): { path: string; source: string }[] {
  return readdirSync(DOMAIN_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => ({
      path: entry.name,
      source: readFileSync(join(DOMAIN_DIR, entry.name), 'utf8'),
    }));
}

/**
 * Writes to a constraint's `strength`.
 *
 * `strength:` in an object literal is how a constraint is CONSTRUCTED, which is
 * legitimate everywhere; `.strength =` is how one would be MUTATED, which is the
 * downgrade this rule forbids and which nothing in the domain does.
 */
const STRENGTH_MUTATION = /\.strength\s*=[^=]/u;

/** A module reaching into attribute storage. */
const ATTRIBUTE_STORAGE = /from\s+'[^']*(attributeRepository|canonicalCatalog|attributeOpsRepository)/u;

describe('hard constraints cannot be downgraded', () => {
  const modules = domainModules();

  it('scans the whole domain (vacuity floor)', () => {
    expect(modules.length).toBeGreaterThanOrEqual(10);
    expect(modules.map((module) => module.path)).toContain('constraint-evaluation.ts');
    expect(modules.map((module) => module.path)).toContain('constraint-validation.ts');
  });

  it('never mutates a constraint strength anywhere in the domain', () => {
    const offenders = modules
      .filter((module) => STRENGTH_MUTATION.test(module.source))
      .map((module) => module.path);
    expect(offenders).toEqual([]);
  });

  it('proves the mutation pattern fires (mutation self-test)', () => {
    // A check that cannot distinguish success from failure is worse than none:
    // this is the string the rule exists to catch, and the pattern must reject
    // it while leaving a legitimate construction alone.
    expect(STRENGTH_MUTATION.test("constraint.strength = 'preference';")).toBe(true);
    expect(STRENGTH_MUTATION.test('  set.hard[0].strength   =  x')).toBe(true);
    expect(STRENGTH_MUTATION.test("  strength: 'preference',")).toBe(false);
    expect(STRENGTH_MUTATION.test("if (a.strength === 'hard') {")).toBe(false);
  });

  it('gives the evaluator no strength parameter to be told the wrong answer through', () => {
    const evaluator = modules.find((module) => module.path === 'constraint-evaluation.ts');
    if (!evaluator) throw new Error('constraint-evaluation.ts is missing');
    // The exported entry point takes a validated set, a candidate's facts and an
    // options object whose only member is a variant id. A `strength` or a
    // `relax`/`downgrade` option would be the parameter this rule forbids.
    expect(/export interface EvaluateOptions \{[^}]*\}/su.exec(evaluator.source)?.[0]).not.toMatch(
      /strength|relax|downgrade|soften/u,
    );
  });

  it('derives the verdict from the hard outcomes only', () => {
    const evaluator = modules.find((module) => module.path === 'constraint-evaluation.ts');
    if (!evaluator) throw new Error('constraint-evaluation.ts is missing');
    const verdict = /const verdict = ([\s\S]*?);\n/u.exec(evaluator.source)?.[1] ?? '';
    expect(verdict).toContain('hardOutcomes');
    // If `preferenceOutcomes` could reach the verdict, a failing preference
    // could exclude — or, worse, a passing one could rescue a failed hard
    // requirement. Neither is representable while this holds.
    expect(verdict).not.toContain('preferenceOutcomes');
  });
});

describe('commercial facts come from offers only', () => {
  const modules = domainModules();

  it('keeps the evaluator away from attribute and offer STORAGE alike', () => {
    const evaluator = modules.find((module) => module.path === 'constraint-evaluation.ts');
    if (!evaluator) throw new Error('constraint-evaluation.ts is missing');
    // The evaluator is pure: it receives facts. If it could query, "which offers
    // are eligible" and "which values are selected" would each have a second
    // definition, and the two would disagree the first time one changed.
    expect(ATTRIBUTE_STORAGE.test(evaluator.source)).toBe(false);
    expect(evaluator.source).not.toContain('getDb(');
    expect(evaluator.source).not.toContain('drizzle-orm');
  });

  it('proves the storage pattern fires (mutation self-test)', () => {
    expect(
      ATTRIBUTE_STORAGE.test("import { x } from '../../db/canonical/attributeRepository.js';"),
    ).toBe(true);
    expect(ATTRIBUTE_STORAGE.test("import { y } from '../canonical/units.js';")).toBe(false);
  });

  it('answers every commerce facet from the offer port', () => {
    const evaluator = modules.find((module) => module.path === 'constraint-evaluation.ts');
    if (!evaluator) throw new Error('constraint-evaluation.ts is missing');
    const commerce = /function commerceSatisfaction\(([\s\S]*?)\n\}/u.exec(evaluator.source)?.[1];
    expect(commerce).toBeDefined();
    // Every branch reads `offer.…` — the port's snapshot — and no branch reads a
    // fact, which is what would make a static product attribute answer a price.
    expect(commerce).toContain('offer.lowestPriceMinor');
    expect(commerce).toContain('offer.availability');
    expect(commerce).not.toContain('productFacts');
    expect(commerce).not.toContain('variantFacts');
  });

  it('defaults to a port that reports no data rather than plausible numbers', () => {
    const port = modules.find((module) => module.path === 'offer-facts.port.ts');
    if (!port) throw new Error('offer-facts.port.ts is missing');
    expect(port.source).toContain('let registeredPort: OfferFactsPort = unavailableOfferFacts');
    // The default must be an empty map, not a throw (which would break every
    // search) and not a fabricated price (which would answer confidently and
    // wrongly).
    expect(port.source).toMatch(/unavailableOfferFacts[\s\S]*?return new Map\(\)/u);
  });
});

describe('reserved offer keys', () => {
  it('names every commercial fact a static attribute must not carry', () => {
    // A vacuity floor plus the specific members whose absence would reopen the
    // hole: `price` and `availability` are the two a real feed asserts.
    expect(RESERVED_OFFER_FACT_KEYS.length).toBeGreaterThanOrEqual(15);
    for (const key of ['price', 'availability', 'condition', 'shipping_cost', 'total_price']) {
      expect(RESERVED_OFFER_FACT_KEYS, `'${key}' must be reserved`).toContain(key);
    }
    // And `msrp` is deliberately NOT reserved: a manufacturer's suggested price
    // is a fact about the product, and a `money` attribute is its right home.
    expect(RESERVED_OFFER_FACT_KEYS).not.toContain('msrp');
  });

  it('is refused by the registry service with a message that points somewhere useful', async () => {
    const registry = readFileSync(join(DOMAIN_DIR, 'definition-registry.service.ts'), 'utf8');
    expect(registry).toContain('RESERVED_OFFER_FACT_KEYS.includes(key)');
    expect(registry).toContain('commerce constraint facets');
  });
});
