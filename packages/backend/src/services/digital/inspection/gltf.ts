/**
 * glTF and GLB — measured from the JSON, never from the buffers (#1015 W4).
 *
 * ## The deliberate omission: no accessor data is ever decoded
 *
 * A glTF's geometry lives in binary buffers addressed by accessors, and an
 * accessor is a component type, a count, a byte offset, a byte stride, a
 * normalization flag and an optional SPARSE substitution table — every one of them
 * a number from the file, every one of them an index into memory. Decoding that is
 * the single largest parser surface either format has, and #1015 W12 threat 7 is
 * about precisely this: a whole-application parser pointed at hostile input.
 *
 * Everything this pipeline reports is therefore derivable from the JSON alone:
 *
 * - **Counts** from `accessor.count`, which is metadata.
 * - **The bounding box** from the POSITION accessors' `min`/`max`, which the glTF
 *   spec REQUIRES on position accessors, transformed by the node hierarchy.
 * - **UV mapping, rigs and animations** from the presence of `TEXCOORD_n`
 *   attributes, `skins` and `animations`.
 *
 * And one thing is therefore NOT derivable: **`watertight` is always absent.**
 * Answering it needs the index buffer. A pipeline that returned `false` because it
 * had not looked would mark every glTF on the marketplace as unprintable, and the
 * column cannot distinguish that from a measurement — which is the entire reason
 * ADR 0010 D12 made it nullable and #1015 W4 closes with *"do not overclaim"*.
 *
 * ## Counts are DECLARED, and a declaration is checked rather than believed
 *
 * There is no length arithmetic here to corroborate a count against, the way
 * `stl.ts` has. So every number taken from the document goes through
 * {@link safeCount}: a non-integer, a negative, a `1e300` and anything above
 * {@link MAX_REPORTED_TRIANGLES} is refused rather than clamped. A clamped count
 * is a measurement nobody made, and this is the format where an attacker can write
 * one for free.
 *
 * ## Units
 *
 * glTF's unit IS specified: one unit is one metre. So the scale to millimetres is
 * exactly 1000 and nothing is assumed — unlike STL and OBJ, where
 * `UNITLESS_MESH_SCALE_TO_MM` carries a convention.
 *
 * ## The node walk, and why it is bounded twice
 *
 * A node's children are INDICES into the `nodes` array, so a document can declare
 * a cycle in two lines, and a recursive walker handed one never returns. The walk
 * below is iterative, carries an explicit visited set, and is bounded by BOTH
 * {@link MAX_GLTF_NODE_DEPTH} and {@link MAX_GLTF_NODE_VISITS} — either alone is
 * insufficient, because a two-node cycle is shallow and a fan-out of a million
 * children is flat. Hitting either bound leaves the bounding box ABSENT rather
 * than partial: half a scene's extents is not the model's size.
 */

import {
  MAX_GLB_CHUNKS,
  MAX_GLTF_NODE_DEPTH,
  MAX_GLTF_NODE_VISITS,
  MAX_JSON_DOCUMENT_BYTES,
  MAX_REPORTED_TRIANGLES,
  MAX_REPORTED_VERTICES,
  MAX_RESOURCE_REFERENCES,
} from './limits.js';
import { boundingBoxMmFrom } from './mesh.js';
import {
  corruptFile,
  measured,
  refusedTooLarge,
  safeCount,
  unsupportedFormat,
  type GeometryMeasurement,
  type InspectionOutcome,
} from './result.js';
import { resolveResourceReference } from './resources.js';
import type { InspectionBudget } from './budget.js';

/** One glTF unit is one metre; the column is millimetres. */
export const GLTF_SCALE_TO_MM = 1000;

/** `glTF` as a little-endian uint32, and the two chunk types the spec defines. */
const GLB_MAGIC = 0x46546c67;
const GLB_CHUNK_JSON = 0x4e4f534a;
const GLB_CHUNK_BIN = 0x004e4942;
const GLB_HEADER_BYTES = 12;
const GLB_CHUNK_HEADER_BYTES = 8;
/** The only container version this processor measures. */
const GLB_SUPPORTED_VERSION = 2;

/** Primitive modes that produce triangles, and how many per index. */
const MODE_TRIANGLES = 4;
const MODE_TRIANGLE_STRIP = 5;
const MODE_TRIANGLE_FAN = 6;

