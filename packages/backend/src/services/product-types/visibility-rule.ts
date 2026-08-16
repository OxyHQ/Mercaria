/**
 * The conditional-visibility rule interpreter (#367, ADR 0007 D5/D14).
 *
 * A product-type field may declare a condition under which it is shown: "ask for
 * the storage size only when the connectivity is `cellular`". ADR 0007 D5 fixes
 * the form that condition takes — **a closed, bounded, non-Turing-complete
 * declarative predicate AST, evaluated by an interpreter with no function calls,
 * no regexes supplied by the row and a hard node-count bound** — and this module
 * is that interpreter.
 *
 * ## What it cannot do, and why each absence is structural
 *
 * - **It cannot execute anything.** There is no `eval`, no `new Function`, no
 *   template engine and no dynamic import in this file, and
 *   `product-type-isolation.test.ts` fails the build if one appears. The only
 *   operations are strict scalar comparison, numeric ordering and array
 *   membership, all written out below.
 * - **It cannot hold a pattern.** `ProductTypeRuleOperator` has no `matches`,
 *   `like` or `regex` member, and `PRODUCT_TYPE_FORBIDDEN_RULE_OPERATORS` names
 *   twelve such spellings so that a candidate carrying one is refused under its
 *   OWN reason code rather than the generic "unknown operator". A pattern
 *   supplied by a stored row is a small language and a DoS primitive — #63's
 *   finding about feed transforms, and the reason `regex_replace` is
 *   unrepresentable there too.
 * - **It cannot read anything outside the product type.** A rule names another
 *   field by its ATTRIBUTE KEY, validated against the registry's own key shape.
 *   There is no path syntax, no dot traversal and no root reference, so a rule
 *   has no way to spell a price, a stock level or a merchant — which is the
 *   mechanical version of ADR 0007 D5's "listing, offer and inventory fields are
 *   composed, never modelled as product-type attributes".
 * - **It cannot run away.** Node count, depth, branch count, value count and
 *   string length are all bounded during PARSING, before anything is evaluated,
 *   and a cyclic candidate trips the node counter rather than the stack.
 *
 * ## Three-valued, because two values would have to lie about absence
 *
 * An authoring draft is half-finished by definition: the field a rule reads is
 * usually the one the author has not reached yet. `unknown` is therefore a real
 * outcome and not a soft yes — the house rule every Mercaria domain applies to a
 * missing fact. {@link effectiveFieldRequirement} then states the one policy
 * decision that follows from it: a field whose precondition is unknown is
 * `hidden`, so an unanswered condition can never make a field REQUIRED. The
 * alternative deadlocks the form — the author is told to fill in a field whose
 * own precondition they have not been shown yet.
 *
 * The module is PURE: no database handle, no clock, no configuration, no I/O.
 */

import {
  PRODUCT_TYPE_ATTRIBUTE_KEY_PATTERN,
  PRODUCT_TYPE_FORBIDDEN_RULE_OPERATORS,
  PRODUCT_TYPE_RULE_COMPARISON_OPERATORS,
  PRODUCT_TYPE_RULE_MAX_BRANCHES,
  PRODUCT_TYPE_RULE_MAX_DEPTH,
  PRODUCT_TYPE_RULE_MAX_NODES,
  PRODUCT_TYPE_RULE_MAX_SERIALIZED_BYTES,
  PRODUCT_TYPE_RULE_MAX_STRING_LENGTH,
  PRODUCT_TYPE_RULE_MAX_VALUES,
  PRODUCT_TYPE_RULE_MEMBERSHIP_OPERATORS,
  PRODUCT_TYPE_RULE_PRESENCE_OPERATORS,
  type ProductTypeFieldRequirement,
  type ProductTypeRuleComparisonOperator,
  type ProductTypeRuleMembershipOperator,
  type ProductTypeRuleParse,
  type ProductTypeRulePresenceOperator,
  type ProductTypeRuleRefusal,
  type ProductTypeRuleScalar,
  type ProductTypeRuleValues,
  type ProductTypeVisibilityOutcome,
  type ProductTypeVisibilityRule,
  type ProductTypeVisibilityVerdict,
} from '@mercaria/shared-types';

/** A refusal, thrown internally so a walker twelve frames down can name a path. */
class RuleRefusal extends Error {
  readonly refusal: ProductTypeRuleRefusal;
  readonly path: string;

  constructor(refusal: ProductTypeRuleRefusal, path: string) {
    super(`${refusal} at ${path}`);
    this.refusal = refusal;
    this.path = path;
  }
}

/** The mutable budget one parse spends. */
interface ParseBudget {
  nodes: number;
  maxDepth: number;
  fields: string[];
}

function refuse(refusal: ProductTypeRuleRefusal, path: string): never {
  throw new RuleRefusal(refusal, path);
}

