/**
 * The two operator levers on one program (#143 link rule 8).
 *
 * `redirect` and `attribution`, independently. Neither gates a durable record:
 * with attribution off the touch is still WRITTEN, which is ADR 0005 D18's
 * "gating loops and gates, never records" and the reason an operator can pause
 * a program during an incident without losing the evidence of what happened
 * during it.
 *
 * Every change is audited through `referral_events` — the same append-only
 * trail every other referral decision lands in — with a mandatory actor and a
 * mandatory reason, so "who turned this off and why" always has an answer.
 */

import type { ReferralProgramControlsView } from '@mercaria/shared-types';
import { notFound, validationError } from '../../lib/errors/error-codes.js';
import { getDb } from '../../db/postgres.js';
import { appendReferralEvent } from '../../db/referrals/eventRepository.js';
import {
  findProgramControls,
  upsertProgramControls,
  REFERRAL_CONTROLS_DEFAULT,
} from '../../db/referrals/programControlRepository.js';
import { findLatestProgramVersion } from '../../db/referrals/programRepository.js';

/** The stored or defaulted levers for a program, as an operator reads them. */
export async function readProgramControls(
  programId: string,
): Promise<ReferralProgramControlsView> {
  const db = getDb();
  const program = await findLatestProgramVersion(db, programId);
  if (!program) throw notFound('Referral program not found');

  const row = await findProgramControls(db, programId);
  if (!row) {
    // Absence is a real answer and is reported as one, with the row's own
    // clock replaced by the program's: an operator reading "both enabled,
    // updated never" needs to see that nobody has intervened rather than a
    // fabricated timestamp.
    return {
      programId,
      redirectEnabled: REFERRAL_CONTROLS_DEFAULT.redirectEnabled,
      attributionEnabled: REFERRAL_CONTROLS_DEFAULT.attributionEnabled,
      reason: 'No operator intervention recorded for this program.',
      updatedAt: program.createdAt.toISOString(),
    };
  }
  return {
    programId: row.programId,
    redirectEnabled: row.redirectEnabled,
    attributionEnabled: row.attributionEnabled,
    reason: row.reason,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Set both levers, attributably.
 *
 * BOTH are written every time, because the request states both: a partial
 * update would let a client that omitted a field silently inherit whatever the
 * last incident left down, which is exactly the state nobody remembers to
 * check.
 */
export async function setProgramControls(input: {
  programId: string;
  redirectEnabled: boolean;
  attributionEnabled: boolean;
  actorOxyUserId: string;
  reason: string;
}): Promise<ReferralProgramControlsView> {
  const reason = input.reason.trim();
  if (reason.length === 0) {
    throw validationError('A control change requires a reason');
  }

  const db = getDb();
  return await db.transaction(async (tx) => {
    const program = await findLatestProgramVersion(tx, input.programId);
    if (!program) throw notFound('Referral program not found');

    const row = await upsertProgramControls(tx, {
      programId: input.programId,
      redirectEnabled: input.redirectEnabled,
      attributionEnabled: input.attributionEnabled,
      updatedByOxyUserId: input.actorOxyUserId,
      reason,
    });
    await appendReferralEvent(tx, {
      subjectType: 'program',
      subjectId: input.programId,
      action: 'program_controls_set',
      actorKind: 'operator',
      actorRef: input.actorOxyUserId,
      reason: `redirect=${row.redirectEnabled} attribution=${row.attributionEnabled}: ${reason}`,
    });
    return {
      programId: row.programId,
      redirectEnabled: row.redirectEnabled,
      attributionEnabled: row.attributionEnabled,
      reason: row.reason,
      updatedAt: row.updatedAt.toISOString(),
    };
  });
}
