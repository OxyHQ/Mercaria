/**
 * The storage port: the ONE resolution of a private asset, and the absences that
 * make it the only one (ADR 0010 D17, #1015 W1 rule 4).
 *
 * ## What changed, and why the test had to change with it
 *
 * This file used to assert that a private deliverable resolved through
 * `oxyClient.getFileDownloadUrlAsync`. That was wrong, and the test passing is
 * what made it survive: the SDK call resolves a URL for the CURRENT USER against
 * Oxy's own ACL, and a Mercaria buyer is not a user Oxy knows anything about.
 * Mocking the SDK proved the port called it, never that the call could work.
 *
 * The mechanism is now Oxy's service-token mint (`/assets/service/linked-url`,
 * Oxy ADR 0021), authorized by the file's own owner having attached it to this
 * application. So the shape of the double changed too: `getFileDownloadUrlAsync`
 * is kept in the `oxyClient` double ON PURPOSE, beside the public builder, so the
 * census below can tell "never called" from "not callable".
 *
 * Every absence asserted here carries a CONTROL that proves the assertion could
 * have failed — the house rule, and it earns its keep twice below: a grep over a
 * domain that moved would otherwise report a clean result about no files, and a
 * "the log does not contain the key" check over a path that logged nothing would
 * report a clean result about no log lines.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const getFileDownloadUrlAsync = vi.fn();
const getFileDownloadUrl = vi.fn();
const uploadRawFile = vi.fn();
const assetLink = vi.fn();
const assetDelete = vi.fn();
const makeServiceRequest = vi.fn();
const logError = vi.fn();

vi.mock('../../../middleware/auth.js', () => ({
  oxyClient: {
    // Both user-scoped resolvers are present in the double ON PURPOSE. D17
    // forbids resolving a private deliverable through either — the public CDN
    // builder 404s it, and the async one answers for a VIEWER — and a double that
    // simply omitted them could not tell "never called" from "not callable".
    getFileDownloadUrlAsync: (...args: unknown[]) => getFileDownloadUrlAsync(...args),
    getFileDownloadUrl: (...args: unknown[]) => getFileDownloadUrl(...args),
    uploadRawFile: (...args: unknown[]) => uploadRawFile(...args),
    assetLink: (...args: unknown[]) => assetLink(...args),
    assetDelete: (...args: unknown[]) => assetDelete(...args),
  },
}));
vi.mock('../../../capabilities/oxy-service-client.js', () => ({
  oxyServiceClient: () => ({
    makeServiceRequest: (...args: unknown[]) => makeServiceRequest(...args),
  }),
}));
vi.mock('../../../lib/logger.js', () => ({
  log: {
    general: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: (...a: unknown[]) => logError(...a) },
  },
}));

const STORAGE_KEY = 'oxyfile_not_a_real_asset_id';
const DIGEST = 'a'.repeat(64);
const RESOLVED_URL = `https://s3.oxy.test/private/${STORAGE_KEY}?X-Amz-Signature=not-a-real-signature`;
const LINKED_URL_PATH = '/assets/service/linked-url';

/** One entry as the mint returns it: the URL and the three measured facts. */
const mintedEntry = {
  id: STORAGE_KEY,
  url: RESOLVED_URL,
  expiresIn: 300,
  mime: 'model/stl',
  size: 4_096,
  sha256: DIGEST,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveAuthorizedUrl mints through the service route, and nothing else', () => {
  it('asks the mint for exactly the one id and returns the URL it answered', async () => {
    const { assetStorage } = await import('../storage.js');
    makeServiceRequest.mockResolvedValue([mintedEntry]);

    await expect(assetStorage.resolveAuthorizedUrl(STORAGE_KEY)).resolves.toBe(RESOLVED_URL);
    expect(makeServiceRequest).toHaveBeenCalledWith('POST', LINKED_URL_PATH, {
      ids: [STORAGE_KEY],
    });
    // The controls for the two absences. This call DID resolve, so "the
    // user-scoped resolvers were not called" is a measurement rather than a
    // consequence of nothing happening at all.
    expect(getFileDownloadUrlAsync).not.toHaveBeenCalled();
    expect(getFileDownloadUrl).not.toHaveBeenCalled();
  });

  it('IGNORES a variant rather than serving a derivative of a paid deliverable', async () => {
    // The parameter survives for the port's shape; serving a rendition instead of
    // the object a buyer paid for is the failure nobody would notice until a
    // printer rejected the file.
    const { assetStorage } = await import('../storage.js');
    makeServiceRequest.mockResolvedValue([mintedEntry]);

    await expect(assetStorage.resolveAuthorizedUrl(STORAGE_KEY, 'poster')).resolves.toBe(
      RESOLVED_URL,
    );
    const [, , body] = makeServiceRequest.mock.calls[0];
    expect(JSON.stringify(body)).not.toContain('poster');
  });

  it('REFUSES when the mint omits the id — the file is not attached to this app', async () => {
    // Oxy's answer for "not linked by its owner", "unknown", "deleted" and
    // "system-owned" is one absence, and this is what that absence becomes here:
    // a serving failure. It is NOT a revocation — the buyer's right is untouched
    // (ADR 0010 D6) — and reporting it as one would take a right away over an
    // unlinking somebody did in a different product.
    const { assetStorage, isDigitalStorageError } = await import('../storage.js');
    makeServiceRequest.mockResolvedValue([]);

    const failure = await assetStorage.resolveAuthorizedUrl(STORAGE_KEY).catch((error) => error);
    expect(isDigitalStorageError(failure)).toBe(true);
    expect(failure.reason).toBe('absent');
    expect(getFileDownloadUrl).not.toHaveBeenCalled();
  });

  it('REFUSES on a definitive denial and never falls back to the public builder', async () => {
    // A 403 from the mint means the service credential lacks the scope, or the
    // route is not deployed yet. Either way the CDN form is a guaranteed 404, so
    // falling back would hand a buyer a broken URL and swallow the real failure.
    const { assetStorage, isDigitalStorageError } = await import('../storage.js');
    makeServiceRequest.mockRejectedValue(
      Object.assign(new Error('Forbidden'), { status: 403 }),
    );

    const failure = await assetStorage.resolveAuthorizedUrl(STORAGE_KEY).catch((error) => error);
    expect(isDigitalStorageError(failure)).toBe(true);
    expect(failure.reason).toBe('unresolved');
    expect(getFileDownloadUrl).not.toHaveBeenCalled();
  });

  it('REFUSES on a transient failure too — this caller knows the asset is private', async () => {
    // `AssetUrlResolutionError` says a caller that independently knows an asset is
    // PUBLIC may fall back on a 5xx. This one knows the opposite, and the test
    // exists because "transient" is exactly the word that would invite somebody
    // to add the fallback.
    const { assetStorage, isDigitalStorageError } = await import('../storage.js');
    makeServiceRequest.mockRejectedValue(
      Object.assign(new Error('Service Unavailable'), { status: 503 }),
    );

    const failure = await assetStorage.resolveAuthorizedUrl(STORAGE_KEY).catch((error) => error);
    expect(isDigitalStorageError(failure)).toBe(true);
    expect(getFileDownloadUrl).not.toHaveBeenCalled();
  });

  it('logs the failure WITHOUT the storage key, the URL or the error message', async () => {
    const { assetStorage } = await import('../storage.js');
    makeServiceRequest.mockRejectedValue(
      Object.assign(new Error(`could not sign ${STORAGE_KEY} -> ${RESOLVED_URL}`), {
        status: 500,
      }),
    );

    await assetStorage.resolveAuthorizedUrl(STORAGE_KEY).catch(() => undefined);

    // The anti-vacuity floor: something WAS logged, so the absences below are
    // measured over a non-empty population.
    expect(logError).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(logError.mock.calls);
    expect(logged).not.toContain(STORAGE_KEY);
    expect(logged).not.toContain(RESOLVED_URL);
    // And the control that the search works: the line that IS emitted is found.
    expect(logged).toContain('authorized asset URL could not be resolved');
  });

  it('logs an unservable-but-entitled file without naming it either', async () => {
    // The `absent` branch has its own log line, and it is the one most likely to
    // be read during an incident — so it must still not carry the door.
    const { assetStorage } = await import('../storage.js');
    makeServiceRequest.mockResolvedValue([]);

    await assetStorage.resolveAuthorizedUrl(STORAGE_KEY).catch(() => undefined);

    expect(logError).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(logError.mock.calls);
    expect(logged).not.toContain(STORAGE_KEY);
    expect(logged).toContain('no longer servable');
  });

  it('carries neither the key nor the URL on the error it throws', async () => {
    const { assetStorage } = await import('../storage.js');
    makeServiceRequest.mockRejectedValue(new Error(`denied for ${STORAGE_KEY}`));
    const failure = await assetStorage.resolveAuthorizedUrl(STORAGE_KEY).catch((error) => error);
    expect(failure.message).not.toContain(STORAGE_KEY);
    expect(failure.message).not.toContain(RESOLVED_URL);
    // Control: the error carries a real message, so the two absences above are
    // not passing against an empty string.
    expect(failure.message.length).toBeGreaterThan(0);
  });
});

