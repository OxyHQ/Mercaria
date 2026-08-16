/**
 * The conditional-visibility rule interpreter (#367, ADR 0007 D5/D14) — unit
 * cases, the three-valued algebra, and a FUZZ pass over both valid and hostile
 * input.
 *
 * ADR 0007 D5 asks for two things this file has to demonstrate rather than
 * assert: that the rule language is bounded and non-Turing-complete, and that
 * the interpreter is fuzz-tested. The fuzz pass therefore runs two generators —
 * one that builds well-formed rules and one that builds arbitrary junk — plus a
 * fixed set of adversarial candidates (a CYCLE, a ten-thousand-deep chain, a
 * `__proto__` key, non-finite numbers, twelve forbidden operator spellings).
 *
 * The properties under test are the ones a bound is FOR:
 *
 *  - parsing never throws and never hangs, whatever it is handed;
 *  - a valid parse is within every declared bound, so the bounds cannot be
 *    satisfied by a rule that simply was not measured;
 *  - evaluation never throws and always answers one of exactly three outcomes;
 *  - evaluation is deterministic and free of input mutation;
 *  - and the generator itself is measured — a fuzz run that produced only
 *    invalid candidates would pass every assertion above while testing the
 *    refusal path and nothing else, so both populations carry a floor.
 *
 * The PRNG is seeded, so a failure names a reproducible case rather than "it
 * went red once".
 */

import { describe, expect, it } from 'vitest';
import {
  PRODUCT_TYPE_FORBIDDEN_RULE_OPERATORS,
  PRODUCT_TYPE_RULE_MAX_BRANCHES,
  PRODUCT_TYPE_RULE_MAX_DEPTH,
  PRODUCT_TYPE_RULE_MAX_NODES,
  PRODUCT_TYPE_RULE_MAX_SERIALIZED_BYTES,
  PRODUCT_TYPE_RULE_MAX_STRING_LENGTH,
  PRODUCT_TYPE_RULE_MAX_VALUES,
  PRODUCT_TYPE_RULE_OPERATORS,
  PRODUCT_TYPE_VISIBILITY_OUTCOMES,
  type ProductTypeRuleValues,
  type ProductTypeVisibilityRule,
} from '@mercaria/shared-types';
import {
  effectiveFieldRequirement,
  evaluateVisibilityRule,
  parseVisibilityRule,
} from '../product-types/visibility-rule.js';

/** A parsed rule, or a failure naming the refusal — used by every case below. */
function parsed(candidate: unknown): ProductTypeVisibilityRule {
  const result = parseVisibilityRule(candidate);
  if (result.outcome !== 'valid') {
    throw new Error(`expected a valid rule, got ${result.refusal} at ${result.path}`);
  }
  return result.rule;
}