interface GltfOptions {
  readonly budget: InspectionBudget;
  readonly availableResources: ReadonlySet<string>;
}

/**
 * Inspect a `.gltf` JSON document.
 *
 * `binChunkPresent` is false here by definition: a buffer with no `uri` refers to
 * a GLB BIN chunk, and a standalone `.gltf` has none — so such a buffer is a
 * structural error rather than an embedded resource, and saying so is more useful
 * than reporting a missing file with no name.
 */
export function inspectGltfJson(bytes: Uint8Array, options: GltfOptions): InspectionOutcome {
  if (bytes.length > MAX_JSON_DOCUMENT_BYTES) {
    return refusedTooLarge(
      `${bytes.length} bytes of JSON, above the ${MAX_JSON_DOCUMENT_BYTES}-byte ceiling`,
    );
  }
  return measureGltfDocument(bytes, options, false);
}

/**
 * Inspect a GLB container: validate the chunk table, then measure its JSON chunk.
 *
 * Every offset is derived and bounds-checked; nothing is allocated from a declared
 * length. The declared total length is allowed to be SHORTER than the file (a
 * container with trailing bytes is still a container) and never longer — a header
 * claiming more than it has is the one shape that would walk a reader off the end.
 */
export function inspectGlb(bytes: Uint8Array, options: GltfOptions): InspectionOutcome {
  if (bytes.length < GLB_HEADER_BYTES) {
    return corruptFile(`${bytes.length} bytes is shorter than a GLB header`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) return corruptFile('the GLB magic is not `glTF`');

  const version = view.getUint32(4, true);
  if (version !== GLB_SUPPORTED_VERSION) {
    return unsupportedFormat(
      `GLB container version ${version}; this processor measures version ${GLB_SUPPORTED_VERSION}`,
    );
  }

  const declaredLength = view.getUint32(8, true);
  if (declaredLength > bytes.length) {
    return corruptFile(
      `the header declares ${declaredLength} bytes and the file holds ${bytes.length}`,
    );
  }
  const end = Math.max(declaredLength, GLB_HEADER_BYTES);

  let offset = GLB_HEADER_BYTES;
  let json: Uint8Array | null = null;
  let binPresent = false;

  for (let chunk = 0; chunk < MAX_GLB_CHUNKS; chunk += 1) {
    if (offset === end) break;
    if (offset + GLB_CHUNK_HEADER_BYTES > end) {
      return corruptFile(`a chunk header at byte ${offset} runs past the declared length`);
    }
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const dataStart = offset + GLB_CHUNK_HEADER_BYTES;
    if (chunkLength > end - dataStart) {
      return corruptFile(
        `a chunk at byte ${offset} declares ${chunkLength} bytes, past the declared length`,
      );
    }
    if (chunkType === GLB_CHUNK_JSON && json === null) {
      if (chunkLength > MAX_JSON_DOCUMENT_BYTES) {
        return refusedTooLarge(
          `a JSON chunk of ${chunkLength} bytes, above the ${MAX_JSON_DOCUMENT_BYTES}-byte ceiling`,
        );
      }
      json = bytes.subarray(dataStart, dataStart + chunkLength);
    } else if (chunkType === GLB_CHUNK_BIN) {
      binPresent = true;
    }
    // Chunk lengths are 4-byte aligned by spec; a writer that forgot the padding
    // would otherwise desynchronize every later chunk. Rounding UP here cannot
    // overshoot the end, because the next iteration bounds-checks before reading.
    offset += GLB_CHUNK_HEADER_BYTES + chunkLength + ((4 - (chunkLength % 4)) % 4);
    if (offset > end) break;
  }

  if (json === null) return corruptFile('the container holds no JSON chunk');
  return measureGltfDocument(json, options, binPresent);
}

/** Parse the JSON and measure it. Shared by both entry points. */
function measureGltfDocument(
  json: Uint8Array,
  options: GltfOptions,
  binChunkPresent: boolean,
): InspectionOutcome {
  let document: unknown;
  try {
    document = JSON.parse(new TextDecoder('utf-8', { fatal: false }).decode(json));
  } catch (err) {
    // Includes the RangeError a pathologically nested document raises, which is
    // the reason this is a catch rather than a shape test: `JSON.parse`'s own
    // recursion limit is the depth bound, and it reports by throwing.
    return corruptFile(`the glTF JSON does not parse: ${(err as Error).message}`);
  }
  if (!isRecord(document)) return corruptFile('the glTF JSON is not an object');
  const asset = document.asset;
  if (!isRecord(asset) || typeof asset.version !== 'string') {
    return corruptFile('no `asset.version`, so this is not a glTF document');
  }

  const accessors = asArray(document.accessors);
  const meshes = asArray(document.meshes);
  const nodes = asArray(document.nodes);
  const scenes = asArray(document.scenes);

  let triangleCount = 0;
  let vertexCount = 0;
  let hasUvMapping = false;

  for (const mesh of meshes) {
    if (!isRecord(mesh)) continue;
    for (const primitive of asArray(mesh.primitives)) {
      if (!isRecord(primitive)) continue;
      const attributes = isRecord(primitive.attributes) ? primitive.attributes : {};
      if (Object.keys(attributes).some((key) => key.startsWith('TEXCOORD_'))) {
        hasUvMapping = true;
      }
      const positionCount = accessorCount(accessors, attributes.POSITION);
      if (positionCount === 'invalid') {
        return corruptFile('a POSITION accessor declares a count no column can hold');
      }
      if (positionCount !== null) vertexCount += positionCount;

      const mode = typeof primitive.mode === 'number' ? primitive.mode : MODE_TRIANGLES;
      if (mode !== MODE_TRIANGLES && mode !== MODE_TRIANGLE_STRIP && mode !== MODE_TRIANGLE_FAN) {
        continue;
      }
      const indexCount = accessorCount(accessors, primitive.indices);
      if (indexCount === 'invalid') {
        return corruptFile('an index accessor declares a count no column can hold');
      }
      const elements = indexCount ?? positionCount;
      if (elements === null) continue;
      triangleCount +=
        mode === MODE_TRIANGLES ? Math.floor(elements / 3) : Math.max(0, elements - 2);
    }
  }

  if (triangleCount > MAX_REPORTED_TRIANGLES) {
    return refusedTooLarge(
      `the document declares ${triangleCount} triangles, above the ${MAX_REPORTED_TRIANGLES} ceiling`,
    );
  }
  if (vertexCount > MAX_REPORTED_VERTICES) {
    return refusedTooLarge(
      `the document declares ${vertexCount} vertices, above the ${MAX_REPORTED_VERTICES} ceiling`,
    );
  }

  const missing = missingGltfResources(document, options.availableResources, binChunkPresent);
  if (missing === 'buffer_without_uri') {
    return corruptFile(
      'a buffer declares no `uri`, which is only valid inside a GLB binary container',
    );
  }

  const measurement: GeometryMeasurement = {
    triangleCount,
    vertexCount,
    meshCount: meshes.length,
    hasUvMapping,
    hasRig: hasRig(document, nodes),
    animationCount: asArray(document.animations).length,
    missingResources: missing,
    // `watertight` is deliberately absent. See the module docblock.
    ...worldBoundingBox(accessors, meshes, nodes, scenes, options.budget),
  };
  return measured(measurement);
}

/**
 * Whether the document carries a skeleton.
 *
 * `skins` OR a node naming one, because a document may declare skins that nothing
 * references (an exporter artefact) and a node may name a skin index out of range
 * (a broken one). Either is evidence of a rig having been authored, which is the
 * question a buyer filtering for `rigged` is asking — and it is deliberately NOT
 * the stronger claim that the rig works.
 */
function hasRig(document: Record<string, unknown>, nodes: readonly unknown[]): boolean {
  if (asArray(document.skins).length > 0) return true;
  return nodes.some((node) => isRecord(node) && node.skin !== undefined);
}

/**
 * The bounding box in world space, or `{}` when it cannot be established.
 *
 * Returns a PARTIAL measurement object rather than a value, so the caller spreads
 * it: the difference between "no bounding box" and "a bounding box of undefined"
 * is the difference between an absent column and a CHECK violation on two of three
 * axes, and spreading an empty object is the one spelling that cannot get it
 * wrong.
 */
function worldBoundingBox(
  accessors: readonly unknown[],
  meshes: readonly unknown[],
  nodes: readonly unknown[],
  scenes: readonly unknown[],
  budget: InspectionBudget,
): { boundingBox?: ReturnType<typeof boundingBoxMmFrom> } {
  const roots = sceneRoots(scenes, nodes);
  if (roots.length === 0) return {};

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  let sawGeometry = false;

  const visited = new Set<number>();
  const stack: { node: number; matrix: readonly number[]; depth: number }[] = roots.map((node) => ({
    node,
    matrix: IDENTITY,
    depth: 0,
  }));
  let visits = 0;

  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry) break;
    visits += 1;
    if (visits > MAX_GLTF_NODE_VISITS) return {};
    if (budget.expiredOnStride(visits)) return {};
    if (entry.depth > MAX_GLTF_NODE_DEPTH) return {};
    if (visited.has(entry.node)) {
      // A node reached twice. In a well-formed document the hierarchy is a forest,
      // so this is either a cycle or a shared subtree; skipping is right for both
      // and is what keeps the walk terminating.
      continue;
    }
    visited.add(entry.node);

    const node = nodes[entry.node];
    if (!isRecord(node)) continue;
    const local = localMatrix(node);
    if (!local) return {};
    const world = multiply(entry.matrix, local);

    if (typeof node.mesh === 'number') {
      const mesh = meshes[node.mesh];
      if (isRecord(mesh)) {
        for (const primitive of asArray(mesh.primitives)) {
          if (!isRecord(primitive)) continue;
          const attributes = isRecord(primitive.attributes) ? primitive.attributes : {};
          const extents = accessorExtents(accessors, attributes.POSITION);
          if (!extents) return {};
          for (const corner of cornersOf(extents)) {
            const [x, y, z] = transform(world, corner[0], corner[1], corner[2]);
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return {};
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (z < minZ) minZ = z;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
            if (z > maxZ) maxZ = z;
            sawGeometry = true;
          }
        }
      }
    }

    for (const child of asArray(node.children)) {
      if (typeof child !== 'number' || !Number.isInteger(child)) continue;
      if (child < 0 || child >= nodes.length) continue;
      stack.push({ node: child, matrix: world, depth: entry.depth + 1 });
    }
  }

  if (!sawGeometry) return {};
  const box = boundingBoxMmFrom(minX, minY, minZ, maxX, maxY, maxZ, GLTF_SCALE_TO_MM);
  return box ? { boundingBox: box } : {};
}