describe('describeAssetObject reads the SAME mint, and discards the credential', () => {
  it('returns what the asset service measured, and no URL', async () => {
    const { assetStorage } = await import('../storage.js');
    makeServiceRequest.mockResolvedValue([mintedEntry]);

    const described = await assetStorage.describeAssetObject(STORAGE_KEY);

    // An exact equality, not a containment: a `url` field reaching a descriptor
    // is how a credential ends up in a response body nobody meant to put it in,
    // and `insertAssetFile` spreads what it is handed.
    expect(described).toEqual({
      storageKey: STORAGE_KEY,
      byteSize: 4_096,
      mediaType: 'model/stl',
      contentHash: DIGEST,
    });
  });

  it('reads the mint rather than the metadata route, which answers for ANY id', async () => {
    // The stronger register-time check, and the reason there is no
    // `getServiceAssetMetadataByIds` call here: that route would have accepted a
    // file the creator never attached to Mercaria, and the failure would have
    // surfaced months later to a buyer as a download that does not work.
    const { assetStorage } = await import('../storage.js');
    makeServiceRequest.mockResolvedValue([mintedEntry]);

    await assetStorage.describeAssetObject(STORAGE_KEY);

    expect(makeServiceRequest).toHaveBeenCalledWith('POST', LINKED_URL_PATH, {
      ids: [STORAGE_KEY],
    });
  });

  it('answers null for every shape the table would refuse', async () => {
    const { assetStorage } = await import('../storage.js');

    // Not attached to this application, unknown, deleted, system-owned — one
    // absence, deliberately.
    makeServiceRequest.mockResolvedValue([]);
    await expect(assetStorage.describeAssetObject(STORAGE_KEY)).resolves.toBeNull();

    // An entry for a DIFFERENT id never satisfies this one.
    makeServiceRequest.mockResolvedValue([{ ...mintedEntry, id: 'some-other-file' }]);
    await expect(assetStorage.describeAssetObject(STORAGE_KEY)).resolves.toBeNull();

    // `asset_files_content_hash_check` is `^[0-9a-f]{64}$`. Refusing here turns a
    // service that answered without a digest into a named refusal rather than a
    // constraint violation two layers down.
    makeServiceRequest.mockResolvedValue([{ ...mintedEntry, sha256: 'nope' }]);
    await expect(assetStorage.describeAssetObject(STORAGE_KEY)).resolves.toBeNull();

    makeServiceRequest.mockResolvedValue([{ ...mintedEntry, size: 0 }]);
    await expect(assetStorage.describeAssetObject(STORAGE_KEY)).resolves.toBeNull();

    makeServiceRequest.mockResolvedValue([{ ...mintedEntry, mime: '   ' }]);
    await expect(assetStorage.describeAssetObject(STORAGE_KEY)).resolves.toBeNull();

    // An entry with no URL is not servable whatever else it says, and the
    // transport is generic over its return type — these checks are the only thing
    // between a changed wire shape and an `asset_files` insert.
    makeServiceRequest.mockResolvedValue([{ ...mintedEntry, url: '' }]);
    await expect(assetStorage.describeAssetObject(STORAGE_KEY)).resolves.toBeNull();

    makeServiceRequest.mockResolvedValue({ data: [mintedEntry] });
    await expect(assetStorage.describeAssetObject(STORAGE_KEY)).resolves.toBeNull();

    // The control: the SAME call shape returns a descriptor for a good entry, so
    // the seven nulls above are refusals and not a function that returns null.
    makeServiceRequest.mockResolvedValue([mintedEntry]);
    await expect(assetStorage.describeAssetObject(STORAGE_KEY)).resolves.not.toBeNull();
  });

  it('raises rather than guessing when the service could not be asked', async () => {
    const { assetStorage, isDigitalStorageError } = await import('../storage.js');
    makeServiceRequest.mockRejectedValue(new Error('429'));
    const failure = await assetStorage.describeAssetObject(STORAGE_KEY).catch((error) => error);
    expect(isDigitalStorageError(failure)).toBe(true);
    expect(failure.reason).toBe('unresolved');
  });
});

