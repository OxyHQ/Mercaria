/**
 * The ONE geometry census — bounding box, welded vertex count and
 * watertightness — shared by every indexed-triangle format here.
 *
 * STL, OBJ and 3MF all reduce to the same thing: a stream of triangles with
 * explicit coordinates. Measuring each of them separately would be three chances
 * to disagree about what `watertight` means, and the one measurement in this
 * pipeline that a buyer might spend money on the strength of is exactly that one.
 * So the parsers differ only in how they GET to a triangle; from there the answer
 * comes from here.
 *
 * ## What `watertight` means, precisely
 *
 * The mesh is a CLOSED, ORIENTABLE 2-manifold at the welding tolerance below:
 * every undirected edge is used by exactly two triangles, and those two use it in
 * OPPOSITE directions. Both halves are checked and both are needed — a Möbius-like
 * surface satisfies the first and fails the second, and a slicer handed one
 * produces a solid nobody asked for.
 *
 * Three results, not two:
 *
 * - `true`  — the census ran to completion and every edge passed.
 * - `false` — the census ran to completion and an edge failed.
 * - absent  — the census did NOT run, or did not finish: above
 *   {@link MAX_WATERTIGHT_TRIANGLES}, out of time budget, or an empty soup.
 *
 * The third is the one #1015 W4's closing rule is about. A pipeline that reported
 * `false` for "did not check" would have every large model on the marketplace
 * labelled unprintable, and a reviewer reading the column could not tell which
 * ones had actually been measured.
 *
 * ## The welding tolerance, and the alternative that was rejected
 *
 * Corners are welded on a fixed grid of {@link VERTEX_WELD_EPSILON} in the FILE's
 * own coordinate units. Binary STL stores three unshared corners per facet, so
 * without welding no edge is ever shared and every mesh would read as open.
 *
 * The rejected alternative was a tolerance derived from the bounding box (weld at
 * `diagonal × 1e-6`), which is scale-invariant and is what a mesh library would
 * do. It needs the bounding box BEFORE the census, so it needs a second pass over
 * the largest input this pipeline accepts — and it changes the answer only for
 * meshes whose coordinates are orders of magnitude from unit scale, where the
 * float32 that STL and 3MF store cannot represent the difference the finer
 * tolerance would resolve. The fixed grid is stated here, the processor VERSION
 * carries it, and changing it writes a new inspection row beside the old one
 * rather than silently restating an old measurement as a new one.
 */

import { MAX_BOUNDING_BOX_MM, MAX_DEDUPLICATED_VERTEX_TRIANGLES, MAX_WATERTIGHT_TRIANGLES } from './limits.js';
import type { InspectionBudget } from './budget.js';
import { corruptFile, refusedTooLarge, type BoundingBoxMm, type InspectionOutcome } from './result.js';

/**
 * The vertex welding grid, in the file's own coordinate units — 1/10 000.
 *
 * For the millimetre-scale meshes this marketplace sells, that welds corners
 * within 0.1 µm, which is finer than any printer and coarser than the float32
 * rounding an exporter introduces when it writes the same logical corner twice.
 */
export const VERTEX_WELD_EPSILON = 1e-4;

/** Why a census stopped early. `null` while it is still running. */
export type MeshCensusHalt = 'non_finite_coordinate' | 'triangle_ceiling' | 'time_budget';

/** What the census established. Every field optional: absent is NOT MEASURED. */
export interface MeshSummary {
  /** Triangles accepted. Always present — even `0`, which is a measured zero. */
  readonly triangleCount: number;
  /** Distinct welded corner positions, or absent above the dedup ceiling. */
  readonly vertexCount?: number;
  readonly boundingBox?: BoundingBoxMm;
  readonly watertight?: boolean;
}

