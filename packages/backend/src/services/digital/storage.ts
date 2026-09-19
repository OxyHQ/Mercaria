/**
 * The object-storage port for digital asset bytes (ADR 0010 D17, #1015 W1).
 *
 * ## Mercaria has no S3 client and never has
 *
 * Its media is Oxy files. `services/catalog-hydration.service.ts` `resolveMedia`
 * is the one PUBLIC resolver — it builds `https://cloud.oxy.so/<id>` with no
 * network call — and a digital asset file is the opposite kind of object: a
 * PRIVATE Oxy asset, which that builder resolves to a hard 404 while looking
 * exactly like it worked. So `asset_files.storage_key` holds an Oxy `file_id` and
 * this module is the only thing that turns one into a URL.
 *
 * ## D17's mechanism, and the user-scoped path it is NOT
 *
 * The obvious call — `oxyClient.getFileDownloadUrlAsync(fileId)` — is WRONG here,
 * and it took building it to see why. It resolves a URL for the CURRENT USER
 * through Oxy's `canUserAccessFile`, which asks *may this viewer read this file*.
 * A Mercaria buyer is not a viewer: they have no relationship to the seller's
 * private file in Oxy at all, and Oxy is right to refuse them. The fact that
 * authorizes the download is a row in `asset_rights`, which Oxy does not hold and
 * should not. A media token was measured and fails for the same reason — Oxy's
 * `verifyMediaToken` returns a `uid` and the stream route re-runs the same ACL,
 * so the token names a viewer and would be minted and then refused.
 *
 * So D17 binds `getServiceLinkedDownloadUrls` (Oxy ADR 0021): a SERVICE-token
 * batch mint, scoped by the one claim that is not ours to forge — the file's own
 * owner attached it to the `mercaria` application. Oxy answers *did this file's
 * owner attach it here*; this service answers *may this person have it*; neither
 * is derivable from the other, which is the whole division.
 *
 * There is no fallback, to the CDN builder or anywhere else, and
 * `AssetUrlResolutionError`'s docblock is the reason it would be wrong rather
 * than merely unnecessary: of the failures it documents as possibly
 * fallback-able, none applies to a private asset — 401/403/404 are definitive,
 * and a 5xx "transient" fallback is defensible only for a caller that
 * independently knows the asset is PUBLIC. This one knows the opposite, so a
 * fallback would hand a buyer a guaranteed 404 and swallow the real failure.
 *
 * ## One route answers both questions, which is why there is no `files:read` call
 *
 * `getServiceLinkedDownloadUrls` returns the mint AND the three measured facts
 * (`sha256`, `size`, `mime`) in one response, so `describeAssetObject` reads it
 * too rather than asking `getServiceAssetMetadataByIds`. That is not a saved
 * round trip, it is a stronger register-time check: the metadata route answers
 * for ANY file id, so registration would have accepted a file the creator never
 * attached to Mercaria and the failure would have surfaced months later, to a
 * buyer, as a download that does not work. Reading the mint makes "not attached
 * here" a refusal the CREATOR meets, immediately, in the register call.
 *
 * The cost is a 300-second credential minted and discarded at register time.
 * Taken deliberately: it is never returned, never logged, and the alternative is
 * a class of failure whose only witness is somebody who already paid.
 *
 * ## Why this is a PORT and not four calls spread through two controllers
 *
 * The provider is a decision that was deferred once already (Phase A shipped no
 * storage at all) and may be revisited — a second vertical with multi-gigabyte
 * sources is exactly the case that would make somebody ask. One interface with
 * one implementation costs nothing today and makes that a new file rather than a
 * grep. The narrower reason is the one that bites: D17 says the storage key is
 * resolved ONLY through the authorized path, and a rule stated across four call
 * sites is a rule somebody adds a fifth to. This module is the ONLY place in the
 * digital domain that names `oxyClient`, and
 * `__tests__/digital-storage-port.test.ts` fails the build on a second one.
 *
 * ## `describeAssetObject` is the fourth member, and W1 requirement 7 is why
 *
 * `asset_files.content_hash` is documented on the table as *"SHA-256 of the
 * stored bytes, computed server-side (#1015 W1 requirement 7) — never taken from
 * the client, which would make it an attacker-chosen value and the duplicate
 * detector in W8 a thing an attacker controls"*. The creator surface registers a
 * file the creator uploaded STRAIGHT TO OXY — the bytes never transit this API,
 * because an 8 GiB ceiling (`MAX_ASSET_FILE_BYTES`) and a 10 MB
 * `express.json()` limit are not reconcilable — so the only honest source for the
 * hash, the byte size and the verified media type is the asset service itself,
 * read server-to-server. Without this member the register route would have to
 * believe a client-reported digest, which is the exact value W1 forbids. It
 * resolves through `getServiceLinkedDownloadUrls`, which is service-token
 * authenticated and therefore needs `OXY_APPLICATION_KEY`/`OXY_APPLICATION_SECRET`;
 * an unconfigured deployment gets a refusal and never a client-supplied fact.
 */

