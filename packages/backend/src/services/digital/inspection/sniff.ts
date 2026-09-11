/**
 * What a file ACTUALLY is, decided from its bytes (#1015 W4 requirement 1).
 *
 * ## The extension is a claim, and claims are what this module refuses to read
 *
 * `asset_files.format` and `.media_type` are written at upload from what the
 * creator's client said. A `.stl` whose bytes are a zip is not an STL with the
 * wrong name — it is a different thing, and every downstream decision that
 * believed the name was taken about a file that does not exist: the geometry
 * parser reads garbage, the viewer is handed a media type no renderer matches,
 * and the one consumer for whom it matters most is the authorizer, which serves
 * bytes with a `Content-Type` the upload chose (#1015 W12 threat 7 — an archive
 * announced as a model is how a parser gets pointed at an attacker's choice of
 * decoder).
 *
 * So this module is deliberately blind to the declared format. It takes bytes and
 * answers with a key from {@link ASSET_FORMAT_REGISTRY} or with nothing. The
 * comparison against what the creator claimed happens one layer up, in
 * `inspect.service.ts`, because "what is this" and "does that match the row" are
 * different questions and only the first one is about bytes.
 *
 * ## Order is load-bearing twice
 *
 * **Binary STL is checked before every text heuristic.** The format's 80-byte
 * header is free-form and exporters have been writing the word `solid` into it
 * since the 1990s, so a leading `solid` is NOT evidence of ASCII STL. What is
 * evidence is arithmetic: a binary STL's length is `84 + 50 × triangles` for the
 * count in its own header, which a text file matches only by coincidence.
 *
 * **A zip is identified as a zip, never as what it contains.** 3MF is a zip with a
 * named part inside it, and deciding that here would mean this module inflating
 * attacker bytes. It does not: `container.ts` refines a zip to `3mf` by reading
 * the central directory under the ceilings in `limits.ts`, and the refinement is a
 * separate, separately-tested step.
 *
 * ## Nothing here reads more than the probe window
 *
 * Every detector looks at {@link PROBE_BYTES} from the front of the file, plus —
 * for the STL length formula alone — the total length, which is a number already
 * in hand. A sniffer that scanned whole files would be the largest unbounded read
 * in the pipeline and it would buy nothing: a format that cannot be recognized
 * from its first 64 KiB is not a format with a magic number.
 */

import { assetFormatCapability } from '@mercaria/shared-types';

/**
 * How much of the front of a file the detectors see — 64 KiB.
 *
 * Generous for a magic number (the longest below is 21 bytes) and sized for the
 * two heuristics that are not magic numbers: an OBJ or a glTF may open with a
 * licence header the creator's exporter wrote, and the first line that identifies
 * the format can sit well past the start.
 */
export const PROBE_BYTES = 64 * 1024;

/** What the bytes say, or that they say nothing this registry knows. */
export type SniffResult =
  | {
      readonly kind: 'identified';
      /** A key of {@link ASSET_FORMAT_REGISTRY}. */
      readonly formatKey: string;
      /** The registry's media type for that key — the VERIFIED one. */
      readonly mediaType: string;
      /** What was recognized, for the creator's screen and the operator's log. */
      readonly evidence: string;
    }
  | {
      readonly kind: 'unidentified';
      readonly evidence: string;
    };

/** A byte-prefix magic number and the registry key it identifies. */
interface MagicSignature {
  readonly formatKey: string;
  readonly prefix: readonly number[];
  readonly evidence: string;
}

/**
 * The prefix magics, longest-first.
 *
 * Longest-first matters for nothing in this table today (none is a prefix of
 * another) and is kept because the first table where one IS a prefix of another
 * would otherwise resolve by declaration order, which is not a property anybody
 * would think to assert.
 */
