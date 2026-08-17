/**
 * The variant matrix: axes, the product of their values, and what the author
 * does to the rows afterwards (ADR 0007 D6).
 *
 * ## What is generated and what is stored
 *
 * Generating the Cartesian product is a CONVENIENCE for the author; it is not
 * what gets stored. D6 says matrices are sparse and nothing generates the full
 * product as rows, so a generated combination the author has not enabled is not
 * sent at all — {@link enabledVariantPayloads} is what leaves this module, and a
 * disabled row has no payload. That is how "impossible combinations can be
 * disabled" and "sparse matrices" are the same mechanism rather than two.
 *
 * ## Duplicate detection
 *
 * {@link axisDedupeKey} is a CLIENT-SIDE dedupe key and is deliberately NOT the
 * server's axis signature. The server hashes the normalized
 * `(attributeDefinitionId, normalizedValue)` pairs and the digest is what the
 * partial unique index refuses a second of; this is the same pairs, sorted and
 * joined, so it collides in exactly the same cases without pretending to
 * reproduce a hash. It is never sent — `DraftVariantPayload` has no signature
 * member to send it in — and the database stays the authority.
 *
 * The normalization is the shared one (`trim`, collapse runs of whitespace,
 * lowercase), and it is applied to the controlled value's own CANONICAL STRING
 * rather than to its id, because that is what the server hashes. Two variants
 * whose axes were entered in a different order produce the same key by
 * construction, which is what "regardless of display order" asks for.
 *
 * Nothing in this file names an axis. Which attributes may define variants is
 * `AuthoringField.variantCapable`, composed by the server.
 */

import type { AuthoringField, AuthoringSchema, CurrencyCode } from "@mercaria/shared-types";
import type { DraftVariantPayload } from "./api";
import {
  composeFieldPayload,
  type DraftFieldEntries,
  type DraftFieldEntry,
} from "./answers";
import { toMinorUnits } from "../money";

/** Every field this product type lets an author vary along. */
export function variantCapableFields(schema: AuthoringSchema): readonly AuthoringField[] {
  return schema.fields.filter(
    (field) => field.variantCapable && field.requirement !== "forbidden",
  );
}

/** One axis the author has switched on, with the values they chose along it. */
export interface MatrixAxis {
  readonly attributeKey: string;
  /** In display order. Each entry is one value of this axis. */
  readonly values: readonly DraftFieldEntry[];
}

/** One row of the matrix, as the author edits it. */
export interface VariantRow {
  /** Stable client-side row identity. Never sent; the server keys on position. */
  readonly key: string;
  /** One entry per axis, keyed by the axis's stable attribute key. */
  readonly axes: DraftFieldEntries;
  /**
   * Whether this combination is actually sold. A disabled row is kept on screen
   * — so the author can see what they excluded — and is not sent.
   */
  readonly enabled: boolean;
  readonly sku: string;
  readonly barcode: string;
  readonly priceMajor: string;
  readonly compareAtMajor: string;
  readonly currency: CurrencyCode;
  readonly inventoryTracked: boolean;
  readonly inventoryAvailable: string;
  readonly selectedCanonicalVariantId: string | null;
}

/** The bound on how many rows a product may generate at once. */
export const MAX_MATRIX_ROWS = 200;

/* -------------------------------------------------------------------------- */
/* Normalization and dedupe                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The shared axis-value normalization: trim, collapse whitespace runs, fold
 * case. Restated here because the dashboard cannot import the backend; the
 * spelling is the one thing that has to match, so it is one line with the
 * server's own comment on it.
 */
function normalizeAxisValue(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}

/** Every controlled value's canonical STRING, by id, across the whole schema. */
export function controlledValueStrings(schema: AuthoringSchema): ReadonlyMap<string, string> {
  const byId = new Map<string, string>();
  for (const field of schema.fields) {
    for (const controlled of field.controlledValues) byId.set(controlled.id, controlled.value);
  }
  return byId;
}

