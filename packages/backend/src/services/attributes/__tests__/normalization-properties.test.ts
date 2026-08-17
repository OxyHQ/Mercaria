/**
 * Property tests over randomized inputs for attribute NORMALIZATION and
 * CONSTRAINT RULE EVALUATION (#367 Workstream 18, "use property/fuzz tests for
 * normalization and rule evaluation").
 *
 * ## Why a hand-rolled generator
 *
 * There is no property-testing library in this repository — no `fast-check`, no
 * `jsverify`, nothing exposing `test.prop`. Three domains already needed one and
 * each wrote the same small deterministic LCG:
 * `db/payments/__tests__/ledger.realdb.test.ts`,
 * `services/ranking/__tests__/ranking-properties.test.ts` and
 * `services/retail-pricing/__tests__/retail-cost-formula.test.ts`. This follows
 * that convention rather than adding a dependency to satisfy one checkbox, and
 * the seed is printed into every failure message for the reason
 * `ranking-properties.test.ts` states: a property test that fails once on a seed
 * nobody recorded is a flake report, not a bug report.
 *
 * ## What a property test buys here that the benchmark table does not
 *
 * `normalization.test.ts` is exhaustive over ~30 hand-written observations, which
 * is the right shape for "this exact spelling normalizes to this exact value".
 * It cannot say anything about inputs nobody thought of. These are the
 * INVARIANTS — statements true of every input in a family, where a generator
 * reaches spellings a fixture author would not write down:
 *
 *  1. normalization is IDEMPOTENT — normalizing a normalized rendering again
 *     lands on the same magnitude;
 *  2. it is TOTAL — every input yields a state from the closed vocabulary and
 *     never throws, which is what makes a refusal a value rather than a crash;
 *  3. only `normalized` carries a magnitude (#94's "a refusal is a first-class
 *     outcome, and only `normalized` may carry a value");
 *  4. a magnitude is invariant under the SPELLING of its unit, across the whole
 *     alias table;
 *  5. rule evaluation is order-independent over a constraint set, and an
 *     `unknown` fact is never reported satisfied.
 *
 * ## Every property has a control that shows the generator reaches the case
 *
 * A property test whose generator only ever produced garbage would satisfy
 * "never throws" and "a refusal carries no value" while proving nothing about
 * normalization. So each block counts the outcomes it saw and FLOORS the
 * interesting one — the vacuity floor `reportPopulation` applies to a journey,
 * applied to a generated population.
 */

import { describe, expect, it } from 'vitest';

import {
  CONSTRAINT_EVALUATION_VERSION,
  UNIT_FAMILIES,
  type HardConstraint,
  type UnitFamily,
  type ValidatedConstraintSet,
} from '@mercaria/shared-types';
import { BASE_UNITS, UNIT_DEFINITIONS, normalizeQuantity, unitFamilyOf } from '../../canonical/units.js';
import {
  evaluateCandidate,
  type CandidateFacts,
  type EvaluableFact,
} from '../constraint-evaluation.js';

/** A deterministic 32-bit LCG. Reproducible, and no dependency. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

/** The seed every failure message carries, so a red run is reproducible. */
const SEED = 20_260_817;

function pick<T>(random: () => number, values: readonly T[]): T {
  const value = values[Math.floor(random() * values.length)];
  if (value === undefined) throw new Error('pick: empty population');
  return value;
}

/** Every canonical unit in the table, which is the alias-free spelling set. */
const CANONICAL_UNITS: readonly string[] = Object.keys(UNIT_DEFINITIONS);

/**
 * The separators, cases and paddings a source might use between number and unit.
 *
 * Deliberately only spellings `parseQuantity` is anchored to accept plus a few it
 * is not — the point is that the outcome is a VALUE either way, never a throw.
 */
const JOINERS: readonly string[] = ['', ' ', '  ', '\t', '  '];