const MAGIC_SIGNATURES: readonly MagicSignature[] = [
  {
    // `Kaydara FBX Binary  \0` — twenty bytes plus the NUL. The two spaces are
    // part of the signature, not formatting.
    formatKey: 'fbx',
    prefix: [
      0x4b, 0x61, 0x79, 0x64, 0x61, 0x72, 0x61, 0x20, 0x46, 0x42, 0x58, 0x20, 0x42, 0x69, 0x6e,
      0x61, 0x72, 0x79, 0x20, 0x20, 0x00,
    ],
    evidence: 'Kaydara FBX binary signature',
  },
  {
    formatKey: 'png',
    prefix: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    evidence: 'PNG signature',
  },
  {
    // `BLENDER` — and the compressed variants deliberately are NOT listed; see
    // {@link sniffFormat}.
    formatKey: 'blend',
    prefix: [0x42, 0x4c, 0x45, 0x4e, 0x44, 0x45, 0x52],
    evidence: 'Blender signature',
  },
  { formatKey: 'pdf', prefix: [0x25, 0x50, 0x44, 0x46, 0x2d], evidence: '%PDF- header' },
  { formatKey: 'glb', prefix: [0x67, 0x6c, 0x54, 0x46], evidence: 'glTF binary magic' },
  { formatKey: 'zip', prefix: [0x50, 0x4b, 0x03, 0x04], evidence: 'zip local file header' },
  {
    // An EMPTY archive is nothing but an end-of-central-directory record, and a
    // 3MF is never empty — but a zip that is empty is still a zip, and calling it
    // unidentified would report `corrupt` for a file whose only sin is holding
    // nothing.
    formatKey: 'zip',
    prefix: [0x50, 0x4b, 0x05, 0x06],
    evidence: 'zip end-of-central-directory record',
  },
  {
    formatKey: 'zip',
    prefix: [0x50, 0x4b, 0x07, 0x08],
    evidence: 'spanned zip signature',
  },
  { formatKey: 'jpeg', prefix: [0xff, 0xd8, 0xff], evidence: 'JPEG SOI marker' },
];

/** Whether `bytes` opens with `prefix`. */
function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[index] !== prefix[index]) return false;
  }
  return true;
}

/**
 * Whether `bytes` is a binary STL, by the length formula in its own header.
 *
 * `84 + 50 × triangleCount === length` — 80 bytes of free-form header, a
 * `uint32le` count, then fifty bytes per facet. The equality is checked and NOT
 * the inequality: a declared count LARGER than the bytes is a lie the geometry
 * parser must refuse (and does), while a count smaller than the bytes is a file
 * with trailing junk, which real exporters produce and which is still a binary
 * STL. Both are handled in `stl.ts`; what this decides is only whether to point
 * the binary reader at it.
 */
function looksLikeBinaryStl(bytes: Uint8Array, totalLength: number): boolean {
  if (totalLength < 84 || bytes.length < 84) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, 84);
  const declared = view.getUint32(80, true);
  return 84 + declared * 50 === totalLength;
}

/**
 * The probe window decoded as UTF-8, or `null` when it is not text at all.
 *
 * A TRUNCATED probe is cut back to its last complete line. Without that, the
 * final line of the window is a fragment of whatever came next, and the OBJ
 * detector — which treats one unrecognized line as disqualifying — would reject a
 * large OBJ on a byte boundary. A detector whose answer depends on where the
 * window happened to land is worse than a weaker detector.
 */
