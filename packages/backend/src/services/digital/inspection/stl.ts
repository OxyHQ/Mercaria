/**
 * STL, both dialects, and the arithmetic that tells them apart (#1015 W4).
 *
 * ## The format's one verifiable claim, and why it is checked in both directions
 *
 * A binary STL is 80 bytes of free-form header, a `uint32le` triangle count, and
 * exactly fifty bytes per triangle. So the file's own length corroborates its own
 * header: `84 + 50 × count`. That makes STL the one format here where a declared
 * count can be VERIFIED rather than trusted, and the check runs in the dangerous
 * direction first — a count that needs more bytes than the file has is a lie, and
 * a parser that believed it would read past the buffer or allocate from it. The
 * other direction (fewer bytes needed than the file has) is trailing junk, which
 * real exporters emit, and is accepted: the triangles are all there.
 *
 * `sniff.ts` uses the exact equality to CHOOSE the dialect, because the word
 * `solid` at the front of a binary STL's header has been a false positive for
 * thirty years. This module re-derives it rather than trusting the sniff, so the
 * parser is correct when called directly — which is how its tests call it.
 *
 * ## What STL cannot carry, stated as `false` rather than as NULL
 *
 * There is no UV channel, no skeleton and no animation track anywhere in the
 * format. So `hasUvMapping: false`, `hasRig: false` and `animationCount: 0` are
 * MEASURED facts about any STL, not absences — and recording them as NULL would
 * throw away a true statement and make a product page say "unknown" about
 * something the format settles. This is the distinction ADR 0010 D12 keeps the
 * columns nullable for, used in the direction people forget: `0` is an answer.
 *
 * ## Units
 *
 * STL carries no unit. See {@link UNITLESS_MESH_SCALE_TO_MM}.
 */

import { MAX_REPORTED_TRIANGLES, MAX_TEXT_DOCUMENT_BYTES } from './limits.js';
import { censusHaltOutcome, startMeshCensus, type MeshSummary } from './mesh.js';
import { corruptFile, measured, refusedTooLarge, type InspectionOutcome } from './result.js';
import type { InspectionBudget } from './budget.js';

/**
 * The unit assumed for a format that declares none — millimetres, scale 1.
 *
 * STL and OBJ are both unitless. Every consumer-3D tooling chain treats them as
 * millimetres: slicers import them that way, printers are specified that way, and
 * the marketplace's own launch vertical is printable models. So the scale is 1 and
 * the assumption is NAMED here rather than spelled as a literal in two parsers.
 *
 * The rejected alternative was to report no bounding box at all for a unitless
 * format, which is the purist reading of "bounding box in millimetres". It was
 * rejected because a marketplace for printable models whose size never displays
 * is not a marketplace for printable models — and because the assumption is
 * recoverable: `PROCESSOR_VERSION` is part of the inspection row's identity, so a
 * later version that reads units differently writes a NEW row beside this one
 * instead of quietly restating it.
 */
export const UNITLESS_MESH_SCALE_TO_MM = 1;

/** Where a binary STL's triangle count sits, and what one triangle costs. */
const BINARY_STL_HEADER_BYTES = 84;
const BINARY_STL_TRIANGLE_BYTES = 50;
/** Twelve bytes of normal precede the three vertices of a binary facet. */
const BINARY_STL_NORMAL_BYTES = 12;

/** Whether `length` is exactly what a binary STL declaring `count` triangles occupies. */
export function binaryStlLengthMatches(declaredTriangles: number, length: number): boolean {
  return BINARY_STL_HEADER_BYTES + declaredTriangles * BINARY_STL_TRIANGLE_BYTES === length;
}

/** How much of the front of a file decides "is this text at all". */
const STL_BINARY_PROBE_BYTES = 1024;

