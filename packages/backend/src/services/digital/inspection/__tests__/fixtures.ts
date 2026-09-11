/**
 * REAL bytes for the inspection tests — built here, never mocked.
 *
 * ## Why fixtures and not stubbed parsers
 *
 * Every module under test in this directory is a byte reader, so the only thing
 * worth testing about one is what it does with bytes. A test that mocked
 * `inspectStl` and asserted the orchestrator called it would pass against a parser
 * that read past the end of its buffer, which is the single failure mode #1015 W12
 * is about. So these builders produce genuine binary STL, genuine zip central
 * directories and genuine GLB chunk tables, and the hostile cases are built by
 * deliberately corrupting one field of a real structure rather than by inventing
 * noise.
 *
 * The builders take the LIES as explicit options — a declared triangle count that
 * does not match the length, a declared uncompressed size that does not match the
 * stream, an entry count the directory does not have — because those are exactly
 * the inputs a production writer cannot produce and an attacker can.
 */

import { deflateRawSync } from 'node:zlib';

/** A vertex in the file's own coordinate units. */
export type Vertex = readonly [number, number, number];
/** Three corners. */
export type Triangle = readonly [Vertex, Vertex, Vertex];

/**
 * A binary STL.
 *
 * `header` defaults to the word `solid`, which is the trap: real exporters write
 * it, so a sniffer that reads the first word instead of the length formula
 * misclassifies a binary file as ASCII. `declaredTriangles` overrides the header's
 * count WITHOUT changing the body, which is how the "a count larger than the bytes"
 * case is built.
 */
export function binaryStl(
  triangles: readonly Triangle[],
  options?: { readonly header?: string; readonly declaredTriangles?: number; readonly trailingJunk?: number },
): Uint8Array {
  const trailing = options?.trailingJunk ?? 0;
  const bytes = new Uint8Array(84 + triangles.length * 50 + trailing);
  const view = new DataView(bytes.buffer);
  const header = new TextEncoder().encode(options?.header ?? 'solid exported-by-a-real-tool');
  bytes.set(header.subarray(0, 80), 0);
  view.setUint32(80, options?.declaredTriangles ?? triangles.length, true);
  let offset = 84;
  for (const triangle of triangles) {
    // The normal. Left at zero: nothing in this pipeline reads it, and a test that
    // computed one would be asserting a fact no column holds.
    offset += 12;
    for (const vertex of triangle) {
      view.setFloat32(offset, vertex[0], true);
      view.setFloat32(offset + 4, vertex[1], true);
      view.setFloat32(offset + 8, vertex[2], true);
      offset += 12;
    }
    offset += 2;
  }
  return bytes;
}

/** An ASCII STL with one `solid` block per group of triangles. */
export function asciiStl(solids: readonly (readonly Triangle[])[]): Uint8Array {
  const lines: string[] = [];
  solids.forEach((triangles, index) => {
    lines.push(`solid part-${index}`);
    for (const triangle of triangles) {
      lines.push('  facet normal 0 0 0');
      lines.push('    outer loop');
      for (const vertex of triangle) {
        lines.push(`      vertex ${vertex[0]} ${vertex[1]} ${vertex[2]}`);
      }
      lines.push('    endloop');
      lines.push('  endfacet');
    }
    lines.push(`endsolid part-${index}`);
  });
  return new TextEncoder().encode(`${lines.join('\n')}\n`);
}

/**
 * A closed, orientable tetrahedron — the watertight control.
 *
 * Four triangles, consistently wound outward, so every one of its six edges is used
 * exactly twice in opposite directions. This is the fixture that proves a
 * `watertight: true` is reachable at all; {@link openTetrahedron} is the one that
 * proves the check can still say no.
 */
export const CLOSED_TETRAHEDRON: readonly Triangle[] = [
  [[0, 0, 0], [10, 0, 0], [0, 20, 0]],
  [[0, 0, 0], [0, 20, 0], [0, 0, 30]],
  [[0, 0, 0], [0, 0, 30], [10, 0, 0]],
  [[10, 0, 0], [0, 0, 30], [0, 20, 0]],
];

/** The same tetrahedron with one face removed: four edges are now used once. */
export const openTetrahedron = (): readonly Triangle[] => CLOSED_TETRAHEDRON.slice(0, 3);

/** An OBJ from explicit lines, so a test can write exactly the directives it means. */
export function objFile(lines: readonly string[]): Uint8Array {
  return new TextEncoder().encode(`${lines.join('\n')}\n`);
}

/** A `.gltf` JSON document. */
export function gltfJson(document: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(document));
}

/**
 * A GLB container.
 *
 * `declaredLength` overrides the header's total length without changing the file,
 * which is how the "a header claiming more than it has" case is built.
 */
export function glb(
  document: unknown,
  options?: {
    readonly bin?: Uint8Array;
    readonly declaredLength?: number;
    readonly version?: number;
  },
): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(document));
  const jsonPadded = padTo4(json, 0x20);
  const bin = options?.bin;
  const binPadded = bin ? padTo4(bin, 0x00) : null;

  const total = 12 + 8 + jsonPadded.length + (binPadded ? 8 + binPadded.length : 0);
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, options?.version ?? 2, true);
  view.setUint32(8, options?.declaredLength ?? total, true);
  view.setUint32(12, jsonPadded.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.set(jsonPadded, 20);
  if (binPadded) {
    const at = 20 + jsonPadded.length;
    view.setUint32(at, binPadded.length, true);
    view.setUint32(at + 4, 0x004e4942, true);
    bytes.set(binPadded, at + 8);
  }
  return bytes;
}