/**
 * A plain object, rejecting arrays and `null`.
 *
 * `Object.prototype.hasOwnProperty` is used for every property read below rather
 * than `in`, so a candidate carrying a crafted prototype cannot answer for a
 * property it does not own.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function own(source: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(source, key) ? source[key] : undefined;
}

/** A scalar leaf: a bounded string, a finite number, or a boolean. */
function readScalar(value: unknown, path: string): ProductTypeRuleScalar {
  if (typeof value === 'string') {
    if (value.length > PRODUCT_TYPE_RULE_MAX_STRING_LENGTH) refuse('invalid_value', path);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) refuse('invalid_value', path);
    return value;
  }
  if (typeof value === 'boolean') return value;
  refuse('invalid_value', path);
}

/** An attribute key, shaped exactly as the registry shapes its own. */
function readFieldKey(value: unknown, path: string, budget: ParseBudget): string {
  if (typeof value !== 'string') refuse('invalid_field_key', path);
  if (!PRODUCT_TYPE_ATTRIBUTE_KEY_PATTERN.test(value)) refuse('invalid_field_key', path);
  if (!budget.fields.includes(value)) budget.fields.push(value);
  return value;
}

/**
 * Classify an operator string. A spelling on the forbidden list gets its own
 * refusal so the build failure names the actual problem — somebody reached for a
 * pattern language — rather than reporting a typo.
 */
function readOperator(value: unknown, path: string): string {
  if (typeof value !== 'string') refuse('unknown_operator', path);
  if (PRODUCT_TYPE_FORBIDDEN_RULE_OPERATORS.includes(value)) refuse('forbidden_operator', path);
  return value;
}

function parseNode(
  candidate: unknown,
  path: string,
  depth: number,
  budget: ParseBudget,
): ProductTypeVisibilityRule {
  budget.nodes += 1;
  if (budget.nodes > PRODUCT_TYPE_RULE_MAX_NODES) refuse('too_many_nodes', path);
  if (depth > PRODUCT_TYPE_RULE_MAX_DEPTH) refuse('too_deep', path);
  if (depth > budget.maxDepth) budget.maxDepth = depth;
  if (!isPlainObject(candidate)) refuse('not_an_object', path);

  const node = own(candidate, 'node');

  if (node === 'all' || node === 'any') {
    const branches = own(candidate, 'rules');
    if (!Array.isArray(branches)) refuse('not_an_object', `${path}.rules`);
    if (branches.length === 0) refuse('empty_branch_list', `${path}.rules`);
    if (branches.length > PRODUCT_TYPE_RULE_MAX_BRANCHES) {
      refuse('too_many_branches', `${path}.rules`);
    }
    const rules = branches.map((branch, index) =>
      parseNode(branch, `${path}.rules[${index}]`, depth + 1, budget),
    );
    return node === 'all' ? { node: 'all', rules } : { node: 'any', rules };
  }

  if (node === 'not') {
    return { node: 'not', rule: parseNode(own(candidate, 'rule'), `${path}.rule`, depth + 1, budget) };
  }

  if (node === 'compare') {
    const field = readFieldKey(own(candidate, 'field'), `${path}.field`, budget);
    const op = readOperator(own(candidate, 'op'), `${path}.op`);
    if (!PRODUCT_TYPE_RULE_COMPARISON_OPERATORS.includes(op as ProductTypeRuleComparisonOperator)) {
      refuse('unknown_operator', `${path}.op`);
    }
    const value = readScalar(own(candidate, 'value'), `${path}.value`);
    // An ordering operator against a string or a boolean has no defensible
    // answer — string ordering is locale-dependent and boolean ordering is a
    // coincidence of representation — so it is refused at PARSE time rather than
    // answered `unknown` on every evaluation.
    if (op !== 'eq' && op !== 'ne' && typeof value !== 'number') {
      refuse('value_type_mismatch', `${path}.value`);
    }
    return { node: 'compare', field, op: op as ProductTypeRuleComparisonOperator, value };
  }

  if (node === 'membership') {
    const field = readFieldKey(own(candidate, 'field'), `${path}.field`, budget);
    const op = readOperator(own(candidate, 'op'), `${path}.op`);
    if (!PRODUCT_TYPE_RULE_MEMBERSHIP_OPERATORS.includes(op as ProductTypeRuleMembershipOperator)) {
      refuse('unknown_operator', `${path}.op`);
    }
    const raw = own(candidate, 'values');
    if (!Array.isArray(raw)) refuse('invalid_value', `${path}.values`);
    if (raw.length === 0) refuse('invalid_value', `${path}.values`);
    if (raw.length > PRODUCT_TYPE_RULE_MAX_VALUES) refuse('too_many_values', `${path}.values`);
    const values = raw.map((entry, index) => readScalar(entry, `${path}.values[${index}]`));
    return { node: 'membership', field, op: op as ProductTypeRuleMembershipOperator, values };
  }

  if (node === 'presence') {
    const field = readFieldKey(own(candidate, 'field'), `${path}.field`, budget);
    const op = readOperator(own(candidate, 'op'), `${path}.op`);
    if (!PRODUCT_TYPE_RULE_PRESENCE_OPERATORS.includes(op as ProductTypeRulePresenceOperator)) {
      refuse('unknown_operator', `${path}.op`);
    }
    return { node: 'presence', field, op: op as ProductTypeRulePresenceOperator };
  }

  refuse('unknown_node', path);
}

