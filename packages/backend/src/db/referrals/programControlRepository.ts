/**
 * Reads and writes for `referral_program_controls` — the THREE operator levers
 * (#143 link rule 8, plus #145's payout lever).
 *
 * There is no delete function, on purpose. "Turn it back on" is an UPDATE with
 * its own actor and reason, which leaves a row saying who re-enabled a program
 * and why; deleting the row would make that indistinguishable from a program
 * nobody ever touched.
 */

import { eq } from 'drizzle-orm';
import type { DatabaseOrTransaction } from '../postgres.js';
import { referralProgramControls } from '../schema/referrals.js';

/** A controls row as the services read it back. */
export type ReferralProgramControlRow = typeof referralProgramControls.$inferSelect;

/** The effective levers for a program, with absence resolved. */
export interface ReferralProgramControlState {
  redirectEnabled: boolean;
  attributionEnabled: boolean;
  /**
   * #145: may a payout batch for this program be built and settled?
   *
   * ADR 0005 D18's "program suspension stops new vesting/payout where policy
   * says so but preserves history", at the grain the ADR states it. It
   * withholds and never voids, exactly like every D15 gate — and it is
   * deliberately NOT what program TERMINATION uses, since D18 says a terminated
   * program's existing rewards run their ordinary lifecycle to payout.
   */
  payoutEnabled: boolean;
}

/**
 * All three levers ON — what a program with no controls row resolves to.
 *
 * Exported so the readers and the tests share one spelling of the default; two
 * places deciding what absence means is exactly how a gate ends up open in one
 * path and shut in another.
 */
export const REFERRAL_CONTROLS_DEFAULT: ReferralProgramControlState = Object.freeze({
  redirectEnabled: true,
  attributionEnabled: true,
  payoutEnabled: true,
});

/** The stored row for a program, or `undefined` when nobody has intervened. */
export async function findProgramControls(
  db: DatabaseOrTransaction,
  programId: string,
): Promise<ReferralProgramControlRow | undefined> {
  const [row] = await db
    .select()
    .from(referralProgramControls)
    .where(eq(referralProgramControls.programId, programId));
  return row;
}

/**
 * The EFFECTIVE levers, absence resolved to {@link REFERRAL_CONTROLS_DEFAULT}.
 *
 * Every gate on the edge reads this rather than the row, so no caller has to
 * remember what a missing row means.
 */
export async function resolveProgramControls(
  db: DatabaseOrTransaction,
  programId: string,
): Promise<ReferralProgramControlState> {
  const row = await findProgramControls(db, programId);
  if (!row) return REFERRAL_CONTROLS_DEFAULT;
  return {
    redirectEnabled: row.redirectEnabled,
    attributionEnabled: row.attributionEnabled,
    payoutEnabled: row.payoutEnabled,
  };
}

/**
 * Set all three levers for a program, creating the row on first intervention.
 *
 * One statement, so two operators racing converge on one row rather than one of
 * them failing on the unique index. Every lever is written together because the
 * request states all of them: a partial update would let a client that omitted
 * a field silently keep whatever the last incident left behind.
 */
export async function upsertProgramControls(
  db: DatabaseOrTransaction,
  input: {
    programId: string;
    redirectEnabled: boolean;
    attributionEnabled: boolean;
    payoutEnabled: boolean;
    updatedByOxyUserId: string;
    reason: string;
  },
): Promise<ReferralProgramControlRow> {
  const [row] = await db
    .insert(referralProgramControls)
    .values({
      programId: input.programId,
      redirectEnabled: input.redirectEnabled,
      attributionEnabled: input.attributionEnabled,
      payoutEnabled: input.payoutEnabled,
      updatedByOxyUserId: input.updatedByOxyUserId,
      reason: input.reason,
    })
    .onConflictDoUpdate({
      target: referralProgramControls.programId,
      set: {
        redirectEnabled: input.redirectEnabled,
        attributionEnabled: input.attributionEnabled,
        payoutEnabled: input.payoutEnabled,
        updatedByOxyUserId: input.updatedByOxyUserId,
        reason: input.reason,
      },
    })
    .returning();
  if (!row) {
    throw new Error(
      `referral_program_controls upsert for program ${input.programId} returned no row.`,
    );
  }
  return row;
}
