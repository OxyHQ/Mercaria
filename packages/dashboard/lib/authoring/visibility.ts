/**
 * Which schema fields this draft should SHOW right now (ADR 0007 D5).
 *
 * ## Why this exists at all, and what it is not
 *
 * `AuthoringField.visibilityRule` travels in the composed schema precisely so a
 * form can decide what to render before it submits anything — the same reason
 * `AuthoringFieldValidation` is restated there. Rendering is a client question
 * and there is no per-draft "which fields are visible" endpoint, so a client
 * that wanted one would have to POST a validation on every keystroke.
 *
 * This is therefore a SECOND implementation of a pure function the backend also
 * owns (`services/product-types/visibility-rule.ts`), and that is stated rather
 * than hidden. What bounds the cost of a divergence is the direction of
 * authority: the server re-evaluates the identical rule at `validate` and at
 * `publish`, so a disagreement here can only mean a field was shown that did
 * not need answering, or one was hidden and the server then reports
 * `required_field_missing` against it — both visible, neither silent. Nothing
 * this module decides can make a publish succeed that the server would refuse.
 *
 * The rule vocabulary itself is `@mercaria/shared-types`' and is imported, not
 * restated: there is no local copy of the operator list, the node list or the
 * outcome list, so a member added upstream is a `tsc` error here rather than a
 * branch that silently falls through.
 *
 * ## The three-valued part is the part to get right
 *
 * `unknown` is not a soft yes and not a soft no. It means the draft has not yet
 * answered a field the rule reads. `effectiveRequirement` below states the one
 * policy decision, in one place and identically to the server's: a field is
 * asked for only when its condition is definitely `satisfied`.
 *
 * Treating `unknown` as visible deadlocks the form — the author is told a field
 * is required while the field whose answer would decide that is not shown yet.
 */

import type {
  ProductTypeFieldRequirement,
  ProductTypeRuleFieldValue,
  ProductTypeRuleScalar,
  ProductTypeRuleValues,
  ProductTypeVisibilityOutcome,
  ProductTypeVisibilityRule,
} from "@mercaria/shared-types";

/**
 * One field's answer, as the interpreter sees it.
 *
 * A STRING discriminant rather than `known: boolean`, matching the server's
 * shape — and here it also keeps the list branch out of the scalar comparisons
 * without a cast.
 */
type FieldAnswer =
  | { state: "absent" }
  | { state: "scalar"; value: ProductTypeRuleScalar }
  | { state: "list"; values: readonly ProductTypeRuleScalar[] };

/**
 * `null` and `undefined` are both "unanswered" and are indistinguishable on
 * purpose: an author who cleared a field and one who never touched it have said
 * the same thing.
 *
 * An EMPTY ARRAY is present, not absent — "this product has no ports" is an
 * answer, and reading it as silence would make a rule keyed on it never fire
 * for exactly the products it describes.
 */
function readAnswer(values: ProductTypeRuleValues, field: string): FieldAnswer {
  const raw: ProductTypeRuleFieldValue = Object.prototype.hasOwnProperty.call(values, field)
    ? values[field]
    : undefined;
  if (raw === undefined || raw === null) return { state: "absent" };
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
    return { state: "scalar", value: raw };
  }
  return { state: "list", values: raw };
}

function evaluateNode(
  rule: ProductTypeVisibilityRule,
  values: ProductTypeRuleValues,
): ProductTypeVisibilityOutcome {
  switch (rule.node) {
    case "all": {
      // Kleene conjunction: a definite failure beats an unknown, so a rule whose
      // other half is already false does not report itself unanswerable.
      let sawUnknown = false;
      for (const branch of rule.rules) {
        const outcome = evaluateNode(branch, values);
        if (outcome === "unsatisfied") return "unsatisfied";
        if (outcome === "unknown") sawUnknown = true;
      }
      return sawUnknown ? "unknown" : "satisfied";
    }
    case "any": {
      let sawUnknown = false;
      for (const branch of rule.rules) {
        const outcome = evaluateNode(branch, values);
        if (outcome === "satisfied") return "satisfied";
        if (outcome === "unknown") sawUnknown = true;
      }
      return sawUnknown ? "unknown" : "unsatisfied";
    }
    case "not": {
      const inner = evaluateNode(rule.rule, values);
      if (inner === "satisfied") return "unsatisfied";
      if (inner === "unsatisfied") return "satisfied";
      return "unknown";
    }
    case "presence": {
      // The one pair of operators that is DEFINITE on an unanswered field, which
      // is what they are for.
      const present = readAnswer(values, rule.field).state !== "absent";
      return (rule.op === "is_present") === present ? "satisfied" : "unsatisfied";
    }
    case "compare": {
      const answer = readAnswer(values, rule.field);
      if (answer.state === "absent") return "unknown";
      // A list answer compared against a scalar is a question this rule cannot
      // answer; coercing it would report a definite `unsatisfied` for a
      // mis-declared schema.
      if (answer.state === "list") return "unknown";
      if (rule.op === "eq") return answer.value === rule.value ? "satisfied" : "unsatisfied";
      if (rule.op === "ne") return answer.value === rule.value ? "unsatisfied" : "satisfied";
      // Ordering is numeric on BOTH sides and nothing is coerced: deciding that
      // a numeric-looking string is a number would make `'010' < '9'` a fact
      // about a product.
      if (typeof rule.value !== "number") return "unknown";
      if (typeof answer.value !== "number") return "unknown";
      if (rule.op === "gt") return answer.value > rule.value ? "satisfied" : "unsatisfied";
      if (rule.op === "gte") return answer.value >= rule.value ? "satisfied" : "unsatisfied";
      if (rule.op === "lt") return answer.value < rule.value ? "satisfied" : "unsatisfied";
      return answer.value <= rule.value ? "satisfied" : "unsatisfied";
    }
    case "membership": {
      const answer = readAnswer(values, rule.field);
      if (answer.state === "absent") return "unknown";
      if (rule.op === "includes_any") {
        if (answer.state !== "list") return "unknown";
        return answer.values.some((entry) => rule.values.includes(entry))
          ? "satisfied"
          : "unsatisfied";
      }
      if (answer.state !== "scalar") return "unknown";
      const member = rule.values.includes(answer.value);
      return (rule.op === "in") === member ? "satisfied" : "unsatisfied";
    }
    default:
      // Unreachable for a rule the shared union describes, and the only honest
      // answer for one that somehow is not: an outcome this interpreter cannot
      // produce must never read as `satisfied`.
      return "unknown";
  }
}

/** Evaluate one field's condition against the draft's product-scope answers. */
export function evaluateVisibility(
  rule: ProductTypeVisibilityRule,
  values: ProductTypeRuleValues,
): ProductTypeVisibilityOutcome {
  return evaluateNode(rule, values);
}

/**
 * The requirement a field ACTUALLY has once its condition is evaluated.
 *
 * The one policy decision, stated in one place and identically to the server's
 * `effectiveFieldRequirement`: `unsatisfied` and `unknown` both produce
 * `hidden`.
 */
export function effectiveRequirement(
  declared: ProductTypeFieldRequirement,
  rule: ProductTypeVisibilityRule | null,
  values: ProductTypeRuleValues,
): ProductTypeFieldRequirement {
  if (rule === null) return declared;
  return evaluateNode(rule, values) === "satisfied" ? declared : "hidden";
}
