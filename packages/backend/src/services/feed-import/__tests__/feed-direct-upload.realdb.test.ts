/**
 * Direct feed uploads and background validation, against a real Postgres
 * server (`feed_upload_sessions`, `feed_validation_jobs`, the consumption of a
 * cited upload).
 *
 * Every property here is a CHECK, a partial unique, a guarded transition or a
 * trigger — nothing a mocked insert would refuse. What IS replaced is Oxy Files:
 * `services/catalog-media/oxy-files.ts` is mocked with an in-memory storage that
 * answers exactly the four client-upload calls and the download mint, so the
 * session service, the repositories, the container check and the reference
 * trigger all run for real. The mint answers `data:` URLs, which `upload.ts`
 * reads through the real `fetch` exactly as it reads a presigned storage URL.
 *
 * The properties, in order:
 *
 * 1. An upload goes uploading → completed, writes a `feed_uploads` row whose
 *    `storage_key` is the Oxy file id, and the reference trigger queues it.
 * 2. A multi-entry archive and a compression mismatch are refused before any
 *    `feed_uploads` row exists.
 * 3. Storage's DEDUPLICATED answer is not trusted on its own: another owner must
 *    prove possession, and a wrong range fails; the same owner is accepted.
 * 4. One open session per storage upload: the same configuration resumes, any
 *    other is refused.
 * 5. A `verifying` session completes when it is read.
 * 6. Citing an upload CONSUMES it (no deadline), and only this feed's upload can
 *    be cited.
 * 7. A validation is a job: asking twice answers one job, and running it writes
 *    the report an activation cites.
 */

import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { catalogSources } from '../../../db/schema/provenance.js';
import { catalogSourceConfigs } from '../../../db/schema/ingestion.js';
import { oxyFileReferenceOutboxes } from '../../../db/schema/oxyFiles.js';
import { deleteTestStores } from '../../../db/__tests__/store-teardown.js';
import { insertStore } from '../../../db/stores/storeRepository.js';
import {
  feedConfigurationVersions,
  feedConfigurations,
  feedImportReports,
  feedUploadSessions,
  feedUploads,
  feedValidationJobs,
} from '../../../db/schema/feedImport.js';
import { createFeedConfiguration, draftFeedVersion } from '../configuration.service.js';
import {
  completeFeedUploadSession,
  describeFeedUploadSession,
  loadFeedUploadSession,
  openFeedUploadSession,
  proveFeedUploadPossession,
  type FeedUploadOwner,
} from '../upload-session.service.js';
import { requestFeedValidation, runFeedValidationJob } from '../validation-dispatcher.js';
import { claimFeedValidationJobs } from '../../../db/feedImport/feedValidationJobRepository.js';

/** The in-memory storage the mocked adapter answers from. */
const storage = vi.hoisted(() => {
  interface Upload {
    readonly uploadId: string;
    readonly sha256: string;
    readonly size: number;
    /** What the client "PUT"; set by the test before completing. */
    bytes?: Buffer;
    /** Answer `verifying` to the next completion. */
    verifyOnce?: boolean;
    state: 'uploading' | 'verifying' | 'completed';
    fileId?: string;
  }
  return {
    files: new Map<string, Buffer>(),
    /** The application's files by SHA-256 — storage's deduplication key. */
    bySha: new Map<string, string>(),
    uploads: new Map<string, Upload>(),
    counter: 0,
  };
});