describe('property: normalizing a quantity', () => {
  it('is TOTAL — every generated input yields a state and never throws', () => {
    const random = lcg(SEED);
    const seen = new Map<string, number>();
    for (let run = 0; run < 3000; run += 1) {
      const magnitude = Math.round(random() * 1_000_000) / 100;
      const unit = pick(random, CANONICAL_UNITS);
      const display = `${magnitude}${pick(random, JOINERS)}${unit}`;
      let outcome: ReturnType<typeof normalizeQuantity> | null = null;
      expect(() => {
        outcome = normalizeQuantity(display);
      }, `seed=${SEED} run=${run} display=${JSON.stringify(display)}`).not.toThrow();
      const state = outcome === null ? 'threw' : outcome.state;
      seen.set(state, (seen.get(state) ?? 0) + 1);
    }
    // The vacuity floor: a generator producing nothing parseable would satisfy
    // "never throws" while saying nothing about normalization.
    expect(seen.get('normalized') ?? 0, `seed=${SEED} states=${JSON.stringify([...seen])}`).toBeGreaterThan(2000);
    expect(seen.get('threw') ?? 0).toBe(0);
  });

  it('gives a magnitude to `normalized` and to NOTHING else', () => {
    const random = lcg(SEED + 1);
    let normalized = 0;
    let refused = 0;
    for (let run = 0; run < 3000; run += 1) {
      // Half well-formed, half deliberate junk, so both branches are populated.
      const display =
        random() < 0.5
          ? `${Math.round(random() * 10_000) / 10}${pick(random, JOINERS)}${pick(random, CANONICAL_UNITS)}`
          : `${pick(random, ['', '??', 'abc', '1e', '-', '  ', '12 parsecs', 'NaN kg', '∞ mm'])}`;
      const result = normalizeQuantity(display);
      const context = `seed=${SEED + 1} run=${run} display=${JSON.stringify(display)}`;
      if (result.state === 'normalized') {
        normalized += 1;
        expect(result.baseMagnitude, context).toBeDefined();
        expect(result.baseUnit, context).toBeDefined();
        expect(Number.isFinite(result.baseMagnitude ?? Number.NaN), context).toBe(true);
        continue;
      }
      refused += 1;
      // #94: only `normalized` may carry a value, and this contract expresses
      // "no value" as an ABSENT property rather than a null — so the assertion is
      // over presence. `Object.hasOwn` and not `=== undefined`: a property
      // present-and-undefined would satisfy the second and is still a value the
      // type says cannot be there.
      expect(Object.hasOwn(result, 'baseMagnitude'), context).toBe(false);
      expect(Object.hasOwn(result, 'baseUnit'), context).toBe(false);
    }
    // BOTH branches floored — the assertion above is about a partition, and a
    // run that produced only one side would prove half of it.
    expect(normalized, `seed=${SEED + 1}`).toBeGreaterThan(500);
    expect(refused, `seed=${SEED + 1}`).toBeGreaterThan(500);
  });

  it('is IDEMPOTENT — re-normalizing a normalized rendering does not move it', () => {
    const random = lcg(SEED + 2);
    let checked = 0;
    for (let run = 0; run < 2000; run += 1) {
      const magnitude = Math.round(random() * 100_000) / 1000;
      const unit = pick(random, CANONICAL_UNITS);
      const first = normalizeQuantity(`${magnitude} ${unit}`);
      if (first.state !== 'normalized' || first.baseUnit === undefined) continue;
      const again = normalizeQuantity(`${String(first.baseMagnitude)} ${first.baseUnit}`);
      const context = `seed=${SEED + 2} run=${run} display=${magnitude} ${unit}`;
      expect(again.state, context).toBe('normalized');
      // The base magnitude is the stored fact, so idempotence is about IT and not
      // about the rendering — re-reading a stored value must not drift.
      expect(again.baseMagnitude, context).toBe(first.baseMagnitude);
      expect(again.baseUnit, context).toBe(first.baseUnit);
      checked += 1;
    }
    expect(checked, `seed=${SEED + 2} — no input normalized, so idempotence was never tested`).toBeGreaterThan(1500);
  });

  it('gives one magnitude one value however its unit is SPELLED', () => {
    const random = lcg(SEED + 3);
    // Alias spellings are the ones a source actually sends, and they are where a
    // resolver bug hides: the canonical key is what the table is keyed on, so a
    // test using only canonical keys never exercises `resolveUnit` at all.
    const spellings: readonly (readonly [string, string])[] = [
      ['in', 'inch'],
      ['in', '"'],
      ['mm', 'millimetre'],
      ['GB', 'gigabyte'],
      ['g', 'gram'],
      ['Hz', 'hertz'],
    ];
    let checked = 0;
    for (let run = 0; run < 1200; run += 1) {
      const [canonical, alias] = pick(random, spellings);
      const magnitude = Math.round(random() * 10_000) / 100;
      const viaCanonical = normalizeQuantity(`${magnitude} ${canonical}`);
      const viaAlias = normalizeQuantity(`${magnitude} ${alias}`);
      const context = `seed=${SEED + 3} run=${run} magnitude=${magnitude} ${canonical}/${alias}`;
      expect(viaAlias.state, context).toBe('normalized');
      expect(viaAlias.baseMagnitude, context).toBe(viaCanonical.baseMagnitude);
      expect(viaAlias.baseUnit, context).toBe(viaCanonical.baseUnit);
      // The SOURCE unit resolves to the same canonical key, which is the half a
      // base-magnitude comparison alone cannot see: two units of one family
      // convert onto the same base from different source spellings too.
      expect(viaAlias.sourceUnit, context).toBe(viaCanonical.sourceUnit);
      checked += 1;
    }
    expect(checked).toBe(1200);
  });

  it('never converts across DIMENSIONS, over generated pairs', () => {
    // The #94 property, reached by a generator rather than by a chosen pair, so a
    // family added later is covered without anybody editing this file.
    const random = lcg(SEED + 4);
    let crossFamily = 0;
    for (let run = 0; run < 2000; run += 1) {
      const from = pick(random, UNIT_FAMILIES as readonly UnitFamily[]);
      const to = pick(random, UNIT_FAMILIES as readonly UnitFamily[]);
      if (from === to) continue;
      const context = `seed=${SEED + 4} run=${run} ${from}->${to}`;
      // Normalizing states the family; nothing in the pipeline may then read a
      // magnitude of one family as a magnitude of another.
      const normalizedFrom = normalizeQuantity(`1 ${BASE_UNITS[from]}`);
      expect(normalizedFrom.state, context).toBe('normalized');
      expect(unitFamilyOf(normalizedFrom.baseUnit ?? ''), context).toBe(from);
      expect(unitFamilyOf(BASE_UNITS[to]), context).toBe(to);
      expect(unitFamilyOf(normalizedFrom.baseUnit ?? ''), context).not.toBe(to);
      crossFamily += 1;
    }
    expect(crossFamily, `seed=${SEED + 4}`).toBeGreaterThan(1500);
  });
});

