/**
 * OBJ — a line-oriented text mesh that names its material library and nothing
 * else (#1015 W4 requirements 2 and 3).
 *
 * ## Faces are polygons, and the triangle count says which convention was used
 *
 * An OBJ face may have any number of corners. This module fan-triangulates —
 * `cornerCount − 2` triangles per face, the corners taken as
 * `(c0, ci, ci+1)` — and that IS the triangle count reported. A quad mesh of
 * 1 000 faces therefore measures 2 000 triangles, which is what every importer
 * will also say, and is the number that is comparable with the STL beside it in
 * the same package. Reporting the face count instead would make `triangleCount`
 * mean two different things depending on which file it came from.
 *
 * Fan triangulation is only correct for a CONVEX face; a concave quad fans into
 * two triangles that overlap rather than tile. It is still the right count, and
 * the bounding box is unaffected (it is the union of corners either way), but it
 * is the reason `watertight` from an OBJ is a statement about the fanned soup and
 * not about the creator's polygons. Stated rather than left to be discovered.
 *
 * ## Indices are validated, because an index is an offset into our memory
 *
 * OBJ indices are 1-based and may be NEGATIVE, meaning relative to the end of the
 * list so far. Both are resolved here, and an index that lands outside the
 * vertices declared BEFORE the face is `corrupt` with its line number — not
 * clamped, not skipped. A parser that clamped would read a real coordinate from
 * the wrong vertex and report a bounding box for a mesh nobody uploaded.
 *
 * ## What OBJ cannot carry
 *
 * No skeleton and no animation: `hasRig: false` and `animationCount: 0` are
 * measured facts, for `stl.ts`'s reason. A UV channel it CAN carry, so
 * `hasUvMapping` is measured from the faces — from whether a corner actually
 * references a `vt`, not merely from whether the file declares one, because an
 * exporter that wrote texture coordinates no face uses has produced a mesh with no
 * UV mapping.
 */

import {
  MAX_REPORTED_TRIANGLES,
  MAX_REPORTED_VERTICES,
  MAX_RESOURCE_REFERENCES,
  MAX_TEXT_DOCUMENT_BYTES,
} from './limits.js';
import { censusHaltOutcome, startMeshCensus } from './mesh.js';
import { corruptFile, measured, refusedTooLarge, type InspectionOutcome } from './result.js';
import { resolveResourceReference } from './resources.js';
import { UNITLESS_MESH_SCALE_TO_MM } from './stl.js';
import type { InspectionBudget } from './budget.js';

