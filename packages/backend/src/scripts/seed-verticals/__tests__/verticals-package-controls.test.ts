/**
 * The controls behind every vertical-package claim (#367 Workstream 14).
 *
 * ## Why this file exists, and what it is NOT
 *
 * The three realdb files assert what a seeded catalogue DOES. This one asserts
 * that those assertions could fail — because a seeded vertical is the easiest
 * place in this epic to produce something that looks like proof and is not. A
 * census that compares fourteen zeros against fourteen zeros passes; a
 * "one SKU fits many vehicles" case passes trivially against a fixture holding
 * one vehicle; and a `deriveExpectation` that recomputed the same wrong number
 * the fixture already carries would agree with itself forever.
 *
 * So every check here comes in a PAIR: the assertion, and a mutation of a
 * CLONED package that must make it fail. Where a mutation is involved the
 * clone is diffed against the original FIRST — a mutation that never applied is
 * indistinguishable from one that survived, and both leave the test green.
 *
 * It reads no database on purpose. `judgeCensus`'s vacuity floor cannot be
 * driven from a real namespace at all: proving that all-zero counts answer
 * `vacuous` means supplying all-zero counts, which a seeded namespace by
 * definition never has.
 */

import { describe, expect, it } from 'vitest';

import { deriveExpectation, judgeCensus, CENSUS_POSITIVE_CONTROL_ENTITIES } from '../census.js';
import { namespaceFor, nsCategoryKey, nsKey, nsSlug } from '../apply.js';
import { PRODUCT_TYPE_KEY_PATTERN } from '@mercaria/shared-types';
import { VERTICAL_PACKAGES, verticalPackageByName } from '../index.js';
import { TRAILWIND_ABSENT_COMBINATIONS, TRAILWIND_AXES } from '../footwear.js';
import type { VerticalExpectation, VerticalPackage } from '../types.js';

/**
 * A deep, mutable copy.
 *
 * `structuredClone` and not a spread: every mutation below reaches into a
 * nested array, and a shallow copy would mutate the REAL package — which would
 * pass the mutation test and then corrupt every case that ran after it in the
 * same process.
 */
function clone(pkg: VerticalPackage): VerticalPackage {
  return structuredClone(pkg) as VerticalPackage;
}

/** Assert a mutation LANDED before asserting anything about what it caused. */
function assertMutated(before: unknown, after: unknown, what: string): void {
  expect(JSON.stringify(after), `the mutation '${what}' never applied`).not.toBe(
    JSON.stringify(before),
  );
}

/** A count map that agrees with a package exactly. */
function exactCounts(pkg: VerticalPackage): Record<keyof VerticalExpectation, number> {
  return { ...pkg.expect };
}

const ZERO_COUNTS: Record<keyof VerticalExpectation, number> = {
  categories: 0,
  attributes: 0,
  enumValues: 0,
  productTypes: 0,
  productTypeFields: 0,
  brands: 0,
  families: 0,
  products: 0,
  variants: 0,
  identifiers: 0,
  facts: 0,
  vehicleConfigurations: 0,
  fitments: 0,
  compatibilityClaims: 0,
};

describe('the package registry', () => {
  it('holds exactly the three reference verticals the workstream names', () => {
    // An exact set, never `toContain`: a fourth package added without a realdb
    // file and a doc is a vertical nobody proved anything about, and this is
    // where that is noticed.
    expect(VERTICAL_PACKAGES.map((pkg) => pkg.name).sort()).toEqual([
      'brake_pad',
      'footwear',
      'smartphone',
    ]);
  });

  it('resolves each package by name and refuses an unknown one', () => {
    for (const pkg of VERTICAL_PACKAGES) {
      expect(verticalPackageByName(pkg.name)).toBe(pkg);
    }
    expect(verticalPackageByName('bicycle')).toBeUndefined();
  });
});

