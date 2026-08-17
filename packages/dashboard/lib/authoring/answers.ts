/**
 * Form state for one field, and the ONE place it becomes a draft answer.
 *
 * ## Why every payload is built here and nowhere else
 *
 * ADR 0007 D1's invariant is that identity is an id or a stable machine key and
 * a label is presentation. The way a client breaks it is not a decision anybody
 * makes: it is one screen that has a controlled value's display string to hand
 * and sends that instead of the `enumValueId` beside it. So the composition is
 * a single function taking the SCHEMA's own `AuthoringField`, and the entry
 * union below has no member that carries a label at all — the canonical
 * reference entry keeps a display name for rendering, and
 * {@link composeFieldPayload} has no property to put it in.
 *
 * `packages/dashboard`'s scanned gate (`validate-authoring-schema-driven.mjs`)
 * fails the build if any other module in this app builds an object literal with
 * an `attributeKey` or an `enumValueId` in it, which is what makes "one place"
 * a property of the tree rather than a convention.
 *
 * ## Nothing here knows a category
 *
 * There is no attribute key, no product-type key and no controlled value in
 * this file. Every branch is taken on the schema's own closed vocabularies —
 * `valueType`, `cardinality`, `valuePolicy` — which the server composes and
 * `@mercaria/shared-types` types.
 */

import type {
  AttributeComponentAxis,
  AuthoringCanonicalRefKind,
  AuthoringDraftValue,
  AuthoringField,
  AuthoringValueKind,
  ProductTypeRuleScalar,
  ProductTypeRuleValues,
} from "@mercaria/shared-types";
import type { DraftAnswerPayload, DraftFieldPayload } from "./api";

/**
 * One thing an author has entered, before it is an answer.
 *
 * A STRING discriminant per storage kind, so an entry that is two things at
 * once has no shape. `number` keeps the RAW text rather than a parsed number:
 * an author mid-typing has `"1."` in the box, and parsing eagerly would either
 * discard the keystroke or store `1`.
 */
export type DraftFieldEntry =
  | { readonly kind: "text"; readonly ordinal: number; readonly text: string }
  | {
      readonly kind: "number";
      readonly ordinal: number;
      readonly componentAxis: AttributeComponentAxis | null;
      readonly raw: string;
      readonly unit: string | null;
    }
  | { readonly kind: "boolean"; readonly ordinal: number; readonly value: boolean }
  | { readonly kind: "controlled_value"; readonly ordinal: number; readonly enumValueId: string }
  | {
      readonly kind: "canonical_reference";
      readonly ordinal: number;
      readonly refKind: AuthoringCanonicalRefKind;
      readonly refId: string;
      /** Presentation only. It has nowhere to go in a payload, by construction. */
      readonly refName: string;
    };

/** Every entry an author has made, keyed by the field's stable machine key. */
export type DraftFieldEntries = Readonly<Record<string, readonly DraftFieldEntry[]>>;

/* -------------------------------------------------------------------------- */
/* The schema's own rules, read rather than assumed                            */
/* -------------------------------------------------------------------------- */

/**
 * The value kind an attribute's declared type requires.
 *
 * The same total mapping the server states in `validation.ts`, and it is stated
 * rather than inferred for the same reason: a `date` is stored as TEXT (an ISO
 * 8601 string, so it round-trips without a timezone anybody has to guess) and a
 * `money` is stored as a NUMBER of minor units, with the currency coming from
 * the attribute's own column rather than from the answer.
 */
export function expectedEntryKind(field: AuthoringField): AuthoringValueKind {
  if (field.valuePolicy === "canonical_reference") return "canonical_reference";
  switch (field.validation.valueType) {
    case "boolean":
      return "boolean";
    case "integer":
    case "decimal":
    case "money":
    case "measurement":
    case "structured":
      return "number";
    case "enum":
      return "controlled_value";
    case "string":
    case "date":
      return "text";
    default:
      return "text";
  }
}

/** How many answers one cardinality admits. `null` means unbounded. */
export function maxEntriesFor(field: AuthoringField): number | null {
  switch (field.validation.cardinality) {
    case "single":
      return 1;
    case "range":
      // A range is exactly two magnitudes, a low and a high. A third would be a
      // range with no meaning rather than a longer one.
      return 2;
    case "set":
    case "ordered_list":
      return null;
    default:
      return null;
  }
}

/**
 * Whether a field admits more than one entry the author adds by hand.
 *
 * A `structured` field is excluded even though it carries several answers: its
 * entries are its declared AXES and are created from the declaration, never by
 * an author pressing "add another".
 */