import type { AssetUploadInput, OxyServices } from '@oxy.so/core';
import { oxyClient } from '../../middleware/auth.js';
import { oxyServiceClient } from '../../capabilities/oxy-service-client.js';
import { log } from '../../lib/logger.js';

/**
 * One stored object, described by MEASUREMENT rather than by a claim.
 *
 * Every field here is what the asset service says about the bytes it holds.
 * Nothing on it came from a request body, which is what makes it safe to write
 * into `asset_files` — see the module docblock on W1 requirement 7.
 */
export interface StoredAssetObject {
  /** The Oxy `file_id`. Written to `asset_files.storage_key`, a PROTECTED column. */
  readonly storageKey: string;
  readonly byteSize: number;
  /** The media type the asset service verified from content. */
  readonly mediaType: string;
  /** Lowercase hex SHA-256 of the stored bytes. */
  readonly contentHash: string;
}

/** What `putAssetObject` is handed. The bytes, and nothing a client chose. */
export interface PutAssetObjectInput {
  readonly file: AssetUploadInput;
  /**
   * Free-form metadata the asset service stores beside the object.
   *
   * Deliberately `string` values only: this is an audit aid, not a second
   * representation of anything `asset_files` holds. Two records of one fact can
   * disagree, and the table is the one that authorizes.
   */
  readonly metadata?: Readonly<Record<string, string>>;
}

/**
 * Why a storage operation did not happen.
 *
 * - `unconfigured` — this deployment has no credential for the operation. A 503:
 *   the caller did nothing wrong and retrying after somebody sets a variable is
 *   the correct behaviour.
 * - `absent` — the asset service does not hold (or will not admit to) that id.
 * - `unresolved` — resolution itself failed, definitively or transiently. The
 *   two are NOT distinguished to the caller on purpose: for a private asset both
 *   mean "no URL", and the only thing telling them apart would buy is a probe
 *   that learns which file ids exist.
 */
export type DigitalStorageFailure = 'unconfigured' | 'absent' | 'unresolved';

/**
 * A storage failure, carrying the reason and NEVER the resolved URL or the key.
 *
 * The same discipline `AssetUrlResolutionError` documents: a resolved private
 * URL embeds a scoped media token, so it may not reach a message, a log line or
 * an error field. ADR 0010 D5 and #1015 W1 rule 4.
 */
export class DigitalStorageError extends Error {
  readonly reason: DigitalStorageFailure;

  constructor(reason: DigitalStorageFailure, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DigitalStorageError';
    this.reason = reason;
  }
}

/** Whether a thrown value is this module's failure. */
export function isDigitalStorageError(error: unknown): error is DigitalStorageError {
  return error instanceof DigitalStorageError;
}

/**
 * The provider-neutral contract. One interface; `oxyAssetStorage` is the one
 * implementation of it.
 */
export interface DigitalAssetStoragePort {
  /** Store bytes as a PRIVATE object and return what the service measured. */
  putAssetObject(input: PutAssetObjectInput): Promise<StoredAssetObject>;
  /**
   * What the service holds under `storageKey`, measured — or `null` when it
   * holds nothing active.
   */
  describeAssetObject(storageKey: string): Promise<StoredAssetObject | null>;
  /**
   * A short-lived, caller-scoped URL for the object. Called ONLY after
   * `download.service.redeemDownloadGrant` has authorized the transfer.
   */
  resolveAuthorizedUrl(storageKey: string, variant?: string): Promise<string>;
  /**
   * Remove the object.
   *
   * Reachable only for an UNPUBLISHED version's file: the migration 0156
   * triggers refuse to delete a published `asset_files` row, and ADR 0010 D6's
   * "nothing is deleted" governs the commerce record. An orphaned object whose
   * row never got written is what this is for.
   */
  deleteAssetObject(storageKey: string): Promise<void>;
}