describe.each(VERTICAL_PACKAGES.map((pkg) => [pkg.name, pkg] as const))(
  '%s: the declared expectation is the data',
  (_name, pkg) => {
    it('agrees with the counts the package data implies', () => {
      // Two statements of one fact. The census rests on them not drifting: a
      // package whose `expect` was hand-edited to match a bad run would
      // otherwise validate that run forever.
      expect(deriveExpectation(pkg)).toEqual(pkg.expect);
    });

    it('notices a variant added without updating the expectation', () => {
      const mutated = clone(pkg);
      const product = mutated.products[0];
      expect(product, 'the package declares no product to mutate').toBeDefined();
      if (!product) return;
      const before = product.variants.length;
      (product.variants as unknown[]).push({
        key: `${product.key}-control`,
        options: product.variantAxisKeys.map((key) => ({ key, value: 'control' })),
      });
      assertMutated(before, product.variants.length, 'append a variant');

      expect(deriveExpectation(mutated)).not.toEqual(mutated.expect);
      expect(deriveExpectation(mutated).variants).toBe(pkg.expect.variants + 1);
    });

    it('counts a STRUCTURED fact as one row per component axis, not as one', () => {
      // The one place a naive derivation is wrong in the direction that reports
      // a MISMATCH on a package that seeded perfectly.
      const structured = pkg.attributes.filter((attribute) => attribute.valueType === 'structured');
      const declared = pkg.products.flatMap((product) => [
        ...(product.facts ?? []),
        ...product.variants.flatMap((variant) => variant.facts ?? []),
      ]);
      const structuredFacts = declared.filter((fact) =>
        structured.some((attribute) => attribute.key === fact.attributeKey),
      );
      const extraRows = structuredFacts.reduce((sum, fact) => {
        const attribute = structured.find((candidate) => candidate.key === fact.attributeKey);
        return sum + ((attribute?.componentAxes?.length ?? 1) - 1);
      }, 0);
      expect(deriveExpectation(pkg).facts).toBe(declared.length + extraRows);
      if (structured.length > 0) {
        // Positive control: the package HAS a structured attribute, so
        // `extraRows` is not zero and the branch above was actually taken.
        expect(extraRows).toBeGreaterThan(0);
      }
    });
  },
);

