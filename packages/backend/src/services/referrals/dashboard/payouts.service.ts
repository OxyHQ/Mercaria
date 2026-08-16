/**
 * What a partner may read about being PAID (#147 "Payout experience", under
 * ADR 0005 D14/D15 and A5).
 *
 * ## The beneficiary is masked at the SOURCE
 *
 * `ReferralPayoutReadiness` carries `beneficiaryLast4` and no account
 * reference in any form, so a client that wanted the whole handle has nothing
 * to render — #46's status projection, which "never carries the
 * connected-account id, in any form". The masking happens here rather than in a
 * serializer for the reason that projection gives: a filtered row is one
 * `select()` away from being an unfiltered one.
 *
 * ## The three gates are DERIVED, never read off the partner row
 *
 * `partner-standing.service.ts` states why at length and the real-server suite
 * refused the alternative: reading the three stored columns put
 * `tax.readiness: 'ready'` and `outstanding: ['tax_questionnaire_not_completed']`
 * into one response. The stored triple is an OBSERVATION of what a derivation
 * last said; this reads the derivation.
 *
 * ## A provider return page proves nothing
 *
 * #147's payout item 10, and it needs no code here to be true: nothing in this
 * module or its callers takes a redirect, a return parameter or a provider
 * status, and readiness comes from #46's own verdict through
 * `readReferralPartnerReadiness`. The refusal is the absence of a seam, which
 * is the same shape ADR 0001 D2 gives the seller onboarding round trip.
 */

import type {
  CurrencyCode,
  ReferralPayoutBatchPartnerView,
  ReferralPayoutReadiness,
} from '@mercaria/shared-types';
import { REFERRAL_PAYOUT_MINIMUM_MINOR_BY_CURRENCY } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../../db/postgres.js';
import type { ReferralPartnerRow } from '../../../db/referrals/partnerRepository.js';
import {
  listPayoutBatchesForPartner,
  listPayoutBatchItems,
} from '../../../db/referralEarnings/payoutBatchRepository.js';
import { readReferralPartnerReadiness } from '../earnings/partner-readiness.port.js';
import { readEnforcementEffects } from '../integrity/enforcement.service.js';
import { readTaxProfile } from '../tax-profile.service.js';
import { readProgramControls } from '../controls.service.js';
import { listPartnerProgramIds } from '../../../db/referrals/performanceRepository.js';

/** How many payouts the partner-facing history carries. */
const RECENT_PAYOUT_LIMIT = 12;

/**
 * The visible tail of a payout destination.
 *
 * FOUR characters, and never more: the reference is a `provider_accounts` row
 * id rather than an IBAN, so this identifies which destination without being
 * one. A shorter tail would not distinguish two accounts; a longer one starts
 * being the handle.
 */
function maskBeneficiary(ref: string | null): string | undefined {
  if (!ref || ref.length < 4) return undefined;
  return ref.slice(-4);
}

/**
 * A batch as ADR 0005 A5 permits a partner to see it.
 *
 * `toReferralPayoutBatchPartnerView` in `earnings/read.service.ts` produces a
 * structurally identical shape and is not reused, deliberately: it returns an
 * anonymous type, so nothing there fails `tsc` when a field is added to the
 * row and spread. This one is annotated with the named interface, which is what
 * makes the allow-list a compiler check rather than a convention.
 *
 * `providerReference` and `failureDetail` are on the row and absent here. A
 * rail's own handle is Mercaria's operational fact, and a failure DETAIL is
 * free text — which A5 excludes in any form.
 */
function projectBatchForPartner(
  batch: {
    status: string;
    netPayoutMinor: number;
    withholdingMinor: number;
    currency: string;
    paidAt: Date | null;
    createdAt: Date;
  },
  itemCount: number,
): ReferralPayoutBatchPartnerView {
  return {
    date: (batch.paidAt ?? batch.createdAt).toISOString().slice(0, 10),
    status: batch.status as ReferralPayoutBatchPartnerView['status'],
    netPayoutMinor: Number(batch.netPayoutMinor),
    withholdingMinor: Number(batch.withholdingMinor),
    currency: batch.currency as CurrencyCode,
    itemCount,
  };
}

/**
 * Whether any program this partner holds an instrument under still pays.
 *
 * ANY rather than ALL: a partner earning under two programs, one of which an
 * operator has paused, can still be paid for the other. Reporting `false`
 * because one lever is down would tell them their money is stuck when it is
 * not — and reporting the per-program detail would publish an operator's
 * incident decision about a program to every partner in it.
 */
async function anyProgramPaysOut(
  db: DatabaseOrTransaction,
  partnerId: string,
): Promise<{ payoutEnabled: boolean; attributionEnabled: boolean }> {
  const programIds = await listPartnerProgramIds(db, partnerId);
  if (programIds.length === 0) {
    // No instrument, so no program lever applies. The default is both enabled,
    // which is what `REFERRAL_CONTROLS_DEFAULT` says an unmanaged program is.
    return { payoutEnabled: true, attributionEnabled: true };
  }
  const controls = await Promise.all(programIds.map((id) => readProgramControls(id)));
  return {
    payoutEnabled: controls.some((row) => row.payoutEnabled),
    attributionEnabled: controls.some((row) => row.attributionEnabled),
  };
}

export async function readPartnerPayoutReadiness(
  partner: ReferralPartnerRow,
  outstanding: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<ReferralPayoutReadiness> {
  const [readiness, tax, levers, batches, enforcement] = await Promise.all([
    readReferralPartnerReadiness({
      partnerId: partner.id,
      ownerType: partner.ownerType,
      ownerId: partner.ownerId,
    }),
    readTaxProfile(partner.id),
    anyProgramPaysOut(db, partner.id),
    listPayoutBatchesForPartner(db, { partnerId: partner.id, limit: RECENT_PAYOUT_LIMIT }),
    // #148's derivation, NOT the partner's `state` column. The column used to
    // collapse new links, new attribution and payout into one fact; since #148
    // a live `attribution_suspension` or `payout_hold` can raise any of the
    // three on a partner whose state is still `approved`. Reading the column
    // here would tell an investigated partner they are earning while
    // attribution is suspended, or that their honest vested balance is
    // suspended when only a scoped hold applies.
    readEnforcementEffects(db, partner.id),
  ]);

  const recentPayouts: ReferralPayoutBatchPartnerView[] = [];
  for (const batch of batches) {
    const items = await listPayoutBatchItems(db, batch.id);
    recentPayouts.push(projectBatchForPartner(batch, items.length));
  }

  return {
    // Earning is the partner's own standing, the program's attribution lever
    // AND #148's scoped enforcement — three different questions from
    // withdrawal, which is why `partner-standing.service.ts` refuses to
    // collapse them into one bar.
    earningEnabled:
      partner.state === 'approved' &&
      levers.attributionEnabled &&
      !enforcement.newAttributionSuspended,
    payoutEnabled: levers.payoutEnabled && !enforcement.payoutHeld,
    identity: readiness.identity,
    tax: tax.readiness,
    payout: readiness.payout,
    outstanding,
    ...(maskBeneficiary(readiness.payoutBeneficiaryRef ?? partner.payoutBeneficiaryRef) !== undefined
      ? {
          beneficiaryLast4: maskBeneficiary(
            readiness.payoutBeneficiaryRef ?? partner.payoutBeneficiaryRef,
          ) as string,
        }
      : {}),
    supportedCurrencies: Object.keys(REFERRAL_PAYOUT_MINIMUM_MINOR_BY_CURRENCY) as CurrencyCode[],
    cadence: 'monthly',
    recentPayouts,
  };
}
