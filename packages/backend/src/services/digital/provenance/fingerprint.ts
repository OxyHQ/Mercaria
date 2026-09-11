/**
 * Deriving the provenance fingerprints of one file — PURE functions over bytes
 * (#1015 W8, ADR 0010's `asset_provenance_signals`).
 *
 * ## What a fingerprint is here, and what it is NOT
 *
 * `ASSET_PROVENANCE_SIGNAL_KINDS`' own docblock is the contract this module
 * implements: *"Each is EVIDENCE and none is proof of ownership."* So nothing in
 * this file returns a verdict, a confidence, a probability or a `duplicateOf`.
 * There is nothing here to accuse anybody with, which is structural rather than
 * polite: the table holds no verdict column, the read (`findMatchingProvenanceSignals`)
 * returns a list of versions, and the derivation returns a string.
 *
 * ## Pure, on purpose
 *
 * No database, no clock, no configuration, no storage. The inputs are bytes and
 * the output is a string, which is what lets `__tests__/fingerprint.test.ts` drive
 * the identical-bytes case, the reordered re-export, the translated-and-scaled
 * re-export and — the control — two genuinely different meshes, rather than
 * illustrating one of them. `version-coverage.ts` is the precedent in this same
 * directory and was written pure for the same reason.
 *
 * ## The three kinds this module derives, and the two it does not
 *
 * Derived here: `content_hash`, `geometry_fingerprint`, `preview_phash`.
 * NOT derived here, and not derivable by any machine: `creator_declaration` and
 * `prior_publication`. Those are things a PERSON asserts, and `appeal.ts` is what
 * records them. The split is not cosmetic — `sweep.ts` matches only on the three
 * machine-derived kinds, so a creator's own words can never manufacture a match
 * against somebody else.
 *
 * ## Why the tolerance lives in the FINGERPRINT rather than in the comparison
 *
 * The obvious design for near-duplicate detection is a locality-sensitive hash
 * compared by distance: store a digest, then ask for everything within `d` of it.
 * It does not work against this table and could not be made to without a schema
 * change this workstream does not own:
 *
 * - `asset_provenance_signals` is indexed `(kind, value)` and the only read is an
 *   EQUALITY read. There is no range operator over a `text` digest and there is no
 *   `pg_trgm`-shaped metric that means anything on a cryptographic hash.
 * - A SHA-256 digest has no usable metric at all: one bit of input changes half the
 *   output bits, so Hamming distance over it is noise.
 *
 * So the tolerance is moved INTO the value: the geometry fingerprint normalises
 * and QUANTISES before hashing, so a re-export that reorders, re-containers,
 * translates or rescales the mesh lands on the same string and is found by the
 * equality read the table already supports. The threshold is then the quantisation
 * step, a stated bound rather than a tuned number.
 *
 * **What that buys and what it costs is written out in full** at
 * {@link GEOMETRY_FINGERPRINT_QUANTISATION_DIVISOR}, including the arithmetic that
 * shows it CANNOT survive a re-quantisation of every coordinate on a large mesh and
 * why no choice of grid would change that. Read it before concluding the sweep
 * finds re-exports in general: it finds a specific, named family of them, and the
 * family it misses needs a distance-capable index this workstream does not own.
 * The direction of every failure is a missed match, never a fabricated one, which
 * is the only direction #1015 W8 permits to be wrong.
 */

import { createHash } from 'node:crypto';
import { readVertexPositions } from './mesh-vertices.js';

/* -------------------------------------------------------------------------- */
/* Content hash — the exact-duplicate detector, and nothing more               */
/* -------------------------------------------------------------------------- */

/**
 * SHA-256 of the stored bytes, lowercase hex.
 *
 * Deliberately the SAME algorithm and the same spelling as
 * `asset_files.content_hash`, because the sweep compares one against the other: a
 * second convention here (uppercase, base64, a prefix) would make every exact
 * duplicate invisible while every test of this function passed.
 *
 * What it detects is one thing — byte-identical files — and what it cannot detect
 * is the case the rest of this module exists for: the same mesh re-exported, where
 * a single differing float in a header changes the digest completely.
 */