describe('parsing refuses everything outside the language', () => {
  it('accepts the four leaf shapes and the three combinators', () => {
    expect(parseVisibilityRule({ node: 'compare', field: 'ram', op: 'gte', value: 16 }).outcome).toBe('valid');
    expect(parseVisibilityRule({ node: 'membership', field: 'ports', op: 'includes_any', values: ['usb_c'] }).outcome).toBe('valid');
    expect(parseVisibilityRule({ node: 'presence', field: 'gtin', op: 'is_present' }).outcome).toBe('valid');
    expect(
      parseVisibilityRule({
        node: 'all',
        rules: [
          { node: 'presence', field: 'gtin', op: 'is_absent' },
          { node: 'not', rule: { node: 'compare', field: 'ram', op: 'eq', value: 8 } },
          { node: 'any', rules: [{ node: 'membership', field: 'color', op: 'in', values: ['black'] }] },
        ],
      }).outcome,
    ).toBe('valid');
  });

  it('names the refusal and the path', () => {
    const cases: ReadonlyArray<readonly [unknown, string, string]> = [
      [null, 'not_an_object', '$'],
      ['a string', 'not_an_object', '$'],
      [{ node: 'exec' }, 'unknown_node', '$'],
      [{ node: 'compare', field: 'ram', op: 'matches', value: 'x' }, 'forbidden_operator', '$.op'],
      [{ node: 'compare', field: 'ram', op: 'startsWith', value: 'x' }, 'unknown_operator', '$.op'],
      [{ node: 'compare', field: 'RAM', op: 'eq', value: 1 }, 'invalid_field_key', '$.field'],
      [{ node: 'compare', field: 'ram.size', op: 'eq', value: 1 }, 'invalid_field_key', '$.field'],
      [{ node: 'compare', field: 'ram', op: 'eq', value: { a: 1 } }, 'invalid_value', '$.value'],
      [{ node: 'compare', field: 'ram', op: 'gt', value: 'big' }, 'value_type_mismatch', '$.value'],
      [{ node: 'membership', field: 'ram', op: 'in', values: [] }, 'invalid_value', '$.values'],
      [{ node: 'all', rules: [] }, 'empty_branch_list', '$.rules'],
      [{ node: 'presence', field: 'ram', op: 'is_here' }, 'unknown_operator', '$.op'],
    ];
    for (const [candidate, refusal, path] of cases) {
      const result = parseVisibilityRule(candidate);
      expect(result.outcome, JSON.stringify(candidate)).toBe('invalid');
      if (result.outcome === 'invalid') {
        expect(result.refusal, JSON.stringify(candidate)).toBe(refusal);
        expect(result.path, JSON.stringify(candidate)).toBe(path);
      }
    }
  });

  it('refuses every forbidden operator spelling under its OWN reason code', () => {
    // A louder refusal than `unknown_operator` on purpose: somebody reaching for
    // a pattern language is a different problem from somebody making a typo, and
    // the twelve spellings exist so the build failure says which.
    expect(PRODUCT_TYPE_FORBIDDEN_RULE_OPERATORS.length).toBeGreaterThanOrEqual(12);
    for (const op of PRODUCT_TYPE_FORBIDDEN_RULE_OPERATORS) {
      const result = parseVisibilityRule({ node: 'compare', field: 'ram', op, value: 'x' });
      expect(result.outcome, op).toBe('invalid');
      if (result.outcome === 'invalid') expect(result.refusal, op).toBe('forbidden_operator');
    }
    // And the two vocabularies are DISJOINT, so a forbidden spelling can never
    // also be a permitted one.
    for (const op of PRODUCT_TYPE_RULE_OPERATORS) {
      expect(PRODUCT_TYPE_FORBIDDEN_RULE_OPERATORS.includes(op), op).toBe(false);
    }
  });

  it('enforces every bound', () => {
    const deep = (levels: number): unknown => {
      let node: unknown = { node: 'presence', field: 'a', op: 'is_present' };
      for (let index = 0; index < levels; index += 1) node = { node: 'not', rule: node };
      return node;
    };
    expect(parseVisibilityRule(deep(PRODUCT_TYPE_RULE_MAX_DEPTH - 1)).outcome).toBe('valid');
    const tooDeep = parseVisibilityRule(deep(PRODUCT_TYPE_RULE_MAX_DEPTH));
    expect(tooDeep.outcome).toBe('invalid');
    if (tooDeep.outcome === 'invalid') expect(tooDeep.refusal).toBe('too_deep');

    const wide = {
      node: 'all',
      rules: Array.from({ length: PRODUCT_TYPE_RULE_MAX_BRANCHES + 1 }, () => ({
        node: 'presence',
        field: 'a',
        op: 'is_present',
      })),
    };
    const tooWide = parseVisibilityRule(wide);
    expect(tooWide.outcome).toBe('invalid');
    if (tooWide.outcome === 'invalid') expect(tooWide.refusal).toBe('too_many_branches');

    const manyValues = {
      node: 'membership',
      field: 'a',
      op: 'in',
      values: Array.from({ length: PRODUCT_TYPE_RULE_MAX_VALUES + 1 }, (_unused, index) => index),
    };
    const tooMany = parseVisibilityRule(manyValues);
    expect(tooMany.outcome).toBe('invalid');
    if (tooMany.outcome === 'invalid') expect(tooMany.refusal).toBe('too_many_values');

    const longString = {
      node: 'compare',
      field: 'a',
      op: 'eq',
      value: 'x'.repeat(PRODUCT_TYPE_RULE_MAX_STRING_LENGTH + 1),
    };
    const tooLong = parseVisibilityRule(longString);
    expect(tooLong.outcome).toBe('invalid');
    if (tooLong.outcome === 'invalid') expect(tooLong.refusal).toBe('invalid_value');

    // The byte bound is REACHABLE with everything else satisfied: 32 values of
    // 256 characters is about 8 KB, which is what the column's own CHECK bounds.
    const heavy = {
      node: 'membership',
      field: 'a',
      op: 'in',
      values: Array.from({ length: PRODUCT_TYPE_RULE_MAX_VALUES }, () =>
        'x'.repeat(PRODUCT_TYPE_RULE_MAX_STRING_LENGTH),
      ),
    };
    const tooLarge = parseVisibilityRule(heavy);
    expect(tooLarge.outcome).toBe('invalid');
    if (tooLarge.outcome === 'invalid') expect(tooLarge.refusal).toBe('too_large');
    expect(PRODUCT_TYPE_RULE_MAX_VALUES * PRODUCT_TYPE_RULE_MAX_STRING_LENGTH).toBeGreaterThan(
      PRODUCT_TYPE_RULE_MAX_SERIALIZED_BYTES,
    );
  });

  it('a node count over the bound is refused', () => {
    // A balanced tree wider than the node budget but within depth and branch
    // bounds, so `too_many_nodes` is the reason rather than either of the other
    // two. Depth 4 × 16 branches is 4 096 leaves at the widest.
    const leaf = { node: 'presence', field: 'a', op: 'is_present' };
    const level = (children: unknown[]) => ({ node: 'all', rules: children });
    const tree = level(
      Array.from({ length: PRODUCT_TYPE_RULE_MAX_BRANCHES }, () =>
        level(Array.from({ length: PRODUCT_TYPE_RULE_MAX_BRANCHES }, () => leaf)),
      ),
    );
    const result = parseVisibilityRule(tree);
    expect(result.outcome).toBe('invalid');
    if (result.outcome === 'invalid') expect(result.refusal).toBe('too_many_nodes');
    expect(PRODUCT_TYPE_RULE_MAX_BRANCHES * PRODUCT_TYPE_RULE_MAX_BRANCHES).toBeGreaterThan(
      PRODUCT_TYPE_RULE_MAX_NODES,
    );
  });

  it('reports every field the rule reads, deduplicated', () => {
    const result = parseVisibilityRule({
      node: 'all',
      rules: [
        { node: 'compare', field: 'ram', op: 'gte', value: 16 },
        { node: 'presence', field: 'gtin', op: 'is_present' },
        { node: 'compare', field: 'ram', op: 'lte', value: 64 },
      ],
    });
    expect(result.outcome).toBe('valid');
    if (result.outcome === 'valid') {
      expect(result.fields).toEqual(['ram', 'gtin']);
      expect(result.nodeCount).toBe(4);
      expect(result.depth).toBe(2);
    }
  });
});