/**
 * The Oxy application this service is, as Oxy's `file_links.app` spells it.
 *
 * It is the left half of the authorization Oxy performs (ADR 0021): a file is
 * servable to Mercaria only when a `file_links` row carries THIS value and was
 * created by the file's own owner. So the constant is not cosmetic — a typo here
 * makes every download refuse, and it makes it refuse in the one way that is
 * indistinguishable from "the creator never attached the file", so nothing in the
 * error says what is wrong.
 *
 * It is NOT configurable. The value is the application identity Oxy mints this
 * service's tokens for, so a deployment cannot pick a different one and have it
 * mean anything; reading it from the environment would turn a compile-time
 * constant into a silent mismatch.
 */
export const MERCARIA_OXY_APP = 'mercaria';

/**
 * The `entityType` this service links asset files under.
 *
 * Oxy stores the link's `entityType`/`entityId` and authorizes on neither — only
 * `app` and `created_by` decide. So this is a label for whoever reads a file's
 * links in the Oxy console, and its value is chosen to say which Mercaria row the
 * file belongs to rather than to gate anything here.
 */
export const MERCARIA_ASSET_FILE_ENTITY_TYPE = 'asset_file';

/**
 * The client the SERVICE-authenticated reads use.
 *
 * `getServiceLinkedDownloadUrls` goes through `makeServiceRequest`, so it is
 * authenticated by a service credential rather than by a user session — which is
 * the whole point: there is no user session on this path and the buyer would be
 * the wrong one if there were. `capabilities/oxy-service-client.ts` is the
 * existing single reader of those credentials and this reuses it rather than
 * adding a second — two places reading one secret is how one of them ends up
 * pointed at the wrong environment.
 */
function serviceClientOrThrow(): OxyServices {
  const client = oxyServiceClient();
  if (!client) {
    throw new DigitalStorageError(
      'unconfigured',
      'Digital asset storage needs Oxy application credentials to verify an uploaded file.',
    );
  }
  return client;
}

/**
 * The one read: what Oxy will serve under `storageKey`, or `null`.
 *
 * `null` covers every refusal Oxy makes, and they are deliberately not
 * distinguished here because Oxy does not distinguish them either: an unknown id,
 * a deleted one, a system-owned one, one linked by somebody other than its owner,
 * and one never attached to this application all come back as the same absence.
 * Telling them apart is a probe for which Oxy file ids exist (Oxy ADR 0021), and
 * `asset_rights` is what decides entitlement regardless.
 *
 * Every field is validated before it leaves, because what is returned is written
 * into `asset_files`, whose CHECKs are the real floor: `content_hash` is
 * `^[0-9a-f]{64}$` and `byte_size` is positive. Checking here turns an asset
 * service that answered without a digest into a named refusal instead of a
 * constraint violation two layers down.
 */
interface LinkedDownloadUrlEntry {
  readonly id: string;
  readonly url: string;
  readonly expiresIn: number;
  readonly mime: string;
  readonly size: number;
  readonly sha256: string;
}

/**
 * The route path, and why this calls it through `makeServiceRequest` rather than
 * through the SDK wrapper that exists for it.
 *
 * `@oxy.so/core` ships `getServiceLinkedDownloadUrls`, which adds chunking at the
 * route's cap of 25 and the throw-rather-than-shorten discipline this file needs.
 * Mercaria consumes that package from npm, and the release carrying the method
 * lands after the release carrying this code, so calling it here would not
 * compile. `makeServiceRequest` is public, typed, and the exact transport the
 * wrapper uses, so the behaviour is identical for the ONE id this module ever
 * sends — n=1 has no chunking to get wrong, and the throw below is the same
 * decision made locally.
 *
 * SWAP THIS for the SDK method at the next `@oxy.so/core` bump. The reason is not
 * tidiness: the wrapper is where the chunk cap lives, so a future caller that
 * asks for a whole version's files must go through it or re-derive a bound that
 * only Oxy knows.
 */
