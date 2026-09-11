/**
 * Deterministic mesh and raster fixtures for the fingerprint tests.
 *
 * Deterministic and not random, because the claims under test are about EQUALITY
 * of digests: a fixture that differed between runs would make a failure
 * unreproducible, and the control case ("two genuinely different meshes must not
 * collide") would be asserting something slightly different every time.
 *
 * The generator is a plain 32-bit LCG rather than `Math.random`, so a seed names a
 * mesh forever and a failing case can be pasted into a bug.
 */

/** A 32-bit LCG in [0, 1). Numerical Recipes' constants. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** `count` distinct vertices on a unit-ish blob, as a flat `[x, y, z, …]` array. */
export function makeVertices(seed: number, count: number): number[] {
  const next = seededRandom(seed);
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    // Spread over a few units so the RMS radius is O(1) and no two vertices
    // coincide by accident — the dedupe step would silently shrink the set.
    out.push((next() - 0.5) * 8, (next() - 0.5) * 8, (next() - 0.5) * 8);
  }
  return out;
}

/**
 * Triangles as index triples, each vertex reused by several faces.
 *
 * Reuse is the point: STL writes a vertex once per incident face and OBJ writes it
 * once in total, so a fixture whose vertices were used by exactly one face each
 * would make the cross-format test pass without the deduplication step existing.
 */
export function makeTriangles(vertexCount: number): [number, number, number][] {
  const faces: [number, number, number][] = [];
  for (let i = 0; i + 2 < vertexCount; i += 1) {
    faces.push([i, i + 1, i + 2]);
  }
  return faces;
}

/** Binary STL, little-endian, float32 — the format's own precision. */
export function writeBinaryStl(
  vertices: readonly number[],
  faces: readonly [number, number, number][],
  headerText = 'mercaria test',
): Uint8Array {
  const bytes = new Uint8Array(84 + faces.length * 50);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < Math.min(headerText.length, 80); i += 1) {
    bytes[i] = headerText.charCodeAt(i);
  }
  view.setUint32(80, faces.length, true);
  faces.forEach((face, index) => {
    const base = 84 + index * 50;
    // The face normal is left as zeros. Nothing reads it, which is itself under
    // test: an implementation that folded normals into the digest would make the
    // same mesh with recomputed normals a different work.
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = face[corner];
      for (let axis = 0; axis < 3; axis += 1) {
        view.setFloat32(base + 12 + (corner * 3 + axis) * 4, vertices[vertex * 3 + axis], true);
      }
    }
  });
  return bytes;
}

/** ASCII STL. */
export function writeAsciiStl(
  vertices: readonly number[],
  faces: readonly [number, number, number][],
): Uint8Array {
  const lines = ['solid mercaria'];
  for (const face of faces) {
    lines.push('  facet normal 0 0 0', '    outer loop');
    for (const vertex of face) {
      lines.push(
        `      vertex ${String(vertices[vertex * 3])} ${String(vertices[vertex * 3 + 1])} ${String(
          vertices[vertex * 3 + 2],
        )}`,
      );
    }
    lines.push('    endloop', '  endfacet');
  }
  lines.push('endsolid mercaria', '');
  return new TextEncoder().encode(lines.join('\n'));
}

/** Wavefront OBJ, with normals and texture coordinates present as decoys. */
export function writeObj(
  vertices: readonly number[],
  faces: readonly [number, number, number][],
): Uint8Array {
  const lines = ['# mercaria test'];
  for (let i = 0; i < vertices.length / 3; i += 1) {
    lines.push(`v ${String(vertices[i * 3])} ${String(vertices[i * 3 + 1])} ${String(vertices[i * 3 + 2])}`);
  }
  // `vn` and `vt` must NOT be read as positions. They are here so that the test
  // population contains the thing a prefix test on `v` alone would eat.
  lines.push('vn 0 1 0', 'vt 0.25 0.75', 'vn 1 0 0');
  for (const face of faces) {
    lines.push(`f ${String(face[0] + 1)} ${String(face[1] + 1)} ${String(face[2] + 1)}`);
  }
  lines.push('');
  return new TextEncoder().encode(lines.join('\n'));
}

/** The float32 values an STL round-trip would store, as doubles. */
export function toFloat32(vertices: readonly number[]): number[] {
  return vertices.map((value) => Math.fround(value));
}

/** `v * scale + offset`, applied per coordinate. */
export function transform(
  vertices: readonly number[],
  scale: number,
  offset: readonly [number, number, number],
): number[] {
  return vertices.map((value, index) => value * scale + offset[index % 3]);
}

/**
 * Every coordinate nudged by a varying multiple of `epsilon`.
 *
 * The multiplier VARIES with the index on purpose: adding a constant to every
 * coordinate is a TRANSLATION, which the fingerprint removes by construction, so a
 * constant nudge would test nothing and would pass for the wrong reason.
 */
export function perturb(vertices: readonly number[], epsilon: number): number[] {
  return vertices.map((value, index) => value + epsilon * ((index % 7) - 3));
}

/** A deterministic greyscale raster. */
export function makeRaster(
  seed: number,
  width: number,
  height: number,
): { width: number; height: number; luma: Uint8Array } {
  const next = seededRandom(seed);
  const luma = new Uint8Array(width * height);
  // Smooth, low-frequency content plus a little noise — a turntable render is
  // mostly smooth, and a perceptual hash over pure noise has no structure for the
  // DCT to keep.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const smooth =
        128 +
        60 * Math.sin((x / width) * Math.PI * 2 + seed) +
        40 * Math.cos((y / height) * Math.PI * 3);
      luma[y * width + x] = Math.max(0, Math.min(255, Math.round(smooth + (next() - 0.5) * 6)));
    }
  }
  return { width, height, luma };
}

/** The same raster, brightened and clamped — a re-encode's most common change. */
export function brighten(
  raster: { width: number; height: number; luma: Uint8Array },
  delta: number,
): { width: number; height: number; luma: Uint8Array } {
  const luma = new Uint8Array(raster.luma.length);
  for (let i = 0; i < luma.length; i += 1) {
    luma[i] = Math.max(0, Math.min(255, raster.luma[i] + delta));
  }
  return { width: raster.width, height: raster.height, luma };
}

/** Nearest-neighbour upscale by an integer factor. */
export function upscale(
  raster: { width: number; height: number; luma: Uint8Array },
  factor: number,
): { width: number; height: number; luma: Uint8Array } {
  const width = raster.width * factor;
  const height = raster.height * factor;
  const luma = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      luma[y * width + x] = raster.luma[Math.floor(y / factor) * raster.width + Math.floor(x / factor)];
    }
  }
  return { width, height, luma };
}
