/**
 * Program discovery, enrollment eligibility and the copy that describes what a
 * program pays (#147 "Program discovery and enrollment", acceptance 7).
 *
 * ## Percentage copy names its base, and it is the TYPE that guarantees it
 *
 * #147 acceptance 7: "Percentage copy always names its revenue base."
 * `ReferralRewardBasisCopy`'s percentage branch has a NON-OPTIONAL
 * `percentageOf`, so a client rendering `20%` with nothing after it has no
 * shape to read the number out of without also holding the sentence. That is
 * the difference this domain cares about: 20% of Mercaria's commission on an
 * order is a very different promise from 20% of the order, and the second is
 * what a partner assumes when nobody says.
 *
 * The sentences come from `REFERRAL_FUNDING_BASE_COPY`, keyed on the funding
 * SOURCE, because the source IS the base — ADR 0005's "The reward-base
 * contract" defines one per source and says "rules receive a base, they never
 * receive an order".
 *
 * ## Eligibility is derived and never stored
 *
 * The `deriveNativeCheckoutEligibility` divergence: the inputs are the
 * program's live status, its `eligiblePartnerTypes` and the partner's own
 * standing, and all three move without anybody touching a partner row.
 *
 * ## Nothing here implies a guaranteed earning
 *
 * #147 program item 7. The projection carries a RATE and a CAP and no
 * projection, estimate, forecast or "typical partner earns" figure — there is
 * no field one could be put in, which is the version of that rule a reviewer
 * can check.
 */

