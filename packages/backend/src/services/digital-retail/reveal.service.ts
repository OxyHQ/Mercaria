/**
 * Handing a buyer their secret, exactly once per request (#1016 Workstream 11,
 * ADR 0011 D10).
 *
 * ## Six questions, in this order, and none of them reads a payment
 *
 *  1. `config.digitalRetail.revealEnabled` — the incident lever;
 *  2. a fulfilment exists for this id;
 *  3. it belongs to THIS caller;
 *  4. its status still authorizes access;
 *  5. there is an ACTIVE artifact;
 *  6. that artifact carries a secret at all.
 *
 * The order is the #1015 download authorizer's, and the reason is the same: every
 * refusal happens before any sealed column is read, so the one function that
 * touches ciphertext is only ever reached by a caller who has already passed
 * every gate.
 *
 * ## "No fulfilment" and "somebody else's fulfilment" get the SAME answer
 *
 * Distinguishing them would confirm that an id exists, which is an enumeration
 * oracle over a table of bearer secrets. `not_found` covers both.
 *
 * ## The plaintext is returned and never stored
 *
 * It exists in the caller's stack frame and in the response body. It is not
 * logged, not cached, not put in a notification payload (the epic's W11
 * requirement 9) and not written back to any row — the row already holds the
 * sealed copy, and a second unsealed one would be the leak this whole design
 * exists to prevent.
 */

import { config } from '../../config/index.js';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  findActiveArtifact,
  findFulfilment,
  readSealedArtifact,
  recordReveal,
} from '../../db/digitalRetail/digitalFulfilmentRepository.js';
import { environmentKeyResolver, unsealArtifactSecret, type SealingKeyResolver } from './secrets.js';

/** Why a reveal did not happen. Closed, and every member is actionable. */
export type RevealRefusalReason =
  | 'reveal_disabled'
  | 'not_found'
  | 'fulfilment_not_active'
  | 'no_artifact'
  | 'artifact_carries_no_secret';

/** What a reveal produced, or why it did not. */
export type RevealResult =
  | {
      readonly revealed: true;
      /** The plaintext. Handed over once; never stored, logged or notified. */
      readonly secret: string;
      readonly instructions: string | null;
      readonly artifactId: string;
    }
  | { readonly revealed: false; readonly reason: RevealRefusalReason };

export interface RevealForBuyerInput {
  readonly fulfilmentId: string;
  /** `oxy:<id>` or `guest:<sessionId>`. An anonymous caller has none and is refused. */
  readonly buyerKey: string;
  readonly now?: Date;
  readonly keyResolver?: SealingKeyResolver;
}

/** Reveal an artifact to the buyer who owns it. */
export async function revealArtifactForBuyer(
  input: RevealForBuyerInput,
  tx?: DatabaseOrTransaction,
): Promise<RevealResult> {
  const db = tx ?? getDb();
  const now = input.now ?? new Date();

  if (!config.digitalRetail.revealEnabled) {
    return { revealed: false, reason: 'reveal_disabled' };
  }

  const fulfilment = await findFulfilment(input.fulfilmentId, db);
  // One answer for two questions, deliberately — see the docblock.
  if (!fulfilment || fulfilment.buyerKey !== input.buyerKey) {
    return { revealed: false, reason: 'not_found' };
  }
  if (fulfilment.status !== 'delivered') {
    return { revealed: false, reason: 'fulfilment_not_active' };
  }

  const artifact = await findActiveArtifact(fulfilment.id, db);
  if (!artifact) return { revealed: false, reason: 'no_artifact' };

  const sealed = await readSealedArtifact(artifact.id, db);
  if (!sealed?.sealedSecret || !sealed.keyReference) {
    // A capability that hands over no secret — a direct activation, an account
    // link — has nothing to reveal, and saying so is not a refusal of access.
    return { revealed: false, reason: 'artifact_carries_no_secret' };
  }

  const secret = await unsealArtifactSecret(
    sealed.sealedSecret,
    sealed.keyReference,
    input.keyResolver ?? environmentKeyResolver(),
  );

  await recordReveal(
    {
      fulfilmentId: fulfilment.id,
      artifactId: artifact.id,
      actorKind: 'buyer',
      buyerKey: input.buyerKey,
      operatorOxyUserId: null,
      reason: null,
      now,
    },
    db,
  );

  return {
    revealed: true,
    secret,
    instructions: artifact.instructions ?? null,
    artifactId: artifact.id,
  };
}

export interface RevealForOperatorInput {
  readonly fulfilmentId: string;
  /** An Oxy account id. Required — the audit row's CHECK refuses a reveal without one. */
  readonly operatorOxyUserId: string;
  /** Why. Required, and stored. An unexplained operator reveal is the thing audited. */
  readonly reason: string;
  readonly now?: Date;
  readonly keyResolver?: SealingKeyResolver;
}

/**
 * Reveal an artifact to a support OPERATOR.
 *
 * Separate from the buyer path rather than a flag on it, because the two differ
 * in what they require and in what they mean: an operator reveal needs a named
 * person and a stated reason, and it is the event a privileged-access review
 * actually looks at. A shared function with an optional operator id would make
 * the audited case the easy one to skip.
 *
 * It does NOT bypass the incident lever. If reveals are off because keys are
 * leaking, they are off for support too — support's remedy in that window is the
 * masked hint, which needs no reveal at all.
 */
export async function revealArtifactForOperator(
  input: RevealForOperatorInput,
  tx?: DatabaseOrTransaction,
): Promise<RevealResult> {
  const db = tx ?? getDb();
  const now = input.now ?? new Date();

  if (!config.digitalRetail.revealEnabled) {
    return { revealed: false, reason: 'reveal_disabled' };
  }
  if (input.operatorOxyUserId.trim() === '' || input.reason.trim() === '') {
    throw new Error('an operator reveal requires a named operator and a stated reason');
  }

  const fulfilment = await findFulfilment(input.fulfilmentId, db);
  if (!fulfilment) return { revealed: false, reason: 'not_found' };

  const artifact = await findActiveArtifact(fulfilment.id, db);
  if (!artifact) return { revealed: false, reason: 'no_artifact' };

  const sealed = await readSealedArtifact(artifact.id, db);
  if (!sealed?.sealedSecret || !sealed.keyReference) {
    return { revealed: false, reason: 'artifact_carries_no_secret' };
  }

  const secret = await unsealArtifactSecret(
    sealed.sealedSecret,
    sealed.keyReference,
    input.keyResolver ?? environmentKeyResolver(),
  );

  await recordReveal(
    {
      fulfilmentId: fulfilment.id,
      artifactId: artifact.id,
      actorKind: 'operator',
      buyerKey: null,
      operatorOxyUserId: input.operatorOxyUserId,
      reason: input.reason,
      now,
    },
    db,
  );

  return {
    revealed: true,
    secret,
    instructions: artifact.instructions ?? null,
    artifactId: artifact.id,
  };
}