/** A running census over a triangle stream. */
export interface MeshCensus {
  /**
   * Add one triangle, by nine coordinates in the file's own units.
   *
   * Returns `null` when it was accepted and a {@link MeshCensusHalt} when the
   * census refuses to continue. A refusal is TERMINAL for the file — the parser
   * turns it into a verdict — and is distinct from the soft degradations
   * (abandoning the vertex map, abandoning the edge map) which merely drop a
   * measurement and keep counting.
   */
  add(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    cx: number,
    cy: number,
    cz: number,
  ): MeshCensusHalt | null;
  /** Freeze the census and report. Safe to call after a halt. */
  finish(): MeshSummary;
}

/**
 * Start a census.
 *
 * `scaleToMm` converts the file's units to millimetres — `1` for a format whose
 * unit convention is already millimetres, `1000` for glTF's metres, whatever the
 * `<model unit>` attribute says for 3MF. It is a PARAMETER rather than a constant
 * because the unit is a property of the format, and a pipeline that assumed one
 * unit everywhere would report a metre-scale glTF as a 0 mm object.
 *
 * `maxTriangles` is the parser's own ceiling (a format that declares its triangle
 * count can refuse before the census starts; one that does not refuses here).
 */
export function startMeshCensus(options: {
  readonly budget: InspectionBudget;
  readonly scaleToMm: number;
  readonly maxTriangles: number;
}): MeshCensus {
  const { budget, scaleToMm, maxTriangles } = options;

  let triangleCount = 0;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  /**
   * Welded corner position to a dense index. Dropped — and `vertexCount` with it
   * — above the dedup ceiling, because the map IS the memory cost of this module
   * and a count derived from a partial map would be a wrong number rather than a
   * missing one.
   */
  let vertexIds: Map<string, number> | null = new Map();
  let nextVertexId = 0;

  /**
   * Undirected edge to `uses × 8 + (balance + 4)`.
   *
   * Packed into one number rather than a record per edge: at a million triangles
   * this map holds ~1.5 M entries, and an object apiece is the difference between
   * a bounded working set and an out-of-memory worker. `uses` never exceeds 2 in
   * a stored value — a third use is non-manifold and ends the census immediately.
   */
  let edges: Map<string, number> | null = new Map();
  let manifoldBroken = false;
  let edgeCensusAbandoned = false;

  function dropEdgeCensus(): void {
    edges = null;
    edgeCensusAbandoned = true;
  }

  function vertexIdOf(x: number, y: number, z: number): number | null {
    if (!vertexIds) return null;
    const key = `${Math.round(x / VERTEX_WELD_EPSILON)},${Math.round(y / VERTEX_WELD_EPSILON)},${Math.round(z / VERTEX_WELD_EPSILON)}`;
    const existing = vertexIds.get(key);
    if (existing !== undefined) return existing;
    const id = nextVertexId;
    nextVertexId += 1;
    vertexIds.set(key, id);
    return id;
  }

  function recordEdge(from: number, to: number): void {
    if (!edges || manifoldBroken) return;
    if (from === to) {
      // A degenerate edge: the triangle has two corners at one position, so it
      // has no interior and cannot bound a solid. Real exporters emit these, and
      // a slicer treats the result as non-manifold — so this pipeline says so
      // rather than skipping the triangle and reporting a closed surface.
      manifoldBroken = true;
      edges = null;
      return;
    }
    const key = from < to ? `${from}_${to}` : `${to}_${from}`;
    const direction = from < to ? 1 : -1;
    const packed = edges.get(key);
    if (packed === undefined) {
      edges.set(key, 1 * 8 + (direction + 4));
      return;
    }
    const uses = Math.floor(packed / 8);
    const balance = (packed % 8) - 4;
    if (uses >= 2) {
      // Three triangles meeting at one edge. Non-manifold, decided, and there is
      // nothing a further edge could say that changes it.
      manifoldBroken = true;
      edges = null;
      return;
    }
    edges.set(key, 2 * 8 + (balance + direction + 4));
  }

  return {
    add(ax, ay, az, bx, by, bz, cx, cy, cz): MeshCensusHalt | null {
      if (
        !Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(az) ||
        !Number.isFinite(bx) || !Number.isFinite(by) || !Number.isFinite(bz) ||
        !Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(cz)
      ) {
        // NaN and Infinity reach here from a file, not from arithmetic: they are
        // four bytes an attacker chose. A census that accepted one would poison
        // the bounding box for every later triangle with no way to tell afterwards.
        return 'non_finite_coordinate';
      }
      if (triangleCount >= maxTriangles) return 'triangle_ceiling';
      if (budget.expiredOnStride(triangleCount)) return 'time_budget';

      triangleCount += 1;

      if (ax < minX) minX = ax;
      if (ay < minY) minY = ay;
      if (az < minZ) minZ = az;
      if (ax > maxX) maxX = ax;
      if (ay > maxY) maxY = ay;
      if (az > maxZ) maxZ = az;
      if (bx < minX) minX = bx;
      if (by < minY) minY = by;
      if (bz < minZ) minZ = bz;
      if (bx > maxX) maxX = bx;
      if (by > maxY) maxY = by;
      if (bz > maxZ) maxZ = bz;
      if (cx < minX) minX = cx;
      if (cy < minY) minY = cy;
      if (cz < minZ) minZ = cz;
      if (cx > maxX) maxX = cx;
      if (cy > maxY) maxY = cy;
      if (cz > maxZ) maxZ = cz;

      if (vertexIds && triangleCount > MAX_DEDUPLICATED_VERTEX_TRIANGLES) {
        vertexIds = null;
        // The edge census is keyed by vertex id, so it cannot outlive the map it
        // reads. It has its own, lower ceiling; this is the case where the dedup
        // ceiling is the one that bites first.
        dropEdgeCensus();
      }
      if (edges && triangleCount > MAX_WATERTIGHT_TRIANGLES) {
        dropEdgeCensus();
      }

      if (vertexIds) {
        // The corners are welded whether or not the edge census is still running:
        // `vertexCount` outlives it, and abandoning the edge map must not also
        // stop counting distinct positions.
        const a = vertexIdOf(ax, ay, az);
        const b = vertexIdOf(bx, by, bz);
        const c = vertexIdOf(cx, cy, cz);
        if (edges && !manifoldBroken && a !== null && b !== null && c !== null) {
          recordEdge(a, b);
          recordEdge(b, c);
          recordEdge(c, a);
        }
      }
      return null;
    },

    finish(): MeshSummary {
      const summary: {
        triangleCount: number;
        vertexCount?: number;
        boundingBox?: BoundingBoxMm;
        watertight?: boolean;
      } = { triangleCount };

      if (vertexIds) summary.vertexCount = vertexIds.size;

      const box = boundingBoxOf(minX, minY, minZ, maxX, maxY, maxZ, scaleToMm, triangleCount);
      if (box) summary.boundingBox = box;

      if (triangleCount === 0) {
        // An empty soup is vacuously closed, and saying `true` would be the exact
        // overclaim this module exists to avoid: an empty file is not a printable
        // model. Absent — not determined.
        return summary;
      }
      if (manifoldBroken) {
        summary.watertight = false;
        return summary;
      }
      if (edgeCensusAbandoned || !edges) return summary;
      summary.watertight = everyEdgeClosed(edges);
      return summary;
    },
  };
}