vi.mock('../../catalog-media/oxy-files.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../catalog-media/oxy-files.js')>();
  const { createHash: hash } = await import('node:crypto');
  const fileOf = (id: string) => {
    const bytes = storage.files.get(id)!;
    return { fileId: id, size: bytes.length, sha256: hash('sha256').update(bytes).digest('hex') };
  };
  const store = (bytes: Buffer): string => {
    const sha = hash('sha256').update(bytes).digest('hex');
    const existing = storage.bySha.get(sha);
    if (existing) return existing;
    storage.counter += 1;
    const id = `file_${storage.counter}_${Date.now()}`;
    storage.files.set(id, bytes);
    storage.bySha.set(sha, id);
    return id;
  };
  return {
    ...actual,
    openClientUpload: async (input: { sha256: string; size: number }) => {
      const held = storage.bySha.get(input.sha256);
      if (held)
        return { kind: 'completed', uploadId: null, file: fileOf(held), deduplicated: true };
      const open = [...storage.uploads.values()].find(
        (upload) => upload.sha256 === input.sha256 && upload.state !== 'completed',
      );
      const upload = open ?? {
        uploadId: `up_${storage.uploads.size + 1}_${Date.now()}`,
        sha256: input.sha256,
        size: input.size,
        state: 'uploading' as const,
      };
      storage.uploads.set(upload.uploadId, upload);
      return {
        kind: 'uploading',
        uploadId: upload.uploadId,
        partSize: 8 * 1024 * 1024,
        partCount: 1,
        expiresAt: null,
        parts: [
          { partNumber: 1, url: `https://storage.test/${upload.uploadId}/1`, size: input.size },
        ],
        uploadedParts: upload.bytes ? [1] : [],
      };
    },
    clientUploadPartUrls: async (uploadId: string, partNumbers: readonly number[]) =>
      partNumbers.map((partNumber) => ({
        partNumber,
        url: `https://storage.test/${uploadId}/${partNumber}`,
        size: storage.uploads.get(uploadId)?.size ?? 1,
      })),
    describeClientUpload: async (uploadId: string) => {
      const upload = storage.uploads.get(uploadId)!;
      if (upload.state === 'verifying') {
        upload.state = 'completed';
        upload.fileId = store(upload.bytes!);
      }
      if (upload.state === 'completed')
        return { kind: 'completed', uploadId, file: fileOf(upload.fileId!), deduplicated: false };
      return {
        kind: 'uploading',
        uploadId,
        partSize: 8 * 1024 * 1024,
        partCount: 1,
        expiresAt: null,
        parts: [],
        uploadedParts: upload.bytes ? [1] : [],
      };
    },
    completeClientUpload: async (uploadId: string) => {
      const upload = storage.uploads.get(uploadId)!;
      if (!upload.bytes) return { kind: 'incomplete', uploadId };
      if (hash('sha256').update(upload.bytes).digest('hex') !== upload.sha256)
        return { kind: 'failed', uploadId, code: 'CHECKSUM_MISMATCH' };
      if (upload.verifyOnce) {
        upload.verifyOnce = false;
        upload.state = 'verifying';
        return { kind: 'verifying', uploadId };
      }
      upload.state = 'completed';
      upload.fileId = store(upload.bytes);
      return { kind: 'completed', uploadId, file: fileOf(upload.fileId), deduplicated: false };
    },
    mintPrivateDownloadUrls: async (ids: readonly string[]) =>
      ids.flatMap((id) => {
        const bytes = storage.files.get(id);
        return bytes === undefined
          ? []
          : [
              {
                id,
                url: `data:application/octet-stream;base64,${bytes.toString('base64')}`,
                expiresIn: 300,
                mime: 'application/octet-stream',
                size: bytes.length,
                sha256: '',
              },
            ];
      }),
  };
});

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('direct feed uploads and background validation (real server)', () => {
  let db: Database;
  const RUN = uuidv7().slice(-12);
  const createdSourceIds: string[] = [];
  const createdConfigurationIds: string[] = [];
  const createdStoreIds: string[] = [];
  let platform: FeedUploadOwner;
  let platformTwin: FeedUploadOwner;
  let merchant: FeedUploadOwner;

  function safe(ids: readonly string[]): string[] {
    return ids.length === 0 ? ['__none__'] : [...ids];
  }

  async function makeConfiguration(storeId: string | null, name: string): Promise<FeedUploadOwner> {
    const configuration = await createFeedConfiguration({
      storeId,
      sourceName: `direct upload ${name} ${RUN}`,
      label: `Direct upload ${name}`,
      identityKeyFields: ['id'],
      actorOxyUserId: `actor-${RUN}`,
    });
    createdConfigurationIds.push(configuration.id);
    createdSourceIds.push(configuration.sourceId);
    return { configurationId: configuration.id, storeId };
  }

  /** A unique CSV per call, so storage never deduplicates by accident. */
  function csv(rows = 2): Buffer {
    const lines = ['id,title'];
    for (let index = 0; index < rows; index += 1) lines.push(`${RUN}-${uuidv7()},Product ${index}`);
    return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
  }

  async function open(
    owner: FeedUploadOwner,
    bytes: Buffer,
    compression: 'none' | 'gzip' = 'none',
  ) {
    return openFeedUploadSession({
      owner,
      filename: 'products.csv',
      compression,
      byteSize: bytes.length,
      sha256: sha256(bytes),
      actorOxyUserId: `actor-${RUN}`,
    });
  }

  /** The client's PUT of every part, as storage records it. */
  function put(uploadIdOf: string, bytes: Buffer): void {
    const upload = [...storage.uploads.values()].find((entry) => entry.uploadId === uploadIdOf);
    if (!upload) throw new Error('no such storage upload');
    upload.bytes = bytes;
  }

  async function oxyUploadIdOf(sessionId: string): Promise<string> {
    const [row] = await db
      .select({ oxyUploadId: feedUploadSessions.oxyUploadId })
      .from(feedUploadSessions)
      .where(eq(feedUploadSessions.id, sessionId));
    return row?.oxyUploadId ?? '';
  }

  async function uploadFully(owner: FeedUploadOwner, bytes: Buffer) {
    const opened = await open(owner, bytes);
    put(await oxyUploadIdOf(opened.id), bytes);
    return completeFeedUploadSession(await loadFeedUploadSession(owner, opened.id));
  }

  beforeAll(async () => {
    db = await connectPostgres();
    const store = await insertStore({
      oxyAccountId: `owner-${RUN}`,
      handle: `direct-upload-${RUN}`,
      name: 'Direct upload store',
      description: '',
      brandColor: '#123456',
      defaultCurrency: 'FAIR',
    });
    createdStoreIds.push(store.id);
    platform = await makeConfiguration(null, 'platform');
    platformTwin = await makeConfiguration(null, 'platform twin');
    merchant = await makeConfiguration(store.id, 'merchant');
  }, 120_000);

  beforeEach(() => {
    storage.uploads.clear();
  });

  afterAll(async () => {
    const configurations = safe(createdConfigurationIds);
    const uploads = await db
      .select({ id: feedUploads.id })
      .from(feedUploads)
      .where(inArray(feedUploads.configurationId, configurations));
    await db
      .delete(feedValidationJobs)
      .where(inArray(feedValidationJobs.configurationId, configurations));
    await db
      .delete(feedUploadSessions)
      .where(inArray(feedUploadSessions.configurationId, configurations));
    await db
      .update(feedConfigurationVersions)
      .set({
        status: 'draft',
        validatedReportId: null,
        activatedAt: null,
        activatedByOxyUserId: null,
        supersededAt: null,
      })
      .where(inArray(feedConfigurationVersions.configurationId, configurations));
    await db
      .delete(feedImportReports)
      .where(inArray(feedImportReports.configurationId, configurations));
    await db
      .delete(feedConfigurationVersions)
      .where(inArray(feedConfigurationVersions.configurationId, configurations));
    await db.delete(feedUploads).where(inArray(feedUploads.configurationId, configurations));
    // The reference trigger queued every insert AND every delete above.
    await db
      .delete(oxyFileReferenceOutboxes)
      .where(
        and(
          eq(oxyFileReferenceOutboxes.entityType, 'feed_upload'),
          inArray(oxyFileReferenceOutboxes.entityId, safe(uploads.map((row) => row.id))),
        ),
      );
    await db.delete(feedConfigurations).where(inArray(feedConfigurations.id, configurations));
    await db
      .delete(catalogSourceConfigs)
      .where(inArray(catalogSourceConfigs.sourceId, safe(createdSourceIds)));
    await db.delete(catalogSources).where(inArray(catalogSources.id, safe(createdSourceIds)));
    await deleteTestStores(db, createdStoreIds);
    await closePostgres();
  });

  describe('1. an upload goes straight to storage and becomes a feed upload', () => {
    it('opens with part URLs, completes, and registers the Oxy file reference', async () => {
      const bytes = csv();
      const opened = await open(platform, bytes);
      expect(opened.status).toBe('uploading');
      expect(opened.partCount).toBe(1);
      expect(opened.parts?.[0]?.url).toMatch(/^https:\/\//u);

      // Completing before the parts arrived keeps the session open.
      const early = await completeFeedUploadSession(
        await loadFeedUploadSession(platform, opened.id),
      );
      expect(early.status).toBe('uploading');

      put(await oxyUploadIdOf(opened.id), bytes);
      const done = await completeFeedUploadSession(
        await loadFeedUploadSession(platform, opened.id),
      );
      expect(done.status).toBe('completed');
      expect(done.upload?.byteSize).toBe(bytes.length);
      expect(done.upload?.contentDigest).toBe(sha256(bytes));

      const [upload] = await db
        .select()
        .from(feedUploads)
        .where(eq(feedUploads.id, done.upload!.id));
      expect(upload?.storageKey).toBe(storage.bySha.get(sha256(bytes)));
      expect(upload?.status).toBe('staged');
      expect(upload?.expiresAt).not.toBeNull();

      const queued = await db
        .select({ id: oxyFileReferenceOutboxes.id })
        .from(oxyFileReferenceOutboxes)
        .where(
          and(
            eq(oxyFileReferenceOutboxes.entityType, 'feed_upload'),
            eq(oxyFileReferenceOutboxes.entityId, done.upload!.id),
          ),
        );
      expect(queued).toHaveLength(1);

      // Completing again is idempotent and answers the same upload.
      const again = await completeFeedUploadSession(
        await loadFeedUploadSession(platform, opened.id),
      );
      expect(again.upload?.id).toBe(done.upload!.id);
    });

    it("answers another configuration's session as absent", async () => {
      const opened = await open(platform, csv());
      await expect(loadFeedUploadSession(platformTwin, opened.id)).rejects.toThrow(/not found/u);
    });
  });

  describe('2. the refusals every feed meets happen before acceptance', () => {
    it('refuses a zip archive from its magic bytes', async () => {
      const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(uuidv7())]);
      const done = await uploadFully(platform, zip);
      expect(done.status).toBe('failed');
      expect(done.failure).toBe('forbidden_container');
      expect(done.upload).toBeUndefined();
    });

    it('refuses gzip bytes declared as uncompressed', async () => {
      const gzip = gzipSync(csv());
      const done = await uploadFully(platform, gzip);
      expect(done.failure).toBe('compression_mismatch');
    });

    it('accepts gzip bytes declared as gzip', async () => {
      const gzip = gzipSync(csv());
      const opened = await open(platform, gzip, 'gzip');
      put(await oxyUploadIdOf(opened.id), gzip);
      const done = await completeFeedUploadSession(
        await loadFeedUploadSession(platform, opened.id),
      );
      expect(done.status).toBe('completed');
      expect(done.upload?.compression).toBe('gzip');
    });
  });

  describe('3. a deduplicated answer is not proof of possession', () => {
    it('asks another owner for a range, fails a wrong one, accepts the right one', async () => {
      const bytes = csv(40);
      const first = await uploadFully(platform, bytes);
      expect(first.status).toBe('completed');

      // The merchant names the same bytes; storage answers at once.
      const challenged = await open(merchant, bytes);
      expect(challenged.status).toBe('proof_required');
      const proof = challenged.proof!;
      expect(proof.length).toBe(bytes.length);

      const wrong = Buffer.from(bytes);
      wrong[0] = wrong[0]! ^ 0xff;
      const failed = await proveFeedUploadPossession(
        await loadFeedUploadSession(merchant, challenged.id),
        wrong,
      );
      expect(failed.status).toBe('failed');
      expect(failed.failure).toBe('proof_failed');

      const retry = await open(merchant, bytes);
      expect(retry.status).toBe('proof_required');
      const range = bytes.subarray(retry.proof!.offset, retry.proof!.offset + retry.proof!.length);
      const accepted = await proveFeedUploadPossession(
        await loadFeedUploadSession(merchant, retry.id),
        Buffer.from(range),
      );
      expect(accepted.status).toBe('completed');
      expect(accepted.upload?.contentDigest).toBe(sha256(bytes));
    });

    it('accepts the same owner at once, because the possession is on record', async () => {
      const bytes = csv();
      await uploadFully(platform, bytes);
      // The twin is another PLATFORM configuration: the same owner.
      const again = await open(platformTwin, bytes);
      expect(again.status).toBe('completed');
      expect(again.upload).toBeDefined();
    });
  });

  describe('4. one open session per storage upload', () => {
    it('resumes for the same configuration and refuses any other', async () => {
      const bytes = csv();
      const first = await open(platform, bytes);
      const resumed = await open(platform, bytes);
      expect(resumed.id).toBe(first.id);
      await expect(open(platformTwin, bytes)).rejects.toThrow(/another feed/u);
    });

    it('refuses a second OPEN session row for one storage upload, at the row', async () => {
      const bytes = csv();
      const first = await open(platform, bytes);
      const oxyUploadId = await oxyUploadIdOf(first.id);
      await expect(
        db.insert(feedUploadSessions).values({
          configurationId: platformTwin.configurationId,
          filename: 'x.csv',
          compression: 'none',
          byteSize: bytes.length,
          contentDigest: sha256(bytes),
          oxyUploadId,
          status: 'uploading',
          openedByOxyUserId: `actor-${RUN}`,
          expiresAt: new Date(Date.now() + 86_400_000),
        }),
      ).rejects.toMatchObject({
        cause: { message: expect.stringMatching(/feed_upload_sessions_open_upload_key/u) },
      });
    });

    it('refuses a completed session that names no upload', async () => {
      await expect(
        db.insert(feedUploadSessions).values({
          configurationId: platform.configurationId,
          filename: 'x.csv',
          compression: 'none',
          byteSize: 10,
          contentDigest: 'a'.repeat(64),
          oxyFileId: 'file_x',
          status: 'completed',
          openedByOxyUserId: `actor-${RUN}`,
          expiresAt: new Date(Date.now() + 86_400_000),
        }),
      ).rejects.toMatchObject({
        cause: { message: expect.stringMatching(/feed_upload_sessions_completed_shape_check/u) },
      });
    });
  });

  describe('5. verification that outlives the completion', () => {
    it('answers verifying, then completes when the session is read', async () => {
      const bytes = csv();
      const opened = await open(platform, bytes);
      const oxyUploadId = await oxyUploadIdOf(opened.id);
      put(oxyUploadId, bytes);
      storage.uploads.get(oxyUploadId)!.verifyOnce = true;
      const verifying = await completeFeedUploadSession(
        await loadFeedUploadSession(platform, opened.id),
      );
      expect(verifying.status).toBe('verifying');
      const done = await describeFeedUploadSession(
        await loadFeedUploadSession(platform, opened.id),
      );
      expect(done.status).toBe('completed');
      expect(done.upload).toBeDefined();
    });
  });

  describe('6. a cited upload is consumed, and only this feed can cite it', () => {
    const draft = (configurationId: string, uploadId: string) =>
      draftFeedVersion({
        configurationId,
        fetchMode: 'upload',
        uploadId,
        format: 'csv',
        hasHeaderRow: true,
        deliveryMode: 'snapshot',
        fieldMappings: [{ role: 'title', sourceField: 'title' }],
        actorOxyUserId: `actor-${RUN}`,
      });

    it("refuses another feed's upload, consumes its own and clears the deadline", async () => {
      const done = await uploadFully(platform, csv());
      const uploadId = done.upload!.id;
      await expect(draft(platformTwin.configurationId, uploadId)).rejects.toThrow(
        /not an upload of this feed/u,
      );

      const version = await draft(platform.configurationId, uploadId);
      expect(version.uploadId).toBe(uploadId);
      const [upload] = await db.select().from(feedUploads).where(eq(feedUploads.id, uploadId));
      expect(upload?.status).toBe('consumed');
      expect(upload?.consumedAt).not.toBeNull();
      expect(upload?.expiresAt).toBeNull();

      // The pair is the row's shape, not the service's habit.
      await expect(
        db.update(feedUploads).set({ expiresAt: new Date() }).where(eq(feedUploads.id, uploadId)),
      ).rejects.toMatchObject({
        cause: { message: expect.stringMatching(/feed_uploads_retention_shape_check/u) },
      });
    });
  });

  describe('7. a validation is a job the client polls', () => {
    it('answers one job for repeated requests and writes the report when run', async () => {
      const done = await uploadFully(platform, csv(5));
      const version = await draftFeedVersion({
        configurationId: platform.configurationId,
        fetchMode: 'upload',
        uploadId: done.upload!.id,
        format: 'csv',
        hasHeaderRow: true,
        deliveryMode: 'snapshot',
        fieldMappings: [{ role: 'title', sourceField: 'title' }],
        actorOxyUserId: `actor-${RUN}`,
      });

      const first = await requestFeedValidation({
        configurationId: platform.configurationId,
        versionId: version.id,
        requestedByOxyUserId: `actor-${RUN}`,
      });
      const second = await requestFeedValidation({
        configurationId: platform.configurationId,
        versionId: version.id,
        requestedByOxyUserId: `actor-${RUN}`,
      });
      expect(second.id).toBe(first.id);
      expect(first.status).toBe('pending');

      await expect(
        requestFeedValidation({
          configurationId: platformTwin.configurationId,
          versionId: version.id,
          requestedByOxyUserId: `actor-${RUN}`,
        }),
      ).rejects.toThrow(/not found/u);

      // Claim THIS job: the claim is global, so drive it by id rather than by
      // whatever a sibling file queued.
      const owner = `test-${RUN}`;
      let claimed: Awaited<ReturnType<typeof claimFeedValidationJobs>>[number] | undefined;
      for (let attempt = 0; attempt < 20 && claimed === undefined; attempt += 1) {
        const batch = await claimFeedValidationJobs({
          leaseOwner: owner,
          batchSize: 50,
          leaseMs: 60_000,
        });
        claimed = batch.find((job) => job.id === first.id);
      }
      expect(claimed?.id).toBe(first.id);
      expect(await runFeedValidationJob(claimed!, owner)).toBe('completed');

      const [job] = await db
        .select()
        .from(feedValidationJobs)
        .where(eq(feedValidationJobs.id, first.id));
      expect(job?.status).toBe('completed');
      const [report] = await db
        .select()
        .from(feedImportReports)
        .where(eq(feedImportReports.id, job!.reportId!));
      expect(report?.mode).toBe('validation');
      expect(report?.scanned).toBe(5);
      expect(report?.valid).toBe(5);
    });

    it('fails a job whose refusal will answer the same way again, with its reason', async () => {
      const done = await uploadFully(platform, csv());
      const version = await draftFeedVersion({
        configurationId: platform.configurationId,
        fetchMode: 'upload',
        uploadId: done.upload!.id,
        format: 'csv',
        hasHeaderRow: true,
        deliveryMode: 'snapshot',
        fieldMappings: [{ role: 'title', sourceField: 'title' }],
        actorOxyUserId: `actor-${RUN}`,
      });
      // The stored file goes, as a takedown or a deletion in Oxy would take it.
      storage.files.delete(
        (await db.select().from(feedUploads).where(eq(feedUploads.id, done.upload!.id)))[0]!
          .storageKey,
      );
      const job = await requestFeedValidation({
        configurationId: platform.configurationId,
        versionId: version.id,
        requestedByOxyUserId: `actor-${RUN}`,
      });
      const owner = `test-fail-${RUN}`;
      let claimed: Awaited<ReturnType<typeof claimFeedValidationJobs>>[number] | undefined;
      for (let attempt = 0; attempt < 20 && claimed === undefined; attempt += 1) {
        const batch = await claimFeedValidationJobs({
          leaseOwner: owner,
          batchSize: 50,
          leaseMs: 60_000,
        });
        claimed = batch.find((row) => row.id === job.id);
      }
      expect(await runFeedValidationJob(claimed!, owner)).toBe('failed');
      const [row] = await db
        .select()
        .from(feedValidationJobs)
        .where(eq(feedValidationJobs.id, job.id));
      expect(row?.status).toBe('failed');
      expect(row?.failureReason).toBe('upload_missing');
    });
  });
});
