/**
 * Opening a feed's bytes — one function over both origins (#63 §"Supported
 * inputs" 5 and 6).
 *
 * A URL and an upload differ in exactly one place, and after it the pipeline is
 * identical: bytes in, bounded, decompressed, decoded, parsed, mapped. Keeping
 * that seam here rather than branching inside the stage builder is what makes
 * "an upload is not a trusted origin just because a merchant authenticated to
 * send it" true by construction — the same caps and the same parser apply to
 * both, because there is only one of each.
 *
 * This module reaches no database, which is what lets the adapter import it
 * directly: the #62 isolation gate scans `services/ingestion/adapters/` for a
 * repository, a database handle or drizzle, and there is none here to reach.
 */

import type { FeedAuthorization } from './auth.js';
import { FeedImportRefusal } from './errors.js';
import { openFeedStream, type FeedValidators } from './fetch.js';
import { openStagedUpload } from './upload.js';

/** Everything opening a feed needs, and nothing about how it is parsed. */
export interface FeedOrigin {
  readonly fetchMode: 'url' | 'upload';
  readonly feedUrl: string | null;
  readonly uploadStorageKey: string | null;
  readonly authorization: FeedAuthorization;
  readonly validators: FeedValidators;
  readonly timeoutMs: number;
}

/**
 * What opening produced.
 *
 * `not_modified` exists only on the URL path and carries no bytes, which is the
 * shape that stops a 304 being mistaken for an empty feed — see
 * `completion.ts` for what that mistake costs.
 */
export type FeedOpenOutcome =
  | {
      readonly kind: 'ok';
      readonly bytes: AsyncIterable<Uint8Array>;
      readonly validators: FeedValidators;
      readonly close: () => void;
    }
  | { readonly kind: 'not_modified' };

export async function openFeedOrigin(
  origin: FeedOrigin,
  signal?: AbortSignal,
): Promise<FeedOpenOutcome> {
  if (origin.fetchMode === 'upload') {
    const key = origin.uploadStorageKey;
    if (key === null) {
      // Unreachable through the schema — `feed_configuration_versions_fetch_shape_check`
      // pairs the mode with its origin — and stated anyway, because the
      // alternative is a `!` on a column the CHECK guarantees.
      throw new FeedImportRefusal(
        'configuration_incomplete',
        'The mapping version declares an upload origin and names no artefact.',
      );
    }
    const bytes = await openStagedUpload(key);
    return {
      kind: 'ok',
      bytes,
      // An upload has no HTTP validators, and inventing one would make the next
      // conditional request present a validator no host ever issued.
      validators: { etag: null, lastModified: null },
      close: () => undefined,
    };
  }

  const url = origin.feedUrl;
  if (url === null) {
    throw new FeedImportRefusal(
      'configuration_incomplete',
      'The mapping version declares a URL origin and names no URL.',
    );
  }
  return openFeedStream({
    url,
    authorization: origin.authorization,
    validators: origin.validators,
    timeoutMs: origin.timeoutMs,
    ...(signal === undefined ? {} : { signal }),
  });
}
