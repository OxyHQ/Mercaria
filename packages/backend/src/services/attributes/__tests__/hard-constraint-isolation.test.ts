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
 *
 * ## The population the FIRST rule is applied to, and what it used to be (#460)
 *
 * Rule 1 is domain-wide — *nothing outside the parse boundary may write a
 * constraint's `strength`* — and its population was
 * `readdirSync(services/attributes)` ONE LEVEL DEEP: twelve modules. The other
 * EIGHT of this domain's twenty were outside it: both repositories, both public
 * controllers, both internal ones, `middleware/attribute-schemas.ts` and
 * `db/schema/attributeRegistry.ts`.
 *
 * **`middleware/attribute-schemas.ts` is the one to read.** A hard requirement
 * is downgraded to a preference by whatever turns a request body into a
 * constraint, and that is the request-schema module — the single most likely
 * home for the line this rule forbids, and it was outside the scan.
 *
 * All eight were measured against `STRENGTH_MUTATION` on comment-stripped
 * source before being added: zero hits. So this widens coverage rather than
 * walling code that was already violating it.
 *
 * Rules 2 and 3 are deliberately NARROW and do not move: they are assertions
 * about `constraint-evaluation.ts`, `offer-facts.port.ts` and
 * `definition-registry.service.ts` by name, not a population.
 */

import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RESERVED_OFFER_FACT_KEYS } from '@mercaria/shared-types';
import {
  type DirectoryReader,
  assertNothingOutsideDomainPopulation,
  namedInSharedDirectories,
  readSrcDirectory,
  walkOwnedDirectory,
} from '../../../__tests__/domain-population.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DOMAIN_DIR = fileURLToPath(new URL('..', import.meta.url));

/**
 * What a module of this domain is called, wherever it lives.
 *
 * Bare `attribute`, matched against the PATH, and it is NOT free the way a
 * hyphenated domain token is: it reaches three modules in other domains, each
 * excused by name below. One word is the whole of it because the domain's own
 * spellings are `services/attributes/`, `db/attributes/`,
 * `db/schema/attributeRegistry.ts` and `middleware/attribute-schemas.ts` — a
 * singular, a plural, a camelCase compound and a hyphenated one.
 */
const ATTRIBUTE_NAME_PATTERN = /attribute/i;

/** The two directories this domain owns outright. */
const OWNED_DIRECTORIES = ['services/attributes', 'db/attributes'] as const;

/** The flat directories a module of this domain lives in under a domain NAME. */
const SHARED_DIRECTORIES = ['routes', 'controllers', 'middleware', 'db/schema'] as const;

/** Every module of the attribute domain, enumerated from disk. */
function domainRelativePaths(readDir: DirectoryReader = readSrcDirectory): string[] {
  return [
    // RECURSIVE, where this read one directory level.
    ...OWNED_DIRECTORIES.flatMap((relative) => walkOwnedDirectory(relative, readDir)),
    ...namedInSharedDirectories(SHARED_DIRECTORIES, ATTRIBUTE_NAME_PATTERN, readDir),
  ];
}

