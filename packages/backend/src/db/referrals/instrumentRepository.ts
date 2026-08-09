/**
 * Reads and writes for `referral_codes` and `referral_links` — one file
 * because a link WRAPS a code (ADR 0005 D3) and every link operation resolves
 * through its code anyway.
 *
 * Codes are stored NORMALIZED (the service lower-cases; the CHECK refuses
 * anything else) and uniqueness is on `lower(code)`, so the duplicate answer is
 * case-insensitive whichever spelling arrives. A duplicate insert returns
 * `null` rather than throwing — a taken code is an ANSWER for the caller to map
 * onto a 409, not a database failure.
 *
 * The click-limit claim is the `$inc`-guard discipline at the link grain: ONE
 * statement whose predicate and mutation evaluate together, so two concurrent
 * clicks at the ceiling admit exactly one.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { isUniqueViolation } from '@oxyhq/db';
import type { ReferralDestinationType, ReferralInstrumentStatus } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { referralCodes, referralLinks } from '../schema/referrals.js';

/** A code row as the services read it back. */
export type ReferralCodeRow = typeof referralCodes.$inferSelect;

/** A link row as the services read it back. */
export type ReferralLinkRow = typeof referralLinks.$inferSelect;

/** The shared destination/context fields both instruments carry. */
export interface InstrumentContextInput {
  destinationType?: ReferralDestinationType;
  destinationRef?: string;
  campaignRef?: string;
  contentKey?: string;
  market?: string;
  locale?: string;
}

export async function findCodeById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<ReferralCodeRow | undefined> {
  const [row] = await db.select().from(referralCodes).where(eq(referralCodes.id, id));
  return row;
}

/** Case-insensitive lookup — the same expression the unique index serves. */
export async function findCodeByCode(
  db: DatabaseOrTransaction,
  code: string,
): Promise<ReferralCodeRow | undefined> {
  const [row] = await db
    .select()
    .from(referralCodes)
    .where(sql`lower(${referralCodes.code}) = ${code.toLowerCase()}`);
  return row;
}

/**
 * Reserve a code. `null` means the namespace already holds that spelling
 * (case-insensitively) — the caller's conflict to report, not an exception.
 */
export async function insertCode(
  db: DatabaseOrTransaction,
  input: InstrumentContextInput & {
    partnerId: string;
    programVersionId: string;
    /** Already normalized lower-case; the CHECK is the second line of defence. */
    code: string;
    aliasOfCodeId?: string;
    activatedAt: Date;
    expiresAt?: Date;
    maxUses?: number;
    disclosureRequired: boolean;
  },
): Promise<ReferralCodeRow | null> {
  try {
    const [row] = await db
      .insert(referralCodes)
      .values({
        partnerId: input.partnerId,
        programVersionId: input.programVersionId,
        code: input.code,
        aliasOfCodeId: input.aliasOfCodeId ?? null,
        destinationType: input.destinationType ?? null,
        destinationRef: input.destinationRef ?? null,
        campaignRef: input.campaignRef ?? null,
        contentKey: input.contentKey ?? null,
        market: input.market ?? null,
        locale: input.locale ?? null,
        activatedAt: input.activatedAt,
        expiresAt: input.expiresAt ?? null,
        maxUses: input.maxUses ?? null,
        disclosureRequired: input.disclosureRequired,
      })
      .returning();
    if (!row) {
      throw new Error(`referral_codes insert for '${input.code}' returned no row.`);
    }
    return row;
  } catch (error) {
    if (isUniqueViolation(error, 'referral_codes_code_key')) return null;
    throw error;
  }
}

/**
 * One instrument-status transition, as a CAS from a SET of expected statuses.
 * `retired` keeps the row and the namespace reservation forever (D3).
 */
export async function transitionCodeStatus(
  db: DatabaseOrTransaction,
  input: {
    id: string;
    expected: readonly ReferralInstrumentStatus[];
    to: ReferralInstrumentStatus;
    at: Date;
  },
): Promise<ReferralCodeRow | undefined> {
  const [row] = await db
    .update(referralCodes)
    .set({
      status: input.to,
      ...(input.to === 'paused' ? { pausedAt: input.at } : {}),
      ...(input.to === 'revoked' ? { revokedAt: input.at } : {}),
      ...(input.to === 'retired' ? { retiredAt: input.at } : {}),
    })
    .where(
      and(
        eq(referralCodes.id, input.id),
        inArray(referralCodes.status, [...input.expected]),
      ),
    )
    .returning();
  return row;
}

