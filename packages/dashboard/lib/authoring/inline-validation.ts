/**
 * The check one field can answer without a round trip.
 *
 * ## What this is for, and what it is not allowed to be
 *
 * `AuthoringFieldValidation` is restated in the composed schema precisely so a
 * form can validate before it submits — the DTO says so, and this is the
 * consumer it was restated for. Every refusal it produces is one of the
 * server's own `AuthoringValidationCode`s, so an inline complaint and the
 * server's are the same sentence in the same place, and there is no
 * client-only vocabulary a translator would have to invent copy for.
 *
 * It is NOT an authority and cannot be one. The server re-validates at
 * `validate` and again inside the publish transaction, and only its verdict
 * decides `publishable`. What this buys is latency: an author typing a
 * fourteenth decimal place is told at the keystroke rather than at the publish.
 *
 * The three checks that are deliberately ABSENT are the ones a client cannot
 * do honestly: `unknown_field` (the schema is the field list, so a key that is
 * not in it cannot be rendered), `duplicate_variant_signature` (the matrix
 * reports it, over rows rather than over one field) and every classification
 * and publication code, which are facts about the draft rather than about a
 * value.
 */

import type { AuthoringField, AuthoringValidationCode } from "@mercaria/shared-types";
import {
  expectedEntryKind,
  maxEntriesFor,
  parseEntryNumber,
  type DraftFieldEntry,
} from "./answers";

/** One inline complaint. Severity mirrors the server's split exactly. */
export interface InlineFinding {
  readonly code: AuthoringValidationCode;
  readonly severity: "error" | "warning";
  /** Which entry it is about, or `null` when it is about the field. */
  readonly ordinal: number | null;
}

/**
 * Decimal places counted from the DECIMAL rendering.
 *
 * `Number.prototype.toString()` produces the shortest round-tripping decimal,
 * so `0.1 + 0.2` reports 17 places rather than 1 — which is correct, because
 * that value genuinely is not one decimal place, and reporting it as one is how
 * a precision rule stops applying to exactly the values that need it.
 */
function decimalPlacesOf(value: number): number {
  const rendered = value.toString();
  if (rendered.includes("e") || rendered.includes("E")) return Number.MAX_SAFE_INTEGER;
  const dot = rendered.indexOf(".");
  return dot === -1 ? 0 : rendered.length - dot - 1;
}

function checkNumberEntry(
  field: AuthoringField,
  entry: Extract<DraftFieldEntry, { kind: "number" }>,
  out: InlineFinding[],
): void {
  const value = parseEntryNumber(entry.raw);
  if (value === null) {
    // A box that has something in it that is not a number. Reported rather than
    // dropped in silence: the payload drops it, so without this the author's
    // typing simply disappears at the next autosave.
    if (entry.raw.trim().length > 0) {
      out.push({ code: "value_type_mismatch", severity: "error", ordinal: entry.ordinal });
    }
    return;
  }
  const validation = field.validation;
  if (validation.minValue !== null && value < validation.minValue) {
    out.push({ code: "value_below_minimum", severity: "error", ordinal: entry.ordinal });
  }
  if (validation.maxValue !== null && value > validation.maxValue) {
    out.push({ code: "value_above_maximum", severity: "error", ordinal: entry.ordinal });
  }
  // A WARNING, like the server's: `implausible` is #94's "this is probably a
  // decimal-point mistake", a different claim from "outside the permitted
  // range". A 40-inch phone screen is almost certainly wrong and just possibly
  // a prototype, and refusing it would make the catalogue unable to record
  // something true.
  if (validation.implausibleAbove !== null && value > validation.implausibleAbove) {
    out.push({ code: "value_implausible", severity: "warning", ordinal: entry.ordinal });
  }
  if (validation.implausibleBelow !== null && value < validation.implausibleBelow) {
    out.push({ code: "value_implausible", severity: "warning", ordinal: entry.ordinal });
  }
  if (validation.decimalPlaces !== null && decimalPlacesOf(value) > validation.decimalPlaces) {
    out.push({ code: "too_many_decimal_places", severity: "error", ordinal: entry.ordinal });
  }
  if (validation.unitFamily !== null && (entry.unit === null || entry.unit.trim().length === 0)) {
    // A magnitude with no unit is not a smaller fact, it is an ambiguous one:
    // 6.1 of what.
    out.push({ code: "unknown_unit", severity: "error", ordinal: entry.ordinal });
  }
  if (validation.valueType === "money" && validation.currency === null) {
    out.push({ code: "currency_mismatch", severity: "error", ordinal: entry.ordinal });
  }
}