export function contentHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/* -------------------------------------------------------------------------- */
/* Geometry fingerprint                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The algorithm identifier carried in every geometry fingerprint value.
 *
 * It is a PREFIX on the scalar rather than a column, and it is load-bearing: a
 * value derived by a future algorithm must never compare equal to one derived by
 * this algorithm, because the table is append-only and the two generations
 * coexist in it forever. With the prefix, changing the algorithm produces a
 * disjoint value space and the worst case is that old and new uploads stop
 * matching each other — a loss of recall. Without it, an algorithm change
 * FABRICATES and ERASES matches at the same time, across evidence nobody can
 * delete.
 *
 * This does not make the column a property bag (`asset_provenance_signals.value`
 * forbids that): nothing parses the prefix out. It is compared for equality as
 * part of the whole string, exactly as the digest is.
 */
export const GEOMETRY_FINGERPRINT_ALGORITHM = 'gfp1';

/**
 * The quantisation grid, as a divisor of the normalisation radius — **the near
 * threshold, stated as a bound rather than tuned as a number**.
 *
 * After normalisation every coordinate is measured in units of the mesh's RMS
 * radius, so the grid step is `1 / 1024` of that radius.
 *
 * ## What the threshold GUARANTEES (soundness), and it is one direction only
 *
 * Two versions produce the same fingerprint only if, after normalisation, every
 * vertex of one falls in the same grid cell as a vertex of the other. So
 * **fingerprint equality implies per-coordinate agreement within one step of the
 * RMS radius** — ~0.1 % of the model's characteristic size. That is the stated
 * distance #1015 W8 asks for, and it is the half that matters: it bounds how
 * different two things can be and still be surfaced as a candidate. A 1 % shrink
 * compensation, a re-mesh, a decimation or a different sculpt is an order of
 * magnitude outside it and is NOT surfaced.
 *
 * ## What it does NOT guarantee (recall), stated because the arithmetic is brutal
 *
 * The converse fails, and it fails harder the bigger the mesh is. A digest over
 * `n` independently quantised coordinates survives a per-coordinate perturbation
 * of relative size `ε` with probability about `(1 - 2ε/g)^n`:
 *
 * | perturbation | ε | n = 180 | n = 3 000 | n = 30 000 |
 * |---|---|---|---|---|
 * | transform applied in double precision | 1e-15 | 1.00 | 1.00 | 1.00 |
 * | float32 round-trip (STL stores float32) | 1e-7 | 0.96 | 0.54 | **0.002** |
 * | exporter rewriting 3 decimals on a 100 mm model | 1e-5 | 0.02 | **1e-27** | **1e-270** |
 *
 * So this fingerprint reliably survives **reordering, duplicate-vertex differences
 * between formats, a format change, translation, uniform scaling and unit change**
 * — every transform that leaves the coordinates' ratios exact — and it does NOT
 * survive a RE-QUANTISATION of the coordinates themselves on a mesh of any real
 * size. Choosing a coarser grid does not rescue that: the failure probability is
 * linear in `n` and `n` is tens of thousands, so the grid would have to be coarse
 * enough to merge genuinely different models long before it were coarse enough to
 * survive a three-decimal rewrite.
 *
 * That is not a tuning problem, it is the primitive: **an equality-indexed digest
 * cannot be noise tolerant.** `asset_provenance_signals` is indexed `(kind, value)`
 * and the only read is an equality read, so a digest is the only thing that can be
 * retrieved. Closing the gap needs a distance-capable retrieval — an LSH banding
 * column, a `bit(64)` Hamming index or a vector index on the evidence table — and
 * that is a SCHEMA change, outside this workstream. It is recorded here, and in the
 * handoff, as the known limit rather than hidden behind a threshold that looks
 * tuned.
 *
 * The direction of the failure is the one #1015 W8 permits: a missed match, never
 * a fabricated one. A creator whose work was re-exported lossily is not accused of
 * nothing — they are simply not found by the sweep, and the ordinary abuse-report
 * path they could always use reaches the same jury.
 */
export const GEOMETRY_FINGERPRINT_QUANTISATION_DIVISOR = 1024;