describe('evaluation is three-valued and unknown never satisfies anything', () => {
  const values: ProductTypeRuleValues = {
    ram: 16,
    color: 'black',
    ports: ['usb_c', 'hdmi'],
    cleared: null,
    empty: [],
  };

  it('answers definitely when it can', () => {
    expect(evaluateVisibilityRule(parsed({ node: 'compare', field: 'ram', op: 'gte', value: 16 }), values).outcome).toBe('satisfied');
    expect(evaluateVisibilityRule(parsed({ node: 'compare', field: 'ram', op: 'gt', value: 16 }), values).outcome).toBe('unsatisfied');
    expect(evaluateVisibilityRule(parsed({ node: 'membership', field: 'color', op: 'in', values: ['black', 'white'] }), values).outcome).toBe('satisfied');
    expect(evaluateVisibilityRule(parsed({ node: 'membership', field: 'color', op: 'not_in', values: ['black'] }), values).outcome).toBe('unsatisfied');
    expect(evaluateVisibilityRule(parsed({ node: 'membership', field: 'ports', op: 'includes_any', values: ['hdmi'] }), values).outcome).toBe('satisfied');
  });

  it('answers unknown for an unanswered field and names it', () => {
    const verdict = evaluateVisibilityRule(
      parsed({ node: 'compare', field: 'storage', op: 'gte', value: 256 }),
      values,
    );
    expect(verdict.outcome).toBe('unknown');
    expect(verdict.unknownFields).toEqual(['storage']);
  });

  it('treats a cleared field and an unset one identically, and an EMPTY LIST as an answer', () => {
    // `null` is somebody clearing a field and `undefined` is never having set
    // one — the same statement. An empty array is different: "this has no ports"
    // is an answer, and reading it as silence makes a rule keyed on it never
    // fire for exactly the products it describes.
    expect(evaluateVisibilityRule(parsed({ node: 'presence', field: 'cleared', op: 'is_absent' }), values).outcome).toBe('satisfied');
    expect(evaluateVisibilityRule(parsed({ node: 'presence', field: 'never_set', op: 'is_absent' }), values).outcome).toBe('satisfied');
    expect(evaluateVisibilityRule(parsed({ node: 'presence', field: 'empty', op: 'is_present' }), values).outcome).toBe('satisfied');
    expect(evaluateVisibilityRule(parsed({ node: 'membership', field: 'empty', op: 'includes_any', values: ['x'] }), values).outcome).toBe('unsatisfied');
  });

  it('never coerces a numeric-looking string', () => {
    // `'010' < '9'` must not become a fact about a product.
    const stringy: ProductTypeRuleValues = { ram: '16' };
    expect(evaluateVisibilityRule(parsed({ node: 'compare', field: 'ram', op: 'gte', value: 16 }), stringy).outcome).toBe('unknown');
    expect(evaluateVisibilityRule(parsed({ node: 'compare', field: 'ram', op: 'eq', value: 16 }), stringy).outcome).toBe('unsatisfied');
  });

  it('applies Kleene logic: a definite failure beats an unknown', () => {
    const rule = parsed({
      node: 'all',
      rules: [
        { node: 'compare', field: 'ram', op: 'gt', value: 32 },
        { node: 'compare', field: 'storage', op: 'gte', value: 256 },
      ],
    });
    // `ram > 32` is definitely false, so the conjunction is false even though the
    // other half is unanswerable — a rule that reported itself `unknown` here
    // would hide a field whose condition has already been decided.
    expect(evaluateVisibilityRule(rule, values).outcome).toBe('unsatisfied');

    const disjunction = parsed({
      node: 'any',
      rules: [
        { node: 'compare', field: 'ram', op: 'gte', value: 16 },
        { node: 'compare', field: 'storage', op: 'gte', value: 256 },
      ],
    });
    expect(evaluateVisibilityRule(disjunction, values).outcome).toBe('satisfied');
  });

  it('double negation is the identity on all three outcomes', () => {
    for (const inner of [
      { node: 'compare', field: 'ram', op: 'gte', value: 16 },
      { node: 'compare', field: 'ram', op: 'gt', value: 99 },
      { node: 'compare', field: 'storage', op: 'gte', value: 1 },
    ]) {
      const once = evaluateVisibilityRule(parsed(inner), values).outcome;
      const twice = evaluateVisibilityRule(
        parsed({ node: 'not', rule: { node: 'not', rule: inner } }),
        values,
      ).outcome;
      expect(twice, JSON.stringify(inner)).toBe(once);
    }
  });
});

