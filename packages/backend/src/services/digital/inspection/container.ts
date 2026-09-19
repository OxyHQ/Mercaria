/**
 * Opening a zip safely — the entries, never the archive's word for them
 * (#1015 W12 threats 5 and 6).
 *
 * A container is the one format family whose CONTENTS are unknown until it is
 * opened, which `ASSET_FORMAT_REGISTRY` records as `container: true` and which is
 * why `3mf`, `zip` and `blend` carry the flag. Everything this module does follows
 * from one rule: **the central directory is a claim, and a claim is checked before
 * it is acted on.**
 *
 * So the refusals happen in this order, and none of them inflates anything:
 *
 * 1. **Zip64 is refused outright.** It exists to carry more than 4 GiB or more
 *    than 65 535 entries, and both are already above the ceilings in `limits.ts` —
 *    so supporting it would mean writing a second offset parser whose only
 *    reachable inputs are files this pipeline refuses anyway.
 * 2. **The entry count** against {@link MAX_CONTAINER_ENTRIES}, before any entry
 *    record is read. A header claiming four million entries is an allocation
 *    instruction.
 * 3. **Each entry's path**: length, segment count, absolute paths, `..` escapes
 *    and SYMLINKS. A symlink in a zip is the traversal that survives extraction —
 *    the path is innocent and the target is somebody else's private key — and it is
 *    detected from the unix mode in the external attributes, which is the only
 *    place it is recorded.
 * 4. **The declared expansion**, per entry and in total, and the declared RATIO.
 *    A zip bomb advertises itself in the central directory; refusing it is reading
 *    its advertisement, not surviving it.
 *
 * Only then may a caller ask for ONE entry's bytes, and `inflateRawSync` is given
 * {@link MAX_CONTAINER_ENTRY_EXPANDED_BYTES} as `maxOutputLength` — a hard
 * allocation ceiling in the zlib binding, verified to hold under both Bun and
 * Node, so a LYING declared size fails with `ERR_BUFFER_TOO_LARGE` instead of
 * expanding. Belt and braces: the declared size was already checked, and the
 * actual output length is compared against it afterwards.
 *
 * ## Nesting is impossible rather than bounded
 *
 * {@link MAX_CONTAINER_DEPTH} is 1 and this module has no recursion to bound: the
 * only caller that reads a member is `threemf.ts`, which reads exactly one part at
 * a path the 3MF spec fixes, and which refuses a part that is itself an archive.
 * A zip of zips is therefore inventoried and left closed.
 */

import { inflateRawSync } from 'node:zlib';
import {
  MAX_CONTAINER_ENTRIES,
  MAX_CONTAINER_ENTRY_EXPANDED_BYTES,
  MAX_CONTAINER_EXPANSION_RATIO,
  MAX_CONTAINER_PATH_BYTES,
  MAX_CONTAINER_PATH_SEGMENTS,
  MAX_CONTAINER_TOTAL_EXPANDED_BYTES,
} from './limits.js';
import {
  corruptFile,
  refusedTooLarge,
  unsupportedFormat,
  type InspectionOutcome,
} from './result.js';
import type { InspectionBudget } from './budget.js';

/** One central-directory record, validated. */
export interface ContainerEntry {
  /** The path as stored, with separators normalized to `/`. */
  readonly path: string;
  /** Lowercased {@link path}, for spec-fixed lookups. */
  readonly lookupPath: string;
  /** 0 stored, 8 deflated. Anything else is refused when the bytes are asked for. */
  readonly method: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
  readonly isDirectory: boolean;
}

/** A safe inventory, or the verdict that refuses the archive. */
export type ContainerOpen =
  | { readonly ok: true; readonly entries: readonly ContainerEntry[] }
  | { readonly ok: false; readonly outcome: InspectionOutcome };

/** One entry's bytes, or the verdict that refuses them. */
export type ContainerEntryRead =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly outcome: InspectionOutcome };

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_BYTES = 22;
/** A zip comment is a `uint16` length, so the record sits within this of the end. */
const EOCD_SEARCH_WINDOW = 0xffff + EOCD_MIN_BYTES;
const ZIP64_ENTRY_SENTINEL = 0xffff;
const ZIP64_OFFSET_SENTINEL = 0xffffffff;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
/** `S_IFLNK` in the high half of the external attributes. */
const UNIX_SYMLINK_MODE = 0xa000;
const UNIX_FILE_TYPE_MASK = 0xf000;
/** Fixed record sizes: the central header before its path, and the local one. */
const CENTRAL_HEADER_BYTES = 46;
const LOCAL_HEADER_BYTES = 30;

