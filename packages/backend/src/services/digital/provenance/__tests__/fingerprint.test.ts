/**
 * The provenance fingerprints, driven over the cases that decide whether this
 * feature accuses innocent creators (#1015 W8).
 *
 * Every claim here is a claim about EQUALITY of a digest, which is why these
 * functions were written pure: the four cases #1015 W8 turns on can be stated as
 * four comparisons rather than illustrated with one.
 *
 *  1. identical bytes → one fingerprint, both kinds;
 *  2. the same mesh re-exported with a different vertex ORDER → one geometry
 *     fingerprint, DIFFERENT content hashes;
 *  3. the same mesh TRANSLATED and SCALED → one geometry fingerprint;
 *  4. two genuinely DIFFERENT meshes → different fingerprints. **The control.**
 *
 * Case 4 is what makes the first three mean anything: a `geometryFingerprint` that
 * returned a constant would pass 1, 2 and 3 and would open a moderation review
 * against every creator on the platform.
 *
 * The file also pins the STATED LIMIT of the tolerance in both directions — a
 * perturbation well inside the grid still matches, one outside it does not —
 * because `GEOMETRY_FINGERPRINT_QUANTISATION_DIVISOR`'s docblock makes a precise
 * claim and a claim nothing checks is a comment.
 */

import { describe, expect, it } from 'vitest';
import {
  GEOMETRY_FINGERPRINT_ALGORITHM,
  GEOMETRY_FINGERPRINT_MIN_DISTINCT_VERTICES,
  GEOMETRY_FINGERPRINT_QUANTISATION_DIVISOR,
  contentHash,
  geometryFingerprint,
} from '../fingerprint.js';
import { MAX_READABLE_VERTICES, readVertexPositions } from '../mesh-vertices.js';
import {
  PREVIEW_PHASH_ALGORITHM,
  PREVIEW_PHASH_MAX_REVIEW_DISTANCE,
  hashEncodedPreview,
  previewHashDistance,
  previewPerceptualHash,
  previewsAreNearIdentical,
} from '../preview-hash.js';
import {
  brighten,
  makeRaster,
  makeTriangles,
  makeVertices,
  perturb,
  toFloat32,
  transform,
  upscale,
  writeAsciiStl,
  writeBinaryStl,
  writeObj,
} from './mesh-fixtures.js';
import { assertEachOf } from '../../../../__tests__/assert-each-of.js';

/** A mesh big enough to clear the minimum, and small enough to stay fast. */
const VERTEX_COUNT = 120;
const VERTICES = toFloat32(makeVertices(20_260_911, VERTEX_COUNT));
const FACES = makeTriangles(VERTEX_COUNT);

/** A genuinely different mesh — a different seed, same size and same writer. */
const OTHER_VERTICES = toFloat32(makeVertices(777_001, VERTEX_COUNT));

/** The digest of a derived fingerprint, or a failure naming the refusal. */
function fingerprintOf(formatKey: string, bytes: Uint8Array): string {
  const result = geometryFingerprint(formatKey, bytes);
  if (result.status !== 'derived') {
    throw new Error(`expected a fingerprint, got unsupported:${result.reason}`);
  }
  return result.value;
}

/* -------------------------------------------------------------------------- */

