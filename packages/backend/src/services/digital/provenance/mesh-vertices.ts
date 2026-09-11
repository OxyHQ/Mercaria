/**
 * Getting vertex POSITIONS out of mesh bytes, for exactly the formats where that
 * can be done without a parser we would not trust (#1015 W8).
 *
 * This module answers one question — *"what points does this file describe?"* —
 * and it is deliberately the smallest question in the neighbourhood. It does not
 * measure the mesh (`asset_file_inspections` and the sandboxed processors own
 * that, ADR 0010 D12), it does not validate it, and it does not care about
 * normals, materials, UVs, scene graphs or units.
 *
 * ## Why three formats and not eleven
 *
 * `ASSET_FORMAT_REGISTRY` marks six formats `geometryMeasurable`. This module
 * handles THREE of them — `stl`, `obj` and nothing else — and answers
 * `unsupported` for the rest. That is the instruction #1015 W8 gives in as many
 * words: *a false positive here accuses a real creator*, so where a fingerprint
 * cannot be derived RELIABLY we say so rather than derive a weak one.
 *
 * The three refusals each have a specific reason, and none of them is effort:
 *
 * - **`glb` / `gltf`** — the positions live behind accessors: component types,
 *   byte strides, sparse substitution, normalized integer encodings, and
 *   optionally a Draco-compressed buffer view this process cannot open at all.
 *   A partial reader that handled the common case would silently produce a
 *   fingerprint over the WRONG points for the uncommon one, and a fingerprint
 *   over the wrong points is not a weaker signal — it is a signal that matches
 *   things it should not.
 * - **`fbx`** — binary FBX is a proprietary node tree with a deflate-compressed
 *   array encoding and two incompatible generations of layout. Same argument,
 *   more of it.
 * - **`3mf`, `zip`, `blend`** — containers. Opening one in-process is #1015 W12
 *   threats 5 and 6 (zip bomb, path traversal) inside the API, and the whole
 *   point of the inspection sandbox is that containers are opened THERE. A
 *   fingerprint is not worth moving that surface.
 *
 * `unsupported` is a first-class answer everywhere in this domain and means the
 * same thing here as `ASSET_INSPECTION_VERDICTS`' member of the same name: we did
 * not measure this, which is different from measuring nothing.
 *
 * ## The one thing the parsers agree on
 *
 * They return positions in the file's own coordinates, in file order, INCLUDING
 * duplicates. Canonicalisation — dedupe, translate, scale, quantise, sort — is
 * `fingerprint.ts`'s job and happens in one place, because a parser that
 * canonicalised would make the fingerprint depend on which parser produced it,
 * and the whole purpose is for one mesh exported two ways to land on one value.
 */

/** The registry format keys this module can read positions out of. */
export const VERTEX_READABLE_FORMAT_KEYS: readonly string[] = ['stl', 'obj'];

/**
 * Why no positions were read.
 *
 * A closed set, because every one of them is a DIFFERENT operational fact and a
 * single `null` would collapse "we do not open containers here" into "this file
 * is broken". The first is a design boundary and the second is a creator's
 * upload failing.
 */
export type VertexReadRefusal =
  /** The format has no reader here, by the decisions in this file's docblock. */
  | 'format_not_readable_here'
  /** The bytes do not parse as the format they claim to be. */
  | 'malformed_bytes'
  /** A coordinate was NaN or infinite. Nothing downstream may normalise that. */
  | 'non_finite_coordinate'
  /** More vertices than this process will read in one pass. */
  | 'too_large';

/** Positions read, or the reason none were. */
export type VertexReadResult =
  | { readonly status: 'read'; readonly positions: Float64Array; readonly count: number }
  | { readonly status: 'refused'; readonly reason: VertexReadRefusal };

/**
 * The in-process ceiling on how many vertices are read at once.
 *
 * Five million triples is 120 MB of `Float64Array` and a few seconds of sorting.
 * The ceiling is here rather than only in the sandbox because THIS module runs in
 * the API process: a fingerprint is a nice-to-have and an out-of-memory kill is
 * not, so the honest answer for a mesh this size is `too_large` — which reads
 * downstream as "no fingerprint", exactly like an unsupported format, and never
 * as "no match".
 */
export const MAX_READABLE_VERTICES = 5_000_000;

/** Binary STL: 80-byte header, uint32 triangle count, then 50 bytes per triangle. */
const STL_BINARY_HEADER_BYTES = 84;
const STL_BINARY_TRIANGLE_BYTES = 50;

/**
 * Read the vertex positions of one file.
 *
 * `formatKey` comes from `ASSET_FORMAT_REGISTRY` and is NOT sniffed from the
 * bytes. Sniffing would let a file claiming to be a `png` be read as an `obj`
 * because it happens to contain lines beginning `v `, and the format on
 * `asset_files` is what every other part of this domain already reasons about.
 */
export function readVertexPositions(formatKey: string, bytes: Uint8Array): VertexReadResult {
  if (formatKey === 'stl') return readStl(bytes);
  if (formatKey === 'obj') return readObj(bytes);
  return { status: 'refused', reason: 'format_not_readable_here' };
}