/**
 * How much float noise is discounted before the ceiling — one nanometre.
 *
 * `ceil` on a subtraction of floats is a trap: a 30 mm extent derived through a node
 * transform arrives as `30.000000000000426`, and ceiling that reports 31 mm. A
 * millimetre of invented size on every transformed model is worse than the
 * sub-nanometre of truncation this costs, and a print bed cares about neither.
 */
const BOX_NOISE_TOLERANCE_MM = 1e-6;

/** One axis, in whole millimetres: the smallest integer box containing the extent. */
function ceilMm(extent: number, scaleToMm: number): number {
  return Math.max(0, Math.ceil(extent * scaleToMm - BOX_NOISE_TOLERANCE_MM));
}

/** Whether every edge was used exactly twice, in opposite directions. */
function everyEdgeClosed(edges: Map<string, number>): boolean {
  for (const packed of edges.values()) {
    const uses = Math.floor(packed / 8);
    const balance = (packed % 8) - 4;
    if (uses !== 2 || balance !== 0) return false;
  }
  return true;
}

/**
 * The smallest whole-millimetre box that CONTAINS the mesh, or `undefined`.
 *
 * `ceil` and not `round`, and the choice is a statement: the box a buyer reads is
 * the one the model fits inside. Rounding would report a 0 mm axis for a 0.4 mm
 * feature — indistinguishable from the measured zero of a genuinely flat plate —
 * where ceiling reports 1 mm, which is true and is the number a print bed cares
 * about. A genuinely flat plate still reports 0, because `ceil(0)` is `0`.
 *
 * `undefined` when there is no geometry, or when an extent is beyond
 * {@link MAX_BOUNDING_BOX_MM}. The second is not fussiness: the column is
 * `integer`, so a larger value fails the INSERT rather than a CHECK, and a job
 * that cannot write its result retries until the budget is gone and records
 * nothing at all. Absent means not measured, which for a box nothing could hold
 * is exactly right.
 */