/** The node indices every scene starts from, or every node when no scene names one. */
function sceneRoots(scenes: readonly unknown[], nodes: readonly unknown[]): number[] {
  const roots: number[] = [];
  for (const scene of scenes) {
    if (!isRecord(scene)) continue;
    for (const node of asArray(scene.nodes)) {
      if (typeof node !== 'number' || !Number.isInteger(node)) continue;
      if (node < 0 || node >= nodes.length) continue;
      roots.push(node);
    }
  }
  return roots;
}

/** A node's local transform: an explicit matrix, or TRS, or identity. */
function localMatrix(node: Record<string, unknown>): readonly number[] | null {
  const explicit = node.matrix;
  if (Array.isArray(explicit)) {
    if (explicit.length !== 16) return null;
    const values = explicit.map((value) => (typeof value === 'number' ? value : Number.NaN));
    if (values.some((value) => !Number.isFinite(value))) return null;
    return values;
  }
  const translation = vector(node.translation, 3, [0, 0, 0]);
  const rotation = vector(node.rotation, 4, [0, 0, 0, 1]);
  const scale = vector(node.scale, 3, [1, 1, 1]);
  if (!translation || !rotation || !scale) return null;
  return fromTrs(translation, rotation, scale);
}

/** A fixed-length numeric vector from the document, its default, or `null` when malformed. */
function vector(value: unknown, length: number, fallback: number[]): number[] | null {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.length !== length) return null;
  const values = value.map((entry) => (typeof entry === 'number' ? entry : Number.NaN));
  return values.some((entry) => !Number.isFinite(entry)) ? null : values;
}