/** The normalized string one axis entry contributes to the dedupe key. */
function normalizedEntryValue(
  entry: DraftFieldEntry,
  valueStringById: ReadonlyMap<string, string>,
): string {
  switch (entry.kind) {
    case "controlled_value":
      return normalizeAxisValue(valueStringById.get(entry.enumValueId) ?? entry.enumValueId);
    case "canonical_reference":
      return normalizeAxisValue(entry.refId);
    case "text":
      return normalizeAxisValue(entry.text);
    case "number":
      return normalizeAxisValue(entry.raw);
    case "boolean":
      return entry.value ? "true" : "false";
    default:
      return "";
  }
}

/**
 * The order-independent key two variants collide on.
 *
 * Sorted by attribute DEFINITION id — the same thing the server sorts by — so
 * the key does not depend on which axis the author switched on first. A row
 * with no axes gets the empty key, which is correct and is why two axis-less
 * rows are reported as duplicates: two variants that vary along nothing are one
 * variant, and the server refuses the second at its partial unique.
 */
export function axisDedupeKey(
  axes: DraftFieldEntries,
  fieldsByKey: ReadonlyMap<string, AuthoringField>,
  valueStringById: ReadonlyMap<string, string>,
): string {
  const pairs: string[] = [];
  for (const [key, entries] of Object.entries(axes)) {
    const field = fieldsByKey.get(key);
    if (field === undefined) continue;
    for (const entry of entries) {
      const value = normalizedEntryValue(entry, valueStringById);
      if (value.length === 0) continue;
      pairs.push(`${field.attributeDefinitionId}=${value}`);
    }
  }
  pairs.sort();
  return pairs.join("|");
}

/**
 * The row keys that duplicate an EARLIER enabled row.
 *
 * Only enabled rows are compared, because a disabled row is not sent and cannot
 * collide with anything. The first occurrence is not reported — the author has
 * to be told which row to remove, and reporting both leaves them choosing.
 */
export function duplicateRowKeys(
  rows: readonly VariantRow[],
  fieldsByKey: ReadonlyMap<string, AuthoringField>,
  valueStringById: ReadonlyMap<string, string>,
): ReadonlySet<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const row of rows) {
    if (!row.enabled) continue;
    const key = axisDedupeKey(row.axes, fieldsByKey, valueStringById);
    if (seen.has(key)) duplicates.add(row.key);
    seen.add(key);
  }
  return duplicates;
}

/* -------------------------------------------------------------------------- */
/* Generation                                                                  */
/* -------------------------------------------------------------------------- */

let rowCounter = 0;

/** A fresh row key. Monotonic within a session; never sent anywhere. */
export function nextRowKey(): string {
  rowCounter += 1;
  return `row-${rowCounter}`;
}

/** A row with no axes — the shape a product with a single variant takes. */
export function singleVariantRow(currency: CurrencyCode): VariantRow {
  return {
    key: nextRowKey(),
    axes: {},
    enabled: true,
    sku: "",
    barcode: "",
    priceMajor: "",
    compareAtMajor: "",
    currency,
    inventoryTracked: true,
    inventoryAvailable: "0",
    selectedCanonicalVariantId: null,
  };
}

/**
 * The Cartesian product of the chosen axes, as rows.
 *
 * `existing` is consulted so regenerating after adding one value to one axis
 * keeps every price, SKU and stock level the author already typed: the row is
 * matched on its dedupe key, which is stable under a reorder of the axes. A
 * combination that already exists keeps its own key too, so React does not
 * remount the row somebody is typing in.
 *
 * The product is capped. Beyond the cap nothing is generated and the caller
 * reports it, because silently truncating produces a matrix that is missing
 * exactly the combinations nobody looked at.
 */
