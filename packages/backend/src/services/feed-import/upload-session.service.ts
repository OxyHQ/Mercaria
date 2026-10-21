/**
 * Direct feed uploads: the client sends a feed file straight to storage, and
 * no request to this API ever carries it (`feed_upload_sessions`).
 *
 * ## The protocol a client follows
 *
 * 1. `open` with the file's size, SHA-256, label and compression. The answer is
 *    a session `uploading` with the part size, the part count and presigned URLs
 *    for up to 100 parts (`parts` asks for more, and fresh ones for any URL that
 *    expired), or `proof_required`, or `completed`.
 * 2. PUT exactly `size` bytes of the file to each part's URL — straight to
 *    storage, in parallel, each retried on its own.
 * 3. `complete`. Storage assembles and hashes the object; only bytes matching
 *    the declared SHA-256 become a file. The answer is `completed` with the
 *    upload, `verifying` (ask again with `describe`), `uploading` with the parts
 *    storage still lacks, or `failed`.
 *
 * Mercaria then reads the first bytes back and refuses a multi-entry archive or
 * a compression the session did not declare — the same refusals the importer
 * applies to any feed — before the `feed_uploads` row a version may cite exists.
 *
 * ## Why a deduplicated answer is not trusted on its own
 *
 * Storage answers bytes the Mercaria application already holds at once, with
 * nothing uploaded. Those bytes may be another store's feed or a creator's
 * private deliverable, and a hash plus a size is all it takes to ask. So unless
 * this OWNER already holds the file in a `feed_uploads` row, the session asks
 * for a proof of possession: one range of at most
 * {@link FEED_UPLOAD_PROOF_MAX_BYTES} at a random offset, compared byte for byte
 * with the stored object. Holding the file answers it in one small request;
 * knowing its hash cannot.
 *
 * ## Two sessions, one storage upload
 *
 * Storage keys an open upload by owner and bytes, so a second session for the
 * same bytes is answered with the FIRST session's upload — parts somebody else
 * is sending. `feed_upload_sessions_open_upload_key` makes that a conflict: the
 * same configuration resumes its own session, any other is refused until the
 * first finishes (its later open is then a deduplicated answer, with a proof).
 */

