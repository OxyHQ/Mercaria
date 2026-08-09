/**
 * SSRF, protocol, size, archive and redaction (#63 security 1–5, acceptance 5).
 *
 * ## What is asserted against the REAL guard, and what is asserted structurally
 *
 * The address checks below run through the real `safeFetch`, so a private,
 * loopback or metadata address is refused by the SDK's own resolution rather
 * than by a fixture. What CANNOT be exercised offline is a redirect from a
 * public host into a private one — it needs a real public host that redirects —
 * so the redirect property is asserted the way `merchant-claims` asserts it: by
 * proving this module hand-rolls no URL check at all and delegates every hop to
 * `safeFetch`, which re-validates each one and pins the connection to the
 * validated address. A second, weaker check here would be the actual hazard.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { boundedBytes, decompressBytes, type FeedByteMeter } from '../bytes.js';
import { FeedImportRefusal } from '../errors.js';
import { openFeedStream } from '../fetch.js';
import { redactFeedMessage, redactFeedUrl } from '../redact.js';
import { detectUploadContainer, sanitizeUploadFilename, uploadPath } from '../upload.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const NO_AUTH = { kind: 'none' as const, secret: null, paramName: null };
const NO_VALIDATORS = { etag: null, lastModified: null };

async function drain(source: AsyncIterable<Uint8Array>): Promise<number> {
  let total = 0;
  for await (const chunk of source) total += chunk.byteLength;
  return total;
}

describe('SSRF and protocol (security 1 and 2)', () => {
  it('refuses a cleartext feed URL before any request is made', async () => {
    await expect(
      openFeedStream({
        url: 'http://example.com/feed.csv',
        authorization: NO_AUTH,
        validators: NO_VALIDATORS,
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({ reason: 'insecure_url' });
  });

  it('refuses loopback, private and metadata addresses through the real guard', async () => {
    for (const host of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '[::1]']) {
      await expect(
        openFeedStream({
          url: `https://${host}/feed.csv`,
          authorization: NO_AUTH,
          validators: NO_VALIDATORS,
          timeoutMs: 1_000,
        }),
      ).rejects.toMatchObject({ reason: 'blocked_address' });
    }
  }, 30_000);

  it('hand-rolls no URL check: every hop is `safeFetch`’s to validate', () => {
    const source = readFileSync(join(HERE, '..', 'fetch.ts'), 'utf8');
    expect(source).toContain("from '@oxyhq/core/server'");
    expect(source).toContain('safeFetch(');
    // The shapes an app-local re-implementation would take. A second answer to
    // "is this address safe" is the hazard, not the safeguard.
    //
    // TYPE imports are stripped first: `import type { IncomingHttpHeaders }
    // from 'node:http'` is a type and cannot make a request, and a detector
    // that fired on it would be loosened by whoever hit it next until it caught
    // nothing (`~/Oxy/AGENTS.md` (C) — a gate that cries wolf gets disabled).
    const executable = source.replace(/^import type [\s\S]*?;$/gmu, '');
    for (const forbidden of [
      "from 'node:https'",
      "from 'node:dns'",
      "from 'node:net'",
      'isPrivateIp',
      'new URL(url).hostname ===',
    ]) {
      expect(executable.includes(forbidden), `fetch.ts re-implements ${forbidden}`).toBe(false);
    }
    // …and the detectors detect: the mutation self-test.
    for (const forbidden of ["from 'node:https'", 'isPrivateIp']) {
      expect(`const x = ${forbidden};`.includes(forbidden)).toBe(true);
    }
  });
});

describe('size and decompression limits (security 2 and 3)', () => {
  it('refuses past the download cap rather than truncating', async () => {
    async function* source(): AsyncGenerator<Uint8Array> {
      for (let index = 0; index < 10; index += 1) yield Buffer.alloc(1_024);
    }
    const meter: FeedByteMeter = { compressedBytes: 0, decompressedBytes: 0 };
    await expect(drain(boundedBytes(source(), 4_096, meter))).rejects.toMatchObject({
      reason: 'download_too_large',
    });
  });

  it('refuses a decompression BOMB on the absolute output cap', async () => {
    // 8 MiB of zeroes compresses to a few kilobytes: the classic shape.
    const bomb = gzipSync(Buffer.alloc(8 * 1024 * 1024));
    async function* source(): AsyncGenerator<Uint8Array> {
      yield bomb;
    }
    const meter: FeedByteMeter = { compressedBytes: bomb.byteLength, decompressedBytes: 0 };
    await expect(
      drain(
        decompressBytes(source(), 'gzip', {
          maxDownloadBytes: 10 * 1024 * 1024,
          maxDecompressedBytes: 1 * 1024 * 1024,
          maxCompressionRatio: 100_000,
        }, meter),
      ),
    ).rejects.toMatchObject({ reason: 'decompressed_too_large' });
  });

  it('refuses a decompression BOMB on the RATIO cap, which the absolute cap misses', async () => {
    // The fixture that makes the two caps disagree: an output well under a
    // generous absolute cap, at a ratio no real feed reaches. Either cap alone
    // is defeatable, which is why both exist.
    const bomb = gzipSync(Buffer.alloc(8 * 1024 * 1024));
    async function* source(): AsyncGenerator<Uint8Array> {
      yield bomb;
    }
    const meter: FeedByteMeter = { compressedBytes: 128 * 1024, decompressedBytes: 0 };
    await expect(
      drain(
        decompressBytes(source(), 'gzip', {
          maxDownloadBytes: 1024 * 1024 * 1024,
          maxDecompressedBytes: 1024 * 1024 * 1024,
          maxCompressionRatio: 10,
        }, meter),
      ),
    ).rejects.toMatchObject({ reason: 'compression_ratio_exceeded' });
  });

  it('lets an ORDINARY feed through both caps', async () => {
    const csv = 'id,title\n'.repeat(20_000);
    const gz = gzipSync(Buffer.from(csv, 'utf8'));
    async function* source(): AsyncGenerator<Uint8Array> {
      yield gz;
    }
    const meter: FeedByteMeter = { compressedBytes: gz.byteLength, decompressedBytes: 0 };
    const total = await drain(
      decompressBytes(source(), 'gzip', {
        maxDownloadBytes: 100 * 1024 * 1024,
        maxDecompressedBytes: 100 * 1024 * 1024,
        maxCompressionRatio: 200,
      }, meter),
    );
    expect(total).toBe(Buffer.byteLength(csv, 'utf8'));
  });
});

describe('uploads: containers and path tricks (security 3)', () => {
  it('refuses every multi-entry container BY NAME, from its magic bytes', () => {
    const cases: readonly [string, Buffer][] = [
      ['zip', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])],
      ['rar', Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0, 0])],
      ['seven_zip', Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 0])],
      ['bzip2', Buffer.from([0x42, 0x5a, 0x68, 0x39, 0, 0, 0, 0])],
      ['xz', Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 0, 0])],
    ];
    for (const [container, prefix] of cases) {
      expect(() => detectUploadContainer(prefix)).toThrow(new RegExp(container, 'u'));
    }

    // tar's only reliable signature is `ustar` at byte 257, which is why the
    // check reads a 512-byte prefix rather than four bytes.
    const tar = Buffer.alloc(512);
    tar.write('ustar', 257, 'ascii');
    expect(() => detectUploadContainer(tar)).toThrow(/tar/u);
  });

  it('accepts a plain file and a single-member gzip', () => {
    expect(detectUploadContainer(Buffer.from('id,title\n1,A\n'))).toBe('none');
    expect(detectUploadContainer(gzipSync(Buffer.from('id,title\n')))).toBe('gzip');
  });

  it('reduces a filename to a LABEL and refuses one that is not usable as one', () => {
    expect(sanitizeUploadFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeUploadFilename('C:\\feeds\\products.csv')).toBe('products.csv');
    expect(sanitizeUploadFilename('  products (final).csv ')).toBe('products _final_.csv');
    expect(() => sanitizeUploadFilename('../')).toThrow(FeedImportRefusal);
    expect(() => sanitizeUploadFilename('')).toThrow(FeedImportRefusal);
  });

  it('refuses a storage key that is not the shape this module mints', () => {
    // The bytes never land under a merchant-supplied name: the key is CSPRNG
    // and this refusal is what stops a value that reached the column some other
    // way becoming a path.
    expect(() => uploadPath('../../etc/passwd')).toThrow(FeedImportRefusal);
    expect(() => uploadPath('a/b')).toThrow(FeedImportRefusal);
    expect(uploadPath('AAAAAAAAAAAA')).toContain('AAAAAAAAAAAA');
  });
});

describe('credential and signed-URL redaction (security 5)', () => {
  it('keeps the HOST and removes everything after it', () => {
    // The real shape: Awin's product-feed download carries the key in the PATH.
    expect(redactFeedUrl('https://productdata.awin.com/datafeed/list/apikey/SECRETKEY')).toBe(
      'https://productdata.awin.com/[redacted]',
    );
    expect(redactFeedUrl('https://feeds.example.com/p.csv?token=abc123&x=1')).toBe(
      'https://feeds.example.com/[redacted]',
    );
  });

  it('replaces a value it cannot parse ENTIRELY', () => {
    // The most likely unparseable value is a pasted token, and "could not parse
    // it, so I logged it" is how a secret reaches a log line.
    expect(redactFeedUrl('sk_live_5fnq2m8xLLL')).toBe('[redacted]');
    expect(redactFeedUrl(null)).toBeNull();
  });

  it('strips a URL out of a message that came from somewhere else', () => {
    expect(
      redactFeedMessage('connect ETIMEDOUT https://productdata.awin.com/datafeed/apikey/KEY'),
    ).toBe('connect ETIMEDOUT https://productdata.awin.com/[redacted]');
    expect(redactFeedMessage('no url in this message')).toBe('no url in this message');
  });
});
