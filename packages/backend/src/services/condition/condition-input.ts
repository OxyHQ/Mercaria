/**
 * Resolving what a client actually said about condition — the ONE place the v1
 * binary field and the #90 statement meet (#90 propagation rule 8).
 *
 * ## This is a versioned contract, not a compatibility shim
 *
 * `AGENTS.md` forbids `@deprecated` markers and back-compat aliases, and this
 * does not become an exception by being useful. It is the same shape
 * `checkout`'s `addressId` is: a shipped mobile build cannot be recalled, so the
 * v1 spelling is accepted as a documented, dated CONTRACT with a stated
 * retirement condition (`LEGACY_CONDITION_CONTRACT`), and the row records that
 * it was used. Nothing is aliased, nothing is silently rewritten, and the
 * projection back out is computed rather than stored.
 *
 * ## The three properties worth stating
 *
 * 1. **Sending both spellings is a 400.** Not a precedence rule — nobody would
 *    remember which won, and the two can disagree (`condition: 'new'` beside
 *    `itemCondition: {key: 'for_parts'}`), so silently picking one would let a
 *    client's own bug become a listing that says the opposite of what it meant.
 * 2. **A v1 `used` can never become `used_like_new`.** It resolves to
 *    `LEGACY_BINARY_CONDITION_TARGET.used` and records `legacy_client_binary`,
 *    which the `listings_unrefined_condition_check` CHECK then restricts to
 *    `UNREFINED_CONDITION_KEYS`. The service and the database agree because both
 *    read the same tuples; and if this function were wrong, the write would
 *    still fail rather than silently upgrade.
 * 3. **A v1 client carries no evidence.** It has no way to send details, photo
 *    annotations or an acknowledgement, so a v1 `used` write produces an empty
 *    disclosure. That is exactly why the evidence gate treats a v1 write as
 *    unrefined and the listing needs refining before it can claim anything
 *    better — see `condition-evidence.service.ts`.
 */

import {
  CONDITION_DETAIL_KINDS_REQUIRING_NOTE,
  CONDITION_DETAIL_KINDS_WITH_SEVERITY,
  LEGACY_BINARY_CONDITION_TARGET,
} from '@mercaria/shared-types';
import type {
  ConditionAssertion,
  ConditionDetailInput,
  ConditionPhotoAnnotationInput,
  ItemConditionKey,
  LegacyBinaryCondition,
  ListingConditionInput,
} from '@mercaria/shared-types';
import { validationError } from '../../lib/errors/error-codes.js';

/**
 * What a client said about condition, once the two spellings are collapsed.
 *
 * `assertion` is the full `ConditionAssertion` union rather than the two values
 * {@link resolveConditionInput} can produce, because the connector sync and the
 * operator surface build this shape directly with `source_declared` and
 * `operator_corrected`. Narrowing it here would push those two onto a parallel
 * type, and the write path would then have two shapes to keep in step.
 */
export interface ResolvedConditionInput {
  key: ItemConditionKey;
  assertion: ConditionAssertion;
  details: readonly ConditionDetailInput[];
  photoAnnotations: readonly ConditionPhotoAnnotationInput[];
  /** Literally `true` only. A missing field is not consent (#90 policy rule 2). */
  defectsAcknowledged: boolean;
}

/** The two spellings, as a request may carry them. */
export interface ConditionInputCarrier {
  condition?: LegacyBinaryCondition;
  itemCondition?: ListingConditionInput;
}

/**
 * Collapse the two spellings into one resolved statement, or `undefined` when
 * the request carried neither.
 *
 * `undefined` is a real answer for a PATCH (the client is not changing the
 * condition) and is refused by the create path, which is where the caller knows
 * enough to say so.
 */
export function resolveConditionInput(
  carrier: ConditionInputCarrier,
): ResolvedConditionInput | undefined {
  if (carrier.condition !== undefined && carrier.itemCondition !== undefined) {
    throw validationError(
      'Send either `condition` (v1) or `itemCondition`, not both — they can disagree and ' +
        'there is deliberately no precedence rule between them',
    );
  }

  if (carrier.itemCondition !== undefined) {
    const statement = carrier.itemCondition;
    assertDetailShape(statement.details ?? []);
    assertPhotoAnnotationShape(statement.photoAnnotations ?? [], statement.details ?? []);

    return {
      key: statement.key,
      assertion: 'seller_declared',
      details: statement.details ?? [],
      photoAnnotations: statement.photoAnnotations ?? [],
      defectsAcknowledged: statement.defectsAcknowledged === true,
    };
  }

  if (carrier.condition !== undefined) {
    return {
      key: LEGACY_BINARY_CONDITION_TARGET[carrier.condition],
      assertion: 'legacy_client_binary',
      details: [],
      photoAnnotations: [],
      // A v1 client has no field for this and therefore has acknowledged
      // nothing. Defaulting it true "because the old flow worked" would turn an
      // affirmative disclosure into a checkbox nobody ticked.
      defectsAcknowledged: false,
    };
  }

  return undefined;
}

/**
 * Refuse a detail whose shape contradicts its kind.
 *
 * The same two rules the CHECKs hold, applied here so the client gets a 400
 * naming the field rather than a 500 carrying a constraint name. The CHECKs stay
 * because this function is not the only writer — the operator surface and any
 * future importer go through the database too.
 */
function assertDetailShape(details: readonly ConditionDetailInput[]): void {
  for (const detail of details) {
    if (detail.severity !== undefined && !CONDITION_DETAIL_KINDS_WITH_SEVERITY.includes(detail.kind)) {
      throw validationError(`A \`${detail.kind}\` condition detail cannot carry a severity`);
    }
    if (
      CONDITION_DETAIL_KINDS_REQUIRING_NOTE.includes(detail.kind) &&
      (detail.note === undefined || detail.note.trim().length === 0)
    ) {
      throw validationError(`A \`${detail.kind}\` condition detail must describe what it means`);
    }
  }
}

/**
 * Refuse a photo annotation pointing at a defect that was not disclosed.
 *
 * The database enforces the stronger version (a photo may only reference a
 * detail on its own LISTING, by composite foreign key); this catches the case
 * the foreign key cannot see, which is an index into a `details` array the same
 * request supplied.
 */
function assertPhotoAnnotationShape(
  annotations: readonly ConditionPhotoAnnotationInput[],
  details: readonly ConditionDetailInput[],
): void {
  for (const annotation of annotations) {
    if (annotation.detailIndex === undefined) continue;
    if (
      !Number.isInteger(annotation.detailIndex) ||
      annotation.detailIndex < 0 ||
      annotation.detailIndex >= details.length
    ) {
      throw validationError(
        'A condition photo annotation references a `detailIndex` that this request did not supply',
      );
    }
  }
}