/**
 * Parse an UNTRUSTED candidate — a request body, a stored jsonb column, a seed —
 * into a rule, or refuse it with a machine code and a path.
 *
 * Never throws. Every refusal path returns the `invalid` branch, which carries
 * no `rule` property, so a caller cannot reach a rule it did not get.
 *
 * The byte bound is applied to the NORMALIZED rule rather than to the candidate:
 * the walk above is what makes the structure finite (a cyclic candidate trips
 * the node counter long before a serializer would throw), and the normalized
 * form is what actually reaches the column the bound belongs to.
 */
export function parseVisibilityRule(candidate: unknown): ProductTypeRuleParse {
  const budget: ParseBudget = { nodes: 0, maxDepth: 0, fields: [] };
  let rule: ProductTypeVisibilityRule;
  try {
    rule = parseNode(candidate, '$', 1, budget);
  } catch (error) {
    if (error instanceof RuleRefusal) {
      return { outcome: 'invalid', refusal: error.refusal, path: error.path };
    }
    throw error;
  }

  if (Buffer.byteLength(JSON.stringify(rule), 'utf8') > PRODUCT_TYPE_RULE_MAX_SERIALIZED_BYTES) {
    return { outcome: 'invalid', refusal: 'too_large', path: '$' };
  }

  return {
    outcome: 'valid',
    rule,
    nodeCount: budget.nodes,
    depth: budget.maxDepth,
    fields: budget.fields,
  };
}

/**
 * One field's answer, as the interpreter sees it.
 *
 * A STRING discriminant, not `known: boolean`: the backend compiles with
 * `strict: false`, and without `strictNullChecks` TypeScript does not narrow a
 * union on the truthiness of a boolean-literal discriminant (#68's finding).
 */
type FieldAnswer =
  | { state: 'absent' }
  | { state: 'scalar'; value: ProductTypeRuleScalar }
  | { state: 'list'; values: readonly ProductTypeRuleScalar[] };

/**
 * `null` and `undefined` are both "unanswered" and are indistinguishable here on
 * purpose: a client that cleared a field and one that never set it have said the
 * same thing.
 *
 * An EMPTY ARRAY is present, not absent. "This product has no ports" is an
 * answer, and reading it as silence would make a rule keyed on it never fire for
 * exactly the products it describes.
 */
function readAnswer(values: ProductTypeRuleValues, field: string): FieldAnswer {
  const raw = Object.prototype.hasOwnProperty.call(values, field) ? values[field] : undefined;
  if (raw === undefined || raw === null) return { state: 'absent' };
  // Scalars are eliminated by `typeof` BEFORE the array case, rather than the
  // array being detected first: `Array.isArray` is typed `arg is any[]`, so it
  // does not narrow a `readonly T[]` member out of a union in the negative
  // branch, and writing the check that way needs a cast to compile.
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
    return { state: 'scalar', value: raw };
  }
  return { state: 'list', values: raw };
}

interface EvaluationTrace {
  unknownFields: string[];
}

function note(trace: EvaluationTrace, field: string): ProductTypeVisibilityOutcome {
  if (!trace.unknownFields.includes(field)) trace.unknownFields.push(field);
  return 'unknown';
}