/**
 * The smallest distinct-vertex count that gets a fingerprint at all.
 *
 * Below this the fingerprint is a false-positive generator rather than evidence:
 * a cube has 8 distinct vertices, a tetrahedron 4, a printer calibration cube 8,
 * and a low-segment cylinder a few dozen. Thousands of unrelated creators upload
 * all of them, and two identical cubes are not a re-upload — they are a cube.
 *
 * So a trivially small mesh is answered `too_few_distinct_vertices`, which reads
 * downstream as NO FINGERPRINT and therefore as no candidate. The alternative —
 * fingerprinting it anyway and letting a reviewer sort it out — puts a real
 * creator in front of a moderation queue because they uploaded a calibration
 * cube, and #1015 W8's first sentence is that a false positive here accuses a
 * real creator.
 *
 * 32 is above every platonic solid and every default primitive a slicer or an
 * engine emits, and far below any model somebody sells.
 */
export const GEOMETRY_FINGERPRINT_MIN_DISTINCT_VERTICES = 32;

/** Why a geometry fingerprint was not derived. */
export type GeometryFingerprintRefusal =
  /** No vertex reader for this format here — see `mesh-vertices.ts`. */
  | 'format_not_readable_here'
  | 'malformed_bytes'
  | 'non_finite_coordinate'
  | 'too_large'
  /** Fewer than {@link GEOMETRY_FINGERPRINT_MIN_DISTINCT_VERTICES} distinct points. */
  | 'too_few_distinct_vertices'
  /**
   * The RMS radius underflowed to zero, so there is no scale to normalise by.
   *
   * Not reachable by a mesh whose vertices merely coincide — deduplication turns
   * that into `too_few_distinct_vertices` first. What reaches it is a mesh whose
   * whole extent is denormal (every coordinate within ~1e-200 of the others),
   * where the sum of squares underflows. Kept as an explicit answer rather than
   * left to produce `Infinity` scale factors and a digest of `NaN` cells, which
   * would be a fingerprint every such file shared.
   */
  | 'degenerate_scale';

/** A fingerprint, or the reason there is none. */
export type GeometryFingerprintResult =
  | {
      readonly status: 'derived';
      readonly value: string;
      readonly distinctVertexCount: number;
    }
  | { readonly status: 'unsupported'; readonly reason: GeometryFingerprintRefusal };

/**
 * A normalised geometry fingerprint of one mesh file.
 *
 * Six steps, each chosen against a named alternative that breaks a case W8
 * requires:
 *
 * 1. **Read positions** in the file's own coordinates (`mesh-vertices.ts`).
 * 2. **Deduplicate exact positions.** Required for cross-format stability, not an
 *    optimisation: STL repeats every shared vertex once per incident triangle and
 *    OBJ does not, so the same mesh saved as both has a 6:1 difference in vertex
 *    COUNT and an identical vertex SET. The fingerprint is over the set.
 * 3. **Translate to the centroid of the distinct set.** The centroid of the
 *    distinct set, not the triangle-area-weighted centroid — the weighted one
 *    depends on the triangulation, which a re-export is free to change.
 * 4. **Scale by the RMS radius.** Not by the bounding-box diagonal: one stray
 *    vertex (a forgotten helper object, an exported light, a stray control point)
 *    moves the bounding box arbitrarily far and changes every quantised
 *    coordinate, whereas it moves the RMS radius by O(1/n). The bounding box was
 *    the first implementation and it is the one that makes the fingerprint fragile
 *    in exactly the way a re-export is likely to trigger.
 * 5. **Quantise** onto the grid above.
 * 6. **Sort lexicographically** and hash, length-prefixed.
 *
 * ## What is deliberately NOT normalised: rotation and mirroring
 *
 * A PCA/inertia-tensor alignment would make the fingerprint rotation-invariant,
 * and it is rejected. For a near-symmetric mesh — which is most printable models —
 * two of the principal axes have nearly equal eigenvalues, so their order and
 * their sign are decided by floating-point noise. That produces false NEGATIVES
 * for the re-export it was added to catch, and, far worse, COLLISIONS between
 * different meshes that happen to share an inertia tensor once each is rotated
 * into its own principal frame.
 *
 * So a rotated or mirrored re-export reads as no match. That is a missed
 * detection, it is stated here rather than discovered, and the remedy is the one
 * that already exists: a creator who sees their work re-uploaded files an ordinary
 * abuse report, which reaches the same jury by the same path. #1015 W8 asks for
 * conservatism in a named direction, and recall is the thing it is willing to give
 * up.
 */
