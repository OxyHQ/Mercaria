/**
 * THE adapter between Mercaria and Oxy Files (Oxy ADR 0043). Every call Mercaria
 * makes about a file's bytes, owner or usage goes through this module and only
 * this module, so a name that changes upstream is a change to one file.
 *
 * - **Import by URL** (D7): Oxy downloads a source with its own SSRF-safe
 *   fetcher and remembers it per (owner, URL), so importing an unchanged source
 *   again returns the same file without a download. Mercaria no longer fetches
 *   supplier bytes at all.
 * - **Upload** of bytes Mercaria already holds (a merchant's upload), and the
 *   resumable multipart upload of a private deliverable of any type up to 8 GiB.
 * - **Adoption** (stage 4b): the application's OWN file of a file it can read,
 *   sharing the stored bytes — a creator's deliverable, without a download.
 * - **References** (D4/D6): the application's own record of which entity uses
 *   which file. The application is always the service token's; nothing here
 *   names it.
 * - **Event signatures** (D9).
 *
 * Two owners exist (`OxyFileOwner`): an ACCOUNT — a store's media belongs to
 * `stores.oxy_account_id`, a P2P listing's to its seller — imported acting as
 * that account; and the Mercaria APPLICATION, for content no account owns
 * (canonical catalogue media, category art, brand logos, digital deliverables —
 * the last PRIVATE: readable by no person, only by Mercaria's service token
 * through `linkedDownloadUrls`, ADR 0043 D3).
 *
 * Errors never carry a source URL, a signed query or a token: a supplier URL is
 * routinely a capability, and these messages reach sync-run rows and logs.
 */

import {
  OxyApiError,
  type ServiceFileReference,
  type ServiceFileReferenceResult,
  type ServiceReferenceInventoryItem,
  type ServiceReferenceReconcileResult,
} from '@oxy.so/core';
import {
  FileEventVerificationError,
  LargeUploadFailedError,
  verifyFileEventSignature,
  type FileEvent,
  type OxyServer,
} from '@oxy.so/core/server';
import { isOxyFileId } from '@mercaria/shared-types';
import { oxyServiceClient } from '../../capabilities/oxy-service-client.js';

/** One minted private download (the SDK does not export the type by name). */
export type ServiceLinkedDownloadUrl = Awaited<
  ReturnType<OxyServer['assets']['linkedDownloadUrls']>
>[number];

/** Who a stored file belongs to (ADR 0043 D1). */
export type OxyFileOwner =
  | { readonly kind: 'account'; readonly oxyUserId: string }
  | { readonly kind: 'application' };

/** What Oxy says it stored. Validated before it leaves this module. */
export interface StoredOxyFile {
  readonly fileId: string;
  readonly mime: string;
  readonly size: number;
  readonly visibility: string;
}

/** A refusal or failure of an Oxy Files call. The message is safe to store. */
export class OxyFilesError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'OxyFilesError';
    this.status = status;
  }
}

const UPLOAD_TIMEOUT_MS = 25_000;

function client(): OxyServer {
  const configured = oxyServiceClient();
  if (!configured) throw new OxyFilesError('Oxy Files needs Mercaria application credentials.');
  return configured;
}