/** Every module in the attribute domain, tests excluded. */
function domainModules(): { path: string; source: string }[] {
  return domainRelativePaths().map((relative) => ({
    path: relative,
    source: readFileSync(join(SRC_ROOT, relative), 'utf8'),
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
    expect(modules.length).toBeGreaterThanOrEqual(16);
    const paths = modules.map((module) => module.path);
    expect(paths).toContain('services/attributes/constraint-evaluation.ts');
    expect(paths).toContain('services/attributes/constraint-validation.ts');
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
    const evaluator = modules.find(
      (module) => module.path === 'services/attributes/constraint-evaluation.ts',
    );
    if (!evaluator) throw new Error('constraint-evaluation.ts is missing');
    // The exported entry point takes a validated set, a candidate's facts and an
    // options object whose only member is a variant id. A `strength` or a
    // `relax`/`downgrade` option would be the parameter this rule forbids.
    expect(/export interface EvaluateOptions \{[^}]*\}/su.exec(evaluator.source)?.[0]).not.toMatch(
      /strength|relax|downgrade|soften/u,
    );
  });

  it('derives the verdict from the hard outcomes only', () => {
    const evaluator = modules.find(
      (module) => module.path === 'services/attributes/constraint-evaluation.ts',
    );
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
    const evaluator = modules.find(
      (module) => module.path === 'services/attributes/constraint-evaluation.ts',
    );
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
    const evaluator = modules.find(
      (module) => module.path === 'services/attributes/constraint-evaluation.ts',
    );
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
    const port = modules.find(
      (module) => module.path === 'services/attributes/offer-facts.port.ts',
    );
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

describe('the population rule 1 is applied to (#460)', () => {
  it('nothing naming an attribute sits outside it', () => {
    assertNothingOutsideDomainPopulation({
      population: domainRelativePaths,
      pattern: ATTRIBUTE_NAME_PATTERN,
      notThisDomain: [
        {
          path: 'db/canonical/attributeRepository.ts',
          why:
            "#56's canonical annotation store — the normalized attribute VALUES, images and " +
            'per-field provenance. It cites a definition version and, as its own docblock says, ' +
            'never writes one: the REGISTRY moved to db/attributes/definitionRepository.ts with ' +
            '#94. Walked by the canonical-catalog gates, not by this one.',
        },
        {
          path: 'db/variantAxes/attributeClaimRepository.ts',
          why:
            "#367's native listing and variant attribute CLAIMS — what a party said, frozen by " +
            'trigger. A claim is an assertion awaiting settlement, not a registry definition, ' +
            'and variant-axis-isolation.test.ts walks db/variantAxes/ whole.',
        },
        {
          path: 'services/comparison/attribute-facts.ts',
          why:
            "#96's translation of a stored value into a comparison cell. It is a READER of this " +
            "domain's output and a module of the comparison domain, which " +
            'comparison-isolation.test.ts walks whole.',
        },
      ],
      // Below today's 23 so a routine deletion does not fail the build, and far
      // enough above zero that a traversal which reached nothing does.
      sweepFloor: 17,
      plantIn: 'lib',
      plantName: 'attribute-cache.ts',
    });
  });

  it('the eight modules the one-level population could not reach are in it', () => {
    // An identity assertion, not a floor. These are exactly what
    // `readdirSync(services/attributes)` missed, and a floor set below 20 is met
    // without any of them.
    const population = domainRelativePaths();
    for (const named of [
      'controllers/catalog-attributes.controller.ts',
      'controllers/internal-catalog-attributes.controller.ts',
      'db/attributes/attributeOpsRepository.ts',
      'db/attributes/definitionRepository.ts',
      'db/schema/attributeRegistry.ts',
      'middleware/attribute-schemas.ts',
      'routes/catalog-attributes.ts',
      'routes/internal-catalog-attributes.ts',
    ]) {
      expect(population, `${named} is outside rule 1 again`).toContain(named);
      expect(
        statSync(join(SRC_ROOT, named)).isFile(),
        `${named} no longer exists, so naming it proves nothing`,
      ).toBe(true);
    }
  });

  it('floors PER SHAPE, because the two sources break independently', () => {
    // One total lets the walk collapse to zero while the sweep carries it.
    const owned = OWNED_DIRECTORIES.flatMap((relative) => walkOwnedDirectory(relative));
    const shared = namedInSharedDirectories(SHARED_DIRECTORIES, ATTRIBUTE_NAME_PATTERN);
    expect(owned.length, 'the owned-directory walk reached nothing').toBeGreaterThanOrEqual(11);
    expect(shared.length, 'the shared-directory name sweep reached nothing').toBeGreaterThanOrEqual(
      5,
    );
  });

  it('all three excluded modules are CLEAN against rule 1, so each exclusion is about ownership', () => {
    // An exclusion for a module that would TRIP the wall is a hole; one for a
    // module that would pass is a statement about who owns it. Measured, because
    // the second is what the reasons above claim.
    for (const foreign of [
      'db/canonical/attributeRepository.ts',
      'db/variantAxes/attributeClaimRepository.ts',
      'services/comparison/attribute-facts.ts',
    ]) {
      const source = readFileSync(join(SRC_ROOT, foreign), 'utf8');
      expect(STRENGTH_MUTATION.test(source), `${foreign} would trip rule 1`).toBe(false);
    }
  });
});