export async function findLinkById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<ReferralLinkRow | undefined> {
  const [row] = await db.select().from(referralLinks).where(eq(referralLinks.id, id));
  return row;
}

export async function findLinkByToken(
  db: DatabaseOrTransaction,
  token: string,
): Promise<ReferralLinkRow | undefined> {
  const [row] = await db.select().from(referralLinks).where(eq(referralLinks.token, token));
  return row;
}

export async function insertLink(
  db: DatabaseOrTransaction,
  input: InstrumentContextInput & {
    /** Supplied by the caller: the signed token embeds it, so it exists first. */
    id: string;
    codeId: string;
    token: string;
    activatedAt: Date;
    expiresAt?: Date;
    maxClicks?: number;
    disclosureRequired: boolean;
  },
): Promise<ReferralLinkRow> {
  const [row] = await db
    .insert(referralLinks)
    .values({
      id: input.id,
      codeId: input.codeId,
      token: input.token,
      destinationType: input.destinationType ?? null,
      destinationRef: input.destinationRef ?? null,
      campaignRef: input.campaignRef ?? null,
      contentKey: input.contentKey ?? null,
      market: input.market ?? null,
      locale: input.locale ?? null,
      activatedAt: input.activatedAt,
      expiresAt: input.expiresAt ?? null,
      maxClicks: input.maxClicks ?? null,
      disclosureRequired: input.disclosureRequired,
    })
    .returning();
  if (!row) {
    throw new Error(`referral_links insert for code ${input.codeId} returned no row.`);
  }
  return row;
}

export async function transitionLinkStatus(
  db: DatabaseOrTransaction,
  input: {
    id: string;
    expected: readonly ReferralInstrumentStatus[];
    to: ReferralInstrumentStatus;
    at: Date;
  },
): Promise<ReferralLinkRow | undefined> {
  const [row] = await db
    .update(referralLinks)
    .set({
      status: input.to,
      ...(input.to === 'paused' ? { pausedAt: input.at } : {}),
      ...(input.to === 'revoked' ? { revokedAt: input.at } : {}),
    })
    .where(
      and(
        eq(referralLinks.id, input.id),
        inArray(referralLinks.status, [...input.expected]),
      ),
    )
    .returning();
  return row;
}

/**
 * Claim one click against the link's limit — predicate and increment in ONE
 * statement, so the ceiling holds under concurrency exactly as the inventory
 * `$inc` guard does.
 *
 * @returns The link as it now stands, or `undefined` when the link is not
 *   active or the ceiling is reached — one refusal the caller maps.
 */
export async function claimLinkClick(
  db: DatabaseOrTransaction,
  id: string,
): Promise<ReferralLinkRow | undefined> {
  const [row] = await db
    .update(referralLinks)
    .set({ clickCount: sql`${referralLinks.clickCount} + 1` })
    .where(
      and(
        eq(referralLinks.id, id),
        eq(referralLinks.status, 'active'),
        sql`(${referralLinks.maxClicks} is null or ${referralLinks.clickCount} < ${referralLinks.maxClicks})`,
      ),
    )
    .returning();
  return row;
}

/** A partner's codes, keyset-paginated newest first. */
export async function listCodesByPartner(
  db: DatabaseOrTransaction,
  input: { partnerId: string; limit: number; before?: Date },
): Promise<ReferralCodeRow[]> {
  return await db
    .select()
    .from(referralCodes)
    .where(
      and(
        eq(referralCodes.partnerId, input.partnerId),
        input.before ? sql`${referralCodes.createdAt} < ${input.before.toISOString()}::timestamptz` : undefined,
      ),
    )
    .orderBy(sql`${referralCodes.createdAt} desc`)
    .limit(input.limit);
}

/** A code's links, keyset-paginated newest first. */
export async function listLinksByCode(
  db: DatabaseOrTransaction,
  input: { codeId: string; limit: number; before?: Date },
): Promise<ReferralLinkRow[]> {
  return await db
    .select()
    .from(referralLinks)
    .where(
      and(
        eq(referralLinks.codeId, input.codeId),
        input.before ? sql`${referralLinks.createdAt} < ${input.before.toISOString()}::timestamptz` : undefined,
      ),
    )
    .orderBy(sql`${referralLinks.createdAt} desc`)
    .limit(input.limit);
}
