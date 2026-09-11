/**
 * The perceptual hash of a GENERATED preview (#1015 W8), and the one distance
 * function in this domain that is a real metric.
 *
 * ## It takes a raster, not an encoded image, and that is a security decision
 *
 * Nothing here decodes a PNG or a JPEG. A perceptual hash of an encoded image is
 * a decoder away from a fingerprint, and an image decoder on creator-supplied
 * bytes is #1015 W12 threat 7 — a whole-application parser on hostile input —
 * sitting inside the API process rather than inside the inspection sandbox where
 * every other parser in this domain lives (ADR 0010 D12, `docs/digital-commerce.md`
 * §"What is NOT built yet").
 *
 * It does not need to. `ASSET_FILE_ROLES` distinguishes a creator's `preview`
 * from the `web_derivative` MERCARIA generates, and the signal kind is
 * `preview_phash` — *"a perceptual hash of a generated preview"*. The preview
 * generator already holds the raster it just rendered, so the hash is taken over
 * Mercaria's own output, which is both the safe input and the RIGHT one: a hash
 * over a turntable render is a hash of the model's appearance, where a hash over a
 * creator-supplied marketing JPEG is a hash of their photography.
 *
 * `hashEncodedPreview` exists so that a caller holding only bytes gets an explicit
 * `unsupported` rather than reaching for a decoder.
 *
 * ## The algorithm
 *
 * The standard DCT perceptual hash, stated so it can be reproduced:
 *
 * 1. Box-average the luma plane down to 32×32.
 * 2. Two-dimensional DCT-II over that.
 * 3. Keep the top-left 8×8 block of low-frequency coefficients, DISCARDING the
 *    DC term — 63 coefficients.
 * 4. Threshold each against the MEDIAN of those 63.
 * 5. Emit the 63 bits as a 16-character hex string (the most significant bit of
 *    the 64 is always zero).
 *
 * The median rather than the mean is the whole robustness argument: a median is
 * unmoved by a handful of extreme coefficients, so a brightness shift, a
 * re-encode, a rescale and mild compression leave most bits alone. The DC term is
 * dropped for the same reason — it IS the average brightness, so keeping it makes
 * the hash sensitive to exactly the transform it should ignore.
 */

/** The algorithm identifier carried in the value, for `fingerprint.ts`' reason. */
export const PREVIEW_PHASH_ALGORITHM = 'phash1';

/** The DCT is taken over this square. */
const PHASH_SAMPLE_SIZE = 32;

/**
 * How much alternating-current content a raster needs before its hash means
 * anything, as a fraction of the DC coefficient.
 *
 * The separable DCT over a 32×32 constant plane leaves residuals around 1e-11 of
 * the DC term — cosine summation rounding, nothing to do with the image. 1e-9 sits
 * two orders above that and many orders below any real image's lowest-frequency
 * content, so the bound separates "numerically flat" from "nearly featureless but
 * real" without being delicate.
 */
const PHASH_MIN_AC_SPREAD_RATIO = 1e-9;

/** The low-frequency block kept. 8×8 minus the DC term = 63 bits. */
const PHASH_BLOCK_SIZE = 8;

/** How many bits the hash actually carries. */
export const PREVIEW_PHASH_SIGNIFICANT_BITS = PHASH_BLOCK_SIZE * PHASH_BLOCK_SIZE - 1;

/**
 * The smallest raster that gets a hash.
 *
 * Below the DCT sample size there is nothing to downsample and the "hash" would be
 * an upsampling artefact shared by every small image. An icon is not a preview.
 */
export const PREVIEW_PHASH_MIN_DIMENSION = PHASH_SAMPLE_SIZE;