const LINKED_URL_PATH = '/assets/service/linked-url';

/**
 * The one read: what Oxy will serve under `storageKey`, or `null`.
 *
 * `null` covers every refusal Oxy makes, and they are deliberately not
 * distinguished here because Oxy does not distinguish them either: an unknown id,
 * a deleted one, a system-owned one, one linked by somebody other than its owner,
 * and one never attached to this application all come back as the same absence.
 * Telling them apart is a probe for which Oxy file ids exist (Oxy ADR 0021), and
 * `asset_rights` is what decides entitlement regardless.
 *
 * Every field is validated before it leaves, because what is returned is written
 * into `asset_files`, whose CHECKs are the real floor: `content_hash` is
 * `^[0-9a-f]{64}$` and `byte_size` is positive. Checking here turns an asset
 * service that answered without a digest into a named refusal instead of a
 * constraint violation two layers down. It is also the boundary where an
 * untrusted response becomes a typed fact — the transport is generic over its
 * return type, so nothing but these checks stands between a changed wire shape
 * and an `asset_files` insert.
 */
async function readServableObject(
  storageKey: string,
): Promise<{ object: StoredAssetObject; url: string } | null> {
  const client = serviceClientOrThrow();
  let minted: unknown;
  try {
    // A failure THROWS and is never read as an absence. A swallowed 429 here
    // would register a file with no verified hash, or tell a buyer who paid that
    // their file is gone — and absence is already this route's answer for "not
    // attached here", so the two must not collapse.
    minted = await client.makeServiceRequest<LinkedDownloadUrlEntry[]>('POST', LINKED_URL_PATH, {
      ids: [storageKey],
    });
  } catch (cause) {
    throw new DigitalStorageError(
      'unresolved',
      'The asset service could not be asked about the file.',
      { cause },
    );
  }
  if (!Array.isArray(minted)) return null;
  const entry = (minted as LinkedDownloadUrlEntry[]).find(
    (candidate) => candidate?.id === storageKey,
  );
  if (!entry) return null;
  if (typeof entry.url !== 'string' || entry.url.trim() === '') return null;
  const contentHash = typeof entry.sha256 === 'string' ? entry.sha256.toLowerCase() : '';
  if (!/^[0-9a-f]{64}$/.test(contentHash)) return null;
  if (!Number.isSafeInteger(entry.size) || entry.size <= 0) return null;
  if (typeof entry.mime !== 'string' || entry.mime.trim() === '') return null;
  return {
    object: {
      storageKey,
      byteSize: entry.size,
      mediaType: entry.mime.trim(),
      contentHash,
    },
    url: entry.url,
  };
}

/** The Oxy file id a raw upload produced, whatever envelope it came back in. */
function uploadedFileId(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) return null;
  const envelope = result as { id?: unknown; fileId?: unknown; file?: { id?: unknown } };
  for (const candidate of [envelope.id, envelope.fileId, envelope.file?.id]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
  }
  return null;
}

