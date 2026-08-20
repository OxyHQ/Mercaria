/**
 * Editing every sold combination at once (#367 step 10).
 *
 * ## SKU is a GENERATOR and barcode is an apply-to-all, deliberately
 *
 * The two look like one feature and are not, and getting it wrong is cheap and
 * damaging in the same motion.
 *
 * A SKU is the merchant's own code for ONE variant. Writing the same string
 * across every row defeats what a SKU is for, and the database will not stop it
 * — `product_variants.sku` is unique at NO grain, deliberately (#296: Shopify
 * enforces no SKU uniqueness at all, so a connector has to be able to import a
 * product whose two variants share one). "Mercaria can HOLD that" is a
 * statement about imported data; it is not a reason to make it one tap to
 * create. So {@link applySkuPrefix} produces a DISTINCT value per row and
 * there is no function here that could write one SKU across many.
 *
 * A barcode is the opposite case. It is a GTIN — an observation of a trade-item
 * identifier — and two rows legitimately sharing one is the premise the whole
 * canonical catalogue rests on. {@link applyBarcodeToAll} is therefore an
 * ordinary apply-to-all and is correct as one.
 *
 * ## The suffix is the POSITION, never the axis label
 *
 * `<prefix>-1`, `<prefix>-2`, in the order the rows are sent. The tempting
 * alternative is the axis values — `SHOE-RED`, which is what a merchant would
 * write by hand — and it is wrong here for a reason ADR 0007 D1 states
 * generally: those are LOCALIZED display strings. Generating from them would
 * make a merchant's own product codes depend on the language their dashboard
 * happened to be in, so the same variant becomes `SHOE-RED` for one colleague
 * and `SHOE-ROJO` for another. A position is stable and language-independent.
 *
 * ## Every function here skips a row that is not sold
 *
 * A disabled row has no payload (`enabledVariantPayloads`), so numbering it
 * would leave gaps in the sequence and writing to it would be work the author
 * cannot see. {@link setAllSold} is the exception and the reason is obvious: it
 * is the function whose whole subject is that flag.
 */

import type { VariantRow } from "./matrix";

/** The separator between an author's prefix and the row's position. */
const SKU_SEPARATOR = "-";

/**
 * Give every sold combination a distinct SKU built from one prefix.
 *
 * Returns the rows unchanged when the prefix is blank, so an empty box is a
 * no-op rather than a way to erase every SKU in the matrix — the author pressed
 * "apply", which is not the same as asking for a clear.
 */
export function applySkuPrefix(
  rows: readonly VariantRow[],
  prefix: string,
): readonly VariantRow[] {
  const trimmed = prefix.trim();
  if (trimmed.length === 0) return rows;

  let position = 0;
  return rows.map((row) => {
    if (!row.enabled) return row;
    position += 1;
    return { ...row, sku: `${trimmed}${SKU_SEPARATOR}${String(position)}` };
  });
}

/**
 * Give every sold combination the same barcode.
 *
 * Correct as an apply-to-all: a GTIN identifies a trade item and rows of one
 * product may legitimately share one. Blank is a no-op, for the reason above.
 */
export function applyBarcodeToAll(
  rows: readonly VariantRow[],
  barcode: string,
): readonly VariantRow[] {
  const trimmed = barcode.trim();
  if (trimmed.length === 0) return rows;
  return rows.map((row) => (row.enabled ? { ...row, barcode: trimmed } : row));
}

/**
 * Mark every combination sold, or none of them.
 *
 * Rows are KEPT either way — this is the bulk form of the `sold` switch, and
 * the whole point of that switch is that an excluded combination stays on
 * screen so the author can see what they excluded. Nothing here deletes a row.
 */
export function setAllSold(
  rows: readonly VariantRow[],
  sold: boolean,
): readonly VariantRow[] {
  return rows.map((row) => (row.enabled === sold ? row : { ...row, enabled: sold }));
}