describe.each(VERTICAL_PACKAGES.map((pkg) => [pkg.name, pkg] as const))(
  '%s: the package is internally resolvable',
  (_name, pkg) => {
    it('declares every category parent before the child that names it', () => {
      const seen = new Set<string>();
      for (const category of pkg.categories) {
        if (category.parentKey !== null) {
          expect(seen, `'${category.key}' names an undeclared or later parent`).toContain(
            category.parentKey,
          );
        }
        seen.add(category.key);
      }
    });

    it('declares every attribute a product-type field cites', () => {
      const attributeKeys = new Set(pkg.attributes.map((attribute) => attribute.key));
      for (const productType of pkg.productTypes) {
        for (const field of productType.fields) {
          expect(attributeKeys).toContain(field.attributeKey);
        }
      }
    });

    it('declares every category a scope names', () => {
      const categoryKeys = new Set(pkg.categories.map((category) => category.key));
      for (const attribute of pkg.attributes) {
        for (const key of attribute.categoryScopeKeys ?? []) expect(categoryKeys).toContain(key);
      }
      for (const productType of pkg.productTypes) {
        for (const key of productType.categoryScopeKeys) expect(categoryKeys).toContain(key);
      }
      for (const family of pkg.families) expect(categoryKeys).toContain(family.categoryKey);
      for (const product of pkg.products) expect(categoryKeys).toContain(product.categoryKey);
    });

    it('gives every variant exactly the options its product declares as axes', () => {
      // `createVariant` throws on a mismatch, so this is a build-time copy of a
      // runtime refusal — worth having, because the runtime one only fires for
      // the products a test happens to seed.
      for (const product of pkg.products) {
        const axes = [...product.variantAxisKeys].sort();
        for (const variant of product.variants) {
          expect(
            variant.options.map((option) => option.key).sort(),
            `${product.key}/${variant.key} does not match its product's axes`,
          ).toEqual(axes);
        }
      }
    });

    it('gives every fact an attribute the package declares', () => {
      const attributeKeys = new Set(pkg.attributes.map((attribute) => attribute.key));
      for (const product of pkg.products) {
        for (const fact of product.facts ?? []) expect(attributeKeys).toContain(fact.attributeKey);
        for (const variant of product.variants) {
          for (const fact of variant.facts ?? []) expect(attributeKeys).toContain(fact.attributeKey);
        }
      }
    });

    it('declares every vehicle a fitment or a claim names', () => {
      const makes = new Set(pkg.vehicleMakes.map((make) => make.key));
      const models = new Set(pkg.vehicleMakes.flatMap((make) => make.models.map((m) => m.key)));
      const generations = new Set(
        pkg.vehicleMakes.flatMap((make) =>
          make.models.flatMap((model) => model.generations.map((g) => g.key)),
        ),
      );
      const configurations = new Set(
        pkg.vehicleMakes.flatMap((make) =>
          make.models.flatMap((model) =>
            model.generations.flatMap((generation) =>
              generation.configurations.map((c) => c.key),
            ),
          ),
        ),
      );
      const variantKeys = new Set(
        pkg.products.flatMap((product) => product.variants.map((variant) => variant.key)),
      );

      for (const fitment of pkg.fitments) {
        expect(variantKeys).toContain(fitment.variantKey);
        expect(makes).toContain(fitment.makeKey);
        if (fitment.modelKey !== undefined) expect(models).toContain(fitment.modelKey);
        if (fitment.generationKey !== undefined) {
          expect(generations).toContain(fitment.generationKey);
        }
        if (fitment.configurationKey !== undefined) {
          expect(configurations).toContain(fitment.configurationKey);
        }
      }
      for (const claim of pkg.compatibilityClaims) {
        expect(variantKeys).toContain(claim.variantKey);
      }
    });

    it('names every ancestor a fitment scope requires', () => {
      // `automotive_fitments_scope_shape_check` is a ladder: at
      // `vehicle_generation` the make, model and generation must all be set and
      // the configuration must be NULL. A fixture that named only the
      // generation would be refused by Postgres at apply time; this says so
      // before the database is involved.
      for (const fitment of pkg.fitments) {
        const present = {
          model: fitment.modelKey !== undefined,
          generation: fitment.generationKey !== undefined,
          configuration: fitment.configurationKey !== undefined,
        };
        if (fitment.scope === 'vehicle_make') {
          expect(present).toEqual({ model: false, generation: false, configuration: false });
        }
        if (fitment.scope === 'vehicle_model') {
          expect(present).toEqual({ model: true, generation: false, configuration: false });
        }
        if (fitment.scope === 'vehicle_generation') {
          expect(present).toEqual({ model: true, generation: true, configuration: false });
        }
        if (fitment.scope === 'vehicle_configuration') {
          expect(present).toEqual({ model: true, generation: true, configuration: true });
        }
      }
    });
  },
);