describe('the effective requirement', () => {
  it('is the declared one only when the condition is definitely satisfied', () => {
    expect(effectiveFieldRequirement('required', null)).toBe('required');
    expect(effectiveFieldRequirement('required', { outcome: 'satisfied', unknownFields: [] })).toBe('required');
    expect(effectiveFieldRequirement('required', { outcome: 'unsatisfied', unknownFields: [] })).toBe('hidden');
    // The decision that keeps an authoring form from deadlocking: a field whose
    // precondition nobody has answered cannot be REQUIRED.
    expect(effectiveFieldRequirement('required', { outcome: 'unknown', unknownFields: ['storage'] })).toBe('hidden');
  });
});

/* -------------------------------------------------------------------------- */
/* The fuzz pass                                                               */
/* -------------------------------------------------------------------------- */

/** mulberry32 — seeded, so a red run names a case somebody can re-run. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIELD_KEYS = ['ram', 'storage', 'color', 'ports', 'gtin', 'weight_grams'];

function pick<T>(next: () => number, items: readonly T[]): T {
  return items[Math.floor(next() * items.length) % items.length];
}

/** A well-formed rule within every bound. */
function generateValidRule(next: () => number, depth: number): unknown {
  const leafOnly = depth >= PRODUCT_TYPE_RULE_MAX_DEPTH - 1;
  const roll = leafOnly ? next() * 0.6 : next();
  if (roll < 0.2) {
    return { node: 'compare', field: pick(next, FIELD_KEYS), op: pick(next, ['eq', 'ne']), value: pick(next, ['black', 42, true]) };
  }
  if (roll < 0.4) {
    return { node: 'compare', field: pick(next, FIELD_KEYS), op: pick(next, ['gt', 'gte', 'lt', 'lte']), value: Math.floor(next() * 1000) };
  }
  if (roll < 0.6) {
    const count = 1 + Math.floor(next() * 4);
    return {
      node: 'membership',
      field: pick(next, FIELD_KEYS),
      op: pick(next, ['in', 'not_in', 'includes_any']),
      values: Array.from({ length: count }, () => pick(next, ['usb_c', 'hdmi', 7, false])),
    };
  }
  if (roll < 0.75) {
    return { node: 'presence', field: pick(next, FIELD_KEYS), op: pick(next, ['is_present', 'is_absent']) };
  }
  if (roll < 0.85) {
    return { node: 'not', rule: generateValidRule(next, depth + 1) };
  }
  const branches = 1 + Math.floor(next() * 3);
  return {
    node: pick(next, ['all', 'any']),
    rules: Array.from({ length: branches }, () => generateValidRule(next, depth + 1)),
  };
}

