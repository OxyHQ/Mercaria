/**
 * Writes and evidence reads for `referral_touches` — append-only.
 *
 * There is no update function in this file ON PURPOSE: a touch is evidence of
 * something that happened, and the only lifecycle it has is the retention
 * sweep (`db/expiryTargets.ts`). The resolver reads the latest eligible touch;
 * everything else about a touch's consequences lives on the attribution that
 * snapshotted it.
 */

import { eq } from 'drizzle-orm';
import type {
  ReferralActorKind,
  ReferralClientSurface,
  ReferralConsentMode,
  ReferralDestinationType,
  ReferralTouchKind,
  ReferralTrafficClass,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { referralTouches } from '../schema/referrals.js';

/** A touch row as the services read it back. */
export type ReferralTouchRow = typeof referralTouches.$inferSelect;

/** One recorded touch — the resolver's input shape, already classified. */
export interface CreateTouchInput {
  programVersionId: string;
  partnerId: string;
  codeId: string;
  linkId?: string;
  touchKind: ReferralTouchKind;
  occurredAt: Date;
  clientSurface: ReferralClientSurface;
  destinationType?: ReferralDestinationType;
  destinationRef?: string;
  actorKind: ReferralActorKind;
  guestSessionRef?: string;
  oxyUserId?: string;
  merchantCandidateRef?: string;
  trafficClass: ReferralTrafficClass;
  consentMode: ReferralConsentMode;
  attributionWindowExpiresAt: Date;
  campaignRef?: string;
  contentKey?: string;
  expiresAt: Date;
}

export async function insertTouch(
  db: DatabaseOrTransaction,
  input: CreateTouchInput,
): Promise<ReferralTouchRow> {
  const [row] = await db
    .insert(referralTouches)
    .values({
      programVersionId: input.programVersionId,
      partnerId: input.partnerId,
      codeId: input.codeId,
      linkId: input.linkId ?? null,
      touchKind: input.touchKind,
      occurredAt: input.occurredAt,
      clientSurface: input.clientSurface,
      destinationType: input.destinationType ?? null,
      destinationRef: input.destinationRef ?? null,
      actorKind: input.actorKind,
      guestSessionRef: input.guestSessionRef ?? null,
      oxyUserId: input.oxyUserId ?? null,
      merchantCandidateRef: input.merchantCandidateRef ?? null,
      trafficClass: input.trafficClass,
      consentMode: input.consentMode,
      attributionWindowExpiresAt: input.attributionWindowExpiresAt,
      campaignRef: input.campaignRef ?? null,
      contentKey: input.contentKey ?? null,
      expiresAt: input.expiresAt,
    })
    .returning();
  if (!row) {
    throw new Error(`referral_touches insert for code ${input.codeId} returned no row.`);
  }
  return row;
}

export async function findTouchById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<ReferralTouchRow | undefined> {
  const [row] = await db.select().from(referralTouches).where(eq(referralTouches.id, id));
  return row;
}