describe('the census vacuity floor', () => {
  const pkg = VERTICAL_PACKAGES[0];
  if (!pkg) throw new Error('no vertical package to judge');

  it('MATCHES a namespace whose counts equal the package', () => {
    const verdict = judgeCensus(pkg, exactCounts(pkg));
    expect(verdict.outcome).toBe('matched');
  });

  it('reports VACUOUS rather than matched when the namespace holds nothing', () => {
    // The failure this whole file exists for: fourteen zeros compared against
    // fourteen zeros is `0 === 0` fourteen times, which every per-entity
    // equality accepts. Only a floor over the TOTAL sees it.
    const emptyPackage: VerticalPackage = { ...pkg, expect: { ...ZERO_COUNTS } };
    // Guard the guard: `judgeCensus` refuses a package declaring zero of a
    // control entity BEFORE it gets to the floor, so this case must be built
    // from a package that does declare them.
    expect(judgeCensus(emptyPackage, ZERO_COUNTS).outcome).toBe('unmeasurable');
    expect(judgeCensus(pkg, ZERO_COUNTS).outcome).toBe('vacuous');
  });

  it('reports MISMATCHED, naming the entity, when one count is short by one', () => {
    const short = { ...exactCounts(pkg), variants: pkg.expect.variants - 1 };
    assertMutated(pkg.expect.variants, short.variants, 'decrement the variant count');
    const verdict = judgeCensus(pkg, short);
    expect(verdict.outcome).toBe('mismatched');
    if (verdict.outcome !== 'mismatched') return;
    expect(verdict.failures.map((line) => line.entity)).toEqual(['variants']);
  });

  it('reports MISMATCHED when a count is HIGH, not only when it is low', () => {
    // Equality, never `>=`. A floor a later edit can satisfy by adding rows
    // anywhere is a floor that ends at `>= 0`.
    const over = { ...exactCounts(pkg), facts: pkg.expect.facts + 1 };
    expect(judgeCensus(pkg, over).outcome).toBe('mismatched');
  });

  it('refuses to measure a package declaring zero of a control entity', () => {
    for (const entity of CENSUS_POSITIVE_CONTROL_ENTITIES) {
      const weakened: VerticalPackage = { ...pkg, expect: { ...pkg.expect, [entity]: 0 } };
      assertMutated(pkg.expect[entity], weakened.expect[entity], `zero out ${entity}`);
      const verdict = judgeCensus(weakened, { ...exactCounts(pkg), [entity]: 0 });
      expect(verdict.outcome, `zeroing ${entity} was accepted as measurable`).toBe('unmeasurable');
    }
  });

  it('does NOT demand a positive count for the vehicle entities', () => {
    // Footwear and smartphones legitimately hold no vehicle, and a control list
    // that demanded one would force a fixture to invent a car to satisfy a gate.
    expect(CENSUS_POSITIVE_CONTROL_ENTITIES).not.toContain('vehicleConfigurations');
    expect(CENSUS_POSITIVE_CONTROL_ENTITIES).not.toContain('fitments');
    expect(CENSUS_POSITIVE_CONTROL_ENTITIES).not.toContain('compatibilityClaims');
  });
});

describe('namespacing', () => {
  it('produces the three different spellings the three CHECKs demand', () => {
    const ns = namespaceFor('v367_footwear');
    expect(nsKey(ns, 'shoe_size_eu')).toBe('v367_footwear_shoe_size_eu');
    expect(nsCategoryKey(ns, 'athletic.mens')).toBe('v367-footwear.athletic.mens');
    expect(nsSlug(ns, 'mens-running-shoes')).toBe('v367-footwear-mens-running-shoes');
  });

  it('refuses a namespace that would produce an invalid attribute key', () => {
    // `attribute_definitions_key_shape_check` is `^[a-z][a-z0-9_]*$`, so a
    // leading digit is refused by Postgres. Refusing it here names the reason.
    expect(() => namespaceFor('9lives')).toThrow(/must start with a letter/u);
    expect(() => namespaceFor('   ')).toThrow(/must start with a letter/u);
  });

  it('produces keys and slugs that satisfy the real shape patterns', () => {
    const ns = namespaceFor('run-4a2b');
    expect(nsKey(ns, 'shoe_size_eu')).toMatch(/^[a-z][a-z0-9_]*$/u);
    expect(nsCategoryKey(ns, 'athletic.mens_running_shoes')).toMatch(
      /^[a-z0-9][a-z0-9_-]*([.][a-z0-9][a-z0-9_-]*)*$/u,
    );
    expect(nsSlug(ns, 'mens-running-shoes')).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/u);
  });
});