import { randomInt, timingSafeEqual } from 'node:crypto';
import {
  FEED_UPLOAD_PROOF_MAX_BYTES,
  type FeedCompression,
  type FeedUploadSessionFailure,
  type FeedUploadSessionStatus,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { getDb } from '../../db/postgres.js';
import {
  findFeedUpload,
  insertFeedUpload,
  ownerHoldsFeedUploadFile,
  type FeedUploadRow,
} from '../../db/feedImport/feedImportReportRepository.js';
import {
  findFeedUploadSession,
  findOpenFeedUploadSessionByOxyUpload,
  insertFeedUploadSession,
  transitionFeedUploadSession,
  type FeedUploadSessionRow,
} from '../../db/feedImport/feedUploadSessionRepository.js';
import {
  conflict,
  MercariaError,
  notFound,
  serviceUnavailable,
  validationError,
} from '../../lib/errors/error-codes.js';
import { ErrorCodes } from '../../utils/api-response.js';
import { log } from '../../lib/logger.js';
import {
  clientUploadPartUrls,
  completeClientUpload,
  describeClientUpload,
  OxyFilesError,
  openClientUpload,
  type ClientUploadPart,
  type ClientUploadState,
  type ClientUploadedFile,
} from '../catalog-media/oxy-files.js';
import { FeedImportRefusal } from './errors.js';
import {
  detectUploadContainer,
  readStoredUploadRange,
  sanitizeUploadFilename,
  SIGNATURE_PREFIX_BYTES,
} from './upload.js';

/** What a client sees of a session. Every field is named; nothing is spread. */
export interface FeedUploadSessionView {
  readonly id: string;
  readonly status: FeedUploadSessionStatus;
  readonly filename: string;
  readonly compression: FeedCompression;
  readonly byteSize: number;
  readonly contentDigest: string;
  readonly expiresAt: Date;
  /** While `uploading`: how to cut the file, and which parts storage holds. */
  readonly partSize?: number;
  readonly partCount?: number;
  readonly uploadedParts?: readonly number[];
  /** Presigned PUT URLs for some of the missing parts. */
  readonly parts?: readonly ClientUploadPart[];
  /** While `proof_required`: the byte range to send. */
  readonly proof?: { readonly offset: number; readonly length: number };
  /** Once `completed`: the upload a version may cite. */
  readonly upload?: FeedUploadView;
  readonly failure?: FeedUploadSessionFailure;
}

/** The upload a completed session became — the shape `GET …/uploads` lists. */
export interface FeedUploadView {
  readonly id: string;
  readonly filename: string;
  readonly byteSize: number;
  readonly contentDigest: string;
  readonly compression: FeedCompression;
  readonly status: FeedUploadRow['status'];
  readonly expiresAt: Date | null;
}

export function toFeedUploadView(row: FeedUploadRow): FeedUploadView {
  return {
    id: row.id,
    filename: row.filename,
    byteSize: row.byteSize,
    contentDigest: row.contentDigest,
    compression: row.compression,
    status: row.status,
    expiresAt: row.expiresAt,
  };
}

/** The configuration a session belongs to: the tenant fact every check reads. */
export interface FeedUploadOwner {
  readonly configurationId: string;
  /** The owning store, or `null` for a platform feed. */
  readonly storeId: string | null;
}

const OPEN_STATUSES: readonly FeedUploadSessionStatus[] = [
  'uploading',
  'proof_required',
  'verifying',
];

/**
 * The type and name storage is told. Mercaria's own labels, never the
 * client's: storage refuses active documents (XML among them) by type and by
 * extension, and a feed is data Mercaria parses, never a document it serves.
 */
function storageLabel(compression: FeedCompression): { mime: string; filename: string } {
  return compression === 'gzip'
    ? { mime: 'application/gzip', filename: 'mercaria-feed.gz' }
    : { mime: 'application/octet-stream', filename: 'mercaria-feed.bin' };
}

/** Storage's terminal codes, in the session's own vocabulary. */
function failureFor(code: string): FeedUploadSessionFailure {
  switch (code) {
    case 'CHECKSUM_MISMATCH':
      return 'checksum_mismatch';
    case 'SIZE_MISMATCH':
      return 'size_mismatch';
    case 'CONTENT_BLOCKED':
      return 'content_blocked';
    case 'EXPIRED':
    case 'ABORTED':
      return 'expired';
    default:
      return 'storage_refused';
  }
}

/** An Oxy Files refusal, answered with the status that tells a client what to do. */
function storageError(error: unknown): unknown {
  if (!(error instanceof OxyFilesError)) return error;
  if (error.status === 413 || error.status === 415 || error.status === 451) {
    return new MercariaError({
      code: ErrorCodes.VALIDATION_ERROR,
      message:
        error.status === 451
          ? 'These bytes were taken down and cannot be stored.'
          : 'The feed file store refused this file.',
      httpStatus: error.status,
      cause: error,
    });
  }
  return serviceUnavailable('The feed file store is unavailable. Try again shortly.');
}

/**
 * Open a direct upload — or resume this configuration's own open one for the
 * same bytes.
 */
export async function openFeedUploadSession(input: {
  owner: FeedUploadOwner;
  filename: string;
  compression: FeedCompression;
  byteSize: number;
  sha256: string;
  actorOxyUserId: string;
  now?: Date;
}): Promise<FeedUploadSessionView> {
  const now = input.now ?? new Date();
  const filename = sanitizeUploadFilename(input.filename);
  const sha256 = input.sha256.toLowerCase();
  if (input.byteSize > config.feedImport.maxDownloadBytes) {
    // The same cap a URL fetch meets, refused before a byte is sent.
    throw new FeedImportRefusal(
      'download_too_large',
      `The feed file is larger than the ${config.feedImport.maxDownloadBytes}-byte limit.`,
    );
  }

  let state: ClientUploadState;
  try {
    state = await openClientUpload({
      sha256,
      size: input.byteSize,
      ...storageLabel(input.compression),
    });
  } catch (error) {
    throw storageError(error);
  }

  const base = {
    configurationId: input.owner.configurationId,
    filename,
    compression: input.compression,
    byteSize: input.byteSize,
    contentDigest: sha256,
    openedByOxyUserId: input.actorOxyUserId,
    now,
  };

  switch (state.kind) {
    case 'uploading':
    case 'verifying': {
      const inserted = await insertFeedUploadSession(getDb(), {
        ...base,
        oxyUploadId: state.uploadId,
        oxyFileId: null,
        status: state.kind,
        proofOffset: null,
        proofLength: null,
      });
      const session = inserted ?? (await resumeOwnSession(state.uploadId, input.owner));
      return viewOf(session, state);
    }
    case 'completed': {
      if (state.file.size !== input.byteSize || state.file.sha256 !== sha256) {
        // Storage answered a file that is not the declared one. Nothing a
        // client sent could produce this; refuse rather than accept it.
        throw serviceUnavailable('The feed file store answered a different file.');
      }
      const session = await insertFeedUploadSession(getDb(), {
        ...base,
        oxyUploadId: null,
        oxyFileId: state.file.fileId,
        status: 'proof_required',
        ...proofRange(input.byteSize),
      });
      if (!session) throw new Error('feed_upload_sessions insert returned no row');
      const holds = await ownerHoldsFeedUploadFile(getDb(), {
        fileId: state.file.fileId,
        storeId: input.owner.storeId,
      });
      // This owner already holds these bytes in an upload of its own: the
      // possession is on record, so the file is accepted without asking.
      return holds ? accept(session, state.file) : viewOf(session);
    }
    case 'failed':
    case 'incomplete':
      throw serviceUnavailable('The feed file store could not open the upload.');
  }
}

/** A random range of at most `FEED_UPLOAD_PROOF_MAX_BYTES` inside the file. */
function proofRange(byteSize: number): { proofOffset: number; proofLength: number } {
  const proofLength = Math.min(FEED_UPLOAD_PROOF_MAX_BYTES, byteSize);
  const span = byteSize - proofLength;
  // `randomInt`'s range is bounded by 2^48, far beyond any accepted feed.
  return { proofOffset: span === 0 ? 0 : randomInt(0, span + 1), proofLength };
}

/**
 * The session already driving this storage upload — answered only to the SAME
 * configuration, and refused to anyone else, whose parts these are not.
 */
async function resumeOwnSession(
  oxyUploadId: string,
  owner: FeedUploadOwner,
): Promise<FeedUploadSessionRow> {
  const existing = await findOpenFeedUploadSessionByOxyUpload(getDb(), oxyUploadId);
  if (existing === undefined) {
    // It closed between the insert and this read; opening again starts afresh.
    throw conflict('The upload changed state while it was being opened. Open it again.');
  }
  if (existing.configurationId !== owner.configurationId) {
    throw conflict(
      'An identical file is being uploaded to another feed right now. Finish that upload, or ' +
        'try again once it has completed.',
    );
  }
  return existing;
}

/** Load a session, refusing one that belongs to another configuration as if absent. */
export async function loadFeedUploadSession(
  owner: FeedUploadOwner,
  sessionId: string,
): Promise<FeedUploadSessionRow> {
  const session = await findFeedUploadSession(getDb(), sessionId);
  // 404 rather than 403 for another feed's session: a distinguishable answer
  // would let a member enumerate which session ids exist.
  if (session === undefined || session.configurationId !== owner.configurationId) {
    throw notFound('Upload session not found for this feed');
  }
  return session;
}

/** Fresh presigned URLs for these parts of an `uploading` session. */
export async function feedUploadPartUrls(
  session: FeedUploadSessionRow,
  partNumbers: readonly number[],
): Promise<readonly ClientUploadPart[]> {
  if (session.status !== 'uploading' || session.oxyUploadId === null) {
    throw conflict(`The upload is ${session.status}; it takes no more parts.`);
  }
  try {
    return await clientUploadPartUrls(session.oxyUploadId, partNumbers);
  } catch (error) {
    throw storageError(error);
  }
}

/**
 * Where a session stands, asking storage when the answer could have moved —
 * which is also how a `verifying` session becomes `completed`: polling it
 * finishes it.
 */
export async function describeFeedUploadSession(
  session: FeedUploadSessionRow,
): Promise<FeedUploadSessionView> {
  if (session.status !== 'uploading' && session.status !== 'verifying') {
    return presentFeedUploadSession(session);
  }
  let state: ClientUploadState;
  try {
    state = await describeClientUpload(session.oxyUploadId ?? '');
  } catch (error) {
    throw storageError(error);
  }
  return advance(session, state);
}

/** Ask storage to assemble and verify the parts, then accept what it made. */
export async function completeFeedUploadSession(
  session: FeedUploadSessionRow,
): Promise<FeedUploadSessionView> {
  if (session.status === 'proof_required') {
    throw conflict('This upload needs a proof of possession, not a completion.');
  }
  if (session.status !== 'uploading' && session.status !== 'verifying') {
    return presentFeedUploadSession(session);
  }
  let state: ClientUploadState;
  try {
    state = await completeClientUpload(session.oxyUploadId ?? '');
    if (state.kind === 'incomplete') {
      // Storage says parts are missing or mis-sized; the session stays open, and
      // the client is told which parts storage holds so it can send the rest.
      state = await describeClientUpload(session.oxyUploadId ?? '');
    }
  } catch (error) {
    throw storageError(error);
  }
  return advance(session, state);
}

/**
 * A proof of possession: exactly the requested range of the file. Compared in
 * constant time with what storage holds; a mismatch fails the session for good
 * (opening again draws a new range).
 */
export async function proveFeedUploadPossession(
  session: FeedUploadSessionRow,
  bytes: Buffer,
): Promise<FeedUploadSessionView> {
  if (session.status !== 'proof_required') {
    throw conflict(`The upload is ${session.status}; it needs no proof.`);
  }
  const offset = session.proofOffset ?? 0;
  const length = session.proofLength ?? 0;
  if (bytes.length !== length) {
    throw validationError(
      `The proof must be exactly ${length} bytes of the file from byte ${offset}.`,
    );
  }
  const fileId = session.oxyFileId ?? '';
  let stored: Buffer;
  try {
    stored = await readStoredUploadRange(fileId, offset, length);
  } catch (error) {
    if (error instanceof FeedImportRefusal && error.reason === 'upload_missing') {
      return fail(session, 'expired');
    }
    throw error instanceof FeedImportRefusal
      ? serviceUnavailable('The feed file store is unavailable. Try again shortly.')
      : error;
  }
  if (stored.length !== length || !timingSafeEqual(stored, bytes)) {
    return fail(session, 'proof_failed');
  }
  return accept(session, {
    fileId,
    size: session.byteSize,
    sha256: session.contentDigest,
  });
}

/** Apply storage's answer to a session that was uploading or verifying. */
async function advance(
  session: FeedUploadSessionRow,
  state: ClientUploadState,
): Promise<FeedUploadSessionView> {
  switch (state.kind) {
    case 'uploading':
    case 'incomplete':
      return viewOf(session, state);
    case 'verifying': {
      if (session.status === 'verifying') return viewOf(session);
      const moved = await transitionFeedUploadSession(getDb(), {
        sessionId: session.id,
        fromStatuses: ['uploading'],
        to: { status: 'verifying' },
      });
      return viewOf(moved ?? (await reread(session)));
    }
    case 'failed':
      return fail(session, failureFor(state.code));
    case 'completed':
      return accept(session, state.file);
  }
}

/**
 * Accept a stored file into a `feed_uploads` row — after the checks every feed
 * meets: the size and hash are the declared ones, and the first bytes are a
 * plain file or a single-member gzip matching the declared compression.
 */
async function accept(
  session: FeedUploadSessionRow,
  file: ClientUploadedFile,
): Promise<FeedUploadSessionView> {
  if (file.size !== session.byteSize) return fail(session, 'size_mismatch');
  if (file.sha256 !== session.contentDigest) return fail(session, 'checksum_mismatch');

  let detected: FeedCompression;
  try {
    const prefix = await readStoredUploadRange(
      file.fileId,
      0,
      Math.min(SIGNATURE_PREFIX_BYTES, file.size),
    );
    detected = detectUploadContainer(prefix);
  } catch (error) {
    if (error instanceof FeedImportRefusal && error.reason === 'forbidden_container') {
      return fail(session, 'forbidden_container');
    }
    if (error instanceof FeedImportRefusal && error.reason === 'upload_missing') {
      return fail(session, 'expired');
    }
    throw error instanceof FeedImportRefusal
      ? serviceUnavailable('The feed file store is unavailable. Try again shortly.')
      : error;
  }
  if (detected !== session.compression) return fail(session, 'compression_mismatch');

  const accepted = await getDb()
    .transaction(async (tx) => {
      const upload = await insertFeedUpload(tx, {
        configurationId: session.configurationId,
        filename: session.filename,
        byteSize: file.size,
        contentDigest: file.sha256,
        storageKey: file.fileId,
        compression: detected,
        uploadedByOxyUserId: session.openedByOxyUserId,
        now: new Date(),
      });
      const moved = await transitionFeedUploadSession(tx, {
        sessionId: session.id,
        fromStatuses: OPEN_STATUSES,
        to: { status: 'completed', oxyFileId: file.fileId, feedUploadId: upload.id },
      });
      // Somebody else finished this session first: undo this upload row and
      // answer what they wrote.
      if (moved === undefined) throw new SessionMovedError();
      return { session: moved, upload };
    })
    .catch((error: unknown) => {
      if (error instanceof SessionMovedError) return undefined;
      throw error;
    });
  if (accepted === undefined) return presentFeedUploadSession(await reread(session));
  log.general.info(
    { sessionId: session.id, uploadId: accepted.upload.id, byteSize: file.size },
    '[FeedImport] direct upload accepted',
  );
  return { ...viewOf(accepted.session), upload: toFeedUploadView(accepted.upload) };
}

class SessionMovedError extends Error {}

async function fail(
  session: FeedUploadSessionRow,
  failure: FeedUploadSessionFailure,
): Promise<FeedUploadSessionView> {
  const moved = await transitionFeedUploadSession(getDb(), {
    sessionId: session.id,
    fromStatuses: OPEN_STATUSES,
    to: { status: 'failed', failure },
  });
  log.general.warn({ sessionId: session.id, failure }, '[FeedImport] direct upload refused');
  return presentFeedUploadSession(moved ?? (await reread(session)));
}

async function reread(session: FeedUploadSessionRow): Promise<FeedUploadSessionRow> {
  return (await findFeedUploadSession(getDb(), session.id)) ?? session;
}

/** The client's view, with storage's live part state when there is one. */
async function viewWithUpload(
  session: FeedUploadSessionRow,
  base: FeedUploadSessionView,
): Promise<FeedUploadSessionView> {
  if (session.status !== 'completed' || session.feedUploadId === null) return base;
  const upload = await findFeedUpload(getDb(), session.feedUploadId);
  return upload === undefined ? base : { ...base, upload: toFeedUploadView(upload) };
}

function viewOf(session: FeedUploadSessionRow, state?: ClientUploadState): FeedUploadSessionView {
  return {
    id: session.id,
    status: session.status,
    filename: session.filename,
    compression: session.compression,
    byteSize: session.byteSize,
    contentDigest: session.contentDigest,
    expiresAt: session.expiresAt,
    ...(state?.kind === 'uploading'
      ? {
          partSize: state.partSize,
          partCount: state.partCount,
          uploadedParts: state.uploadedParts,
          parts: state.parts,
        }
      : {}),
    ...(session.status === 'proof_required' && session.proofOffset !== null
      ? { proof: { offset: session.proofOffset, length: session.proofLength ?? 0 } }
      : {}),
    ...(session.failure === null ? {} : { failure: session.failure }),
  };
}

/** The complete client view of a session, including its upload once completed. */
export async function presentFeedUploadSession(
  session: FeedUploadSessionRow,
): Promise<FeedUploadSessionView> {
  return viewWithUpload(session, viewOf(session));
}