describe('putAssetObject stores PRIVATE, ATTACHES, and re-measures what it stored', () => {
  it('names `private` explicitly, links to this app, and describes the result', async () => {
    const { assetStorage } = await import('../storage.js');
    uploadRawFile.mockResolvedValue({ id: STORAGE_KEY });
    assetLink.mockResolvedValue({});
    makeServiceRequest.mockResolvedValue([mintedEntry]);

    const stored = await assetStorage.putAssetObject({
      file: new Blob(['not a real mesh']),
      metadata: { assetVersionId: 'version-1' },
    });

    expect(uploadRawFile).toHaveBeenCalledWith(expect.anything(), 'private', {
      assetVersionId: 'version-1',
    });
    // The link is the AUTHORIZATION, not bookkeeping: without it the object this
    // call just stored is unservable, because Oxy admits a file only when a link
    // for this app was created by the file's own owner.
    expect(assetLink).toHaveBeenCalledWith(STORAGE_KEY, 'mercaria', 'asset_file', STORAGE_KEY);
    expect(stored.contentHash).toBe(DIGEST);
    // Measured, not taken from the caller: the byte size comes back from the
    // service rather than from the length of the buffer handed over.
    expect(stored.byteSize).toBe(4_096);
  });

  it('refuses when the link did not take, rather than returning an unservable object', async () => {
    const { assetStorage, isDigitalStorageError } = await import('../storage.js');
    uploadRawFile.mockResolvedValue({ id: STORAGE_KEY });
    assetLink.mockRejectedValue(new Error('link failed'));

    const failure = await assetStorage
      .putAssetObject({ file: new Blob(['x']) })
      .catch((error) => error);

    expect(isDigitalStorageError(failure)).toBe(true);
    expect(failure.reason).toBe('unresolved');
    // It did not go on to describe: an object nobody can serve must not be
    // reported as stored.
    expect(makeServiceRequest).not.toHaveBeenCalled();
  });

  it('refuses an upload the service will not describe', async () => {
    const { assetStorage, isDigitalStorageError } = await import('../storage.js');
    uploadRawFile.mockResolvedValue({ id: STORAGE_KEY });
    assetLink.mockResolvedValue({});
    makeServiceRequest.mockResolvedValue([]);
    const failure = await assetStorage
      .putAssetObject({ file: new Blob(['x']) })
      .catch((error) => error);
    expect(isDigitalStorageError(failure)).toBe(true);
    expect(failure.reason).toBe('absent');
  });
});