/**
 * Whether the file is binary: a NUL anywhere in the probe window.
 *
 * An ASCII STL is text and has none. A binary one is NUL-padded in its 80-byte
 * header and NUL-rich in its float data. This is the test that keeps a binary file
 * OUT of the ASCII reader when the length formula does not match — without it, a
 * binary STL with a lying header decodes as one enormous line beginning `solid`,
 * the ASCII reader finds no `facet` in it, and the file is reported as a MEASURED
 * mesh of zero triangles. A plausible zero is the worst available answer, and it is
 * the one the naive fallback produces.
 */
function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, STL_BINARY_PROBE_BYTES);
  for (let index = 0; index < limit; index += 1) {
    if (bytes[index] === 0) return true;
  }
  return false;
}

/**
 * Inspect an STL, choosing the dialect from the bytes.
 *
 * Three outcomes from the length arithmetic, and the middle one is the subtle one:
 *
 * - `84 + 50 x declared === length` — a binary STL, exactly.
 * - `84 + 50 x declared < length` with a positive count — a binary STL with
 *   trailing bytes, which real exporters emit. The declared triangles are all
 *   present, so they are measured.
 * - `84 + 50 x declared > length` — the header declares more than the file holds.
 *   A lie, refused as `corrupt`, named with both numbers. A parser that believed it
 *   would read past its buffer.
 *
 * A declared count of ZERO in a file with a body is also refused: `84 <= length` is
 * satisfied by every binary file, so accepting it would turn any mislabelled binary
 * into a measured empty mesh.
 */
export function inspectStl(
  bytes: Uint8Array,
  options: { readonly budget: InspectionBudget },
): InspectionOutcome {
  if (bytes.length >= BINARY_STL_HEADER_BYTES) {
    const declared = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
      80,
      true,
    );
    const needed = BINARY_STL_HEADER_BYTES + declared * BINARY_STL_TRIANGLE_BYTES;
    if (needed === bytes.length) {
      return inspectBinaryStl(bytes, declared, options.budget);
    }
    if (looksBinary(bytes)) {
      if (declared > 0 && needed < bytes.length) {
        return inspectBinaryStl(bytes, declared, options.budget);
      }
      return corruptFile(
        `the header declares ${declared} triangle(s), which needs ${needed} bytes; the file ` +
          `holds ${bytes.length}`,
      );
    }
  }
  return inspectAsciiStl(bytes, options.budget);
}

/**
 * The binary reader. `declaredTriangles` has already been corroborated by the
 * file length, so the loop's bound is a verified number rather than a claim.
 */