/** The ONE implementation: a digital asset file is a private Oxy asset. */
export const oxyAssetStorage: DigitalAssetStoragePort = {
  async putAssetObject(input: PutAssetObjectInput): Promise<StoredAssetObject> {
    let uploaded: unknown;
    try {
      // `'private'` is stated rather than relied on. The asset service's own
      // default is private, but a default is a thing that changes in somebody
      // else's release, and the difference here is between a paid mesh behind an
      // authorizer and a paid mesh on a CDN.
      uploaded = await oxyClient.uploadRawFile(input.file, 'private', input.metadata);
    } catch (cause) {
      throw new DigitalStorageError('unresolved', 'Storing the asset object failed.', { cause });
    }
    const storageKey = uploadedFileId(uploaded);
    if (!storageKey) {
      throw new DigitalStorageError(
        'unresolved',
        'The asset service accepted the upload and named no file.',
      );
    }
    try {
      // The link is NOT bookkeeping — it is the authorization (Oxy ADR 0021). A
      // file with no `mercaria` link created by its own owner is unservable, and
      // `describeAssetObject` below would answer `null` for an object that was
      // just stored successfully. Linking here is what makes `created_by` equal
      // `owner_user_id`: this client uploaded the object, so it owns it, so its
      // own link satisfies the predicate.
      //
      // `entityId` is the storage key itself. An asset-file row does not exist
      // yet — this call is what produces the key the row will hold — and the
      // alternative of linking later, from the register path, would be linking as
      // a DIFFERENT principal whenever the upload and the registration were not
      // the same caller. Oxy authorizes on `app` and `created_by` only, so the
      // value is a label; a self-reference is the one label that cannot go stale.
      await oxyClient.assetLink(
        storageKey,
        MERCARIA_OXY_APP,
        MERCARIA_ASSET_FILE_ENTITY_TYPE,
        storageKey,
      );
    } catch (cause) {
      throw new DigitalStorageError(
        'unresolved',
        'The asset object was stored and could not be attached to this application.',
        { cause },
      );
    }
    // Measured, not assumed — even here. The caller knows the length of the
    // buffer it handed over; it does not know what the service stored, and
    // `asset_files.content_hash` is a claim about the latter. It also re-reads
    // through the servability check, so an upload whose link did not take is
    // refused HERE rather than at a buyer's download.
    const described = await oxyAssetStorage.describeAssetObject(storageKey);
    if (!described) {
      throw new DigitalStorageError(
        'absent',
        'The asset service accepted the upload and cannot describe it.',
      );
    }
    return described;
  },

  async describeAssetObject(storageKey: string): Promise<StoredAssetObject | null> {
    const servable = await readServableObject(storageKey);
    // The URL is discarded, and discarding it is the point: this member exists to
    // measure, and returning a credential from a describe call is how one ends up
    // in a response body nobody meant to put it in.
    return servable?.object ?? null;
  },

  async resolveAuthorizedUrl(storageKey: string, variant?: string): Promise<string> {
    // `variant` is accepted and deliberately IGNORED, which is worth saying out
    // loud rather than dropping from the signature. A variant is a DERIVED
    // rendition — a thumbnail, a poster — and the service route mints a URL for
    // the original object only. A deliverable has no meaningful rendition: a
    // buyer who paid for a mesh is owed the mesh, and silently serving a
    // derivative would be the one failure mode nobody would notice until a
    // printer rejected the file. Public PREVIEW derivatives are a different
    // surface (`PUBLICLY_VIEWABLE_ASSET_FILE_ROLES`) and never come through here.
    void variant;
    let servable: Awaited<ReturnType<typeof readServableObject>>;
    try {
      servable = await readServableObject(storageKey);
    } catch (cause) {
      // The key is NOT logged and neither is anything derived from it. What a
      // support question needs is that a resolution failed and roughly when;
      // what a log line must never carry is the door.
      log.general.error(
        { err: cause instanceof Error ? cause.name : 'unknown' },
        '[Digital] authorized asset URL could not be resolved',
      );
      throw new DigitalStorageError('unresolved', 'The file could not be served right now.', {
        cause,
      });
    }
    if (!servable) {
      // Reached when the creator's file is no longer attached to this
      // application — they unlinked it, or it was deleted in Oxy. The buyer's
      // RIGHT is untouched by that (ADR 0010 D6: nothing auto-deletes), so this
      // is a serving failure and not a revocation, and it must not be reported as
      // one.
      log.general.error(
        {},
        '[Digital] a file with an active right is no longer servable to this application',
      );
      throw new DigitalStorageError('absent', 'The file could not be served right now.');
    }
    return servable.url;
  },

  async deleteAssetObject(storageKey: string): Promise<void> {
    try {
      await oxyClient.assetDelete(storageKey);
    } catch (cause) {
      throw new DigitalStorageError('unresolved', 'Removing the asset object failed.', { cause });
    }
  },
};

/**
 * What the rest of the domain imports.
 *
 * A named binding rather than the implementation itself, so a second provider is
 * a change to this line and `vi.mock` in a test replaces one symbol.
 */
export const assetStorage: DigitalAssetStoragePort = oxyAssetStorage;