export function generateMatrix(
  axes: readonly MatrixAxis[],
  options: {
    readonly currency: CurrencyCode;
    readonly existing: readonly VariantRow[];
    readonly fieldsByKey: ReadonlyMap<string, AuthoringField>;
    readonly valueStringById: ReadonlyMap<string, string>;
  },
): { readonly rows: readonly VariantRow[]; readonly truncated: boolean } {
  const usable = axes.filter((axis) => axis.values.length > 0);
  if (usable.length === 0) {
    // Every axis switched off collapses to ONE row — a product sold in one
    // configuration. The first existing row's key, price, SKU and stock are
    // kept and only its axes are cleared: the author asked for the collapse by
    // pressing generate with no axes on, and re-minting the row would throw
    // away what they typed and remount the inputs they are looking at.
    const [first] = options.existing;
    const collapsed =
      first === undefined ? singleVariantRow(options.currency) : { ...first, axes: {}, enabled: true };
    return { rows: [collapsed], truncated: false };
  }

  let total = 1;
  for (const axis of usable) total *= axis.values.length;
  if (total > MAX_MATRIX_ROWS) return { rows: options.existing, truncated: true };

  const byKey = new Map<string, VariantRow>();
  for (const row of options.existing) {
    byKey.set(axisDedupeKey(row.axes, options.fieldsByKey, options.valueStringById), row);
  }

  let combinations: DraftFieldEntries[] = [{}];
  for (const axis of usable) {
    const next: DraftFieldEntries[] = [];
    for (const partial of combinations) {
      for (const value of axis.values) {
        next.push({ ...partial, [axis.attributeKey]: [{ ...value, ordinal: 0 }] });
      }
    }
    combinations = next;
  }

  const rows = combinations.map((axesForRow) => {
    const key = axisDedupeKey(axesForRow, options.fieldsByKey, options.valueStringById);
    const previous = byKey.get(key);
    if (previous !== undefined) return { ...previous, axes: axesForRow };
    return { ...singleVariantRow(options.currency), axes: axesForRow };
  });
  return { rows, truncated: false };
}

/* -------------------------------------------------------------------------- */
/* Rows -> payload                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The variants a save sends: the ENABLED rows, in order, with their axes.
 *
 * A price that is not a readable amount is sent as ABSENT rather than as zero,
 * so the server answers `price_missing` and the author is told. Zero is a real
 * price somebody could mean, and turning an unreadable box into one is how a
 * product goes on sale for nothing.
 */
export function enabledVariantPayloads(
  rows: readonly VariantRow[],
  fieldsByKey: ReadonlyMap<string, AuthoringField>,
): readonly DraftVariantPayload[] {
  const payloads: DraftVariantPayload[] = [];
  for (const row of rows) {
    if (!row.enabled) continue;
    const axes = [];
    for (const [key, entries] of Object.entries(row.axes)) {
      const field = fieldsByKey.get(key);
      if (field === undefined) continue;
      const payload = composeFieldPayload(field, entries);
      if (payload.values.length === 0) continue;
      axes.push(payload);
    }
    const price = toMinorUnits(row.priceMajor, row.currency);
    const compareAt = toMinorUnits(row.compareAtMajor, row.currency);
    const available = Number.parseInt(row.inventoryAvailable.trim(), 10);
    payloads.push({
      ...(row.sku.trim().length === 0 ? {} : { sku: row.sku.trim() }),
      ...(row.barcode.trim().length === 0 ? {} : { barcode: row.barcode.trim() }),
      ...(price === null ? {} : { price: { amount: price, currency: row.currency } }),
      ...(compareAt === null
        ? {}
        : { compareAtPrice: { amount: compareAt, currency: row.currency } }),
      inventoryTracked: row.inventoryTracked,
      inventoryAvailable: Number.isFinite(available) && available > 0 ? available : 0,
      axes,
      selectedCanonicalVariantId: row.selectedCanonicalVariantId,
    });
  }
  return payloads;
}