/**
 * The largest Hamming distance at which two previews are treated as the SAME
 * image for review purposes.
 *
 * Five of 63 bits. Under a uniform model the probability that two unrelated
 * 63-bit hashes fall within 5 is **8.3e-13** (the binomial tail
 * `Σ_{k≤5} C(63,k) / 2^63`), which is the number this threshold is chosen
 * against — and the reason it is 5 rather than the 8–10 the perceptual-hashing
 * literature commonly uses for "visually similar".
 *
 * The literature's threshold is tuned for RECALL on a photo corpus. This one is
 * tuned for PRECISION on a corpus of 3D turntable renders, which are the opposite
 * case: they are flat-lit, low-detail, mostly background, and they cluster —
 * real pHashes are NOT uniformly distributed, so the 8.3e-13 above is a floor on
 * the safety margin rather than the true collision rate. Widening to 10 would
 * multiply the uniform-model rate by ~10⁴ on a distribution already known to be
 * concentrated, and every extra collision is a review opened against a creator who
 * rendered a grey object on a white background.
 *
 * A preview match is the WEAKEST of the three signal strengths for the same
 * reason, and `sweep.ts` orders it last.
 */
export const PREVIEW_PHASH_MAX_REVIEW_DISTANCE = 5;

/** A greyscale raster, which is all this needs. */
export interface PreviewRaster {
  readonly width: number;
  readonly height: number;
  /** Row-major luma, `width * height` samples, 0–255. */
  readonly luma: ArrayLike<number>;
}

/** Why no preview hash was derived. */
export type PreviewHashRefusal =
  /** Fewer than {@link PREVIEW_PHASH_MIN_DIMENSION} pixels on a side. */
  | 'raster_too_small'
  /** `luma` is not `width * height` samples. */
  | 'raster_malformed'
  /** A flat image — every DCT coefficient equal, so every bit would be arbitrary. */
  | 'raster_degenerate'
  /** Encoded bytes were offered; this module does not decode. See the docblock. */
  | 'encoded_image_not_decoded_here';

export type PreviewHashResult =
  | { readonly status: 'derived'; readonly value: string }
  | { readonly status: 'unsupported'; readonly reason: PreviewHashRefusal };

/**
 * Hash the raster the preview generator produced.
 *
 * Returns the value as `phash1:<16 hex>`, the prefixed shape `fingerprint.ts`
 * explains: an algorithm change must produce a disjoint value space rather than
 * silently re-interpreting evidence nobody can delete.
 */
export function previewPerceptualHash(raster: PreviewRaster): PreviewHashResult {
  const { width, height, luma } = raster;
  if (!Number.isInteger(width) || !Number.isInteger(height) || luma.length !== width * height) {
    return { status: 'unsupported', reason: 'raster_malformed' };
  }
  if (width < PREVIEW_PHASH_MIN_DIMENSION || height < PREVIEW_PHASH_MIN_DIMENSION) {
    return { status: 'unsupported', reason: 'raster_too_small' };
  }

  const sample = boxDownsample(raster);
  const coefficients = dct2(sample, PHASH_SAMPLE_SIZE);

  const kept: number[] = [];
  for (let v = 0; v < PHASH_BLOCK_SIZE; v += 1) {
    for (let u = 0; u < PHASH_BLOCK_SIZE; u += 1) {
      if (u === 0 && v === 0) continue; // the DC term: average brightness
      kept.push(coefficients[v * PHASH_SAMPLE_SIZE + u]);
    }
  }

  const median = medianOf(kept);
  // A flat image (or a solid colour) has NO alternating-current content: every
  // coefficient but the DC term is zero in exact arithmetic, and in floating point
  // it is the DCT's own rounding noise at around 1e-11 of the DC magnitude. The
  // median then decides nothing and all 63 bits are an artefact, so a hash of a
  // blank render would be a fingerprint every blank render shares — the exact
  // shape of false positive this workstream is written to avoid.
  //
  // Tested against the DC term rather than against zero, because "is this
  // coefficient small" is meaningless without the image's own scale: the same
  // render at 4× the brightness has 4× the noise.
  const spread = Math.max(...kept) - Math.min(...kept);
  if (spread <= Math.abs(coefficients[0]) * PHASH_MIN_AC_SPREAD_RATIO) {
    return { status: 'unsupported', reason: 'raster_degenerate' };
  }

  let bits = 0n;
  for (let i = 0; i < kept.length; i += 1) {
    if (kept[i] > median) bits |= 1n << BigInt(i);
  }
  return { status: 'derived', value: `${PREVIEW_PHASH_ALGORITHM}:${bits.toString(16).padStart(16, '0')}` };
}