function statusOf(error: unknown): number | undefined {
  if (error instanceof OxyApiError) return error.status;
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

function refusal(action: string, error: unknown): OxyFilesError {
  const status = statusOf(error);
  if (status === 401 || status === 403)
    return new OxyFilesError(`Oxy has not authorized Mercaria to ${action}.`, status);
  if (status !== undefined)
    return new OxyFilesError(`Oxy could not ${action} (HTTP ${status}).`, status);
  return new OxyFilesError(`Oxy could not ${action}.`);
}

/**
 * The stored file out of an Oxy answer, whatever envelope it came in (`{ file }`
 * or the file itself). Everything a caller relies on is checked here, so a
 * changed wire shape is a named refusal and never an `undefined` file id
 * written into a gallery.
 */
function storedFile(answer: unknown): StoredOxyFile {
  const envelope = (answer ?? {}) as { file?: unknown };
  const file = (envelope.file ?? answer) as {
    id?: unknown;
    mime?: unknown;
    size?: unknown;
    visibility?: unknown;
  };
  if (
    !isOxyFileId(file?.id) ||
    typeof file.mime !== 'string' ||
    typeof file.size !== 'number' ||
    !Number.isSafeInteger(file.size) ||
    file.size <= 0 ||
    typeof file.visibility !== 'string'
  ) {
    throw new OxyFilesError('Oxy did not describe the stored file.');
  }
  return { fileId: file.id, mime: file.mime, size: file.size, visibility: file.visibility };
}

/**
 * Import a public HTTPS source as a PUBLIC file of `owner` (ADR 0043 D7).
 *
 * Oxy fetches it (HTTPS on every hop, public addresses only, bounded bytes and
 * time) and keeps `(owner, URL) → file`, so a repeat of an unchanged URL answers
 * the same file without downloading — which is what ends the connector's
 * re-upload of every gallery on every product update. A changed source is
 * fetched again only when `revalidate` asks for it.
 *
 * No reference is registered here (the SDK's `reference` option is not used):
 * the row that will hold the file is not written yet, and registering before
 * it commits would keep the file alive for a write that may roll back. The
 * reference outbox registers it after commit; an application file whose write
 * failed is unreferenced and Oxy collects it — the outcome wanted.
 *
 * `importAppFile` / `importUserMedia` (`@oxy.so/core` 4.18.0, Oxy ADR 0043):
 * `POST /assets/service/app/import`, and `/assets/service/user-media/import`
 * owned by the `x-owner-user-id` header.
 */
export async function importOxyFileFromUrl(
  owner: OxyFileOwner,
  sourceUrl: string,
  options: { revalidate?: boolean } = {},
): Promise<StoredOxyFile> {
  if (owner.kind === 'account' && !owner.oxyUserId)
    throw new OxyFilesError('An account-owned import needs its owner.');
  const oxy = client();
  const revalidate = options.revalidate ? { revalidate: true } : {};
  let answer: unknown;
  try {
    answer =
      owner.kind === 'application'
        ? await oxy.assets.importAppFile(sourceUrl, { visibility: 'public', ...revalidate })
        : await oxy.assets.importUserMedia(owner.oxyUserId, sourceUrl, {
            visibility: 'public',
            ...revalidate,
          });
  } catch (error) {
    throw refusal('import the media source', error);
  }
  return storedFile(answer);
}

/**
 * Store bytes Mercaria already holds as a PUBLIC file of `owner`: a merchant's
 * upload through `POST /admin/stores/:storeId/products/media` (account), or an
 * application asset. Oxy deduplicates per (owner, bytes).
 */
export async function uploadOxyFile(
  owner: OxyFileOwner,
  bytes: Buffer | Uint8Array,
  mime: string,
  originalName: string,
): Promise<StoredOxyFile> {
  if (owner.kind === 'account' && !owner.oxyUserId)
    throw new OxyFilesError('An account-owned upload needs its owner.');
  const oxy = client();
  const body = new Uint8Array(bytes);
  try {
    if (owner.kind === 'application') {
      const uploaded = await oxy.assets.uploadAppFile(body, mime, {
        visibility: 'public',
        originalName,
        timeout: UPLOAD_TIMEOUT_MS,
      });
      return storedFile(uploaded);
    }
    return storedFile(
      await oxy.assets.uploadUserMedia(owner.oxyUserId, body, mime, {
        originalName,
        timeout: UPLOAD_TIMEOUT_MS,
      }),
    );
  } catch (error) {
    if (error instanceof OxyFilesError) throw error;
    throw refusal('store the media', error);
  }
}

/**
 * Store bytes this process holds as a PRIVATE file of the Mercaria APPLICATION
 * (ADR 0043 stage 4b, `uploadAppFileLarge`): any type Oxy does not refuse as
 * executable or active content (HTML, SVG, XML, scripts — 415), up to 8 GiB, by
 * a resumable multipart upload whose parts go straight to storage. Oxy hashes
 * the assembled object before it becomes a file, and the SDK hashes the source
 * 8 MiB at a time, so neither side holds the whole file in memory. Calling again
 * for the same bytes resumes an interrupted upload (and an already-stored copy
 * answers at once, deduplicated).
 *
 * No reference is registered here: the caller registers the use under the id
 * this returns, which it does not know before.
 */
export async function uploadPrivateApplicationFile(
  source: Blob,
  mime: string,
  options: { filename: string; metadata?: Readonly<Record<string, string>> },
): Promise<StoredOxyFile> {
  const oxy = client();
  let answer: unknown;
  try {
    answer = await oxy.assets.uploadAppFileLarge(source, {
      mime,
      visibility: 'private',
      filename: options.filename,
      ...(options.metadata ? { metadata: { ...options.metadata } } : {}),
    });
  } catch (error) {
    if (error instanceof LargeUploadFailedError)
      throw new OxyFilesError(`Oxy did not store the upload (${error.code}).`);
    throw refusal('store the file', error);
  }
  return storedFile(answer);
}

/**
 * Give the Mercaria APPLICATION its own PRIVATE file of the bytes `fileId`
 * holds (ADR 0043 stage 4b, `adoptAppFile`): the stored object is SHARED, never
 * downloaded or uploaded again, and the copy outlives the source, whose owner
 * may delete theirs. Oxy answers for a file this application can read — a
 * person's private file its owner attached to Mercaria (ADR 0021), any public
 * or unlisted file, or Mercaria's own (answered as it is) — and 404 otherwise;
 * taken-down bytes are 451. Private is the narrowest visibility, so the
 * "wider than the source" refusal cannot apply. Idempotent per (application,
 * bytes).
 *
 * No reference is registered here, for the same reason as the upload.
 */
export async function adoptAsPrivateApplicationFile(
  fileId: string,
): Promise<StoredOxyFile & { sha256: string }> {
  const oxy = client();
  let answer: Awaited<ReturnType<OxyServer['assets']['adoptAppFile']>>;
  try {
    answer = await oxy.assets.adoptAppFile(fileId, { visibility: 'private' });
  } catch (error) {
    throw refusal('adopt the file', error);
  }
  const stored = storedFile(answer);
  const sha256 = typeof answer?.file?.sha256 === 'string' ? answer.file.sha256.toLowerCase() : '';
  if (!/^[0-9a-f]{64}$/.test(sha256))
    throw new OxyFilesError('Oxy did not describe the stored file.');
  return { ...stored, sha256 };
}

/** Register Mercaria's use of files (`files:references:write`). Per-item results. */
export async function addOxyFileReferences(
  references: readonly ServiceFileReference[],
): Promise<ServiceFileReferenceResult[]> {
  if (references.length === 0) return [];
  try {
    return await client().assets.references.add([...references]);
  } catch (error) {
    if (error instanceof OxyFilesError) throw error;
    throw refusal('register file references', error);
  }
}

/** Withdraw Mercaria's use of files. Never trashes or deletes a file. */
export async function removeOxyFileReferences(
  references: readonly ServiceFileReference[],
): Promise<ServiceFileReferenceResult[]> {
  if (references.length === 0) return [];
  try {
    return await client().assets.references.remove([...references]);
  } catch (error) {
    if (error instanceof OxyFilesError) throw error;
    throw refusal('remove file references', error);
  }
}

/**
 * Send Oxy the whole inventory of one entity type (ADR 0043 D6): Oxy adds the
 * references it is missing and removes the ones created before the run began
 * that the inventory does not list. `dryRun` only counts.
 */
export async function reconcileOxyFileReferences(
  entityType: string,
  items: AsyncIterable<ServiceReferenceInventoryItem>,
  options: { dryRun: boolean },
): Promise<ServiceReferenceReconcileResult> {
  try {
    return await client().assets.references.reconcile(entityType, items, {
      dryRun: options.dryRun,
    });
  } catch (error) {
    if (error instanceof OxyFilesError) throw error;
    throw refusal('reconcile file references', error);
  }
}

/** The file event Mercaria reads, or the endpoint challenge to echo. */
export type VerifiedOxyFileDelivery =
  | { readonly kind: 'challenge'; readonly challenge: string }
  | { readonly kind: 'event'; readonly event: FileEvent }
  | { readonly kind: 'refused'; readonly reason: string };

/**
 * Verify one delivery to the file-events endpoint (ADR 0043 D9): HMAC-SHA256
 * over `<t>.<raw body>` in `oxy-signature`, `t` within five minutes, compared
 * in constant time — Oxy's own verifier, so there is one. A
 * `webhook.challenge` is returned WITHOUT a signature check: Oxy sends it when
 * the endpoint is set, before the secret has been shown to anybody.
 */
export function verifyOxyFileDelivery(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  secret: string,
): VerifiedOxyFileDelivery {
  try {
    const verified = verifyFileEventSignature(rawBody, headers, secret);
    return verified.type === 'webhook.challenge'
      ? { kind: 'challenge', challenge: verified.challenge }
      : { kind: 'event', event: verified };
  } catch (error) {
    if (error instanceof FileEventVerificationError)
      return { kind: 'refused', reason: error.message };
    throw error;
  }
}

/**
 * Mint short-lived download URLs for files this application may read
 * privately: its OWN files (ADR 0043 D3 — an application-owned private
 * deliverable) and a person's file that person attached to it (ADR 0021).
 * Absence is a refusal, not a fact about the file. A failure THROWS; each URL is
 * a live credential and is never logged.
 */
export async function mintPrivateDownloadUrls(
  fileIds: readonly string[],
): Promise<ServiceLinkedDownloadUrl[]> {
  if (fileIds.length === 0) return [];
  try {
    return await client().assets.linkedDownloadUrls([...fileIds]);
  } catch (error) {
    if (error instanceof OxyFilesError) throw error;
    throw refusal('mint a download URL', error);
  }
}

/** Delete one of this application's own files (`files:app:delete`). */
export async function deleteApplicationFile(fileId: string): Promise<void> {
  try {
    await client().assets.deleteAppFile(fileId);
  } catch (error) {
    if (error instanceof OxyFilesError) throw error;
    throw refusal('delete the file', error);
  }
}