export function geometryFingerprint(
  formatKey: string,
  bytes: Uint8Array,
): GeometryFingerprintResult {
  const read = readVertexPositions(formatKey, bytes);
  if (read.status === 'refused') {
    return { status: 'unsupported', reason: read.reason };
  }

  const distinct = distinctPositions(read.positions, read.count);
  if (distinct.length / 3 < GEOMETRY_FINGERPRINT_MIN_DISTINCT_VERTICES) {
    return { status: 'unsupported', reason: 'too_few_distinct_vertices' };
  }

  const count = distinct.length / 3;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < count; i += 1) {
    cx += distinct[i * 3];
    cy += distinct[i * 3 + 1];
    cz += distinct[i * 3 + 2];
  }
  cx /= count;
  cy /= count;
  cz /= count;

  let sumSquares = 0;
  for (let i = 0; i < count; i += 1) {
    const x = distinct[i * 3] - cx;
    const y = distinct[i * 3 + 1] - cy;
    const z = distinct[i * 3 + 2] - cz;
    sumSquares += x * x + y * y + z * z;
  }
  const rmsRadius = Math.sqrt(sumSquares / count);
  if (!(rmsRadius > 0) || !Number.isFinite(rmsRadius)) {
    return { status: 'unsupported', reason: 'degenerate_scale' };
  }

  const scale = GEOMETRY_FINGERPRINT_QUANTISATION_DIVISOR / rmsRadius;
  const cells: string[] = new Array(count);
  for (let i = 0; i < count; i += 1) {
    const x = Math.round((distinct[i * 3] - cx) * scale);
    const y = Math.round((distinct[i * 3 + 1] - cy) * scale);
    const z = Math.round((distinct[i * 3 + 2] - cz) * scale);
    // Fixed-width, sign-explicit fields. A bare `${x},${y},${z}` sorts "10"
    // before "9" and makes the ORDER depend on decimal length, which would make
    // the digest depend on the magnitude of the coordinates rather than on their
    // arrangement — two uniformly scaled copies would then sort differently and
    // hash differently, defeating step 4.
    cells[i] = `${pad(x)},${pad(y)},${pad(z)}`;
  }
  cells.sort();

  const digest = createHash('sha256');
  // Length-prefixed, so a truncated stream cannot hash as a shorter mesh.
  digest.update(`n=${String(count)}\n`);
  for (const cell of cells) digest.update(`${cell}\n`);

  return {
    status: 'derived',
    value: `${GEOMETRY_FINGERPRINT_ALGORITHM}:q${String(
      GEOMETRY_FINGERPRINT_QUANTISATION_DIVISOR,
    )}:${digest.digest('hex')}`,
    distinctVertexCount: count,
  };
}

/**
 * A signed integer as a fixed-width, order-preserving decimal string.
 *
 * Negatives are mapped by an OFFSET rather than printed with a minus sign,
 * because `'-'` (0x2D) sorts before every digit, so `-1` would sort before `-999`
 * and the ordering would not be the numeric one. A single non-negative field
 * sorts lexicographically exactly as it sorts numerically once it is zero-padded.
 */
const CELL_OFFSET = 1_000_000_000;
function pad(value: number): string {
  return String(value + CELL_OFFSET).padStart(11, '0');
}

/**
 * The distinct positions, by exact equality of all three coordinates.
 *
 * Exact equality and not a tolerance: a tolerance here would be a second,
 * undocumented quantisation interacting with the declared one, and which vertices
 * merged would depend on the order they were read in. The declared quantisation in
 * step 5 is the one place a tolerance lives.
 *
 * `-0` is folded to `0` (`+0` normalises it) so an exporter's sign-of-zero does
 * not split one point into two.
 */
function distinctPositions(positions: Float64Array, count: number): Float64Array {
  const seen = new Set<string>();
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const x = positions[i * 3] + 0;
    const y = positions[i * 3 + 1] + 0;
    const z = positions[i * 3 + 2] + 0;
    const key = `${String(x)}|${String(y)}|${String(z)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(x, y, z);
  }
  return Float64Array.from(out);
}
