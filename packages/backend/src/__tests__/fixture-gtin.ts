/**
 * Per-file GTINs for fixtures, collision-free by construction (#594).
 *
 * ## Why a barcode is not a label
 *
 * Every realdb fixture already namespaces its `name`, `slug` and
 * `normalizedName` with a per-module `RUN` token, so everything a human reads
 * is unique per file. The GTIN was left a bare literal — and a GTIN is the one
 * field that is not a label. `product_identifiers_canonical_active_key` is
 *
 *     unique (canonical_scheme, canonical_value) where status = 'active'
 *
 * with **no product, variant or file scoping**: ONE active canonical owner per
 * GTIN across the entire database. So two files minting "different" products
 * under one barcode resolve to one canonical identity in the shared test
 * database, and their offers then collide on
 * `offers_active_commercial_key (variant, merchant, storefront, condition)`.
 *
 * Namespacing cannot cover a global identifier. This is the same shape as
 * `match_policy_versions_active_key` — which #63 already had to give an
 * advisory-lock mutex — applied to barcodes, which nobody had noticed.
 *
 * The failure is non-deterministic, green in isolation and never the same file
 * twice, because it needs two files to overlap in time and the runner decides
 * that.
 *
 * ## What this returns
 *
 * A **valid** GTIN-13 — the check digit is real, because the matcher's
 * identifier stage verifies it and an invalid barcode is silently not an
 * identifier at all, which would make a fixture stop exercising the path it
 * was written for.
 *
 * Layout of the 12-digit body: `2` + 8 digits of the run token's hash + 3
 * digits of sequence. The leading `2` is GS1 restricted circulation, which is
 * what test data should be. The residual collision probability is a birthday
 * over 10^8 — about 2e-6 for twenty concurrent files — rather than zero, and
 * that is worth stating: this makes collision improbable by construction where
 * a shared literal made it certain.
 */

/** Sequence is 3 digits, so a single file may mint a thousand. */
const MAX_SEQUENCE = 999;

/**
 * The GTIN-13 check digit for a 12-digit body.
 *
 * Exported so its test can verify it against REAL barcodes already in this
 * repository — a generator whose check digit is wrong produces values the
 * matcher discards, which looks like a fixture that stopped matching rather
 * than like a broken helper.
 */
export function gtinCheckDigit(body: string): number {
  if (!/^[0-9]{12}$/u.test(body)) throw new Error(`not a 12-digit GTIN body: ${body}`);
  let sum = 0;
  for (let i = 0; i < 12; i += 1) {
    // Weights alternate 1,3 from the LEFT for a 12-digit body.
    sum += Number(body[i]) * (i % 2 === 0 ? 1 : 3);
  }
  return (10 - (sum % 10)) % 10;
}

/** FNV-1a, so two run tokens differing in one character land far apart. */
function hash32(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * The 12-digit BODY, for callers that append their own check digit.
 *
 * Several fixtures own a local `ean13(payload)` that pads to twelve and
 * appends the digit itself, so they need the body rather than a finished GTIN
 * — handing those a complete 13-digit value yields a fourteen-character string
 * that is not an identifier at all, and the symptom is a matcher answering
 * `review_required` rather than anything mentioning barcodes. Measured, on the
 * first version of this change.
 *
 * @param runToken the caller's own per-module token — the `RUN` every realdb
 *   fixture already computes as `uuidv7().slice(-12)`. Passing a CONSTANT here
 *   defeats the whole point, which is why there is no default.
 * @param sequence distinguishes several GTINs within one file.
 */
export function fixtureGtinBody(runToken: string, sequence: number): string {
  if (runToken === '') throw new Error('fixtureGtinBody needs a non-empty run token');
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > MAX_SEQUENCE) {
    throw new Error(`fixtureGtin sequence must be an integer in 0..${MAX_SEQUENCE}, got ${sequence}`);
  }
  const run = `${hash32(runToken) % 100_000_000}`.padStart(8, '0');
  const seq = `${sequence}`.padStart(3, '0');
  return `2${run}${seq}`;
}

/** A complete, check-digit-valid GTIN-13 owned by one file's run. */
export function fixtureGtin(runToken: string, sequence: number): string {
  const body = fixtureGtinBody(runToken, sequence);
  return `${body}${gtinCheckDigit(body)}`;
}