/** Column-major identity, matching glTF's own matrix layout. */
const IDENTITY: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** `T · R · S`, column-major — glTF's own composition order. */
function fromTrs(t: number[], r: number[], s: number[]): number[] {
  const [x, y, z, w] = r;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}

/** `a · b`, both column-major. */
function multiply(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      out[column * 4 + row] =
        a[row] * b[column * 4] +
        a[4 + row] * b[column * 4 + 1] +
        a[8 + row] * b[column * 4 + 2] +
        a[12 + row] * b[column * 4 + 3];
    }
  }
  return out;
}

/** `m · (x, y, z, 1)`, dropping the homogeneous coordinate. */
function transform(m: readonly number[], x: number, y: number, z: number): [number, number, number] {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

/** The eight corners of an axis-aligned box, because a rotation moves each one differently. */
function cornersOf(extents: { min: number[]; max: number[] }): number[][] {
  const { min, max } = extents;
  const corners: number[][] = [];
  for (const x of [min[0], max[0]]) {
    for (const y of [min[1], max[1]]) {
      for (const z of [min[2], max[2]]) corners.push([x, y, z]);
    }
  }
  return corners;
}

/** An accessor's `min`/`max`, or `null` when it has none this module can use. */
function accessorExtents(
  accessors: readonly unknown[],
  index: unknown,
): { min: number[]; max: number[] } | null {
  if (typeof index !== 'number' || !Number.isInteger(index)) return null;
  const accessor = accessors[index];
  if (!isRecord(accessor)) return null;
  const min = vector(accessor.min, 3, [] as number[]);
  const max = vector(accessor.max, 3, [] as number[]);
  if (!min || !max || min.length !== 3 || max.length !== 3) return null;
  return { min, max };
}

/**
 * An accessor's element count: the number, `null` when there is no accessor, or
 * `'invalid'` when the document declares one a column cannot hold.
 *
 * Three outcomes rather than two, because "this primitive has no indices" and
 * "this primitive declares 1e300 indices" must not produce the same answer: the
 * first is ordinary (a non-indexed primitive) and the second is a file to refuse.
 */
function accessorCount(
  accessors: readonly unknown[],
  index: unknown,
): number | null | 'invalid' {
  if (index === undefined) return null;
  if (typeof index !== 'number' || !Number.isInteger(index)) return 'invalid';
  const accessor = accessors[index];
  if (!isRecord(accessor)) return null;
  // The ceiling here is what a NUMBER can hold, not what the pipeline will report:
  // `1e300` and `-1` and `2.5` are corrupt documents, while a plausible-but-enormous
  // count is a document too large to measure. The two get different verdicts, so the
  // totals are compared against `MAX_REPORTED_*` by the caller instead of here.
  const count = safeCount(accessor.count, Number.MAX_SAFE_INTEGER);
  return count === undefined ? 'invalid' : count;
}

/**
 * Every external resource the document names and the version does not hold.
 *
 * `buffers` and `images`, which are the only two `uri`-bearing arrays in glTF 2.0.
 * A buffer with no `uri` inside a GLB is the BIN chunk and is present when the
 * container carried one; outside a GLB it is a structural error, reported as such
 * by the sentinel return.
 */
function missingGltfResources(
  document: Record<string, unknown>,
  available: ReadonlySet<string>,
  binChunkPresent: boolean,
): string[] | 'buffer_without_uri' {
  const missing: string[] = [];
  const seen = new Set<string>();
  let references = 0;

  for (const buffer of asArray(document.buffers)) {
    if (!isRecord(buffer)) continue;
    if (buffer.uri === undefined) {
      if (binChunkPresent) continue;
      return 'buffer_without_uri';
    }
  }

  for (const key of ['buffers', 'images'] as const) {
    for (const entry of asArray(document[key])) {
      if (!isRecord(entry) || typeof entry.uri !== 'string') continue;
      if (references >= MAX_RESOURCE_REFERENCES) break;
      references += 1;
      const resolution = resolveResourceReference(entry.uri, available, { decodeUri: true });
      if (!resolution || resolution.present) continue;
      if (seen.has(resolution.reference)) continue;
      seen.add(resolution.reference);
      missing.push(resolution.reference);
    }
  }
  return missing;
}

/** Whether `value` is a plain object we may read keys from. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `value` when it is an array, otherwise the empty one. Never throws, never copies. */
function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}