import {
  type CurrencyCode,
  type ReferralFundingSourceId,
  type ReferralPartnerOwnerType,
  type ReferralProgramLimits,
  type ReferralProgramOffer,
  type ReferralProgramPartnerView,
  type ReferralRewardBasisCopy,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../../db/postgres.js';
import {
  findActiveProgramVersion,
  listProgramIdentities,
  type ReferralProgramRow,
} from '../../../db/referrals/programRepository.js';
import {
  findActiveRewardRuleVersion,
  parseRewardRuleVersionRef,
  type ReferralRewardRuleRow,
} from '../../../db/referrals/rewardRuleRepository.js';
import { listPartnerProgramIds } from '../../../db/referrals/performanceRepository.js';

/** How many programs a discovery list will consider. */
const PROGRAM_DISCOVERY_LIMIT = 50;

/**
 * What each funding source's percentage is a percentage OF, in words.
 *
 * A `Record` over the source union, so a source added to
 * `REFERRAL_FUNDING_SOURCE_IDS` without a sentence fails `tsc` — which is the
 * point: a new source is a new revenue base, and a percentage of it published
 * with the previous source's sentence is precisely the mis-statement acceptance
 * 7 exists to prevent.
 */
const REFERRAL_FUNDING_BASE_COPY: Readonly<Record<ReferralFundingSourceId, string>> = Object.freeze({
  connected_marketplace:
    "Mercaria's own marketplace commission actually earned on the referred order, after refunds — never the order total and never what the buyer paid.",
  affiliate:
    'Affiliate commission an external network has confirmed for the referred visit — never a click estimate.',
  subscription:
    'Recognized Mercaria Pro subscription revenue for the referred merchant — never a booking.',
  fixed_budget: 'A separately approved marketing budget — not a share of any sale.',
});

/** The partner-safe program projection. Every field named. */
export function projectProgramForPartner(row: ReferralProgramRow): ReferralProgramPartnerView {
  return {
    programId: row.programId,
    version: row.version,
    name: row.name,
    publicTermsSummary: row.publicTermsSummary,
    family: row.family,
    status: row.status,
    ...(row.effectiveStartAt !== null
      ? { effectiveStartAt: row.effectiveStartAt.toISOString() }
      : {}),
    ...(row.effectiveEndAt !== null ? { effectiveEndAt: row.effectiveEndAt.toISOString() } : {}),
    attributionWindowDays: row.attributionWindowDays,
    termsVersion: row.termsVersion,
    disclosureVersion: row.disclosureVersion,
  };
}

/**
 * How a program's active rule describes what it pays.
 *
 * `not_published` when no rule version is active. That is a real state and is
 * reported as one: a program can be live for attribution while its rule is
 * still a draft, and rendering "0%" or an empty string there would tell a
 * partner they earn nothing rather than that nothing has been published.
 */
export function describeRewardBasis(rule: ReferralRewardRuleRow | undefined): ReferralRewardBasisCopy {
  if (!rule) return { kind: 'not_published' };
  if (rule.formula === 'percentage_of_realized_base' && rule.rateBps !== null) {
    return {
      kind: 'percentage_of_realized_base',
      rateBps: rule.rateBps,
      percentageOf: REFERRAL_FUNDING_BASE_COPY[rule.fundingSourceId],
      fundingSourceId: rule.fundingSourceId,
    };
  }
  if (rule.formula === 'fixed_amount' && rule.fixedAmountMinor !== null) {
    return {
      kind: 'fixed_amount',
      amountMinor: Number(rule.fixedAmountMinor),
      // A fixed reward always names a currency: the CHECK pairs
      // `currency_mode = 'fixed_currency'` with `reward_currency`, and a fixed
      // amount in "the funding currency" has no number a partner could read.
      currency: (rule.rewardCurrency ?? 'EUR') as CurrencyCode,
      fundingSourceId: rule.fundingSourceId,
    };
  }
  return { kind: 'not_published' };
}

/** The program's own active rule, resolved through its `commissionRuleRef`. */
async function activeRuleFor(
  db: DatabaseOrTransaction,
  program: ReferralProgramRow,
): Promise<ReferralRewardRuleRow | undefined> {
  const parsed = parseRewardRuleVersionRef(program.commissionRuleRef);
  const ruleId = parsed?.ruleId ?? program.commissionRuleRef;
  return await findActiveRewardRuleVersion(db, ruleId);
}

/** The limits a partner is operating under, from the program and its rule. */
export function describeProgramLimits(
  program: ReferralProgramRow,
  rule: ReferralRewardRuleRow | undefined,
): ReferralProgramLimits {
  return {
    programId: program.programId,
    attributionWindowDays: program.attributionWindowDays,
    ...(program.activationWindowDays !== null
      ? { activationWindowDays: program.activationWindowDays }
      : {}),
    holdDays: program.holdDays,
    ...(rule?.maxRewardPerConversionMinor != null
      ? { maxRewardPerConversionMinor: Number(rule.maxRewardPerConversionMinor) }
      : {}),
    ...(rule?.maxRewardPerPartnerPeriodMinor != null
      ? { maxRewardPerPartnerPeriodMinor: Number(rule.maxRewardPerPartnerPeriodMinor) }
      : {}),
    ...(rule?.partnerCapPeriod != null ? { partnerCapPeriod: rule.partnerCapPeriod } : {}),
    ...(rule?.rewardCurrency != null ? { currency: rule.rewardCurrency as CurrencyCode } : {}),
  };
}

/** The statuses under which a program still accepts new partners. */
const OPEN_PROGRAM_STATUSES = new Set(['active', 'scheduled']);

export interface ProgramDiscoveryInput {
  ownerType: ReferralPartnerOwnerType;
  /** Terms versions this partner has accepted, so `termsAccepted` is a fact. */
  acceptedTermsVersions: readonly string[];
  /** Present when the owner has a partner record. */
  partnerId?: string;
}

/**
 * The programs this owner may see, with the state they are in for each.
 *
 * Shows only what the actor is ELIGIBLE to apply to (#147 program item 1) plus
 * anything they already hold an instrument under — a partner whose program was
 * later closed to their owner type must still see the terms they are earning
 * under, or the dashboard would stop explaining the money it is showing.
 */
export async function readProgramOffers(
  input: ProgramDiscoveryInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ offers: ReferralProgramOffer[]; limits: ReferralProgramLimits[] }> {
  const [identities, enrolledProgramIds] = await Promise.all([
    listProgramIdentities(db, { limit: PROGRAM_DISCOVERY_LIMIT }),
    input.partnerId ? listPartnerProgramIds(db, input.partnerId) : Promise.resolve([]),
  ]);
  const enrolled = new Set(enrolledProgramIds);

  const offers: ReferralProgramOffer[] = [];
  const limits: ReferralProgramLimits[] = [];

  for (const identity of identities) {
    // Read the ACTIVE version where there is one: a draft's terms are not what
    // somebody would be enrolling under, and publishing a draft's summary would
    // advertise terms nobody approved.
    const program = (await findActiveProgramVersion(db, identity.programId)) ?? identity;
    const isEnrolled = enrolled.has(identity.programId);

    const ineligibleReasons: string[] = [];
    if (!program.eligiblePartnerTypes.includes(input.ownerType)) {
      ineligibleReasons.push('owner_type_not_eligible');
    }
    if (!OPEN_PROGRAM_STATUSES.has(program.status)) {
      ineligibleReasons.push('program_not_open');
    }

    if (ineligibleReasons.length > 0 && !isEnrolled) continue;

    const rule = await activeRuleFor(db, program);
    offers.push({
      program: projectProgramForPartner(program),
      eligible: ineligibleReasons.length === 0,
      ineligibleReasons,
      termsAccepted: input.acceptedTermsVersions.includes(program.termsVersion),
      rewardBasis: describeRewardBasis(rule),
    });
    if (isEnrolled) limits.push(describeProgramLimits(program, rule));
  }

  return { offers, limits };
}