/** Arbitrary junk — the shape an attacker or a broken client actually sends. */
function generateJunk(next: () => number, depth: number): unknown {
  const roll = next();
  if (depth > 5 || roll < 0.2) {
    return pick(next, [null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, '', 'node', true, [], {}, { node: 'compare' }]);
  }
  if (roll < 0.4) {
    return {
      node: pick(next, ['compare', 'membership', 'presence', 'all', 'any', 'not', 'exec', '', 'Compare']),
      field: pick(next, [...FIELD_KEYS, 'Bad Key', '', '__proto__', 'a'.repeat(400), 7]),
      op: pick(next, [...PRODUCT_TYPE_RULE_OPERATORS, ...PRODUCT_TYPE_FORBIDDEN_RULE_OPERATORS, '', 42]),
      value: pick(next, ['x', 1, false, null, {}, []]),
      values: pick(next, [[], ['a'], [{}], 'not-an-array', Array.from({ length: 40 }, () => 'v')]),
      rules: pick(next, [[], 'nope', [generateJunk(next, depth + 1)]]),
      rule: generateJunk(next, depth + 1),
      __proto__: { node: 'presence', field: 'ram', op: 'is_present' },
    };
  }
  if (roll < 0.6) return Array.from({ length: 1 + Math.floor(next() * 4) }, () => generateJunk(next, depth + 1));
  return { node: pick(next, ['all', 'any']), rules: Array.from({ length: 1 + Math.floor(next() * 5) }, () => generateJunk(next, depth + 1)) };
}

/**
 * A valid rule with one thing done to it.
 *
 * Pure junk almost never parses — measured at 11 acceptances in 3 000 candidates
 * on the first run of this file, which would have left the evaluation path
 * essentially untested while every assertion passed. Mutating well-formed rules
 * is what produces the NEAR-valid population, including the one that matters
 * most: a rule carrying properties the language does not define, which this
 * parser ignores rather than refuses because it reads only the keys it knows.
 */
function mutateValidRule(next: () => number, rule: unknown): unknown {
  const clone = JSON.parse(JSON.stringify(rule));
  const roll = next();
  if (roll < 0.25) {
    clone.pattern = '.*';
    clone.script = 'return true';
    clone.extra = { nested: [1, 2, 3] };
    return clone;
  }
  if (roll < 0.4) {
    clone.op = pick(next, [...PRODUCT_TYPE_FORBIDDEN_RULE_OPERATORS, 'nope', 42]);
    return clone;
  }
  if (roll < 0.52) {
    clone.field = pick(next, ['Bad Key', '', 7, 'a'.repeat(400)]);
    return clone;
  }
  if (roll < 0.62) {
    delete clone.node;
    return clone;
  }
  if (roll < 0.72) {
    let wrapped: unknown = clone;
    for (let index = 0; index < 8; index += 1) wrapped = { node: 'not', rule: wrapped };
    return wrapped;
  }
  if (roll < 0.82) {
    clone.value = pick(next, [{}, [], null, Number.NaN]);
    return clone;
  }
  if (roll < 0.9) {
    clone.values = Array.from({ length: PRODUCT_TYPE_RULE_MAX_VALUES + 5 }, () => 'v');
    return clone;
  }
  return clone;
}