/**
 * One hard constraint, in the shape `evaluateCandidate` takes.
 *
 * A fixture BUILDER, not a re-implementation: it composes an input and computes
 * no verdict. The first version of the block below compared a digest this file
 * computed against itself, which measured this helper and nothing in production —
 * the defect these suites keep catching, produced here by me.
 */
function hardConstraint(
  id: string,
  attributeKey: string,
  op: 'gte' | 'lte',
  magnitude: number,
  unit: string,
): HardConstraint {
  return {
    kind: 'attribute',
    id,
    scope: 'product',
    explanation: `${attributeKey} ${op} ${magnitude}${unit}`,
    strength: 'hard',
    missingDataPolicy: 'exclude_when_unknown',
    attributeKey,
    definitionVersion: 1,
    predicate: { op, value: { type: 'measurement', magnitude, unit } },
  } as HardConstraint;
}

function validatedSet(hard: readonly HardConstraint[]): ValidatedConstraintSet {
  return {
    hard,
    preferences: [],
    evaluationVersion: CONSTRAINT_EVALUATION_VERSION,
    definitionVersions: {},
    brand: 'validated-constraint-set',
  } as ValidatedConstraintSet;
}

function factsFor(entries: readonly EvaluableFact[]): CandidateFacts {
  return {
    productId: 'product-1',
    productFacts: entries,
    variantFacts: new Map(),
    offerFacts: new Map(),
  };
}