export function isRepeatable(field: AuthoringField): boolean {
  if (field.validation.valueType === "structured") return false;
  const max = maxEntriesFor(field);
  return max === null || max > 1;
}

/**
 * A fresh, empty entry for one field at one ordinal.
 *
 * The unit is seeded from the attribute's `baseUnit` for a MEASUREMENT and is
 * editable. That is a presentation default the author sees and can change, not
 * an imputation: the server refuses a magnitude with no unit outright
 * (`unknown_unit`), precisely so nothing invents what somebody meant, and a
 * pre-filled box the author is looking at is a different act from a server
 * filling one in behind them.
 */
export function emptyEntry(
  field: AuthoringField,
  ordinal: number,
  componentAxis: AttributeComponentAxis | null = null,
): DraftFieldEntry {
  switch (expectedEntryKind(field)) {
    case "boolean":
      return { kind: "boolean", ordinal, value: false };
    case "number":
      return {
        kind: "number",
        ordinal,
        componentAxis,
        raw: "",
        unit: field.validation.unitFamily === null ? null : field.validation.baseUnit,
      };
    case "controlled_value":
      return { kind: "controlled_value", ordinal, enumValueId: "" };
    case "canonical_reference":
      return { kind: "canonical_reference", ordinal, refKind: "brand", refId: "", refName: "" };
    default:
      return { kind: "text", ordinal, text: "" };
  }
}

/**
 * The entries a field starts life with.
 *
 * A `structured` attribute gets one entry per DECLARED axis, in the
 * declaration's order, because `structured_component_missing` is reported for
 * every axis the draft does not answer — an author should be looking at the
 * three boxes rather than discovering them from three errors.
 */
export function initialEntries(field: AuthoringField): readonly DraftFieldEntry[] {
  if (field.validation.valueType === "structured") {
    return field.validation.componentAxes.map((axis, index) => emptyEntry(field, index, axis));
  }
  return [emptyEntry(field, 0)];
}

/* -------------------------------------------------------------------------- */
/* Entry -> payload                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A number an author has finished typing, or `null`.
 *
 * `Number('')` is 0 and `Number(' ')` is 0, both of which would turn an empty
 * box into a real answer of zero — which is a value somebody would then have to
 * notice and delete. Anything that is not a finite number is `null` and the
 * entry is dropped; the inline check reports it so the author is told rather
 * than having the entry vanish.
 */
export function parseEntryNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/**
 * One entry as the answer it is, or `null` when it carries nothing.
 *
 * Dropping an empty entry is what makes "clear a field" expressible: the patch
 * sends `values: []` for that key and the server clears it. An entry that is
 * present but unreadable (a half-typed number) is also dropped, and the inline
 * check is what tells the author — silently sending it would fail the whole
 * save on one box.
 */
function toAnswer(entry: DraftFieldEntry): DraftAnswerPayload | null {
  switch (entry.kind) {
    case "text": {
      const text = entry.text.trim();
      return text.length === 0 ? null : { ordinal: entry.ordinal, text };
    }
    case "number": {
      const value = parseEntryNumber(entry.raw);
      if (value === null) return null;
      return {
        ordinal: entry.ordinal,
        number: value,
        ...(entry.componentAxis === null ? {} : { componentAxis: entry.componentAxis }),
        ...(entry.unit === null || entry.unit.trim().length === 0
          ? {}
          : { unit: entry.unit.trim() }),
      };
    }
    case "boolean":
      return { ordinal: entry.ordinal, boolean: entry.value };
    case "controlled_value":
      return entry.enumValueId.length === 0
        ? null
        : { ordinal: entry.ordinal, enumValueId: entry.enumValueId };
    case "canonical_reference":
      return entry.refId.length === 0
        ? null
        : { ordinal: entry.ordinal, canonicalRef: { kind: entry.refKind, id: entry.refId } };
    default:
      return null;
  }
}

/**
 * The payload for one field — the ONLY function in this app that builds one.
 *
 * `attributeKey` is `field.key`, read off the composed schema. There is no
 * parameter a caller could pass a typed-in name through, and no branch that
 * reads a label.
 */
export function composeFieldPayload(
  field: AuthoringField,
  entries: readonly DraftFieldEntry[],
): DraftFieldPayload {
  const values: DraftAnswerPayload[] = [];
  for (const entry of entries) {
    const answer = toAnswer(entry);
    if (answer !== null) values.push(answer);
  }
  return { attributeKey: field.key, values };
}