/**
 * The refusal a caller holding encoded bytes gets.
 *
 * A function rather than a comment, so that "we do not decode here" is something a
 * call site receives at runtime instead of something a reviewer has to know.
 */
export function hashEncodedPreview(): PreviewHashResult {
  return { status: 'unsupported', reason: 'encoded_image_not_decoded_here' };
}

/**
 * Hamming distance between two `phash1:` values, or `null` when they are not
 * comparable.
 *
 * `null` for a different algorithm prefix rather than a large distance, and that
 * is the important half: a distance of 63 reads as "very different images", where
 * the truth is "these two things are not on the same scale at all". A caller that
 * cannot tell those apart would quietly stop finding matches the day the algorithm
 * changed and would report it as everything being dissimilar.
 */
export function previewHashDistance(left: string, right: string): number | null {
  const a = parsePreviewHash(left);
  const b = parsePreviewHash(right);
  if (a === null || b === null) return null;
  let difference = a ^ b;
  let distance = 0;
  while (difference !== 0n) {
    difference &= difference - 1n;
    distance += 1;
  }
  return distance;
}

/**
 * Whether two previews are near-identical under
 * {@link PREVIEW_PHASH_MAX_REVIEW_DISTANCE}.
 *
 * `false` when the values are not comparable, because an unanswerable comparison
 * is not a match — the direction that opens no review.
 */
export function previewsAreNearIdentical(left: string, right: string): boolean {
  const distance = previewHashDistance(left, right);
  return distance !== null && distance <= PREVIEW_PHASH_MAX_REVIEW_DISTANCE;
}

function parsePreviewHash(value: string): bigint | null {
  const prefix = `${PREVIEW_PHASH_ALGORITHM}:`;
  if (!value.startsWith(prefix)) return null;
  const hex = value.slice(prefix.length);
  if (!/^[0-9a-f]{16}$/.test(hex)) return null;
  return BigInt(`0x${hex}`);
}

/**
 * Box-average down to 32×32.
 *
 * Area averaging rather than nearest-neighbour sampling: nearest-neighbour makes
 * the hash depend on which 1024 pixels happen to land on the sample grid, so the
 * same image at two resolutions hashes differently — which is precisely the
 * invariance a perceptual hash exists to provide.
 */
function boxDownsample(raster: PreviewRaster): Float64Array {
  const { width, height, luma } = raster;
  const out = new Float64Array(PHASH_SAMPLE_SIZE * PHASH_SAMPLE_SIZE);
  for (let y = 0; y < PHASH_SAMPLE_SIZE; y += 1) {
    const y0 = Math.floor((y * height) / PHASH_SAMPLE_SIZE);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / PHASH_SAMPLE_SIZE));
    for (let x = 0; x < PHASH_SAMPLE_SIZE; x += 1) {
      const x0 = Math.floor((x * width) / PHASH_SAMPLE_SIZE);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / PHASH_SAMPLE_SIZE));
      let total = 0;
      let samples = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          total += luma[sy * width + sx];
          samples += 1;
        }
      }
      out[y * PHASH_SAMPLE_SIZE + x] = total / samples;
    }
  }
  return out;
}

/** Separable two-dimensional DCT-II. */
function dct2(values: Float64Array, size: number): Float64Array {
  const cosine = new Float64Array(size * size);
  for (let k = 0; k < size; k += 1) {
    for (let n = 0; n < size; n += 1) {
      cosine[k * size + n] = Math.cos(((2 * n + 1) * k * Math.PI) / (2 * size));
    }
  }
  const rows = new Float64Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let k = 0; k < size; k += 1) {
      let sum = 0;
      for (let n = 0; n < size; n += 1) sum += values[y * size + n] * cosine[k * size + n];
      rows[y * size + k] = sum;
    }
  }
  const out = new Float64Array(size * size);
  for (let x = 0; x < size; x += 1) {
    for (let k = 0; k < size; k += 1) {
      let sum = 0;
      for (let n = 0; n < size; n += 1) sum += rows[n * size + x] * cosine[k * size + n];
      out[k * size + x] = sum;
    }
  }
  return out;
}

/** The median of a list, without mutating it. */
function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
