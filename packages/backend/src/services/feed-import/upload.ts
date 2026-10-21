/**
 * Uploaded feed artefacts (#63 §"Supported inputs" 6, security 3).
 *
 * ## The bytes go straight to storage and never through this API
 *
 * A feed is gigabytes, and every Oxy API hostname sits behind a proxy that
 * refuses a request body over 100 MB. So a client uploads a feed through a
 * SESSION (`upload-session.service.ts`): it PUTs presigned parts to Oxy Files'
 * storage, and the file is a PRIVATE file the Mercaria application owns. What
 * this module does is read it back — the first bytes, to refuse a container
 * before anything is accepted, and the whole object, for a preview, a
 * validation or a run. Every task reads the same object, so an upload no
 * longer goes with the task that received it.
 *
 * ## Path traversal is UNREPRESENTABLE, not scanned for
 *
 * The issue asks for archives to be scanned for "path tricks". Mercaria accepts
 * a plain file or a single-member gzip and nothing else, and a gzip member has
 * no entry NAME — so there is no path inside an accepted artefact for a
 * traversal to live in, and the scan has nothing it could miss. Every
 * multi-entry container is refused BY NAME, from its magic bytes rather than
 * from its extension, so renaming `feed.zip` to `feed.csv` changes nothing.
 *
 * The one name that does exist is the merchant's own filename, and it is
 * reduced to a LABEL: basename only, a positive character class, no `..`, no
 * leading dot, bounded. Nothing is stored under it — the stored artefact is an
 * Oxy file id, and storage is told a name Mercaria chose.
 *
 * ## An upload Oxy no longer serves is a REFUSAL, never an empty feed
 *
 * `upload_missing` names the remedy (upload it again) instead of importing zero
 * records and reporting a complete enumeration, which is the one shape that
 * retires a catalogue.
 */

import type { FeedCompression, FeedForbiddenContainer } from '@mercaria/shared-types';
import { mintPrivateDownloadUrls } from '../catalog-media/oxy-files.js';
import { FeedImportRefusal } from './errors.js';

/** The magic bytes of every container Mercaria refuses, plus the one it accepts. */
const CONTAINER_SIGNATURES: readonly {
  readonly container: FeedForbiddenContainer;
  readonly bytes: readonly number[];
  readonly offset: number;
}[] = [
  { container: 'zip', bytes: [0x50, 0x4b, 0x03, 0x04], offset: 0 },
  { container: 'zip', bytes: [0x50, 0x4b, 0x05, 0x06], offset: 0 },
  { container: 'rar', bytes: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07], offset: 0 },
  { container: 'seven_zip', bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], offset: 0 },
  { container: 'bzip2', bytes: [0x42, 0x5a, 0x68], offset: 0 },
  { container: 'xz', bytes: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], offset: 0 },
  // `ustar` at byte 257 is a tar header — the only reliable tar signature there
  // is, and the reason the check reads a 512-byte prefix rather than four bytes.
  { container: 'tar', bytes: [0x75, 0x73, 0x74, 0x61, 0x72], offset: 257 },
];

/** gzip's own two bytes. Used to CONFIRM a declared gzip, never to guess one. */
const GZIP_SIGNATURE = [0x1f, 0x8b];

/** How much of the artefact the container check reads. Enough to see a tar header. */
export const SIGNATURE_PREFIX_BYTES = 512;

/**
 * Refuse a multi-entry container, by name, from its bytes.
 *
 * Returns the compression the artefact actually IS, which is compared against
 * what the version declares: a gzip uploaded as `none` would be handed to the
 * CSV parser as binary and produce ten thousand malformed records rather than
 * one honest refusal.
 */
export function detectUploadContainer(prefix: Buffer): FeedCompression {
  for (const signature of CONTAINER_SIGNATURES) {
    if (prefix.length < signature.offset + signature.bytes.length) continue;
    const matches = signature.bytes.every(
      (byte, position) => prefix[signature.offset + position] === byte,
    );
    if (matches) {
      throw new FeedImportRefusal(
        'forbidden_container',
        `The upload is a ${signature.container} archive. Mercaria accepts a plain file or a ` +
          'single-member gzip: a multi-entry archive carries a path per member, and refusing ' +
          'the container is what makes a path-traversal trick unrepresentable rather than ' +
          'something a scanner has to catch. Upload the feed file itself.',
      );
    }
  }
  const isGzip = GZIP_SIGNATURE.every((byte, position) => prefix[position] === byte);
  return isGzip ? 'gzip' : 'none';
}