/** A hostile candidate: two thirds pure junk, one third a mutated valid rule. */
function generateHostile(next: () => number): unknown {
  return next() < 0.35 ? mutateValidRule(next, generateValidRule(next, 1)) : generateJunk(next, 1);
}

/** Randomly answered draft values, including hostile shapes. */
function generateValues(next: () => number): ProductTypeRuleValues {
  const values: Record<string, unknown> = {};
  for (const key of FIELD_KEYS) {
    const roll = next();
    if (roll < 0.25) continue;
    if (roll < 0.35) values[key] = null;
    else if (roll < 0.55) values[key] = Math.floor(next() * 1000);
    else if (roll < 0.75) values[key] = pick(next, ['black', 'usb_c', '16']);
    else if (roll < 0.85) values[key] = next() < 0.5;
    else values[key] = Array.from({ length: Math.floor(next() * 4) }, () => pick(next, ['usb_c', 'hdmi', 3]));
  }
  return values as ProductTypeRuleValues;
}

/** Every node in a parsed rule, so the fuzz pass can measure what it built. */
function measure(rule: ProductTypeVisibilityRule, depth = 1): { nodes: number; depth: number } {
  if (rule.node === 'all' || rule.node === 'any') {
    let nodes = 1;
    let deepest = depth;
    for (const branch of rule.rules) {
      const inner = measure(branch, depth + 1);
      nodes += inner.nodes;
      deepest = Math.max(deepest, inner.depth);
    }
    return { nodes, depth: deepest };
  }
  if (rule.node === 'not') {
    const inner = measure(rule.rule, depth + 1);
    return { nodes: inner.nodes + 1, depth: inner.depth };
  }
  return { nodes: 1, depth };
}