describe('the footwear sparse matrix is genuinely sparse', () => {
  const footwear = verticalPackageByName('footwear');
  if (!footwear) throw new Error('the footwear package is missing');
  const trailwind = footwear.products.find((product) => product.key === 'trailwind_3');
  if (!trailwind) throw new Error('the Trailwind product is missing');

  const valuesPerAxis = TRAILWIND_AXES.map((axis) =>
    Array.from(
      new Set(
        trailwind.variants.map(
          (variant) => variant.options.find((option) => option.key === axis)?.value ?? '',
        ),
      ),
    ),
  );
  const fullMatrix = valuesPerAxis.reduce((product, values) => product * values.length, 1);

  it('seeds FEWER variants than its axes describe', () => {
    expect(trailwind.variants.length).toBeLessThan(fullMatrix);
    expect(trailwind.variants.length + TRAILWIND_ABSENT_COMBINATIONS.length).toBe(fullMatrix);
  });

  it('names every absent combination, and none of them is present', () => {
    const present = new Set(
      trailwind.variants.map((variant) =>
        TRAILWIND_AXES.map(
          (axis) => variant.options.find((option) => option.key === axis)?.value ?? '',
        ).join('/'),
      ),
    );
    for (const absent of TRAILWIND_ABSENT_COMBINATIONS) {
      expect(present).not.toContain(`${absent.size}/${absent.color}/${absent.width}`);
    }
    // The control that makes the assertion above mean something: an absent
    // combination whose VALUES each appear elsewhere is absent as a
    // COMBINATION. Without this, a fixture that simply never mentions `wide`
    // would satisfy every line above and prove nothing about sparseness.
    for (const absent of TRAILWIND_ABSENT_COMBINATIONS) {
      expect(valuesPerAxis[0]).toContain(absent.size);
      expect(valuesPerAxis[1]).toContain(absent.color);
      expect(valuesPerAxis[2]).toContain(absent.width);
    }
  });

  it('notices when an absent combination is seeded after all', () => {
    const mutated = clone(footwear);
    const product = mutated.products.find((candidate) => candidate.key === 'trailwind_3');
    expect(product).toBeDefined();
    if (!product) return;
    const absent = TRAILWIND_ABSENT_COMBINATIONS[0];
    expect(absent).toBeDefined();
    if (!absent) return;
    const before = product.variants.length;
    (product.variants as unknown[]).push({
      key: 'trailwind-control',
      options: [
        { key: 'shoe_size_eu', value: absent.size },
        { key: 'footwear_color', value: absent.color },
        { key: 'shoe_width', value: absent.width },
      ],
    });
    assertMutated(before, product.variants.length, 'seed a combination declared absent');

    const present = new Set(
      product.variants.map((variant) =>
        TRAILWIND_AXES.map(
          (axis) => variant.options.find((option) => option.key === axis)?.value ?? '',
        ).join('/'),
      ),
    );
    expect(present).toContain(`${absent.size}/${absent.color}/${absent.width}`);
  });
});

describe('the size systems cannot be collapsed by anything in the package', () => {
  const footwear = verticalPackageByName('footwear');
  if (!footwear) throw new Error('the footwear package is missing');

  const sizeAttributes = footwear.attributes.filter((attribute) =>
    attribute.key.startsWith('shoe_size_'),
  );

  it('declares four size systems as four separate definitions', () => {
    expect(sizeAttributes.map((attribute) => attribute.key).sort()).toEqual([
      'shoe_size_cm',
      'shoe_size_eu',
      'shoe_size_uk',
      'shoe_size_us_mens',
      'shoe_size_us_womens',
    ]);
  });

  it("scopes each US system to ONE audience's category and nothing else", () => {
    const mens = footwear.attributes.find((a) => a.key === 'shoe_size_us_mens');
    const womens = footwear.attributes.find((a) => a.key === 'shoe_size_us_womens');
    expect(mens?.categoryScopeKeys).toEqual(['athletic.mens_running_shoes']);
    expect(womens?.categoryScopeKeys).toEqual(['athletic.womens_running_shoes']);
    // The control: the two scopes are DISJOINT, so neither definition can reach
    // the other's department. Two definitions scoped to the same node would
    // satisfy the lines above and prove nothing.
    const overlap = (mens?.categoryScopeKeys ?? []).filter((key) =>
      (womens?.categoryScopeKeys ?? []).includes(key),
    );
    expect(overlap).toEqual([]);
  });

  it('makes the two brands DISAGREE at EU 42, which no universal table could', () => {
    // The positive form of "EU 42, US Men's 9 and UK 8 are not collapsed".
    const chartAt = (productKey: string, euSize: string): Record<string, string> => {
      const product = footwear.products.find((candidate) => candidate.key === productKey);
      const variant = product?.variants.find((candidate) =>
        candidate.options.some((option) => option.key === 'shoe_size_eu' && option.value === euSize),
      );
      const facts: Record<string, string> = {};
      for (const fact of variant?.facts ?? []) facts[fact.attributeKey] = fact.displayValue;
      return facts;
    };
    const kestrel = chartAt('trailwind_3', '42');
    const nordvik = chartAt('fjord_runner', '42');

    // Vacuity floor: both charts must actually carry a US size, or "they
    // disagree" is two undefineds not being equal.
    expect(kestrel.shoe_size_us_mens).toBeDefined();
    expect(nordvik.shoe_size_us_mens).toBeDefined();
    expect(kestrel.shoe_size_us_mens).not.toBe(nordvik.shoe_size_us_mens);
    expect(kestrel.shoe_size_uk).not.toBe(nordvik.shoe_size_uk);
  });
});