describe('deleteAssetObject', () => {
  it('delegates to the asset service', async () => {
    const { assetStorage } = await import('../storage.js');
    assetDelete.mockResolvedValue(undefined);
    await assetStorage.deleteAssetObject(STORAGE_KEY);
    expect(assetDelete).toHaveBeenCalledWith(STORAGE_KEY);
  });
});

/* -------------------------------------------------------------------------- */
/* The source census — the rule D17 states, held structurally                   */
/* -------------------------------------------------------------------------- */

const SRC = join(import.meta.dirname, '..', '..', '..');

/** Every `.ts` file under `dir`, recursively, excluding test directories. */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === '__tests__') continue;
      found.push(...sourceFiles(path));
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) found.push(path);
  }
  return found;
}

/**
 * A file's CODE, with comments removed.
 *
 * Load-bearing rather than fastidious: every rule below is about what the code
 * reaches for, and `storage.ts`'s own docblock names both forbidden spellings in
 * order to explain why they are forbidden. A census over raw text would make the
 * explanation the violation, and the obvious repair — deleting the explanation —
 * is the opposite of what anybody wants.
 */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Every non-test source file of the digital domain, controllers included. */
function digitalDomainFiles(): string[] {
  return [
    ...sourceFiles(join(SRC, 'services', 'digital')),
    ...sourceFiles(join(SRC, 'db', 'digital')),
    join(SRC, 'controllers', 'digital-creator.controller.ts'),
    join(SRC, 'controllers', 'digital-buyer.controller.ts'),
    join(SRC, 'routes', 'digital.routes.ts'),
  ];
}