describe('property: evaluating a constraint set', () => {
  it('reaches the same VERDICT however the constraints are ordered', () => {
    // Driven through the real `evaluateCandidate`, over shuffles rather than one
    // reversal: a sort-dependent evaluator can survive a single reversal by
    // symmetry. The per-constraint outcomes are compared BY ID, because the
    // outcome array follows the input order by construction and comparing it
    // positionally would assert the shuffle happened rather than that it did not
    // matter.
    const random = lcg(SEED + 5);
    let excluded = 0;
    let included = 0;

    for (let run = 0; run < 400; run += 1) {
      const ramGb = pick(random, [4, 8, 16, 32, 64]);
      const screenIn = Math.round(random() * 100) / 10;
      const constraints = [
        hardConstraint('ram-min', 'ram_capacity', 'gte', pick(random, [4, 16, 64]), 'GB'),
        hardConstraint('screen-min', 'screen_size', 'gte', Math.round(random() * 80) / 10, 'in'),
        hardConstraint('screen-max', 'screen_size', 'lte', 4 + Math.round(random() * 80) / 10, 'in'),
      ];
      const shuffled = [...constraints];
      for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(random() * (index + 1));
        const held = shuffled[index];
        const other = shuffled[swap];
        if (held === undefined || other === undefined) continue;
        shuffled[index] = other;
        shuffled[swap] = held;
      }

      const candidate = factsFor([
        { attributeKey: 'ram_capacity', definitionVersion: 1, normalizedNumber: ramGb * 1_000_000_000, sourceBacked: true },
        { attributeKey: 'screen_size', definitionVersion: 1, normalizedNumber: screenIn * 25.4, sourceBacked: true },
      ]);

      const asDeclared = evaluateCandidate(validatedSet(constraints), candidate);
      const asShuffled = evaluateCandidate(validatedSet(shuffled), candidate);
      const context = `seed=${SEED + 5} run=${run} ram=${ramGb}GB screen=${screenIn}in`;

      expect(asShuffled.verdict, context).toBe(asDeclared.verdict);
      // And every constraint reaches the same satisfaction, matched by ID.
      const byId = (evaluation: typeof asDeclared): string =>
        [...evaluation.hardOutcomes]
          .map((outcome) => `${outcome.constraintId}=${outcome.satisfaction}`)
          .sort()
          .join('|');
      expect(byId(asShuffled), context).toBe(byId(asDeclared));

      if (asDeclared.verdict === 'excluded') excluded += 1;
      else included += 1;
    }

    // BOTH verdicts floored. Without this the property is satisfied by a
    // generator whose every candidate was excluded — order-independence over one
    // outcome says nothing about the other.
    expect(excluded, `seed=${SEED + 5} — nothing was excluded`).toBeGreaterThan(20);
    expect(included, `seed=${SEED + 5} — nothing was included`).toBeGreaterThan(20);
  });

  it('never reports a constraint satisfied on a fact nobody recorded', () => {
    // #94's "missing data is `unknown`, never a quiet yes", over generated
    // bounds: a candidate with NO facts can never satisfy a hard requirement,
    // whatever the bound happens to be.
    const random = lcg(SEED + 6);
    let checked = 0;
    for (let run = 0; run < 500; run += 1) {
      const constraint = hardConstraint(
        'ram-min',
        'ram_capacity',
        pick(random, ['gte', 'lte'] as const),
        Math.round(random() * 128),
        'GB',
      );
      const evaluation = evaluateCandidate(validatedSet([constraint]), factsFor([]));
      const context = `seed=${SEED + 6} run=${run}`;
      expect(evaluation.hardOutcomes[0]?.satisfaction, context).not.toBe('satisfied');
      // …and `exclude_when_unknown` means the verdict follows.
      expect(evaluation.verdict, context).toBe('excluded');
      checked += 1;
    }
    expect(checked).toBe(500);
  });
});