describe('nothing about a vehicle is a variant axis', () => {
  const brakePad = verticalPackageByName('brake_pad');
  if (!brakePad) throw new Error('the brake-pad package is missing');

  it('gives every brake-pad product ZERO variant axes', () => {
    for (const product of brakePad.products) {
      expect(product.variantAxisKeys).toEqual([]);
      expect(product.variants).toHaveLength(1);
    }
  });

  it('marks no attribute in the package variant-defining', () => {
    for (const attribute of brakePad.attributes) {
      expect(attribute.variantDefining ?? false, `${attribute.key} is variant-defining`).toBe(false);
    }
  });

  it('declares no product-type field as variant-capable', () => {
    for (const productType of brakePad.productTypes) {
      for (const field of productType.fields) {
        expect(field.variantCapable ?? false, `${field.attributeKey} is variant-capable`).toBe(
          false,
        );
      }
    }
  });

  it('reaches MORE vehicle configurations than it has variants, by a wide margin', () => {
    // The headline, as arithmetic over the package: one variant per product,
    // thirteen configurations. Both numbers are asserted, because a ratio
    // computed from one of them says nothing.
    const configurations = brakePad.vehicleMakes.reduce(
      (sum, make) =>
        sum +
        make.models.reduce(
          (modelSum, model) =>
            modelSum +
            model.generations.reduce(
              (generationSum, generation) =>
                generationSum + generation.configurations.length,
              0,
            ),
          0,
        ),
      0,
    );
    const variants = brakePad.products.reduce(
      (sum, product) => sum + product.variants.length,
      0,
    );
    expect(variants).toBe(2);
    expect(configurations).toBe(13);
    expect(configurations).toBeGreaterThan(variants * 5);
  });

  it('notices a fixture reduced to one vehicle', () => {
    // The control the lead asked for by name: "one SKU fits many vehicles"
    // passes trivially if the fixture has one vehicle, so the assertion asserts
    // the vehicle COUNT and this proves the count notices.
    // Built as a NEW package rather than by mutating the real one's readonly
    // arrays: the point is a fixture holding exactly one vehicle, and a cast
    // that let a `readonly` array be pushed into would be the kind of thing
    // this file exists to refuse.
    const make = brakePad.vehicleMakes[0];
    const model = make?.models[0];
    const generation = model?.generations[0];
    const configuration = generation?.configurations[0];
    expect(configuration).toBeDefined();
    if (!make || !model || !generation || !configuration) return;
    const mutated: VerticalPackage = {
      ...brakePad,
      vehicleMakes: [
        {
          ...make,
          models: [
            { ...model, generations: [{ ...generation, configurations: [configuration] }] },
          ],
        },
      ],
    };
    assertMutated(
      brakePad.vehicleMakes.length,
      mutated.vehicleMakes.length,
      'reduce the fixture to one vehicle',
    );

    const configurations = mutated.vehicleMakes.reduce(
      (sum, m) =>
        sum +
        m.models.reduce(
          (modelSum, candidate) =>
            modelSum +
            candidate.generations.reduce((gSum, g) => gSum + g.configurations.length, 0),
          0,
        ),
      0,
    );
    expect(configurations).toBe(1);
    // The very assertion the real case makes, now failing.
    expect(configurations).not.toBeGreaterThan(2 * 5);
  });

  it('holds two GENERATIONS whose production years overlap', () => {
    const overlaps: string[] = [];
    for (const make of brakePad.vehicleMakes) {
      for (const model of make.models) {
        for (const a of model.generations) {
          for (const b of model.generations) {
            if (a.key >= b.key) continue;
            const aFrom = a.producedFromYear ?? 0;
            const aTo = a.producedToYear ?? 9999;
            const bFrom = b.producedFromYear ?? 0;
            const bTo = b.producedToYear ?? 9999;
            if (aFrom <= bTo && bFrom <= aTo) overlaps.push(`${model.key}:${a.key}/${b.key}`);
          }
        }
      }
    }
    // Two, on two different makes — so the case is not one fixture's accident.
    expect(overlaps.length).toBeGreaterThanOrEqual(2);
    expect(new Set(overlaps.map((entry) => entry.split(':')[0])).size).toBeGreaterThanOrEqual(2);
  });

  it('holds one generation with configurations in two different markets', () => {
    const markets = new Map<string, Set<string>>();
    for (const make of brakePad.vehicleMakes) {
      for (const model of make.models) {
        for (const generation of model.generations) {
          const set = new Set<string>();
          for (const configuration of generation.configurations) {
            if (configuration.market !== undefined) set.add(configuration.market);
          }
          markets.set(generation.key, set);
        }
      }
    }
    const multiMarket = [...markets.entries()].filter(([, set]) => set.size > 1);
    expect(multiMarket.length).toBeGreaterThanOrEqual(1);
  });

  it('excludes exactly one configuration, at a narrower scope than the fit it overrides', () => {
    const exclusions = brakePad.fitments.filter(
      (fitment) => fitment.applicability === 'does_not_apply',
    );
    expect(exclusions).toHaveLength(1);
    const exclusion = exclusions[0];
    if (!exclusion) return;
    expect(exclusion.scope).toBe('vehicle_configuration');
    // The control: the exclusion only means anything if a BROADER positive fit
    // covers the same vehicle. Without one it is a statement about a car nobody
    // claimed the pad fits.
    const broader = brakePad.fitments.filter(
      (fitment) =>
        fitment.applicability === 'applies' &&
        fitment.scope === 'vehicle_generation' &&
        fitment.generationKey === exclusion.generationKey &&
        fitment.position === exclusion.position,
    );
    expect(broader.length).toBeGreaterThanOrEqual(1);
  });

  it('keeps every unresolved claim unresolved, with a reason', () => {
    expect(brakePad.compatibilityClaims.length).toBeGreaterThanOrEqual(2);
    for (const claim of brakePad.compatibilityClaims) {
      expect(claim.unresolvedReason).toBe('ambiguous_target');
      expect(claim.rawTargetText.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('the smartphone axes and facts are on opposite sides of one line', () => {
  const smartphone = verticalPackageByName('smartphone');
  if (!smartphone) throw new Error('the smartphone package is missing');

  const AXES = ['storage_capacity', 'phone_color', 'device_region'];
  const FACTS = [
    'screen_size',
    'screen_refresh_rate',
    'chipset',
    'ram_capacity',
    'battery_capacity',
    'charging_port',
    'device_dimensions',
    'cellular_generation',
    'wifi_standard',
    'nfc',
  ];

  it('marks exactly the three axes variant-defining', () => {
    const defining = smartphone.attributes
      .filter((attribute) => attribute.variantDefining === true)
      .map((attribute) => attribute.key)
      .sort();
    expect(defining).toEqual([...AXES].sort());
  });

  it('marks every typed fact NOT variant-defining, and names all ten', () => {
    const notDefining = smartphone.attributes
      .filter((attribute) => attribute.variantDefining !== true)
      .map((attribute) => attribute.key)
      .sort();
    expect(notDefining).toEqual([...FACTS].sort());
    // Disjointness, stated: the two lists cover the package and share nothing.
    expect(AXES.filter((key) => FACTS.includes(key))).toEqual([]);
    expect(smartphone.attributes).toHaveLength(AXES.length + FACTS.length);
  });

  it('declares every field citing a fact at a NON-variant scope', () => {
    for (const productType of smartphone.productTypes) {
      for (const field of productType.fields) {
        if (!FACTS.includes(field.attributeKey)) continue;
        expect(field.variantCapable ?? false, `${field.attributeKey} is variant-capable`).toBe(
          false,
        );
      }
    }
  });

  it('spells the accented alias WITH its accent and the search token WITHOUT', () => {
    // The two mechanisms are read by different stages against differently
    // folded queries. Getting either backwards makes a Spanish query silently
    // miss — the exact failure the realdb case's alias-removal control catches.
    const axon = smartphone.products.find((product) => product.key === 'axon_9_pro');
    expect(axon).toBeDefined();
    if (!axon) return;
    expect(axon.aliases?.some((alias) => alias.alias.includes('móvil'))).toBe(true);
    expect(axon.searchTokens).toContain('movil');
    expect(axon.searchTokens?.some((token) => token.includes('ó'))).toBe(false);
    // Every search token must be discriminating: five characters, or carrying a
    // digit. A shorter one is dropped by the retrieval stage and is a token
    // nobody will ever match.
    for (const token of axon.searchTokens ?? []) {
      expect(token.length >= 5 || /[0-9]/u.test(token), `'${token}' is not discriminating`).toBe(
        true,
      );
    }
  });
});

/**
 * Every product-type key a seeded package can produce satisfies the CHECK
 * `product_type_definitions_key_shape_check` enforces (#477).
 *
 * This is here because #477 NARROWED that constraint on a live table, and the
 * question a narrowing has to answer is "can any stored row violate the new
 * shape". There is no production database on a developer's machine to count,
 * and a count taken once would not stay true. What makes the answer durable is
 * that the population is bounded and checked in: `insertProductTypeDefinition`
 * is the table's only production writer, `apply.ts` is its only production
 * caller, and the key it writes is `nsKey(namespaceFor(token), pkg.key)`.
 *
 * So the safety argument reduces to two facts, and both are asserted below
 * rather than reasoned about: every shipped package key is legal, and
 * namespacing keeps it legal. A fourth package with a dotted or hyphenated key
 * fails HERE, before it can become an immutable row the constraint refuses.
 */
describe('a seeded product-type key can never violate the shape CHECK', () => {
  it('has packages to measure', () => {
    // The vacuity floor: every `it.each` below is vacuously green over an empty
    // package list, which is exactly what a broken import would produce.
    expect(VERTICAL_PACKAGES.length).toBeGreaterThanOrEqual(3);
    expect(VERTICAL_PACKAGES.flatMap((pkg) => pkg.productTypes).length).toBeGreaterThanOrEqual(3);
  });

  it('ships only keys the constraint accepts', () => {
    const keys = VERTICAL_PACKAGES.flatMap((pkg) =>
      pkg.productTypes.map((productType) => productType.key),
    );
    expect(keys.filter((key) => !PRODUCT_TYPE_KEY_PATTERN.test(key))).toEqual([]);
  });

  it('keeps them legal once namespaced, for any namespace `namespaceFor` will mint', () => {
    // `namespaceFor` folds everything outside `[a-z0-9]` to `_` and refuses a
    // leading digit, so its output is always `[a-z][a-z0-9_]*` — which is what
    // makes the prefixed key legal rather than it happening to be so for the
    // three tokens in use. Tokens chosen to exercise the folding, not to pass.
    for (const token of ['v367_footwear', 'run-4a2b', 'A Weird  Token!!', 'x']) {
      const ns = namespaceFor(token);
      for (const pkg of VERTICAL_PACKAGES) {
        for (const productType of pkg.productTypes) {
          const key = nsKey(ns, productType.key);
          expect(PRODUCT_TYPE_KEY_PATTERN.test(key), `${token} -> ${key}`).toBe(true);
        }
      }
    }
  });

  it('is a real test — the pattern refuses the shapes the broken CHECK admitted', () => {
    // Mutation self-test. Without it this whole block passes against a pattern
    // that accepts everything, which is precisely what #477 was.
    for (const bad of ['foo bar', 'foo/bar', 'fooXbar', 'foo.', '1foo', '']) {
      expect(PRODUCT_TYPE_KEY_PATTERN.test(bad), bad).toBe(false);
    }
    expect(PRODUCT_TYPE_KEY_PATTERN.test('electronics.phones.smartphone')).toBe(true);
  });
});
