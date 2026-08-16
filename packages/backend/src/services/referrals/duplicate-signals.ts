/**
 * Detecting duplicate or conflicting partner identities (#146 review rule 4).
 *
 * ## DERIVED at review time, never stored
 *
 * The `deriveNativeCheckoutEligibility` divergence from the one-stored-verdict
 * rule, and for the reason that rule itself gives: every input lives on rows
 * this function does not own and moves without anybody touching the
 * application. A stored signal would be right on the day it was written and
 * wrong the moment the other partner was terminated, renamed or approved —
 * and the place that must not happen is a reviewer reading "duplicate" about
 * somebody who no longer exists.
 *
 * It also means #146 review rule 4 needs no table, no sweep and no backfill:
 * an operator opening an application today gets an answer computed today.
 *
 * ## It DETECTS and refuses nothing
 *
 * The `payment_discrepancies` posture. A shared hostname is a fact, not a
 * verdict — two people who both promote through a large publishing platform
 * share one, and refusing them would be refusing the commonest legitimate case.
 * What the reviewer gets is what to look at.
 *
 * ## The one thing a signal may never do is name the other partner to the
 * APPLICANT
 *
 * `matched_partner_display_name` and `matched_partner_owner_id` are in
 * `REFERRAL_APPLICATION_FORBIDDEN_DISCLOSURES` for exactly that reason, and the
 * type below is operator-facing only — no partner projection reads it, and the
 * closed rejection vocabulary has `duplicate_partner_identity` and no way to
 * qualify it.
 */

import { and, eq, ne, sql } from 'drizzle-orm';
import type { ReferralPartnerOwnerType } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import { referralPartnerApplications, referralPartners } from '../../db/schema/referrals.js';
import { promotionUrlHost } from './application-answers.js';

/** What kind of collision was observed. */
export type ReferralDuplicateSignalKind =
  /** Two partners whose display names normalize to the same string. */
  | 'display_name_match'
  /** Two applications naming a promotion URL on the same host. */
  | 'promotion_host_match'
  /**
   * A `user` partner and a `store` partner carrying the SAME owner id.
   *
   * Not a collision `referral_partners_owner_key` can see: that index is over
   * the PAIR, so one identifier used as both a store id and an Oxy account id
   * is two legitimate rows to the database and one identity to a reviewer.
   */
  | 'owner_id_across_types';

/** {@link ReferralDuplicateSignalKind} as a tuple. */
export const REFERRAL_DUPLICATE_SIGNAL_KINDS: readonly ReferralDuplicateSignalKind[] = [
  'display_name_match',
  'promotion_host_match',
  'owner_id_across_types',
];

/** One observed collision, for an OPERATOR. Never rendered to an applicant. */
export interface ReferralDuplicateSignal {
  kind: ReferralDuplicateSignalKind;
  matchedPartnerId: string;
  matchedPartnerState: string;
  /** What the two have in common — a name, a hostname, or an owner id. */
  observed: string;
}

/**
 * Normalize a display name for comparison.
 *
 * Case-folded, whitespace-collapsed and stripped of the characters a
 * homoglyph-free impersonation actually uses — a trailing full stop, a
 * surrounding quote, a doubled space. Deliberately NOT a full confusables
 * mapping: this is a hint for a person, and a normalizer aggressive enough to
 * catch every lookalike would fold genuinely different names together and make
 * the signal useless by firing constantly.
 *
 * **The rule ORDER is load-bearing**, and the first version had it wrong:
 * stripping trailing punctuation before collapsing whitespace leaves
 * `'Shop".  '` with its full stop intact, because `$` does not reach past the
 * trailing spaces. Whitespace is normalized FIRST, then the anchor means what
 * it looks like it means. (#77's redaction rules are ordered for the same
 * reason and it cost a real bug there too.)
 */
export function normalizeDisplayNameForComparison(raw: string): string {
  return raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/["'`´]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,]+$/g, '')
    .trim();
}

/** Every promotion host an application names, de-duplicated. */
export function promotionHostsOf(urls: readonly string[]): readonly string[] {
  return [...new Set(urls.map(promotionUrlHost).filter((h): h is string => h !== undefined))];
}

/**
 * Signals against one partner, computed now.
 *
 * Bounded on purpose: at most `limit` matches per kind. A reviewer needs to
 * know a collision exists and where to look, and a display name shared by four
 * hundred abandoned drafts is a page nobody reads — the count is what matters
 * there, and the cap makes the read affordable on an unindexed comparison.
 */
export async function readDuplicateSignals(
  db: DatabaseOrTransaction,
  input: {
    partnerId: string;
    ownerType: ReferralPartnerOwnerType;
    ownerId: string;
    displayName: string;
    promotionUrls: readonly string[];
    limit?: number;
  },
): Promise<readonly ReferralDuplicateSignal[]> {
  const limit = input.limit ?? 10;
  const signals: ReferralDuplicateSignal[] = [];

  const normalized = normalizeDisplayNameForComparison(input.displayName);
  if (normalized.length > 0) {
    const nameMatches = await db
      .select({
        id: referralPartners.id,
        state: referralPartners.state,
        displayName: referralPartners.displayName,
      })
      .from(referralPartners)
      .where(
        and(
          ne(referralPartners.id, input.partnerId),
          // The same normalization, in SQL. It is a SUBSET of the JS one — no
          // NFKC and no quote stripping — which is the safe direction: it can
          // miss a match a person would spot, and cannot invent one.
          sql`regexp_replace(lower(trim(${referralPartners.displayName})), '\\s+', ' ', 'g') = ${normalized}`,
        ),
      )
      .limit(limit);
    for (const match of nameMatches) {
      signals.push({
        kind: 'display_name_match',
        matchedPartnerId: match.id,
        matchedPartnerState: match.state,
        observed: match.displayName,
      });
    }
  }

  const hosts = promotionHostsOf(input.promotionUrls);
  if (hosts.length > 0) {
    const hostMatches = await db
      .select({
        partnerId: referralPartnerApplications.partnerId,
        state: referralPartners.state,
        promotionUrls: referralPartnerApplications.promotionUrls,
      })
      .from(referralPartnerApplications)
      .innerJoin(referralPartners, eq(referralPartners.id, referralPartnerApplications.partnerId))
      .where(ne(referralPartnerApplications.partnerId, input.partnerId))
      .limit(500);
    for (const match of hostMatches) {
      const shared = promotionHostsOf(match.promotionUrls).find((h) => hosts.includes(h));
      if (shared === undefined) continue;
      if (signals.filter((s) => s.kind === 'promotion_host_match').length >= limit) break;
      signals.push({
        kind: 'promotion_host_match',
        matchedPartnerId: match.partnerId,
        matchedPartnerState: match.state,
        observed: shared,
      });
    }
  }

  // The OTHER owner type only. A row with the SAME pair cannot exist —
  // `referral_partners_owner_key` forbids it — so a predicate admitting one
  // would be a branch that can never fire, which reads as coverage. This is the
  // whole of what that index cannot see.
  const crossType = await db
    .select({ id: referralPartners.id, state: referralPartners.state })
    .from(referralPartners)
    .where(
      and(
        eq(referralPartners.ownerId, input.ownerId),
        ne(referralPartners.ownerType, input.ownerType),
      ),
    )
    .limit(limit);
  for (const match of crossType) {
    signals.push({
      kind: 'owner_id_across_types',
      matchedPartnerId: match.id,
      matchedPartnerState: match.state,
      observed: input.ownerId,
    });
  }

  return signals;
}