function decodeTextProbe(bytes: Uint8Array): string | null {
  const window = bytes.subarray(0, Math.min(bytes.length, PROBE_BYTES));
  // A NUL in the first window is the cheapest reliable "this is binary" test, and
  // every text format here is NUL-free by definition.
  for (let index = 0; index < window.length; index += 1) {
    if (window[index] === 0x00) return null;
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(window);
  if (window.length === bytes.length) return text;
  const lastNewline = text.lastIndexOf('\n');
  return lastNewline === -1 ? text : text.slice(0, lastNewline);
}

/** Whether the probe text parses as a glTF JSON document's opening. */
function looksLikeGltfJson(text: string): boolean {
  const head = text.replace(/^\uFEFF/u, '').trimStart();
  if (!head.startsWith('{')) return false;
  // `asset.version` is REQUIRED by the glTF spec, so its absence in the first
  // window is as close to proof as a prefix can get. Deliberately a flat key
  // search rather than a JSON parse: the probe is a fragment, so parsing it would
  // fail for every document larger than the window.
  return /"asset"\s*:/u.test(head) && /"version"\s*:/u.test(head);
}

/** Whether the probe text opens an ASCII STL. */
function looksLikeAsciiStl(text: string): boolean {
  const head = text.trimStart();
  if (!/^solid\b/iu.test(head)) return false;
  // `solid` alone is not enough — it is also the first word of many binary STL
  // headers, which is why this runs after the length formula, and of at least one
  // shader language. A facet declaration is the format.
  return /^\s*facet\s+normal\b/imu.test(head) || /^\s*endsolid\b/imu.test(head);
}

/** Whether the probe text is an ASCII FBX. */
function looksLikeAsciiFbx(text: string): boolean {
  return /FBXHeaderExtension\s*:/u.test(text);
}

/**
 * Whether the probe text is an OBJ.
 *
 * OBJ has no magic number at all, so this is a statement about LINE SHAPES and
 * is the weakest detector here. It requires a geometric statement — a `v` or an
 * `f` — and not merely one of the bookkeeping directives, because `mtllib` and
 * `usemtl` also appear in `.mtl` files and `o`/`g` are one letter.
 */
const OBJ_DIRECTIVE =
  /^(vp|o|g|s|l|p|usemtl|mtllib|usemap|maplib|bevel|c_interp|d_interp|lod|shadow_obj|trace_obj|ctech|stech|cstype|deg|bmat|step|curv|curv2|surf|parm|trim|hole|scrv|sp|end|con|mg)(\s|$)/u;

function looksLikeObj(text: string): boolean {
  let sawGeometry = false;
  let sawDirective = false;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (/^(v|vn|vt|f)\s/u.test(line)) {
      if (/^(v|f)\s/u.test(line)) sawGeometry = true;
      sawDirective = true;
      continue;
    }
    if (OBJ_DIRECTIVE.test(line)) {
      sawDirective = true;
      continue;
    }
    // An unrecognized non-comment line. OBJ is a closed directive vocabulary, so
    // one unknown line is enough to say this is some other text format.
    return false;
  }
  return sawGeometry && sawDirective;
}

/**
 * What `bytes` is.
 *
 * `totalLength` is passed separately because the caller may hold a TRUNCATED
 * probe: the only detector that needs the whole-file length is the STL formula,
 * and it needs the number rather than the bytes. Passing the real length with a
 * short buffer is what lets a future streaming caller sniff without reading 256
 * MiB, and passing `bytes.length` is correct for every caller that has the file.
 *
 * A COMPRESSED `.blend` is deliberately unidentified. Blender writes gzip- and
 * zstd-wrapped files whose magic is the compressor's, so identifying one would
 * mean decompressing an attacker's stream to look at what is inside — for a format
 * the registry already declares `geometryMeasurable: false`. The honest outcome is
 * `unidentified`, which `inspect.service.ts` resolves against a non-measurable
 * declared format as `unsupported` rather than as a mismatch.
 */
export function sniffFormat(bytes: Uint8Array, totalLength: number = bytes.length): SniffResult {
  for (const signature of MAGIC_SIGNATURES) {
    if (!startsWith(bytes, signature.prefix)) continue;
    return identify(signature.formatKey, signature.evidence);
  }

  if (looksLikeBinaryStl(bytes, totalLength)) {
    return identify('stl', 'binary STL length formula (84 + 50 x triangles)');
  }

  const text = decodeTextProbe(bytes);
  if (text === null) {
    return { kind: 'unidentified', evidence: 'no known magic number, and the probe is not text' };
  }
  if (looksLikeGltfJson(text)) return identify('gltf', 'glTF JSON with an asset.version member');
  if (looksLikeAsciiFbx(text)) return identify('fbx', 'ASCII FBX header extension');
  if (looksLikeAsciiStl(text)) return identify('stl', 'ASCII STL solid/facet declarations');
  if (looksLikeObj(text)) return identify('obj', 'OBJ vertex and face directives');

  return { kind: 'unidentified', evidence: 'no known magic number and no recognized text format' };
}

/**
 * Resolve a sniffed key through the registry, so the media type is the REGISTRY's.
 *
 * A key this module recognizes but the registry does not carry is reported as
 * unidentified rather than as itself. That is not defensive noise: the registry is
 * per-vertical and a deployment may drop a format row, at which point a file of
 * that format genuinely is something Mercaria does not know — and inventing a
 * media type here would hand the viewer a type no capability row backs.
 */
function identify(formatKey: string, evidence: string): SniffResult {
  const capability = assetFormatCapability(formatKey);
  if (!capability) {
    return {
      kind: 'unidentified',
      evidence: `${evidence}, but '${formatKey}' is not in the format registry`,
    };
  }
  return { kind: 'identified', formatKey, mediaType: capability.mediaType, evidence };
}