/** Whether a field has any answer at all — what "completed" reads. */
export function hasAnswer(entries: readonly DraftFieldEntry[] | undefined): boolean {
  if (entries === undefined) return false;
  return entries.some((entry) => toAnswer(entry) !== null);
}

/* -------------------------------------------------------------------------- */
/* Draft -> entries (hydration)                                                */
/* -------------------------------------------------------------------------- */

/** One stored value back into the entry an author edits. */
function toEntry(value: AuthoringDraftValue): DraftFieldEntry | null {
  switch (value.kind) {
    case "text":
      return value.text === null ? null : { kind: "text", ordinal: value.ordinal, text: value.text };
    case "number":
      return value.number === null
        ? null
        : {
            kind: "number",
            ordinal: value.ordinal,
            componentAxis: value.componentAxis,
            raw: String(value.number),
            unit: value.unit,
          };
    case "boolean":
      return value.boolean === null
        ? null
        : { kind: "boolean", ordinal: value.ordinal, value: value.boolean };
    case "controlled_value":
      return value.enumValueId === null
        ? null
        : { kind: "controlled_value", ordinal: value.ordinal, enumValueId: value.enumValueId };
    case "canonical_reference":
      return value.canonicalRefId === null || value.canonicalRefKind === null
        ? null
        : {
            kind: "canonical_reference",
            ordinal: value.ordinal,
            refKind: value.canonicalRefKind,
            refId: value.canonicalRefId,
            // The stored answer is an id; the NAME is fetched for display and is
            // absent until it is. Rendering the id would be showing somebody a
            // uuid and calling it a brand.
            refName: "",
          };
    default:
      return null;
  }
}

/**
 * Hydrate the entries for one scope of a draft.
 *
 * `draftVariantId` is `null` for the product scope and the variant's id for an
 * axis. Entries come back sorted by ordinal, because ordinal is what an
 * `ordered_list` MEANS and the wire order is not guaranteed to carry it.
 */
export function hydrateEntries(
  values: readonly AuthoringDraftValue[],
  draftVariantId: string | null,
): DraftFieldEntries {
  const byKey = new Map<string, DraftFieldEntry[]>();
  for (const value of values) {
    if (value.draftVariantId !== draftVariantId) continue;
    const entry = toEntry(value);
    if (entry === null) continue;
    const bucket = byKey.get(value.attributeKey) ?? [];
    bucket.push(entry);
    byKey.set(value.attributeKey, bucket);
  }
  const out: Record<string, readonly DraftFieldEntry[]> = {};
  for (const [key, bucket] of byKey) {
    out[key] = [...bucket].sort((left, right) => left.ordinal - right.ordinal);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Entries -> the values a visibility rule reads                               */
/* -------------------------------------------------------------------------- */

/** The comparable scalar of one entry, or `null` where there is not one. */
function scalarOf(entry: DraftFieldEntry): ProductTypeRuleScalar | null {
  switch (entry.kind) {
    case "text": {
      const text = entry.text.trim();
      return text.length === 0 ? null : text;
    }
    case "number":
      return parseEntryNumber(entry.raw);
    case "boolean":
      return entry.value;
    case "controlled_value":
      return entry.enumValueId.length === 0 ? null : entry.enumValueId;
    case "canonical_reference":
      return entry.refId.length === 0 ? null : entry.refId;
    default:
      return null;
  }
}

/**
 * The answers a visibility rule is evaluated against, keyed by attribute key.
 *
 * Keyed by KEY and not by field id, because that is what a rule names, and it
 * maps the SCALAR a rule can compare rather than a row. A multi-valued answer
 * becomes an array, which is what `includes_any` reads; anything the
 * interpreter cannot compare is left absent, which it reads as `unknown` rather
 * than as a failed comparison.
 */
export function ruleValuesFor(entries: DraftFieldEntries): ProductTypeRuleValues {
  const out: Record<string, ProductTypeRuleScalar | readonly ProductTypeRuleScalar[]> = {};
  for (const [key, bucket] of Object.entries(entries)) {
    const scalars: ProductTypeRuleScalar[] = [];
    for (const entry of bucket) {
      const scalar = scalarOf(entry);
      if (scalar !== null) scalars.push(scalar);
    }
    if (scalars.length === 0) continue;
    const first = scalars[0];
    out[key] = scalars.length === 1 && first !== undefined ? first : scalars;
  }
  return out;
}