describe('fuzz: the interpreter is bounded, total and deterministic', () => {
  it('parses 2000 well-formed rules, all within every declared bound', () => {
    const next = rng(0x5eed_1234);
    let valid = 0;
    let combinators = 0;
    for (let index = 0; index < 2000; index += 1) {
      const candidate = generateValidRule(next, 1);
      const result = parseVisibilityRule(candidate);
      expect(result.outcome, JSON.stringify(candidate)).toBe('valid');
      if (result.outcome !== 'valid') continue;
      valid += 1;
      const measured = measure(result.rule);
      expect(measured.nodes).toBe(result.nodeCount);
      expect(measured.depth).toBe(result.depth);
      expect(result.nodeCount).toBeLessThanOrEqual(PRODUCT_TYPE_RULE_MAX_NODES);
      expect(result.depth).toBeLessThanOrEqual(PRODUCT_TYPE_RULE_MAX_DEPTH);
      expect(Buffer.byteLength(JSON.stringify(result.rule), 'utf8')).toBeLessThanOrEqual(
        PRODUCT_TYPE_RULE_MAX_SERIALIZED_BYTES,
      );
      if (result.rule.node === 'all' || result.rule.node === 'any' || result.rule.node === 'not') {
        combinators += 1;
      }
    }
    expect(valid).toBe(2000);
    // The generator's own vacuity floor: a population of nothing but leaves
    // would never exercise the recursion, the depth bound or the Kleene
    // combinators, and would pass every assertion above.
    expect(combinators).toBeGreaterThan(200);
  });

  it('never throws and never hangs on 3000 arbitrary candidates', () => {
    const next = rng(0xbad_c0de);
    let refused = 0;
    let accepted = 0;
    const refusals = new Set<string>();
    for (let index = 0; index < 3000; index += 1) {
      const candidate = generateHostile(next);
      const result = parseVisibilityRule(candidate);
      if (result.outcome === 'invalid') {
        refused += 1;
        refusals.add(result.refusal);
        expect(typeof result.path).toBe('string');
        continue;
      }
      accepted += 1;
      // Anything that DID parse is still within every bound — an accepted
      // hostile candidate must be as bounded as a generated one.
      expect(result.nodeCount).toBeLessThanOrEqual(PRODUCT_TYPE_RULE_MAX_NODES);
      expect(result.depth).toBeLessThanOrEqual(PRODUCT_TYPE_RULE_MAX_DEPTH);
      const verdict = evaluateVisibilityRule(result.rule, generateValues(next));
      expect(PRODUCT_TYPE_VISIBILITY_OUTCOMES).toContain(verdict.outcome);
    }
    expect(refused + accepted).toBe(3000);
    // Both populations carry a floor. A junk generator that produced only
    // refusals would never exercise evaluation; one that produced only
    // acceptances would never exercise the refusal paths.
    expect(refused).toBeGreaterThan(1000);
    expect(accepted).toBeGreaterThan(100);
    expect(refusals.size).toBeGreaterThanOrEqual(5);
  });

  it('evaluation is deterministic and mutates neither the rule nor the values', () => {
    const next = rng(0xfeed_face);
    for (let index = 0; index < 1000; index += 1) {
      const rule = parsed(generateValidRule(next, 1));
      const values = generateValues(next);
      const ruleBefore = JSON.stringify(rule);
      const valuesBefore = JSON.stringify(values);
      const first = evaluateVisibilityRule(rule, values);
      const second = evaluateVisibilityRule(rule, values);
      expect(second.outcome).toBe(first.outcome);
      expect(second.unknownFields).toEqual(first.unknownFields);
      expect(PRODUCT_TYPE_VISIBILITY_OUTCOMES).toContain(first.outcome);
      expect(JSON.stringify(rule)).toBe(ruleBefore);
      expect(JSON.stringify(values)).toBe(valuesBefore);
    }
  });

  it('survives the adversarial fixtures a random generator will not produce', () => {
    // A CYCLE. The node counter is what makes this terminate: a recursive
    // descent that serialized the candidate first would throw, and one with no
    // budget would recurse until the stack gave out.
    const cyclic: Record<string, unknown> = { node: 'not' };
    cyclic.rule = cyclic;
    const cycle = parseVisibilityRule(cyclic);
    expect(cycle.outcome).toBe('invalid');
    if (cycle.outcome === 'invalid') expect(cycle.refusal).toBe('too_deep');

    // A ten-thousand-deep chain, built iteratively so the FIXTURE does not blow
    // the stack before the parser sees it.
    let chain: unknown = { node: 'presence', field: 'ram', op: 'is_present' };
    for (let index = 0; index < 10_000; index += 1) chain = { node: 'not', rule: chain };
    const deep = parseVisibilityRule(chain);
    expect(deep.outcome).toBe('invalid');
    if (deep.outcome === 'invalid') expect(deep.refusal).toBe('too_deep');

    // A `__proto__`-carrying candidate. Every property is read with
    // `hasOwnProperty`, so an inherited `node` cannot answer for a missing one.
    const polluted = JSON.parse('{"__proto__": {"node": "presence", "field": "ram", "op": "is_present"}}');
    const pollutedResult = parseVisibilityRule(polluted);
    expect(pollutedResult.outcome).toBe('invalid');
    if (pollutedResult.outcome === 'invalid') expect(pollutedResult.refusal).toBe('unknown_node');
    expect(({} as Record<string, unknown>).node).toBeUndefined();

    // Non-finite numbers are not values. `NaN` compared with anything is false,
    // so admitting one would make a rule that is silently never satisfied.
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const result = parseVisibilityRule({ node: 'compare', field: 'ram', op: 'gte', value });
      expect(result.outcome, String(value)).toBe('invalid');
      if (result.outcome === 'invalid') expect(result.refusal).toBe('invalid_value');
    }

    // A rule read back out of jsonb that never went through the parser: the
    // ordering branch re-checks its own side rather than trusting it.
    const smuggled = {
      node: 'compare',
      field: 'ram',
      op: 'gt',
      value: 'sixteen',
    } as unknown as ProductTypeVisibilityRule;
    expect(evaluateVisibilityRule(smuggled, { ram: 32 }).outcome).toBe('unknown');

    // An unrecognised node reaching the evaluator answers `unknown`, never
    // `satisfied` — the one honest answer for an outcome it cannot produce.
    const alien = { node: 'exec', field: 'ram' } as unknown as ProductTypeVisibilityRule;
    expect(evaluateVisibilityRule(alien, { ram: 32 }).outcome).toBe('unknown');
  });
});