function evaluateNode(
  rule: ProductTypeVisibilityRule,
  values: ProductTypeRuleValues,
  trace: EvaluationTrace,
): ProductTypeVisibilityOutcome {
  switch (rule.node) {
    case 'all': {
      // Kleene conjunction: a definite failure beats an unknown, so a rule whose
      // other half is already false does not report itself unanswerable.
      let sawUnknown = false;
      for (const branch of rule.rules) {
        const outcome = evaluateNode(branch, values, trace);
        if (outcome === 'unsatisfied') return 'unsatisfied';
        if (outcome === 'unknown') sawUnknown = true;
      }
      return sawUnknown ? 'unknown' : 'satisfied';
    }
    case 'any': {
      let sawUnknown = false;
      for (const branch of rule.rules) {
        const outcome = evaluateNode(branch, values, trace);
        if (outcome === 'satisfied') return 'satisfied';
        if (outcome === 'unknown') sawUnknown = true;
      }
      return sawUnknown ? 'unknown' : 'unsatisfied';
    }
    case 'not': {
      const inner = evaluateNode(rule.rule, values, trace);
      if (inner === 'satisfied') return 'unsatisfied';
      if (inner === 'unsatisfied') return 'satisfied';
      return 'unknown';
    }
    case 'presence': {
      const answer = readAnswer(values, rule.field);
      const present = answer.state !== 'absent';
      // The one pair of operators that is DEFINITE on an unanswered field —
      // which is what they are for.
      return (rule.op === 'is_present') === present ? 'satisfied' : 'unsatisfied';
    }
    case 'compare': {
      const answer = readAnswer(values, rule.field);
      if (answer.state === 'absent') return note(trace, rule.field);
      // A list answer compared against a scalar is a question this rule cannot
      // answer. Coercing it — "does the list equal the value" — would silently
      // report a definite `unsatisfied` for a mis-declared schema.
      if (answer.state === 'list') return note(trace, rule.field);
      if (rule.op === 'eq') return answer.value === rule.value ? 'satisfied' : 'unsatisfied';
      if (rule.op === 'ne') return answer.value === rule.value ? 'unsatisfied' : 'satisfied';
      // Ordering is numeric on BOTH sides. `parseVisibilityRule` already refuses
      // a non-numeric rule value (`value_type_mismatch`), and the second check
      // here is not redundant: this function also runs against rules read back
      // out of jsonb, where the parser is what a WRITER went through rather than
      // something this reader can assume. An unanswerable comparison is
      // `unknown`, never a definite verdict.
      //
      // Nothing is coerced on the draft's side either: a numeric-looking string
      // is not a number, because deciding that it is would make `'010' < '9'` a
      // fact about a product.
      if (typeof rule.value !== 'number') return note(trace, rule.field);
      if (typeof answer.value !== 'number') return note(trace, rule.field);
      if (rule.op === 'gt') return answer.value > rule.value ? 'satisfied' : 'unsatisfied';
      if (rule.op === 'gte') return answer.value >= rule.value ? 'satisfied' : 'unsatisfied';
      if (rule.op === 'lt') return answer.value < rule.value ? 'satisfied' : 'unsatisfied';
      return answer.value <= rule.value ? 'satisfied' : 'unsatisfied';
    }
    case 'membership': {
      const answer = readAnswer(values, rule.field);
      if (answer.state === 'absent') return note(trace, rule.field);
      if (rule.op === 'includes_any') {
        if (answer.state !== 'list') return note(trace, rule.field);
        const hit = answer.values.some((entry) => rule.values.includes(entry));
        return hit ? 'satisfied' : 'unsatisfied';
      }
      if (answer.state !== 'scalar') return note(trace, rule.field);
      const member = rule.values.includes(answer.value);
      return (rule.op === 'in') === member ? 'satisfied' : 'unsatisfied';
    }
    default:
      // Unreachable for a rule that came through `parseVisibilityRule`, and the
      // only honest answer for one that did not: an outcome this interpreter
      // cannot produce must never read as `satisfied`.
      return 'unknown';
  }
}

/**
 * Evaluate a PARSED rule against a draft's answers.
 *
 * Takes an already-parsed rule rather than an unknown, so the bounds cannot be
 * skipped by calling this directly — the type is the reminder and
 * {@link parseVisibilityRule} is the only way to obtain one from untrusted
 * input.
 */
export function evaluateVisibilityRule(
  rule: ProductTypeVisibilityRule,
  values: ProductTypeRuleValues,
): ProductTypeVisibilityVerdict {
  const trace: EvaluationTrace = { unknownFields: [] };
  const outcome = evaluateNode(rule, values, trace);
  return { outcome, unknownFields: trace.unknownFields };
}

/**
 * The requirement a field ACTUALLY has, once its condition has been evaluated.
 *
 * The one policy decision this module makes, stated in one place: a field is
 * asked for only when its condition is definitely `satisfied`. `unsatisfied` and
 * `unknown` both produce `hidden`, and the difference between them lives in the
 * verdict the caller already holds.
 *
 * Treating `unknown` as visible is the tempting alternative and it deadlocks an
 * authoring form: the author is told a field is required while the field whose
 * answer would decide that is itself not shown yet. Treating it as `hidden` can
 * at worst let a publish through without a value whose precondition nobody
 * established — which is the state the draft is honestly in.
 */
export function effectiveFieldRequirement(
  declared: ProductTypeFieldRequirement,
  verdict: ProductTypeVisibilityVerdict | null,
): ProductTypeFieldRequirement {
  if (verdict === null) return declared;
  return verdict.outcome === 'satisfied' ? declared : 'hidden';
}