/**
 * STL, either encoding.
 *
 * The ASCII/binary decision is made on the LENGTH ARITHMETIC, not on the leading
 * `solid` token, and that is the standard resolution of a genuinely ambiguous
 * format: plenty of binary STL writers put a description beginning "solid" in the
 * 80-byte header, so the token test misreads those as ASCII and finds no
 * `vertex` lines. If the file is exactly `84 + 50 * n` bytes for the `n` its own
 * header declares, it is binary; otherwise it is read as text.
 */
function readStl(bytes: Uint8Array): VertexReadResult {
  if (bytes.byteLength >= STL_BINARY_HEADER_BYTES) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const triangles = view.getUint32(80, true);
    if (
      triangles > 0 &&
      bytes.byteLength === STL_BINARY_HEADER_BYTES + triangles * STL_BINARY_TRIANGLE_BYTES
    ) {
      if (triangles * 3 > MAX_READABLE_VERTICES) {
        return { status: 'refused', reason: 'too_large' };
      }
      const positions = new Float64Array(triangles * 9);
      let out = 0;
      for (let i = 0; i < triangles; i += 1) {
        // 12 bytes of face normal are skipped: a normal is DERIVED from the
        // positions, and two exporters disagree about its sign and its
        // normalisation for meshes that are otherwise identical.
        const base = STL_BINARY_HEADER_BYTES + i * STL_BINARY_TRIANGLE_BYTES + 12;
        for (let component = 0; component < 9; component += 1) {
          const value = view.getFloat32(base + component * 4, true);
          if (!Number.isFinite(value)) {
            return { status: 'refused', reason: 'non_finite_coordinate' };
          }
          positions[out] = value;
          out += 1;
        }
      }
      return { status: 'read', positions, count: triangles * 3 };
    }
  }
  return readAsciiStl(bytes);
}

/** ASCII STL: every `vertex x y z` line, in file order. */
function readAsciiStl(bytes: Uint8Array): VertexReadResult {
  const text = decodeUtf8(bytes);
  if (text === null) return { status: 'refused', reason: 'malformed_bytes' };
  const values: number[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('vertex')) continue;
    const parsed = parseThreeFloats(trimmed.slice('vertex'.length));
    if (parsed === 'non_finite') return { status: 'refused', reason: 'non_finite_coordinate' };
    if (parsed === null) return { status: 'refused', reason: 'malformed_bytes' };
    values.push(parsed[0], parsed[1], parsed[2]);
    if (values.length > MAX_READABLE_VERTICES * 3) {
      return { status: 'refused', reason: 'too_large' };
    }
  }
  if (values.length === 0) return { status: 'refused', reason: 'malformed_bytes' };
  return { status: 'read', positions: Float64Array.from(values), count: values.length / 3 };
}

/**
 * Wavefront OBJ: every `v x y z [w]` line.
 *
 * `vt` and `vn` are NOT positions and a prefix test on `v` alone would eat both —
 * which would silently mix texture coordinates into a geometry fingerprint and
 * make two identical meshes with different UV layouts look like different works.
 * The split is on whitespace, so the discriminator is the whole first token.
 *
 * A fourth component (`w`, the rational weight) is read and discarded: it is a
 * projective weight rather than a coordinate, and exporters emit `1.0` for it.
 */
function readObj(bytes: Uint8Array): VertexReadResult {
  const text = decodeUtf8(bytes);
  if (text === null) return { status: 'refused', reason: 'malformed_bytes' };
  const values: number[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('v')) continue;
    const parts = trimmed.split(/\s+/);
    if (parts[0] !== 'v') continue;
    const parsed = parseThreeFloats(parts.slice(1, 4).join(' '));
    if (parsed === 'non_finite') return { status: 'refused', reason: 'non_finite_coordinate' };
    if (parsed === null) return { status: 'refused', reason: 'malformed_bytes' };
    values.push(parsed[0], parsed[1], parsed[2]);
    if (values.length > MAX_READABLE_VERTICES * 3) {
      return { status: 'refused', reason: 'too_large' };
    }
  }
  if (values.length === 0) return { status: 'refused', reason: 'malformed_bytes' };
  return { status: 'read', positions: Float64Array.from(values), count: values.length / 3 };
}

/**
 * Three floats, or why not.
 *
 * `'non_finite'` is distinguished from `null` so the caller can tell a file
 * carrying `NaN` — which a mesh really can, and which no normalisation may touch
 * — from a line that is not three numbers at all.
 */
function parseThreeFloats(text: string): [number, number, number] | null | 'non_finite' {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 3) return null;
  const out: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    const value = Number(parts[i]);
    if (Number.isNaN(value) && parts[i].toLowerCase() !== 'nan') return null;
    if (!Number.isFinite(value)) return 'non_finite';
    out.push(value);
  }
  return [out[0], out[1], out[2]];
}

/** UTF-8 text, or `null` when the bytes are not text at all. */
function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