function boundingBoxOf(
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  scaleToMm: number,
  triangleCount: number,
): BoundingBoxMm | undefined {
  if (triangleCount === 0) return undefined;
  return boundingBoxMmFrom(minX, minY, minZ, maxX, maxY, maxZ, scaleToMm);
}

/**
 * The same box from extents somebody else accumulated.
 *
 * `gltf.ts` derives its extents from accessor `min`/`max` metadata rather than
 * from a triangle stream — the binary buffers are deliberately not read — so it
 * needs the millimetre conversion, the `ceil` convention and the column ceiling
 * without the census. One implementation, because two would disagree about
 * rounding and the disagreement would show up as two sizes for one model in a
 * package holding both an STL and a glTF of it.
 */
export function boundingBoxMmFrom(
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  scaleToMm: number,
): BoundingBoxMm | undefined {
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return undefined;
  const xMm = ceilMm(maxX - minX, scaleToMm);
  const yMm = ceilMm(maxY - minY, scaleToMm);
  const zMm = ceilMm(maxZ - minZ, scaleToMm);
  if (!Number.isFinite(xMm) || !Number.isFinite(yMm) || !Number.isFinite(zMm)) return undefined;
  if (xMm < 0 || yMm < 0 || zMm < 0) return undefined;
  if (xMm > MAX_BOUNDING_BOX_MM || yMm > MAX_BOUNDING_BOX_MM || zMm > MAX_BOUNDING_BOX_MM) {
    return undefined;
  }
  return { xMm, yMm, zMm };
}

/**
 * The verdict a halted census produces.
 *
 * No partial measurement travels with it, and that is deliberate. A census that
 * stopped at the triangle ceiling has counted a PREFIX of the file: reporting that
 * prefix's triangle count would publish a number that is wrong about the model
 * rather than missing, and its bounding box would be the box of whichever corner
 * of the mesh happened to be written first. Absent means not measured, and for a
 * file nobody finished reading that is the only true statement available.
 */
export function censusHaltOutcome(halt: MeshCensusHalt, maxTriangles: number): InspectionOutcome {
  switch (halt) {
    case 'non_finite_coordinate':
      return corruptFile('a vertex coordinate is not a finite number');
    case 'triangle_ceiling':
      return refusedTooLarge(`the mesh exceeds the ${maxTriangles}-triangle inspection ceiling`);
    case 'time_budget':
      return refusedTooLarge('the inspection time budget was exhausted before the mesh was read');
  }
}