/**
 * Read and validate a zip's central directory.
 *
 * Nothing is inflated and no local header is touched: the inventory is entirely
 * the central directory, which is the only part of a zip that is supposed to be
 * authoritative and is small enough to bound.
 */
export function openZipContainer(bytes: Uint8Array, budget: InspectionBudget): ContainerOpen {
  if (bytes.length < EOCD_MIN_BYTES) {
    return refuse(corruptFile(`${bytes.length} bytes is shorter than a zip end record`));
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const eocd = findEndOfCentralDirectory(view, bytes.length);
  if (eocd === null) {
    return refuse(corruptFile('no zip end-of-central-directory record'));
  }

  const totalEntries = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);

  if (totalEntries === ZIP64_ENTRY_SENTINEL || centralOffset === ZIP64_OFFSET_SENTINEL) {
    return refuse(
      refusedTooLarge(
        'a zip64 archive; its own ceilings start above the inspection ceilings in limits.ts',
      ),
    );
  }
  if (totalEntries > MAX_CONTAINER_ENTRIES) {
    return refuse(
      refusedTooLarge(`${totalEntries} entries, above the ${MAX_CONTAINER_ENTRIES}-entry ceiling`),
    );
  }
  if (centralOffset + centralSize > bytes.length) {
    return refuse(corruptFile('the central directory runs past the end of the file'));
  }

  const entries: ContainerEntry[] = [];
  let totalExpanded = 0;
  let offset = centralOffset;

  for (let index = 0; index < totalEntries; index += 1) {
    if (budget.expiredOnStride(index)) {
      return refuse(
        refusedTooLarge('the inspection time budget was exhausted reading the archive'),
      );
    }
    if (offset + CENTRAL_HEADER_BYTES > bytes.length) {
      return refuse(corruptFile(`entry ${index}'s record runs past the end of the file`));
    }
    if (view.getUint32(offset, true) !== CENTRAL_SIGNATURE) {
      return refuse(corruptFile(`entry ${index} has no central-directory signature`));
    }
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const externalAttributes = view.getUint32(offset + 38, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);

    if (nameLength > MAX_CONTAINER_PATH_BYTES) {
      return refuse(
        refusedTooLarge(
          `entry ${index} has a ${nameLength}-byte path, above the ` +
            `${MAX_CONTAINER_PATH_BYTES}-byte ceiling`,
        ),
      );
    }
    const nameEnd = offset + CENTRAL_HEADER_BYTES + nameLength;
    if (nameEnd > bytes.length) {
      return refuse(corruptFile(`entry ${index}'s path runs past the end of the file`));
    }
    const rawPath = new TextDecoder('utf-8', { fatal: false }).decode(
      bytes.subarray(offset + CENTRAL_HEADER_BYTES, nameEnd),
    );
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    if ((unixMode & UNIX_FILE_TYPE_MASK) === UNIX_SYMLINK_MODE) {
      return refuse(
        corruptFile(
          `entry '${pathForMessage(rawPath)}' is a symlink; an archive of links is refused`,
        ),
      );
    }
    const pathProblem = pathRefusal(rawPath);
    if (pathProblem) {
      return refuse(corruptFile(`entry '${pathForMessage(rawPath)}': ${pathProblem}`));
    }

    if (uncompressedSize > MAX_CONTAINER_ENTRY_EXPANDED_BYTES) {
      return refuse(
        refusedTooLarge(
          `entry '${pathForMessage(rawPath)}' declares ${uncompressedSize} bytes, above the ` +
            `${MAX_CONTAINER_ENTRY_EXPANDED_BYTES}-byte per-entry ceiling`,
        ),
      );
    }
    if (compressedSize > 0 && uncompressedSize / compressedSize > MAX_CONTAINER_EXPANSION_RATIO) {
      return refuse(
        refusedTooLarge(
          `entry '${pathForMessage(rawPath)}' declares a ` +
            `${Math.round(uncompressedSize / compressedSize)}:1 expansion, above the ` +
            `${MAX_CONTAINER_EXPANSION_RATIO}:1 ceiling`,
        ),
      );
    }
    totalExpanded += uncompressedSize;
    if (totalExpanded > MAX_CONTAINER_TOTAL_EXPANDED_BYTES) {
      return refuse(
        refusedTooLarge(
          `the archive declares more than ${MAX_CONTAINER_TOTAL_EXPANDED_BYTES} expanded bytes`,
        ),
      );
    }

    const normalized = rawPath.replace(/\\/gu, '/');
    entries.push({
      path: normalized,
      lookupPath: normalized.toLowerCase(),
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      isDirectory: normalized.endsWith('/'),
    });
    offset = nameEnd + extraLength + commentLength;
  }

  return { ok: true, entries };
}