function inspectBinaryStl(
  bytes: Uint8Array,
  declaredTriangles: number,
  budget: InspectionBudget,
): InspectionOutcome {
  if (declaredTriangles > MAX_REPORTED_TRIANGLES) {
    return refusedTooLarge(
      `the header declares ${declaredTriangles} triangles, above the ${MAX_REPORTED_TRIANGLES} ceiling`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const census = startMeshCensus({
    budget,
    scaleToMm: UNITLESS_MESH_SCALE_TO_MM,
    maxTriangles: MAX_REPORTED_TRIANGLES,
  });

  for (let index = 0; index < declaredTriangles; index += 1) {
    const base =
      BINARY_STL_HEADER_BYTES + index * BINARY_STL_TRIANGLE_BYTES + BINARY_STL_NORMAL_BYTES;
    const halt = census.add(
      view.getFloat32(base, true),
      view.getFloat32(base + 4, true),
      view.getFloat32(base + 8, true),
      view.getFloat32(base + 12, true),
      view.getFloat32(base + 16, true),
      view.getFloat32(base + 20, true),
      view.getFloat32(base + 24, true),
      view.getFloat32(base + 28, true),
      view.getFloat32(base + 32, true),
    );
    if (halt) return censusHaltOutcome(halt, MAX_REPORTED_TRIANGLES);
  }

  // One binary STL is one unnamed solid. `0` meshes for an empty one, which is a
  // measured zero and the honest reading of a header declaring no triangles.
  return stlMeasurement(census.finish(), declaredTriangles === 0 ? 0 : 1);
}

/**
 * The ASCII reader — a state machine over `facet … endfacet` blocks.
 *
 * Strict about the block structure rather than scanning for `vertex` lines
 * anywhere, because the lenient version cannot tell a three-cornered facet from a
 * four-cornered one and would silently triangulate a file no exporter wrote. A
 * facet that does not hold exactly three vertices is `corrupt`, named with its
 * line number.
 */
function inspectAsciiStl(bytes: Uint8Array, budget: InspectionBudget): InspectionOutcome {
  if (bytes.length > MAX_TEXT_DOCUMENT_BYTES) {
    return refusedTooLarge(
      `${bytes.length} bytes of text, above the ${MAX_TEXT_DOCUMENT_BYTES}-byte ceiling`,
    );
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const census = startMeshCensus({
    budget,
    scaleToMm: UNITLESS_MESH_SCALE_TO_MM,
    maxTriangles: MAX_REPORTED_TRIANGLES,
  });

  let solidCount = 0;
  let inFacet = false;
  let corners: number[] = [];
  let lineNumber = 0;
  let sawAnyKeyword = false;

  for (const rawLine of text.split('\n')) {
    lineNumber += 1;
    if (budget.expiredOnStride(lineNumber)) {
      return refusedTooLarge('the inspection time budget was exhausted before the mesh was read');
    }
    const line = rawLine.trim();
    if (line === '') continue;

    if (/^solid\b/iu.test(line)) {
      solidCount += 1;
      sawAnyKeyword = true;
      continue;
    }
    if (/^endsolid\b/iu.test(line)) {
      sawAnyKeyword = true;
      continue;
    }
    if (/^facet\b/iu.test(line)) {
      inFacet = true;
      corners = [];
      sawAnyKeyword = true;
      continue;
    }
    if (/^(outer\s+loop|endloop)\b/iu.test(line)) continue;
    if (/^endfacet\b/iu.test(line)) {
      if (!inFacet) return corruptFile(`line ${lineNumber}: endfacet with no facet`);
      if (corners.length !== 9) {
        return corruptFile(
          `line ${lineNumber}: a facet with ${corners.length / 3} vertices; STL facets are triangles`,
        );
      }
      const halt = census.add(
        corners[0], corners[1], corners[2],
        corners[3], corners[4], corners[5],
        corners[6], corners[7], corners[8],
      );
      if (halt) return censusHaltOutcome(halt, MAX_REPORTED_TRIANGLES);
      inFacet = false;
      corners = [];
      continue;
    }
    if (/^vertex\b/iu.test(line)) {
      if (!inFacet) return corruptFile(`line ${lineNumber}: vertex outside a facet`);
      const parts = line.split(/\s+/u);
      if (parts.length < 4) return corruptFile(`line ${lineNumber}: a vertex needs three numbers`);
      // Bounded: three corners per facet and the block is closed by `endfacet`, so
      // `corners` cannot grow past nine without the length check above firing.
      if (corners.length >= 9) {
        return corruptFile(`line ${lineNumber}: more than three vertices in one facet`);
      }
      for (let axis = 1; axis <= 3; axis += 1) {
        const value = Number(parts[axis]);
        if (!Number.isFinite(value)) {
          return corruptFile(`line ${lineNumber}: '${parts[axis]}' is not a finite coordinate`);
        }
        corners.push(value);
      }
      continue;
    }
    return corruptFile(`line ${lineNumber}: '${line.split(/\s+/u)[0]}' is not an STL keyword`);
  }

  if (!sawAnyKeyword) return corruptFile('no STL keyword anywhere in the file');
  if (inFacet) return corruptFile('the file ends inside an unterminated facet');
  return stlMeasurement(census.finish(), solidCount);
}

/**
 * Turn a census into the STL measurement, adding the three facts the FORMAT
 * settles and the empty resource set.
 *
 * `missingResources: []` rather than absent: an STL references nothing, so zero
 * missing resources is measured rather than unknown, and the column holds `0`.
 */
function stlMeasurement(summary: MeshSummary, meshCount: number): InspectionOutcome {
  return measured({
    ...summary,
    meshCount,
    hasUvMapping: false,
    hasRig: false,
    animationCount: 0,
    missingResources: [],
  });
}