function padTo4(bytes: Uint8Array, filler: number): Uint8Array {
  const remainder = bytes.length % 4;
  if (remainder === 0) return bytes;
  const padded = new Uint8Array(bytes.length + (4 - remainder));
  padded.fill(filler);
  padded.set(bytes, 0);
  return padded;
}

/** One entry to put in a {@link zipArchive}. */
export interface ZipEntrySpec {
  readonly path: string;
  readonly data: Uint8Array | string;
  /** 0 stored (the default), 8 deflated. */
  readonly method?: 0 | 8;
  /** The unix mode in the high half of the external attributes — `0xa1ff` is a symlink. */
  readonly unixMode?: number;
  /** Lie about the uncompressed size in both headers, without changing the data. */
  readonly declaredUncompressedSize?: number;
}

/**
 * A real zip archive.
 *
 * CRC-32 is written as zero: nothing in `container.ts` verifies it, and computing
 * one here would be a test asserting a field no production code reads. Everything
 * the reader DOES read — signatures, offsets, lengths, names, external attributes —
 * is written exactly as a zip writer would.
 */
export function zipArchive(
  entries: readonly ZipEntrySpec[],
  options?: { readonly declaredTotalEntries?: number; readonly comment?: string },
): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const raw = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data;
    const method = entry.method ?? 0;
    const payload = method === 8 ? new Uint8Array(deflateRawSync(raw)) : raw;
    const name = encoder.encode(entry.path);
    const declared = entry.declaredUncompressedSize ?? raw.length;

    const local = new Uint8Array(30 + name.length + payload.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(8, method, true);
    localView.setUint32(18, payload.length, true);
    localView.setUint32(22, declared, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(payload, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 0x031e, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(10, method, true);
    centralView.setUint32(20, payload.length, true);
    centralView.setUint32(24, declared, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(38, (entry.unixMode ?? 0o100644) << 16, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const comment = encoder.encode(options?.comment ?? '');
  const eocd = new Uint8Array(22 + comment.length);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, options?.declaredTotalEntries ?? entries.length, true);
  eocdView.setUint16(10, options?.declaredTotalEntries ?? entries.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, offset, true);
  eocdView.setUint16(20, comment.length, true);
  eocd.set(comment, 22);

  return concat([...locals, ...centrals, eocd]);
}

/** A minimal 3MF: the OPC content types part plus a model part. */
export function threeMfArchive(
  modelXml: string,
  options?: { readonly extraEntries?: readonly ZipEntrySpec[]; readonly method?: 0 | 8 },
): Uint8Array {
  return zipArchive([
    {
      path: '[Content_Types].xml',
      data:
        '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>',
    },
    { path: '3D/3dmodel.model', data: modelXml, method: options?.method ?? 8 },
    ...(options?.extraEntries ?? []),
  ]);
}

/** A 3MF model part holding one mesh, in `unit`. */
export function threeMfModelXml(
  triangles: readonly Triangle[],
  options?: { readonly unit?: string; readonly itemTransform?: string; readonly texturePath?: string },
): string {
  const vertices: string[] = [];
  const index = new Map<string, number>();
  const faces: string[] = [];
  for (const triangle of triangles) {
    const ids = triangle.map((vertex) => {
      const key = vertex.join(',');
      const existing = index.get(key);
      if (existing !== undefined) return existing;
      const id = index.size;
      index.set(key, id);
      vertices.push(`<vertex x="${vertex[0]}" y="${vertex[1]}" z="${vertex[2]}"/>`);
      return id;
    });
    faces.push(`<triangle v1="${ids[0]}" v2="${ids[1]}" v3="${ids[2]}"/>`);
  }
  const texture = options?.texturePath
    ? `<m:texture2d id="9" path="${options.texturePath}" contenttype="image/png"/>`
    : '';
  const item = options?.itemTransform
    ? `<item objectid="1" transform="${options.itemTransform}"/>`
    : '<item objectid="1"/>';
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<model unit="${options?.unit ?? 'millimeter'}" xml:lang="en-US">` +
    `<resources>${texture}<object id="1" type="model"><mesh>` +
    `<vertices>${vertices.join('')}</vertices>` +
    `<triangles>${faces.join('')}</triangles>` +
    `</mesh></object></resources>` +
    `<build>${item}</build></model>`
  );
}

/** Concatenate byte runs. */
export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A PNG: the eight-byte signature and nothing that needs to be valid after it. */
export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
/** A JPEG SOI marker. */
export const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]);
/** A `%PDF-` header. */
export const PDF_BYTES = new TextEncoder().encode('%PDF-1.7\n%garbage\n');
/** An uncompressed Blender file's signature. */
export const BLEND_BYTES = new TextEncoder().encode('BLENDER-v303RENDH');
/** A gzip-wrapped Blender file: the compressor's magic, which identifies nothing. */
export const COMPRESSED_BLEND_BYTES = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 1, 2, 3, 4, 5, 6]);