/**
 * Check one field's entries against the schema's own rules.
 *
 * `requirement` is the EFFECTIVE one — after the visibility rule — so a hidden
 * field is never reported as missing. Passing the declared requirement instead
 * is the deadlock `effectiveRequirement` exists to prevent.
 */
export function checkFieldEntries(
  field: AuthoringField,
  requirement: AuthoringField["requirement"],
  entries: readonly DraftFieldEntry[],
): readonly InlineFinding[] {
  const out: InlineFinding[] = [];
  const answered = entries.filter((entry) => {
    switch (entry.kind) {
      case "text":
        return entry.text.trim().length > 0;
      case "number":
        return entry.raw.trim().length > 0;
      case "boolean":
        return true;
      case "controlled_value":
        return entry.enumValueId.length > 0;
      case "canonical_reference":
        return entry.refId.length > 0;
      default:
        return false;
    }
  });

  if (requirement === "forbidden") {
    if (answered.length > 0) {
      out.push({ code: "field_forbidden_in_flow", severity: "error", ordinal: null });
    }
    return out;
  }
  if (requirement === "hidden") {
    // A hidden field carrying an answer is not an error — `hidden` means "this
    // flow does not ask, and a value that arrived another way is kept".
    return out;
  }
  if (answered.length === 0) {
    if (requirement === "required") {
      out.push({ code: "required_field_missing", severity: "error", ordinal: null });
    } else if (requirement === "recommended") {
      out.push({ code: "required_field_missing", severity: "warning", ordinal: null });
    }
    return out;
  }

  // A structured value carries one answer per AXIS, so the cardinality bound is
  // per axis: counting the three components of a dimension as three values
  // would refuse every `single` one.
  const max = maxEntriesFor(field);
  const countable =
    field.validation.valueType === "structured"
      ? new Set(answered.map((entry) => entry.ordinal)).size
      : answered.length;
  if (max !== null && countable > max) {
    out.push({ code: "cardinality_exceeded", severity: "error", ordinal: null });
  }

  const expected = expectedEntryKind(field);
  const controlled = new Set(field.controlledValues.map((value) => value.id));

  for (const entry of answered) {
    if (entry.kind !== expected) {
      out.push({ code: "value_type_mismatch", severity: "error", ordinal: entry.ordinal });
      continue;
    }
    if (entry.kind === "controlled_value") {
      if (!controlled.has(entry.enumValueId)) {
        out.push({ code: "value_not_in_controlled_set", severity: "error", ordinal: entry.ordinal });
      }
      continue;
    }
    if (entry.kind === "canonical_reference") {
      if (field.valuePolicy !== "canonical_reference") {
        out.push({
          code: "canonical_reference_not_permitted",
          severity: "error",
          ordinal: entry.ordinal,
        });
      }
      continue;
    }
    if (entry.kind === "text") {
      const maxLength = field.validation.maxLength;
      if (maxLength !== null && entry.text.length > maxLength) {
        out.push({ code: "value_too_long", severity: "error", ordinal: entry.ordinal });
      }
      continue;
    }
    if (entry.kind === "number") checkNumberEntry(field, entry, out);
  }

  if (field.validation.valueType === "structured") {
    const declared = new Set<string>(field.validation.componentAxes);
    const supplied = new Set<string>();
    for (const entry of answered) {
      if (entry.kind !== "number" || entry.componentAxis === null) continue;
      supplied.add(entry.componentAxis);
      if (!declared.has(entry.componentAxis)) {
        out.push({ code: "unknown_component_axis", severity: "error", ordinal: entry.ordinal });
      }
    }
    for (const axis of declared) {
      if (!supplied.has(axis)) {
        out.push({ code: "structured_component_missing", severity: "error", ordinal: null });
      }
    }
  }

  return out;
}
