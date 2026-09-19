/**
 * The false-positive path: how a creator answers a provenance signal about their
 * own work (#1015 W8).
 *
 * ## An appeal ADDS evidence. It never removes any
 *
 * `asset_provenance_signals` is append-only by trigger, and
 * `docs/digital-commerce.md` names what that refuses: *"a creator erasing the
 * fingerprint of something they published"*. So an appeal cannot be a deletion, a
 * `dismissed` flag or a `false_positive` column — all three would be the same
 * erasure wearing a friendlier name, and all three would let a re-uploader
 * pre-emptively clear themselves.
 *
 * What it is instead is the creator's own side of the record, written into the SAME
 * append-only table the machine's fingerprints live in. `ASSET_PROVENANCE_SIGNAL_KINDS`
 * already carries the two kinds for it and says what they are for:
 * `creator_declaration` — *"the creator's own assertion about where the work came
 * from"* — and `prior_publication` — *"a prior publication the creator supplied, so
 * a true original can say so"*. That last clause is this feature.
 *
 * ## The appeal can never manufacture a match
 *
 * The two kinds an appeal writes are exactly the two kinds
 * `SWEPT_PROVENANCE_SIGNAL_KINDS` excludes. That is not a coincidence and it is
 * asserted in both directions by `__tests__/provenance-boundaries.test.ts`: two
 * creators who both declare "my own work, modelled in Blender" would otherwise
 * match each other exactly, and an appeal would generate the candidate it exists
 * to answer.
 *
 * ## Why it changes what a reviewer sees without deciding anything
 *
 * `sweep.ts` stores nothing and re-derives on demand, so a creator's appeal is in
 * the evidence the next sweep and the next operator read — and in a case already
 * open, the appeal is in the table the evidence snapshot was taken from. The appeal
 * does not close a candidate, withdraw a report or reverse an enforcement. It also
 * cannot: this module does not import the moderation services at all, which is the
 * structural half of the same statement.
 *
 * Reversing an enforcement is `enforcement.service`'s `restore`, it runs off a
 * DECISION, and `docs/moderation.md` is where that lives. An appeal that could
 * restore its own listing would be a self-service undo for a moderation outcome,
 * which is the one thing #402 proves can be laundered in two ordinary calls.
 */

import type { AssetProvenanceSignalKind } from '@mercaria/shared-types';
import {
  findAssetVersion,
  findDigitalAsset,
  recordProvenanceSignal,
} from '../../../db/digital/assetRepository.js';
import { findStoreById } from '../../../db/stores/storeRepository.js';
import { forbidden, notFound, validationError } from '../../../lib/errors/error-codes.js';
import { UNSWEPT_PROVENANCE_SIGNAL_KINDS } from './sweep.js';

/**
 * The signal kinds an appeal may write.
 *
 * DERIVED from the sweep's complement rather than retyped, so the safety property
 * above cannot drift: adding a machine-derived kind to the sweep removes it from
 * here automatically, and adding a human-asserted kind makes it appealable with no
 * second edit.
 */
export const PROVENANCE_APPEAL_SIGNAL_KINDS: readonly AssetProvenanceSignalKind[] =
  UNSWEPT_PROVENANCE_SIGNAL_KINDS;

/**
 * The longest statement an appeal may carry.
 *
 * `asset_provenance_signals.value` is an unbounded `text` column — correctly, since
 * it also holds digests whose length is fixed by their algorithm — so the bound on
 * free text has to live at the one write path that produces free text. 2000
 * characters, matching `abuse_reports_details_length_check`, because an appeal and
 * a report are the same kind of statement by the same kind of person and a creator
 * should not discover that one surface accepts what the other refuses.
 */
export const PROVENANCE_APPEAL_STATEMENT_MAX_LENGTH = 2_000;

export interface RecordProvenanceAppealInput {
  /** The version whose fingerprint was matched — the creator's own. */
  readonly versionId: string;
  /** The Oxy account filing. Must be a member of the asset's store. */
  readonly appellantOxyUserId: string;
  readonly kind: AssetProvenanceSignalKind;
  /**
   * The creator's words, or the reference to where they published first.
   *
   * Stored verbatim. It is a statement, not a claim Mercaria evaluates, and
   * nothing downstream parses it — which is why it can share a column with a
   * digest without that column becoming a property bag.
   */
  readonly statement: string;
}

export interface RecordedProvenanceAppeal {
  readonly versionId: string;
  readonly kind: AssetProvenanceSignalKind;
  readonly statement: string;
}

/**
 * Record a creator's counter-evidence against a provenance signal.
 *
 * The store membership check is the whole authorization: only somebody who can act
 * for the store that published the version may append to its provenance record.
 * Without it, anybody could write `prior_publication` rows onto somebody else's
 * version — and because the table is append-only, a forged assertion there could
 * never be removed, only contradicted.
 *
 * `staff` is admitted alongside `owner` and `admin`, deliberately: an appeal is a
 * factual statement about the work, the person who actually modelled it is
 * routinely not the account that owns the shop, and the remedy for a wrong
 * statement is the next statement rather than a narrower allow-list on a record
 * nothing can erase.
 *
 * @throws NOT FOUND when the version or its asset is gone, FORBIDDEN when the
 *   appellant cannot act for the store, VALIDATION when the kind is not appealable
 *   or the statement is empty or over length.
 */
export async function recordProvenanceAppeal(
  input: RecordProvenanceAppealInput,
): Promise<RecordedProvenanceAppeal> {
  if (!PROVENANCE_APPEAL_SIGNAL_KINDS.includes(input.kind)) {
    throw validationError(
      `recordProvenanceAppeal: '${input.kind}' is a machine-derived fingerprint and cannot be ` +
        'asserted by a person.',
    );
  }
  const statement = typeof input.statement === 'string' ? input.statement.trim() : '';
  if (statement.length === 0) {
    throw validationError('recordProvenanceAppeal: a statement is required.');
  }
  if (statement.length > PROVENANCE_APPEAL_STATEMENT_MAX_LENGTH) {
    throw validationError(
      `recordProvenanceAppeal: a statement may be at most ` +
        `${String(PROVENANCE_APPEAL_STATEMENT_MAX_LENGTH)} characters.`,
    );
  }
  if (typeof input.appellantOxyUserId !== 'string' || input.appellantOxyUserId.length === 0) {
    throw validationError('recordProvenanceAppeal: an appellant id is required.');
  }

  const version = await findAssetVersion(input.versionId);
  if (version === null) {
    throw notFound(`recordProvenanceAppeal: version ${input.versionId} does not exist.`);
  }
  const asset = await findDigitalAsset(version.assetId);
  if (asset === null) {
    throw notFound(`recordProvenanceAppeal: asset ${version.assetId} does not exist.`);
  }
  const store = await findStoreById(asset.storeId);
  const isMember =
    store?.members.some((member) => member.oxyUserId === input.appellantOxyUserId) === true;
  if (!isMember) {
    throw forbidden(
      'recordProvenanceAppeal: only a member of the store that published this version may add to ' +
        'its provenance record.',
    );
  }

  // `fileId: null` — "about the version as a whole", which the column's own
  // docblock names as the meaning of NULL. A creator's declaration is about the
  // WORK; attaching it to one file would make it look like an assertion about
  // those bytes, and a reviewer would then ask which file the other files are
  // covered by.
  await recordProvenanceSignal({
    versionId: input.versionId,
    fileId: null,
    kind: input.kind,
    value: statement,
  });

  return { versionId: input.versionId, kind: input.kind, statement };
}