/**
 * Whether a validated archive is a 3MF rather than a plain zip.
 *
 * A 3MF is an OPC package: `[Content_Types].xml` at the root and a 3D model part,
 * conventionally `3D/3dmodel.model`. BOTH are required here rather than just the
 * model part, because a creator's plain zip of loose parts could contain a
 * `.model` file without being a package — and mis-refining a zip into a 3MF would
 * make `inspect.service.ts` report a format mismatch against a correctly declared
 * `.zip`.
 */
export function refineZipContainerFormat(entries: readonly ContainerEntry[]): 'zip' | '3mf' {
  const hasContentTypes = entries.some((entry) => entry.lookupPath === '[content_types].xml');
  return hasContentTypes && findThreeMfModelPart(entries) !== null ? '3mf' : 'zip';
}

/** The 3MF model part, preferring the conventional path. `null` when there is none. */
export function findThreeMfModelPart(entries: readonly ContainerEntry[]): ContainerEntry | null {
  const conventional = entries.find((entry) => entry.lookupPath === '3d/3dmodel.model');
  if (conventional) return conventional;
  return entries.find((entry) => !entry.isDirectory && entry.lookupPath.endsWith('.model')) ?? null;
}

/**
 * ONE entry's bytes.
 *
 * The local header is re-read and re-validated rather than trusted from the
 * central directory, because the two can disagree and the local one is what the
 * data actually follows. The declared size bounds the inflate AND is compared
 * against the result, so a central directory that under-declares a bomb is caught
 * by `maxOutputLength` and one that over-declares is caught by the comparison.
 */
export function readContainerEntry(
  bytes: Uint8Array,
  entry: ContainerEntry,
): ContainerEntryRead {
  if (entry.isDirectory) {
    return refuse(corruptFile(`entry '${pathForMessage(entry.path)}' is a directory`));
  }
  if (entry.localHeaderOffset + LOCAL_HEADER_BYTES > bytes.length) {
    return refuse(corruptFile(`entry '${pathForMessage(entry.path)}' has no local header`));
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(entry.localHeaderOffset, true) !== LOCAL_SIGNATURE) {
    return refuse(
      corruptFile(`entry '${pathForMessage(entry.path)}' has no local file header signature`),
    );
  }
  const nameLength = view.getUint16(entry.localHeaderOffset + 26, true);
  const extraLength = view.getUint16(entry.localHeaderOffset + 28, true);
  const dataStart = entry.localHeaderOffset + LOCAL_HEADER_BYTES + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > bytes.length) {
    return refuse(
      corruptFile(`entry '${pathForMessage(entry.path)}' declares data past the end of the file`),
    );
  }
  const payload = bytes.subarray(dataStart, dataEnd);

  if (entry.method === METHOD_STORE) {
    if (payload.length !== entry.uncompressedSize) {
      return refuse(
        corruptFile(
          `stored entry '${pathForMessage(entry.path)}' holds ${payload.length} bytes and ` +
            `declares ${entry.uncompressedSize}`,
        ),
      );
    }
    return { ok: true, bytes: payload };
  }
  if (entry.method !== METHOD_DEFLATE) {
    return refuse(
      unsupportedFormat(
        `entry '${pathForMessage(entry.path)}' uses compression method ${entry.method}; ` +
          'only stored and deflated entries are read',
      ),
    );
  }

  let inflated: Buffer;
  try {
    inflated = inflateRawSync(payload, {
      // The hard ceiling. `zlib` throws `ERR_BUFFER_TOO_LARGE` rather than
      // allocating, which is what makes a lying declared size harmless.
      maxOutputLength: MAX_CONTAINER_ENTRY_EXPANDED_BYTES,
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ERR_BUFFER_TOO_LARGE') {
      return refuse(
        refusedTooLarge(
          `entry '${pathForMessage(entry.path)}' expands past the ` +
            `${MAX_CONTAINER_ENTRY_EXPANDED_BYTES}-byte ceiling`,
        ),
      );
    }
    return refuse(
      corruptFile(
        `entry '${pathForMessage(entry.path)}' does not inflate: ${(err as Error).message}`,
      ),
    );
  }
  if (inflated.length !== entry.uncompressedSize) {
    return refuse(
      corruptFile(
        `entry '${pathForMessage(entry.path)}' inflated to ${inflated.length} bytes and ` +
          `declares ${entry.uncompressedSize}`,
      ),
    );
  }
  return { ok: true, bytes: new Uint8Array(inflated) };
}