/** Inspect an OBJ against the names the version contains. */
export function inspectObj(
  bytes: Uint8Array,
  options: {
    readonly budget: InspectionBudget;
    /** {@link resourceIndexOf} over the version's file names. */
    readonly availableResources: ReadonlySet<string>;
  },
): InspectionOutcome {
  if (bytes.length > MAX_TEXT_DOCUMENT_BYTES) {
    return refusedTooLarge(
      `${bytes.length} bytes of text, above the ${MAX_TEXT_DOCUMENT_BYTES}-byte ceiling`,
    );
  }
  const { budget, availableResources } = options;
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);

  const census = startMeshCensus({
    budget,
    scaleToMm: UNITLESS_MESH_SCALE_TO_MM,
    maxTriangles: MAX_REPORTED_TRIANGLES,
  });

  /** Declared positions, flat: `[x0, y0, z0, x1, …]`. Bounded by the text ceiling. */
  const positions: number[] = [];
  let declaredUvs = 0;
  let objectCount = 0;
  let faceCount = 0;
  let anyFaceUsesUv = false;
  let lineNumber = 0;
  const missing: string[] = [];
  const seenReferences = new Set<string>();
  let referenceCount = 0;

  for (const rawLine of text.split('\n')) {
    lineNumber += 1;
    if (budget.expiredOnStride(lineNumber)) {
      return refusedTooLarge('the inspection time budget was exhausted before the mesh was read');
    }
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const spaceAt = line.search(/\s/u);
    const keyword = spaceAt === -1 ? line : line.slice(0, spaceAt);
    const rest = spaceAt === -1 ? '' : line.slice(spaceAt + 1).trim();

    if (keyword === 'v') {
      if (positions.length / 3 >= MAX_REPORTED_VERTICES) {
        return refusedTooLarge(
          `more than ${MAX_REPORTED_VERTICES} vertices, above the inspection ceiling`,
        );
      }
      const parts = rest.split(/\s+/u);
      if (parts.length < 3) return corruptFile(`line ${lineNumber}: a vertex needs three numbers`);
      for (let axis = 0; axis < 3; axis += 1) {
        const value = Number(parts[axis]);
        if (!Number.isFinite(value)) {
          return corruptFile(`line ${lineNumber}: '${parts[axis]}' is not a finite coordinate`);
        }
        positions.push(value);
      }
      continue;
    }

    if (keyword === 'vt') {
      declaredUvs += 1;
      continue;
    }

    if (keyword === 'o') {
      objectCount += 1;
      continue;
    }

    if (keyword === 'mtllib' || keyword === 'maplib') {
      // One directive may name several libraries, space-separated.
      for (const token of rest.split(/\s+/u)) {
        if (referenceCount >= MAX_RESOURCE_REFERENCES) break;
        referenceCount += 1;
        const resolution = resolveResourceReference(token, availableResources);
        if (!resolution || resolution.present) continue;
        if (seenReferences.has(resolution.reference)) continue;
        seenReferences.add(resolution.reference);
        missing.push(resolution.reference);
      }
      continue;
    }

    if (keyword === 'f') {
      const corners = rest.split(/\s+/u).filter((token) => token !== '');
      if (corners.length < 3) {
        return corruptFile(`line ${lineNumber}: a face needs at least three corners`);
      }
      const resolved: number[] = [];
      for (const corner of corners) {
        const fields = corner.split('/');
        const positionIndex = resolveIndex(fields[0], positions.length / 3);
        if (positionIndex === null) {
          return corruptFile(
            `line ${lineNumber}: face corner '${corner}' names vertex ${fields[0]}, which is not declared`,
          );
        }
        if (fields.length > 1 && fields[1] !== '') anyFaceUsesUv = true;
        resolved.push(positionIndex);
      }
      faceCount += 1;
      for (let corner = 1; corner + 1 < resolved.length; corner += 1) {
        const a = resolved[0] * 3;
        const b = resolved[corner] * 3;
        const c = resolved[corner + 1] * 3;
        const halt = census.add(
          positions[a], positions[a + 1], positions[a + 2],
          positions[b], positions[b + 1], positions[b + 2],
          positions[c], positions[c + 1], positions[c + 2],
        );
        if (halt) return censusHaltOutcome(halt, MAX_REPORTED_TRIANGLES);
      }
      continue;
    }

    // Every other OBJ directive — `vn`, `g`, `s`, `usemtl`, the free-form curve
    // and surface family — carries nothing this pipeline measures. They are
    // SKIPPED rather than refused: OBJ's vocabulary is long, extended in practice,
    // and a `corrupt` verdict for an unrecognized-but-legal directive would be a
    // false accusation. The format was already established from the bytes by
    // `sniff.ts`; this loop's job is measurement, not validation of the grammar.
  }

  const summary = census.finish();
  return measured({
    ...summary,
    // `v` lines can exceed what any face references; the census's welded count is
    // the figure a viewer reports, so prefer it and fall back to the declared
    // positions only when the census abandoned its map.
    vertexCount: summary.vertexCount ?? positions.length / 3,
    meshCount: objectCount > 0 ? objectCount : faceCount > 0 ? 1 : 0,
    // A UV channel nothing references is not UV mapping. `declaredUvs` is read so
    // that a file with `vt` lines and no faces at all still answers `false` rather
    // than claiming a mapping it cannot demonstrate.
    hasUvMapping: anyFaceUsesUv && declaredUvs > 0,
    hasRig: false,
    animationCount: 0,
    missingResources: missing,
  });
}

/**
 * An OBJ index, resolved against the vertices declared SO FAR.
 *
 * 1-based positive, or negative-relative-to-the-end. `null` for anything that
 * does not land inside the declared list, including `0` (which OBJ does not
 * define) and a non-integer.
 *
 * "So far" is the correct scope and is the subtle half: a negative index is
 * relative to the list AT THAT LINE, so the same `-1` means different vertices in
 * different places, and a parser that resolved indices after reading the whole
 * file would silently mis-resolve every one of them.
 */
function resolveIndex(field: string | undefined, declared: number): number | null {
  if (field === undefined || field === '') return null;
  const raw = Number(field);
  if (!Number.isInteger(raw) || raw === 0) return null;
  const zeroBased = raw > 0 ? raw - 1 : declared + raw;
  if (zeroBased < 0 || zeroBased >= declared) return null;
  return zeroBased;
}
