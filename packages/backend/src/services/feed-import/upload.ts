/**
 * Explicitly uploaded feed artefacts (#63 §"Supported inputs" 6, security 3).
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
 * leading dot, bounded. The stored artefact is never named after it —
 * `storage_key` is minted from CSPRNG bytes and is the only thing that reaches
 * the filesystem, so even a filename that somehow passed the CHECK could not
 * decide where a byte lands.
 *
 * ## The bytes are EPHEMERAL and the domain says so
 *
 * Mercaria has no blob store of its own, so a staged upload lives on the disk of
 * the ECS task that received it. `feed_uploads.status = 'missing'` is a real
 * state rather than an error path: a run whose artefact went with the task that
 * took it refuses with `upload_missing`, which is retryable and instructs a
 * re-upload — instead of importing zero records and reporting a complete
 * enumeration, which is the one shape that retires a catalogue. Durable object
 * storage is the obvious later improvement and it changes this file and nothing
 * else.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { FeedCompression, FeedForbiddenContainer } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
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
const SIGNATURE_PREFIX_BYTES = 512;

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

/** Where a staged artefact lives. Minted from CSPRNG bytes, never from a name. */
export function mintUploadStorageKey(): string {
  return randomBytes(24).toString('base64url');
}

function uploadDirectory(): string {
  return join(config.feedImport.stagingDir, 'uploads');
}

export function uploadPath(storageKey: string): string {
  if (!/^[A-Za-z0-9_-]{8,128}$/u.test(storageKey)) {
    // The CHECK enforces the same shape; this refuses a value that reached here
    // some other way, before it becomes a path.
    throw new FeedImportRefusal('upload_missing', 'The stored upload reference is not usable.');
  }
  return join(uploadDirectory(), storageKey);
}

/** What a staged upload turned out to be. */
export interface StagedUpload {
  readonly storageKey: string;
  readonly byteSize: number;
  readonly contentDigest: string;
  readonly compression: FeedCompression;
}

/**
 * Write an uploaded artefact to the task's own disk, bounded.
 *
 * The container check runs on the FIRST bytes, before the rest is written, so a
 * zip is refused without ever being fully stored. The download cap applies here
 * exactly as it does to a URL fetch — an upload is not a trusted origin just
 * because a merchant authenticated to send it.
 */
export async function stageUploadedFeed(
  bytes: AsyncIterable<Uint8Array>,
  declaredCompression: FeedCompression,
): Promise<StagedUpload> {
  await mkdir(uploadDirectory(), { recursive: true });
  const storageKey = mintUploadStorageKey();
  const target = uploadPath(storageKey);
  const hash = createHash('sha256');
  const handle = createWriteStream(target);

  let byteSize = 0;
  let prefix = Buffer.alloc(0);
  let detected: FeedCompression | null = null;

  try {
    for await (const chunk of bytes) {
      const buffer = Buffer.from(chunk);
      byteSize += buffer.byteLength;
      if (byteSize > config.feedImport.maxDownloadBytes) {
        throw new FeedImportRefusal(
          'download_too_large',
          `The upload exceeded the ${config.feedImport.maxDownloadBytes}-byte limit.`,
        );
      }
      if (detected === null) {
        prefix = Buffer.concat([prefix, buffer]);
        if (prefix.length >= SIGNATURE_PREFIX_BYTES) detected = detectUploadContainer(prefix);
      }
      hash.update(buffer);
      if (!handle.write(buffer)) {
        await new Promise<void>((resolve) =>
          handle.once('drain', () => {
            resolve();
          }),
        );
      }
    }
    if (detected === null) detected = detectUploadContainer(prefix);
    if (detected !== declaredCompression) {
      throw new FeedImportRefusal(
        'unsupported_format',
        `The upload is ${detected === 'gzip' ? 'gzip-compressed' : 'not compressed'} but the ` +
          `mapping version declares ${declaredCompression}. A mismatch is handed to the parser ` +
          'as binary and produces a report full of malformed records instead of one refusal.',
      );
    }
  } catch (error: unknown) {
    handle.destroy();
    await unlink(target).catch(() => undefined);
    throw error;
  }

  await new Promise<void>((resolve, reject) => {
    handle.end(() => {
      resolve();
    });
    handle.once('error', reject);
  });

  return {
    storageKey,
    byteSize,
    contentDigest: hash.digest('hex'),
    compression: detected,
  };
}

/** Read a staged artefact back, or refuse with the reason a re-upload fixes. */
export async function openStagedUpload(storageKey: string): Promise<AsyncIterable<Uint8Array>> {
  const path = uploadPath(storageKey);
  try {
    await stat(path);
  } catch {
    throw new FeedImportRefusal(
      'upload_missing',
      'The uploaded feed artefact is no longer on this task. Uploads are staged on the disk of ' +
        'the task that received them and do not survive a deployment; re-upload the file.',
    );
  }
  return createReadStream(path);
}