describe('#1015 W8 — the content hash is an exact-duplicate detector and nothing more', () => {
  it('identical bytes hash identically, and the hash is lowercase hex sha256', () => {
    const stl = writeBinaryStl(VERTICES, FACES);
    const copy = writeBinaryStl(VERTICES, FACES);
    expect(contentHash(stl)).toBe(contentHash(copy));
    expect(contentHash(stl)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('one byte of difference changes it completely — which is why geometry exists', () => {
    const stl = writeBinaryStl(VERTICES, FACES);
    const rehoused = writeBinaryStl(VERTICES, FACES, 'exported by something else');
    // Same mesh, same coordinates, a different 80-byte header comment.
    expect(contentHash(rehoused)).not.toBe(contentHash(stl));
  });
});

/* -------------------------------------------------------------------------- */

describe('#1015 W8 case 1 — identical bytes', () => {
  it('both fingerprints agree', () => {
    const a = writeBinaryStl(VERTICES, FACES);
    const b = writeBinaryStl(VERTICES, FACES);
    expect(contentHash(a)).toBe(contentHash(b));
    expect(fingerprintOf('stl', a)).toBe(fingerprintOf('stl', b));
  });

  it('the value names its algorithm and its grid, so a future algorithm is disjoint', () => {
    const value = fingerprintOf('stl', writeBinaryStl(VERTICES, FACES));
    expect(value.startsWith(`${GEOMETRY_FINGERPRINT_ALGORITHM}:q`)).toBe(true);
    expect(value).toContain(`q${String(GEOMETRY_FINGERPRINT_QUANTISATION_DIVISOR)}:`);
    expect(value.split(':')[2]).toMatch(/^[0-9a-f]{64}$/);
  });
});

/* -------------------------------------------------------------------------- */

describe('#1015 W8 case 2 — the same mesh re-exported with a different vertex order', () => {
  /** The faces, shuffled, with each face's corners rotated. */
  const REORDERED = [...FACES]
    .map((face, index) => [face[(index + 1) % 3], face[(index + 2) % 3], face[index % 3]] as [number, number, number])
    .reverse();

  it('the geometry fingerprint is unchanged', () => {
    expect(fingerprintOf('stl', writeBinaryStl(VERTICES, REORDERED))).toBe(
      fingerprintOf('stl', writeBinaryStl(VERTICES, FACES)),
    );
  });

  it('and the content hash is NOT — the control for the claim above', () => {
    // If this were equal, the geometry test would be passing because the bytes
    // never changed, which is the way that assertion fails silently.
    expect(contentHash(writeBinaryStl(VERTICES, REORDERED))).not.toBe(
      contentHash(writeBinaryStl(VERTICES, FACES)),
    );
  });

  it('a format change survives it too — STL repeats shared vertices and OBJ does not', () => {
    const binary = fingerprintOf('stl', writeBinaryStl(VERTICES, FACES));
    const ascii = fingerprintOf('stl', writeAsciiStl(VERTICES, FACES));
    const obj = fingerprintOf('obj', writeObj(VERTICES, FACES));
    expect(ascii).toBe(binary);
    expect(obj).toBe(binary);
  });

  it('and the OBJ reader did not eat the `vn` and `vt` decoys', () => {
    // `writeObj` emits three of them. Reading them as positions would add three
    // vertices, and the digest is length-prefixed, so the assertion above would
    // already have failed — this states the mechanism directly.
    const read = readVertexPositions('obj', writeObj(VERTICES, FACES));
    expect(read.status).toBe('read');
    if (read.status === 'read') expect(read.count).toBe(VERTEX_COUNT);
  });
});

/* -------------------------------------------------------------------------- */

describe('#1015 W8 case 3 — the same mesh translated and scaled', () => {
  assertEachOf(
    [
      { label: 'a power-of-two scale and an exact offset', scale: 2, offset: [3.5, -1.25, 8] },
      { label: 'an awkward scale and offset', scale: 1.7, offset: [-11.3, 2.9, 0.125] },
      { label: 'a unit change, mm to m', scale: 0.001, offset: [0, 0, 0] },
      { label: 'translation only', scale: 1, offset: [100, 100, 100] },
    ] as const,
    4,
    ({ label, scale, offset }) => {
      it(`survives ${label}`, () => {
        const moved = transform(VERTICES, scale, offset as readonly [number, number, number]);
        // Written as OBJ TEXT at full precision, so the doubles round-trip exactly
        // and the transform is the only thing being tested. Re-writing it as
        // binary STL would re-quantise every coordinate to float32, which
        // `GEOMETRY_FINGERPRINT_QUANTISATION_DIVISOR`'s docblock states this
        // fingerprint does not survive — a different claim, pinned below.
        expect(fingerprintOf('obj', writeObj(moved, FACES))).toBe(
          fingerprintOf('obj', writeObj(VERTICES, FACES)),
        );
      });
    },
  );
});

/* -------------------------------------------------------------------------- */

describe('#1015 W8 case 4 — THE CONTROL: two different meshes must not collide', () => {
  it('different geometry gives a different fingerprint', () => {
    expect(fingerprintOf('obj', writeObj(OTHER_VERTICES, FACES))).not.toBe(
      fingerprintOf('obj', writeObj(VERTICES, FACES)),
    );
  });

  it('and a different mesh is not rescued by normalisation either', () => {
    // Normalisation removes translation and scale. It must not remove SHAPE: the
    // other mesh, moved and scaled onto the first one's centroid and radius, is
    // still a different mesh.
    const moved = transform(OTHER_VERTICES, 3.25, [4, 4, 4]);
    expect(fingerprintOf('obj', writeObj(moved, FACES))).not.toBe(
      fingerprintOf('obj', writeObj(VERTICES, FACES)),
    );
  });

  it('a DELETED vertex is a different mesh — the digest is length-prefixed', () => {
    const shorter = VERTICES.slice(0, VERTICES.length - 3);
    expect(fingerprintOf('obj', writeObj(shorter, makeTriangles(VERTEX_COUNT - 1)))).not.toBe(
      fingerprintOf('obj', writeObj(VERTICES, FACES)),
    );
  });
});

/* -------------------------------------------------------------------------- */

describe('#1015 W8 — the stated tolerance, pinned in both directions', () => {
  const STEP = 1 / GEOMETRY_FINGERPRINT_QUANTISATION_DIVISOR;

  it('a perturbation far INSIDE the grid step still matches', () => {
    // 1e-9 of a coordinate, six orders inside the ~1e-3 step. This is the
    // "transform applied in double precision" row of the docblock's table.
    const nudged = perturb(VERTICES, 1e-9);
    expect(fingerprintOf('obj', writeObj(nudged, FACES))).toBe(
      fingerprintOf('obj', writeObj(VERTICES, FACES)),
    );
  });

  it('a perturbation OUTSIDE it does not — the soundness bound', () => {
    // Four steps of the grid, applied with a varying sign so it is a shape change
    // rather than a translation the fingerprint removes by design.
    const nudged = perturb(VERTICES, STEP * 4);
    expect(fingerprintOf('obj', writeObj(nudged, FACES))).not.toBe(
      fingerprintOf('obj', writeObj(VERTICES, FACES)),
    );
  });
});

/* -------------------------------------------------------------------------- */

describe('#1015 W8 — where a fingerprint cannot be derived reliably, it says so', () => {
  assertEachOf(['glb', 'gltf', 'fbx', '3mf', 'blend', 'zip', 'png', 'jpeg', 'pdf'], 9, (format) => {
    it(`${format} is unsupported rather than weakly fingerprinted`, () => {
      const result = geometryFingerprint(format, writeBinaryStl(VERTICES, FACES));
      expect(result.status).toBe('unsupported');
    });
  });

  it('a trivially small mesh is refused rather than fingerprinted', () => {
    // A cube: eight distinct vertices, twelve faces, and thousands of unrelated
    // creators upload one. A fingerprint over it would match all of them.
    const cube = [
      0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
      0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1,
    ];
    const result = geometryFingerprint('obj', writeObj(cube, makeTriangles(8)));
    expect(result).toEqual({ status: 'unsupported', reason: 'too_few_distinct_vertices' });
  });

  it('the minimum is a count of DISTINCT vertices, not of written ones', () => {
    // One vertex, repeated far past the minimum. An implementation that counted
    // written vertices would fingerprint a single point.
    const repeated: number[] = [];
    for (let i = 0; i < GEOMETRY_FINGERPRINT_MIN_DISTINCT_VERTICES * 10; i += 1) {
      repeated.push(1, 2, 3);
    }
    expect(geometryFingerprint('obj', writeObj(repeated, makeTriangles(repeated.length / 3)))).toEqual(
      { status: 'unsupported', reason: 'too_few_distinct_vertices' },
    );
  });

  it('a denormal-extent mesh is refused rather than scaled by Infinity', () => {
    const denormal: number[] = [];
    for (let i = 0; i < GEOMETRY_FINGERPRINT_MIN_DISTINCT_VERTICES + 8; i += 1) {
      denormal.push(i * 1e-200, 0, 0);
    }
    expect(
      geometryFingerprint('obj', writeObj(denormal, makeTriangles(denormal.length / 3))),
    ).toEqual({ status: 'unsupported', reason: 'degenerate_scale' });
  });

  it('a non-finite coordinate is refused, never normalised', () => {
    const text = new TextEncoder().encode('v 1 2 3\nv nan 0 0\nv 4 5 6\n');
    expect(readVertexPositions('obj', text)).toEqual({
      status: 'refused',
      reason: 'non_finite_coordinate',
    });
  });

  it('bytes that are not the format they claim to be are refused', () => {
    expect(readVertexPositions('obj', new Uint8Array([0xff, 0xfe, 0x00, 0x01]))).toEqual({
      status: 'refused',
      reason: 'malformed_bytes',
    });
    // Valid UTF-8 with no `v` lines at all: parseable text, no mesh.
    expect(readVertexPositions('obj', new TextEncoder().encode('# nothing here\n'))).toEqual({
      status: 'refused',
      reason: 'malformed_bytes',
    });
  });

  it('the binary/ASCII STL decision is made on length arithmetic, not the `solid` token', () => {
    // A binary STL whose 80-byte header begins "solid", which real exporters
    // produce and which a token test reads as ASCII.
    const bytes = writeBinaryStl(VERTICES, FACES, 'solid exported by a real slicer');
    const read = readVertexPositions('stl', bytes);
    expect(read.status).toBe('read');
    if (read.status === 'read') expect(read.count).toBe(FACES.length * 3);
  });

  it('the in-process vertex ceiling is a real number, not unbounded', () => {
    expect(MAX_READABLE_VERTICES).toBeGreaterThan(100_000);
    expect(Number.isFinite(MAX_READABLE_VERTICES)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */

describe('#1015 W8 — the measured false-positive rate on this corpus', () => {
  /**
   * A corpus, so the control above is a measurement rather than one pair.
   *
   * One pair passing says the two seeds differ. A corpus of 150 meshes with 11 175
   * distinct pairs, none of which collides, is the claim the docblocks make — and
   * if the normalisation ever collapsed (a constant scale, a dropped axis, a
   * digest over the vertex COUNT alone), this is the assertion that reports it as
   * a number rather than as one unlucky pair.
   */
  const CORPUS_SIZE = 150;

  it('150 different meshes produce 150 different geometry fingerprints', () => {
    const seen = new Map<string, number>();
    for (let seed = 1; seed <= CORPUS_SIZE; seed += 1) {
      const vertices = makeVertices(seed * 104_729, VERTEX_COUNT);
      const value = fingerprintOf('obj', writeObj(vertices, FACES));
      const previous = seen.get(value);
      expect(previous, `seeds ${String(previous)} and ${String(seed)} collided`).toBeUndefined();
      seen.set(value, seed);
    }
    expect(seen.size).toBe(CORPUS_SIZE);
  });

  it('and every one of them matches its own reordered re-export', () => {
    // The recall half, over the same corpus: a fingerprint that were merely unique
    // — a hash of the file bytes, say — would pass the test above and fail this.
    const reordered = [...FACES].reverse();
    for (let seed = 1; seed <= CORPUS_SIZE; seed += 1) {
      const vertices = makeVertices(seed * 104_729, VERTEX_COUNT);
      expect(fingerprintOf('obj', writeObj(vertices, reordered))).toBe(
        fingerprintOf('obj', writeObj(vertices, FACES)),
      );
    }
  });

  it('60 different renders stay outside the preview review distance of each other', () => {
    const hashes: string[] = [];
    for (let seed = 1; seed <= 60; seed += 1) {
      const result = previewPerceptualHash(makeRaster(seed * 7_919, 128, 96));
      if (result.status !== 'derived') throw new Error(`no hash for seed ${String(seed)}`);
      hashes.push(result.value);
    }
    let closest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < hashes.length; i += 1) {
      for (let j = i + 1; j < hashes.length; j += 1) {
        const distance = previewHashDistance(hashes[i], hashes[j]);
        if (distance !== null && distance < closest) closest = distance;
      }
    }
    // 1 770 pairs. The assertion is on the CLOSEST of them, so a single pair
    // drifting inside the threshold fails rather than being averaged away.
    expect(closest).toBeGreaterThan(PREVIEW_PHASH_MAX_REVIEW_DISTANCE);
  });
});

/* -------------------------------------------------------------------------- */

describe('#1015 W8 — the preview perceptual hash', () => {
  const RASTER = makeRaster(42, 256, 192);

  it('identical rasters hash identically, at distance zero', () => {
    const a = previewPerceptualHash(RASTER);
    const b = previewPerceptualHash(makeRaster(42, 256, 192));
    expect(a.status).toBe('derived');
    if (a.status !== 'derived' || b.status !== 'derived') return;
    expect(a.value).toBe(b.value);
    expect(previewHashDistance(a.value, b.value)).toBe(0);
    expect(a.value.startsWith(`${PREVIEW_PHASH_ALGORITHM}:`)).toBe(true);
  });

  it('survives a brightness shift — the median threshold is what does that', () => {
    const original = previewPerceptualHash(RASTER);
    const brighter = previewPerceptualHash(brighten(RASTER, 18));
    if (original.status !== 'derived' || brighter.status !== 'derived') throw new Error('no hash');
    expect(previewHashDistance(original.value, brighter.value)).toBeLessThanOrEqual(
      PREVIEW_PHASH_MAX_REVIEW_DISTANCE,
    );
    expect(previewsAreNearIdentical(original.value, brighter.value)).toBe(true);
  });

  it('survives a rescale — box averaging is what does that', () => {
    const original = previewPerceptualHash(RASTER);
    const bigger = previewPerceptualHash(upscale(RASTER, 3));
    if (original.status !== 'derived' || bigger.status !== 'derived') throw new Error('no hash');
    expect(previewsAreNearIdentical(original.value, bigger.value)).toBe(true);
  });

  it('THE CONTROL: two different images are not near-identical', () => {
    const a = previewPerceptualHash(RASTER);
    const b = previewPerceptualHash(makeRaster(9_001, 256, 192));
    if (a.status !== 'derived' || b.status !== 'derived') throw new Error('no hash');
    expect(previewHashDistance(a.value, b.value)).toBeGreaterThan(
      PREVIEW_PHASH_MAX_REVIEW_DISTANCE,
    );
    expect(previewsAreNearIdentical(a.value, b.value)).toBe(false);
  });

  it('a flat render is refused rather than given a hash every flat render shares', () => {
    const flat = { width: 64, height: 64, luma: new Uint8Array(64 * 64).fill(200) };
    expect(previewPerceptualHash(flat)).toEqual({
      status: 'unsupported',
      reason: 'raster_degenerate',
    });
  });

  it('a raster smaller than the DCT sample, or malformed, is refused', () => {
    expect(previewPerceptualHash({ width: 16, height: 16, luma: new Uint8Array(256) })).toEqual({
      status: 'unsupported',
      reason: 'raster_too_small',
    });
    expect(previewPerceptualHash({ width: 64, height: 64, luma: new Uint8Array(10) })).toEqual({
      status: 'unsupported',
      reason: 'raster_malformed',
    });
  });

  it('encoded bytes are never decoded here', () => {
    expect(hashEncodedPreview()).toEqual({
      status: 'unsupported',
      reason: 'encoded_image_not_decoded_here',
    });
  });

  it('an incomparable pair answers `null`, not a large distance', () => {
    const derived = previewPerceptualHash(RASTER);
    if (derived.status !== 'derived') throw new Error('no hash');
    expect(previewHashDistance(derived.value, 'phash2:0000000000000000')).toBeNull();
    expect(previewHashDistance(derived.value, 'not a hash')).toBeNull();
    // And `null` must not be read as a match, which is the direction that opens a
    // review against somebody.
    expect(previewsAreNearIdentical(derived.value, 'phash2:0000000000000000')).toBe(false);
  });
});
