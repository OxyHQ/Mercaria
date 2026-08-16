/**
 * Reads and writes for `referral_conduct_policies` and
 * `referral_disclosure_requirements` (#148 "Prohibited conduct policy" and
 * "Disclosure and promotion compliance").
 *
 * Both tables are the `referral_reward_rules` device: a version is editable
 * while `draft` and frozen by trigger afterwards, and one `active` version per
 * key is a partial unique. So there is an INSERT, an ACTIVATE and a SUPERSEDE
 * here and no general update — a policy change is a new version, because a
 * partner accepted the one that was live when they accepted.
 *
 * Activation is a two-statement compare-and-swap inside the caller's
 * transaction: supersede the incumbent of THIS key, then activate the target.
 * The supersede is scoped to the target row's OWN key rather than to a
 * configured one — #82 shipped that bug and the partial unique caught it at
 * activation time, with the real incumbent still standing.
 */

import { and, desc, eq, ne } from 'drizzle-orm';
import type {
  ReferralDisclosureSurface,
  ReferralProhibitedConduct,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import {
  referralConductPolicies,
  referralDisclosureRequirements,
} from '../schema/referralIntegrity.js';

/** A conduct-policy row as the services read it back. */
export type ReferralConductPolicyRow = typeof referralConductPolicies.$inferSelect;

/** A disclosure-requirement row as the services read it back. */
export type ReferralDisclosureRow = typeof referralDisclosureRequirements.$inferSelect;

/** How many versions a history read may return. */
const VERSION_PAGE_LIMIT = 100;

/** Draft one conduct-policy version. */
export async function insertConductPolicyDraft(
  db: DatabaseOrTransaction,
  input: {
    policyKey: string;
    version: number;
    prohibitedConduct: readonly ReferralProhibitedConduct[];
    termsVersion: string;
    summary: string;
    effectiveFrom: Date;
  },
): Promise<ReferralConductPolicyRow> {
  const [row] = await db
    .insert(referralConductPolicies)
    .values({
      policyKey: input.policyKey,
      version: input.version,
      status: 'draft',
      prohibitedConduct: [...input.prohibitedConduct],
      termsVersion: input.termsVersion,
      summary: input.summary,
      effectiveFrom: input.effectiveFrom,
    })
    .returning();
  return row;
}

/** The live version of one policy key, when there is one. */
export async function findActiveConductPolicy(
  db: DatabaseOrTransaction,
  policyKey: string,
): Promise<ReferralConductPolicyRow | undefined> {
  const [row] = await db
    .select()
    .from(referralConductPolicies)
    .where(
      and(
        eq(referralConductPolicies.policyKey, policyKey),
        eq(referralConductPolicies.status, 'active'),
      ),
    );
  return row;
}

/** One version by id. */
export async function findConductPolicyById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<ReferralConductPolicyRow | undefined> {
  const [row] = await db
    .select()
    .from(referralConductPolicies)
    .where(eq(referralConductPolicies.id, id));
  return row;
}

/** Every version of one key, newest first. */
export async function findConductPolicyVersions(
  db: DatabaseOrTransaction,
  policyKey: string,
): Promise<ReferralConductPolicyRow[]> {
  return await db
    .select()
    .from(referralConductPolicies)
    .where(eq(referralConductPolicies.policyKey, policyKey))
    .orderBy(desc(referralConductPolicies.version))
    .limit(VERSION_PAGE_LIMIT);
}

/** The highest version number issued for a key, or 0. */
export async function nextConductPolicyVersion(
  db: DatabaseOrTransaction,
  policyKey: string,
): Promise<number> {
  const [row] = await db
    .select({ version: referralConductPolicies.version })
    .from(referralConductPolicies)
    .where(eq(referralConductPolicies.policyKey, policyKey))
    .orderBy(desc(referralConductPolicies.version))
    .limit(1);
  return (row?.version ?? 0) + 1;
}

/**
 * Activate a draft, superseding the incumbent of ITS OWN key.
 *
 * Runs in the caller's transaction. The supersede is scoped by the target's own
 * `policy_key`, read off the target row, never a configured constant — the two
 * agree today and a second comparison surface with its own key is foreseeable,
 * which is exactly when a configured key leaves the real incumbent standing and
 * the activation fails on the index.
 */
export async function activateConductPolicy(
  db: DatabaseOrTransaction,
  input: { id: string; policyKey: string; publishedByOxyUserId: string; at: Date },
): Promise<ReferralConductPolicyRow | undefined> {
  await db
    .update(referralConductPolicies)
    .set({ status: 'superseded' })
    .where(
      and(
        eq(referralConductPolicies.policyKey, input.policyKey),
        eq(referralConductPolicies.status, 'active'),
        ne(referralConductPolicies.id, input.id),
      ),
    );
  const [row] = await db
    .update(referralConductPolicies)
    .set({
      status: 'active',
      publishedByOxyUserId: input.publishedByOxyUserId,
      publishedAt: input.at,
    })
    .where(
      and(eq(referralConductPolicies.id, input.id), eq(referralConductPolicies.status, 'draft')),
    )
    .returning();
  return row;
}

// ─── Disclosure requirements ────────────────────────────────────────────────

/** Draft one disclosure-requirement version. */
export async function insertDisclosureDraft(
  db: DatabaseOrTransaction,
  input: {
    disclosureKey: string;
    version: number;
    surface: ReferralDisclosureSurface;
    market: string;
    language: string;
    copy: string;
    required: boolean;
    effectiveFrom: Date;
  },
): Promise<ReferralDisclosureRow> {
  const [row] = await db
    .insert(referralDisclosureRequirements)
    .values({
      disclosureKey: input.disclosureKey,
      version: input.version,
      status: 'draft',
      surface: input.surface,
      market: input.market,
      language: input.language,
      copy: input.copy,
      required: input.required ? 'yes' : 'no',
      effectiveFrom: input.effectiveFrom,
    })
    .returning();
  return row;
}

/** Every ACTIVE disclosure requirement, for the resolver to narrow. */
export async function findActiveDisclosures(
  db: DatabaseOrTransaction,
  disclosureKey: string,
): Promise<ReferralDisclosureRow[]> {
  return await db
    .select()
    .from(referralDisclosureRequirements)
    .where(
      and(
        eq(referralDisclosureRequirements.disclosureKey, disclosureKey),
        eq(referralDisclosureRequirements.status, 'active'),
      ),
    )
    .orderBy(desc(referralDisclosureRequirements.version))
    .limit(VERSION_PAGE_LIMIT);
}

/** One disclosure version by id. */
export async function findDisclosureById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<ReferralDisclosureRow | undefined> {
  const [row] = await db
    .select()
    .from(referralDisclosureRequirements)
    .where(eq(referralDisclosureRequirements.id, id));
  return row;
}

/** The next version for one (key, surface, market, language) tuple. */
export async function nextDisclosureVersion(
  db: DatabaseOrTransaction,
  input: {
    disclosureKey: string;
    surface: ReferralDisclosureSurface;
    market: string;
    language: string;
  },
): Promise<number> {
  const [row] = await db
    .select({ version: referralDisclosureRequirements.version })
    .from(referralDisclosureRequirements)
    .where(
      and(
        eq(referralDisclosureRequirements.disclosureKey, input.disclosureKey),
        eq(referralDisclosureRequirements.surface, input.surface),
        eq(referralDisclosureRequirements.market, input.market),
        eq(referralDisclosureRequirements.language, input.language),
      ),
    )
    .orderBy(desc(referralDisclosureRequirements.version))
    .limit(1);
  return (row?.version ?? 0) + 1;
}

/**
 * Activate a disclosure draft, superseding the incumbent of ITS OWN scope.
 *
 * The scope is the four-column tuple the partial unique is on, read off the
 * target row — see `activateConductPolicy`'s docblock for why it is read rather
 * than passed from configuration.
 */
export async function activateDisclosure(
  db: DatabaseOrTransaction,
  input: {
    id: string;
    disclosureKey: string;
    surface: ReferralDisclosureSurface;
    market: string;
    language: string;
    publishedByOxyUserId: string;
    at: Date;
  },
): Promise<ReferralDisclosureRow | undefined> {
  await db
    .update(referralDisclosureRequirements)
    .set({ status: 'superseded' })
    .where(
      and(
        eq(referralDisclosureRequirements.disclosureKey, input.disclosureKey),
        eq(referralDisclosureRequirements.surface, input.surface),
        eq(referralDisclosureRequirements.market, input.market),
        eq(referralDisclosureRequirements.language, input.language),
        eq(referralDisclosureRequirements.status, 'active'),
        ne(referralDisclosureRequirements.id, input.id),
      ),
    );
  const [row] = await db
    .update(referralDisclosureRequirements)
    .set({
      status: 'active',
      publishedByOxyUserId: input.publishedByOxyUserId,
      publishedAt: input.at,
    })
    .where(
      and(
        eq(referralDisclosureRequirements.id, input.id),
        eq(referralDisclosureRequirements.status, 'draft'),
      ),
    )
    .returning();
  return row;
}