/**
 * The verdict for a plain zip: safe, and holding nothing this processor measures.
 *
 * `unsupported` and not `measured`, because an archive's entry count is not a
 * geometry measurement and there is no column for it. What the detail records is
 * that the SAFETY checks ran and passed, which is the part of a container
 * inspection that has value — and it is recorded against the processor version
 * that ran them.
 */
export function inspectZipContainer(
  bytes: Uint8Array,
  budget: InspectionBudget,
): InspectionOutcome {
  const opened = openZipContainer(bytes, budget);
  if (opened.ok === false) return opened.outcome;
  const files = opened.entries.filter((entry) => !entry.isDirectory).length;
  return unsupportedFormat(
    `a zip archive with ${files} file entr${files === 1 ? 'y' : 'ies'}; its paths and declared ` +
      'expansion were checked and accepted, and no geometry format inside it is measured',
  );
}

/** Why a path is refused, or `null` when it is acceptable. */
function pathRefusal(rawPath: string): string | null {
  if (rawPath === '') return 'an empty path';
  if (hasControlCharacter(rawPath)) return 'a control character in the path';
  const normalized = rawPath.replace(/\\/gu, '/');
  if (normalized.startsWith('/')) return 'an absolute path';
  if (/^[a-z]:\//iu.test(normalized)) return 'a drive-letter absolute path';
  const segments = normalized.split('/');
  if (segments.length > MAX_CONTAINER_PATH_SEGMENTS) {
    return `${segments.length} path segments, above the ${MAX_CONTAINER_PATH_SEGMENTS} ceiling`;
  }
  let depth = 0;
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      depth -= 1;
      if (depth < 0) return 'a path that escapes the archive root';
      continue;
    }
    depth += 1;
  }
  return null;
}

/**
 * Whether a path holds a C0 control character.
 *
 * A code-point scan rather than a character-class regex, because a regex literal
 * holding control characters is itself unreadable and `no-control-regex` is right
 * to refuse it. The comparison is on code units, which is correct here: every
 * control character is ASCII and no surrogate pair can produce one.
 */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** An entry path, bounded and control-character-free, for a message a human reads. */
function pathForMessage(rawPath: string): string {
  let cleaned = '';
  for (let index = 0; index < rawPath.length && cleaned.length < 100; index += 1) {
    const code = rawPath.charCodeAt(index);
    cleaned += code < 0x20 || code === 0x7f ? '?' : rawPath[index];
  }
  return cleaned.length < rawPath.length ? `${cleaned}...` : cleaned;
}

/** A refusal, as the shape both result types share. */
function refuse(outcome: InspectionOutcome): { readonly ok: false; readonly outcome: InspectionOutcome } {
  return { ok: false, outcome };
}

/**
 * The offset of the end-of-central-directory record, searching backwards.
 *
 * The record must END at the file's end, comment included. Without that check a
 * byte sequence inside a compressed stream that happens to match the signature is
 * read as the directory, and every offset derived from it is attacker-chosen.
 */
function findEndOfCentralDirectory(view: DataView, length: number): number | null {
  const earliest = Math.max(0, length - EOCD_SEARCH_WINDOW);
  for (let offset = length - EOCD_MIN_BYTES; offset >= earliest; offset -= 1) {
    if (view.getUint32(offset, true) !== EOCD_SIGNATURE) continue;
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + EOCD_MIN_BYTES + commentLength === length) return offset;
  }
  return null;
}