describe('the digital domain names `oxyClient` in exactly one file', () => {
  it('finds a domain to measure, so the census below is not vacuous', () => {
    const files = digitalDomainFiles();
    // The anti-vacuity floor. A census over a domain that moved would report a
    // clean result for a reason that has nothing to do with the rule.
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((file) => file.endsWith('storage.ts'))).toBe(true);
  });

  it('is `services/digital/storage.ts` and nothing else', () => {
    const namers = digitalDomainFiles().filter((file) => codeOf(file).includes('oxyClient'));
    expect(
      namers.map((file) => file.slice(SRC.length + 1)),
      'ADR 0010 D17: the storage port is the only module in this domain that may ' +
        'reach the Oxy asset client, or the rule about HOW an asset is resolved is ' +
        'stated in as many places as there are callers',
    ).toEqual(['services/digital/storage.ts']);
  });

  it('never reaches for a USER-SCOPED resolver anywhere in the domain', () => {
    // All three spellings are forbidden now, and the third is the one this file
    // used to permit. `resolveMedia` and the synchronous `getFileDownloadUrl`
    // build the public CDN form, which 404s on a private asset while looking like
    // it worked. `getFileDownloadUrlAsync` is worse, because it looks correct: it
    // resolves against Oxy's own ACL for the CURRENT USER, and a buyer is not one
    // — so it would be called successfully and refuse the person who paid. The
    // previous version of this census carried a negative lookahead exempting it,
    // which is precisely how the wrong mechanism shipped.
    const userScopedResolver = /\bresolveMedia\b|\bgetFileDownloadUrl(Async)?\b/;
    const offenders = digitalDomainFiles().filter((file) => userScopedResolver.test(codeOf(file)));
    expect(
      offenders.map((file) => file.slice(SRC.length + 1)),
      'ADR 0010 D17: a private deliverable resolves through the SERVICE mint ' +
        '(`/assets/service/linked-url`, Oxy ADR 0021), never through a resolver ' +
        'that asks whether the CURRENT USER may read the file',
    ).toEqual([]);

    // The control: the SAME pattern matches the module that legitimately uses the
    // public builder, so the empty result above is a fact about the digital
    // domain and not about a regex that matches nothing.
    expect(
      userScopedResolver.test(codeOf(join(SRC, 'services', 'catalog-hydration.service.ts'))),
    ).toBe(true);
  });
});