/** A filename reduced to a LABEL. Refuses rather than silently renaming. */
export function sanitizeUploadFilename(raw: string): string {
  const basename = raw.split(/[/\\]/u).pop() ?? '';
  const cleaned = basename
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters in a filename are the point
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .replace(/[^A-Za-z0-9 _.-]/gu, '_')
    .replace(/^[^A-Za-z0-9]+/u, '')
    .slice(0, 200)
    // Trailing whitespace LAST, after the slice: trimming first and then
    // slicing can put a space back on the end, and a filename ending in a space
    // is refused by the column's own shape CHECK.
    .trimEnd();
  if (cleaned === '' || cleaned.includes('..')) {
    throw new FeedImportRefusal(
      'configuration_incomplete',
      'The upload filename is not usable as a label. Rename the file to plain letters, digits, ' +
        'spaces, dots, hyphens and underscores.',
    );
  }
  return cleaned;
}

/** A stored upload, opened for reading. `close` releases the connection early. */
export interface OpenedUpload {
  readonly bytes: AsyncIterable<Uint8Array>;
  readonly close: () => void;
}

const MISSING_MESSAGE =
  'The uploaded feed file is no longer stored. Upload the file again and draft a version ' +
  'that cites the new upload.';

/** A short-lived URL for the stored file, or the refusal a re-upload fixes. */
async function storedUploadUrl(fileId: string): Promise<string> {
  let minted: Awaited<ReturnType<typeof mintPrivateDownloadUrls>>;
  try {
    minted = await mintPrivateDownloadUrls([fileId]);
  } catch (error) {
    // Oxy unreachable or refusing for now: retryable, and never a fact about
    // the file. The cause carries no URL (the adapter's errors never do).
    throw new FeedImportRefusal('upstream_unavailable', 'The feed file store is unavailable.', {
      retryable: true,
      cause: error,
    });
  }
  const url = minted.find((entry) => entry.id === fileId)?.url;
  // Absence is Oxy's answer for a file it will not serve: deleted, taken down,
  // or not this application's. Each is permanent for this upload.
  if (url === undefined) throw new FeedImportRefusal('upload_missing', MISSING_MESSAGE);
  return url;
}

async function fetchStored(
  url: string,
  init: { range?: string; signal?: AbortSignal },
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: 'error',
      ...(init.range === undefined ? {} : { headers: { range: init.range } }),
      ...(init.signal === undefined ? {} : { signal: init.signal }),
    });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new FeedImportRefusal('upstream_unavailable', 'Reading the stored feed file failed.', {
      retryable: true,
      cause: error,
    });
  }
  if (response.status === 404 || response.status === 410) {
    await response.body?.cancel().catch(() => undefined);
    throw new FeedImportRefusal('upload_missing', MISSING_MESSAGE);
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    // Includes a 403 from a URL that expired between minting and fetching —
    // the next attempt mints a fresh one, so it is retryable.
    throw new FeedImportRefusal(
      'upstream_unavailable',
      `Reading the stored feed file answered ${response.status}.`,
      { retryable: true },
    );
  }
  return response;
}

/**
 * Open a stored upload for reading, start to end.
 *
 * Streamed and never buffered — the caps live one layer up, in `bytes.ts`,
 * exactly as they do for a URL fetch, because an upload is not a trusted origin
 * just because a merchant authenticated to send it.
 */
export async function openStagedUpload(
  fileId: string,
  signal?: AbortSignal,
): Promise<OpenedUpload> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  const response = await fetchStored(await storedUploadUrl(fileId), {
    signal: controller.signal,
  });
  const body = response.body as unknown as AsyncIterable<Uint8Array>;
  return {
    bytes: body,
    close: () => {
      signal?.removeEventListener('abort', onAbort);
      controller.abort();
    },
  };
}

/**
 * Read `length` bytes of a stored upload from `offset`, exactly — the container
 * check's prefix and a proof of possession's range. Returns fewer bytes only
 * when the object itself is shorter.
 */
export async function readStoredUploadRange(
  fileId: string,
  offset: number,
  length: number,
): Promise<Buffer> {
  const response = await fetchStored(await storedUploadUrl(fileId), {
    range: `bytes=${offset}-${offset + length - 1}`,
  });
  const chunks: Buffer[] = [];
  let total = 0;
  // `fetchStored` refuses a response with no body, so there is always one here.
  const body = response.body;
  if (!body)
    throw new FeedImportRefusal('upstream_unavailable', 'The stored feed file had no body.', {
      retryable: true,
    });
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(Buffer.from(value));
      total += value.byteLength;
      // A server that ignored the Range header sends the whole object; stop at
      // what was asked for rather than reading gigabytes to compare 64 KiB.
      if (response.status !== 206 && total >= offset + length) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = Buffer.concat(chunks);
  return response.status === 206
    ? bytes.subarray(0, length)
    : bytes.subarray(offset, offset + length);
}
