/**
 * The two risk-signal FACT producers #148 left unsupplied and this change adds
 * (`click_to_conversion_pattern`, `repeated_cap_attempt`), against a REAL
 * Postgres server.
 *
 * ## Why these cases and not "it returns a number"
 *
 * A producer is the one thing in this domain that can fail by looking like it
 * worked. #149 keeps `no_producer` apart from `no_measurement` precisely
 * because wiring one converts "we never looked" into a confident "clean", and
 * every case below is aimed at that: each producer is measured for the value it
 * reports AND for the absence it must report instead of a reassuring zero.
 *
 * The load-bearing case is `code_entry_at_checkout`. A partner's code typed
 * into the checkout form produces a conversion seconds after the evidence BY
 * CONSTRUCTION, so a `click_to_conversion_pattern` producer that did not
 * restrict itself to `link_click` would fire on every honest code redemption
 * there has ever been — a detector that is wrong in the alarming direction, on
 * the commonest legitimate funnel. That case is the reason
 * `CLICK_EVIDENCE_KIND` exists and is what goes red if somebody widens it.
 *
 * A mocked repository could not carry any of this: `percentile_cont`, the
 * `<code>: <detail>` prefix `reward.service.ts` actually writes, and the window
 * predicates are properties of the server.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import type { ReferralTouchKind } from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import {
  referralAttributions,
  referralCodes,
  referralConversions,
  referralLinks,
  referralEvents,
  referralPartners,
  referralPrograms,
  referralTouches,
} from '../../db/schema/referrals.js';
import { insertPartner } from '../../db/referrals/partnerRepository.js';
import { insertProgramVersion } from '../../db/referrals/programRepository.js';
import { insertCode, insertLink } from '../../db/referrals/instrumentRepository.js';
import { insertTouch } from '../../db/referrals/touchRepository.js';
import { insertAttribution } from '../../db/referrals/attributionRepository.js';
import { upsertConversion } from '../../db/referrals/conversionRepository.js';
import { appendReferralEvent } from '../../db/referrals/eventRepository.js';
import { collectRiskSignalFacts } from '../referrals/integrity/risk-evaluation.service.js';
import { deriveRiskSignals } from '../referrals/integrity/risk-thresholds.js';

const TAG = uuidv7().slice(-8);

let db: Database;
const trackedPartnerIds: string[] = [];
const trackedProgramIds: string[] = [];
let programVersionId = '';
let programId = '';

/** A partner nothing else in the suite shares. */
async function seedPartner(label: string): Promise<string> {
  const { row } = await insertPartner(db, {
    ownerType: 'user',
    ownerId: `owner-${label}-${TAG}`,
    displayName: `Risk ${label} ${TAG}`,
    state: 'applied',
    at: new Date(),
    termsVersion: 'terms-2026-08-01',
    promotionMethods: ['website'],
  });
  trackedPartnerIds.push(row.id);
  return row.id;
}

/**
 * One conversion, with its winning evidence placed a chosen number of seconds
 * before it.
 *
 * `evidenceOccurredAt` is the column the producer measures FROM — it is already
 * on the attribution, which is why the median needs no join to
 * `referral_touches` and why it measures the touch that actually won rather
 * than the partner's most recent one.
 */
async function seedConversion(input: {
  partnerId: string;
  codeId: string;
  touchId: string;
  evidenceTouchKind: ReferralTouchKind;
  convertedAt: Date;
  gapSeconds: number;
}): Promise<string> {
  const evidenceOccurredAt = new Date(input.convertedAt.getTime() - input.gapSeconds * 1_000);
  const attribution = await insertAttribution(db, {
    programId,
    programVersionId,
    partnerId: input.partnerId,
    subjectKind: 'oxy_user',
    subjectRef: `subject-${uuidv7().slice(-10)}`,
    winningTouchId: input.touchId,
    winningCodeId: input.codeId,
    evidenceTouchKind: input.evidenceTouchKind,
    evidenceOccurredAt,
    attributionPolicy: 'last_touch',
    ruleVersionRef: `rule-${TAG}:1`,
    expiresAt: new Date(input.convertedAt.getTime() + 30 * 86_400_000),
    originalActorKind: 'oxy_user',
  });
  if (!attribution) throw new Error('attribution fixture returned no row');
  const { row } = await upsertConversion(db, {
    attributionId: attribution.id,
    programVersionId,
    conversionType: 'first_qualifying_paid_order',
    sourceKind: 'order',
    sourceRef: `ord-${uuidv7().slice(-10)}`,
    sourceEventId: `evt-${uuidv7().slice(-10)}`,
    occurredAt: input.convertedAt,
    state: 'pending',
  });
  await db
    .update(referralConversions)
    .set({ state: 'eligible', verifiedAt: input.convertedAt })
    .where(eq(referralConversions.id, row.id));
  return row.id;
}

/**
 * A partner with a code, a link and one touch on each, ready to hang
 * conversions off.
 *
 * BOTH instruments, because `referral_touches_link_check` refuses a
 * `link_click` touch carrying no link — so a fixture that seeded only a code
 * and then claimed a link click would describe a world the database refuses.
 * The producer reads the ATTRIBUTION's `evidence_touch_kind` rather than the
 * touch's, and it would have been easy to satisfy it with a mismatched pair;
 * that would have passed while pinning nothing about a real funnel.
 */
async function seedFunnel(
  label: string,
): Promise<{ partnerId: string; codeId: string; linkTouchId: string; codeTouchId: string }> {
  const partnerId = await seedPartner(label);
  // Every instant here is an OFFSET from a past anchor, never a literal.
  // `fixture-date-census.test.ts` refuses a fixture carrying a date the real
  // clock is still travelling toward, and a touch's `expires_at` is inherently
  // in the future — so the anchor is what must be in the past, and the retention
  // deadline is derived from it exactly as the production writer derives one.
  // It caught this file on its first full run, which is the gate working.
  const activatedAt = new Date(Date.now() - 75 * 86_400_000);
  const touchOccurredAt = new Date(Date.now() - 60 * 86_400_000);

  const code = await insertCode(db, {
    partnerId,
    programVersionId,
    code: `c-${label}-${TAG}`.toLowerCase(),
    activatedAt,
    disclosureRequired: true,
  });
  if (!code) throw new Error('code collision in fixture');
  const link = await insertLink(db, {
    id: uuidv7(),
    codeId: code.id,
    token: `t-${label}-${TAG}`,
    activatedAt,
    disclosureRequired: true,
  });

  const touchDefaults = {
    programVersionId,
    partnerId,
    codeId: code.id,
    occurredAt: touchOccurredAt,
    clientSurface: 'web' as const,
    actorKind: 'oxy_user' as const,
    trafficClass: 'organic' as const,
    consentMode: 'granted' as const,
    attributionWindowExpiresAt: new Date(touchOccurredAt.getTime() + 30 * 86_400_000),
    expiresAt: new Date(touchOccurredAt.getTime() + 400 * 86_400_000),
  };
  const linkTouch = await insertTouch(db, {
    ...touchDefaults,
    linkId: link.id,
    touchKind: 'link_click',
    oxyUserId: `subject-${uuidv7().slice(-10)}`,
  });
  const codeTouch = await insertTouch(db, {
    ...touchDefaults,
    touchKind: 'code_entry_at_checkout',
    oxyUserId: `subject-${uuidv7().slice(-10)}`,
  });
  if (!linkTouch || !codeTouch) throw new Error('touch fixture returned no row');
  return {
    partnerId,
    codeId: code.id,
    linkTouchId: linkTouch.id,
    codeTouchId: codeTouch.id,
  };
}

beforeAll(async () => {
  db = await connectPostgres();
  programId = `prog-risk-${TAG}`;
  trackedProgramIds.push(programId);
  const program = await insertProgramVersion(db, {
    programId,
    version: 1,
    name: `Risk producers ${TAG}`,
    description: 'Fixture',
    publicTermsSummary: 'Earn a share of Mercaria commission.',
    family: 'buyer_referral',
    eligiblePartnerTypes: ['user'],
    eligibleSubjectKinds: ['oxy_user'],
    markets: [],
    currencies: [],
    channels: [],
    commercialModes: [],
    attributionPolicy: 'last_touch',
    attributionWindowDays: 30,
    qualifyingEventPolicy: 'first_qualifying_paid_order',
    commissionRuleRef: `rule-${TAG}:1`,
    holdDays: 60,
    payoutPolicyRef: `payout-${TAG}`,
    termsVersion: 'terms-2026-08-01',
    disclosureVersion: 'disclosure-2026-08-01',
    createdByOxyUserId: `oxy-op-${TAG}`,
    cohortKeys: [],
  });
  programVersionId = program.id;
}, 120_000);

afterAll(async () => {
  if (trackedPartnerIds.length > 0) {
    // Children first. None of these five carries an append-only trigger, so no
    // `withTriggerToggleLock` window is needed — and `referral_events` is
    // deleted by the CONVERSION ids this file minted rather than by partner,
    // because a refusal event's subject is a conversion.
    const attributionIds = await db
      .select({ id: referralAttributions.id })
      .from(referralAttributions)
      .where(inArray(referralAttributions.partnerId, trackedPartnerIds));
    if (attributionIds.length > 0) {
      const conversionIds = await db
        .select({ id: referralConversions.id })
        .from(referralConversions)
        .where(
          inArray(
            referralConversions.attributionId,
            attributionIds.map((row) => row.id),
          ),
        );
      if (conversionIds.length > 0) {
        await db.delete(referralEvents).where(
          inArray(
            referralEvents.subjectId,
            conversionIds.map((row) => row.id),
          ),
        );
      }
      await db.delete(referralConversions).where(
        inArray(
          referralConversions.attributionId,
          attributionIds.map((row) => row.id),
        ),
      );
    }
    await db
      .delete(referralAttributions)
      .where(inArray(referralAttributions.partnerId, trackedPartnerIds));
    await db.delete(referralTouches).where(inArray(referralTouches.partnerId, trackedPartnerIds));
    // Links BEFORE codes: `referral_links.code_id` is a plain FK, so deleting a
    // code out from under one raises `23503`. Adding the link fixture is what
    // made this teardown a writer of a table it had never touched — the same
    // way `referral-rewards.realdb.test.ts` began failing the moment #145's
    // accrual started writing a ledger posting.
    await db
      .delete(referralLinks)
      .where(
        inArray(
          referralLinks.codeId,
          db
            .select({ id: referralCodes.id })
            .from(referralCodes)
            .where(inArray(referralCodes.partnerId, trackedPartnerIds)),
        ),
      );
    await db.delete(referralCodes).where(inArray(referralCodes.partnerId, trackedPartnerIds));
    await db.delete(referralEvents).where(inArray(referralEvents.subjectId, trackedPartnerIds));
    await db.delete(referralPartners).where(inArray(referralPartners.id, trackedPartnerIds));
  }
  if (trackedProgramIds.length > 0) {
    await db.delete(referralPrograms).where(inArray(referralPrograms.programId, trackedProgramIds));
  }
  await closePostgres();
}, 120_000);

describe('click_to_conversion_pattern — the median, and what it refuses to measure', () => {
  it('reports the median gap over LINK CLICKS, from the winning evidence', async () => {
    const funnel = await seedFunnel('median');
    const convertedAt = new Date(Date.now() - 60 * 60 * 1_000);
    // 2, 4 and 60 seconds. The median of three is the middle one, so a
    // producer that averaged instead (22) or took the minimum (2) fails here.
    for (const gapSeconds of [2, 4, 60]) {
      await seedConversion({
        partnerId: funnel.partnerId,
        codeId: funnel.codeId,
        touchId: funnel.linkTouchId,
        evidenceTouchKind: 'link_click',
        convertedAt,
        gapSeconds,
      });
    }

    const facts = await collectRiskSignalFacts(db, {
      partnerId: funnel.partnerId,
      at: new Date(),
    });

    expect(facts.medianClickToConversionSeconds).toBe(4);
    // The vacuity floor for this case: the conversions were genuinely counted,
    // so a median of 4 is a measurement rather than a default.
    expect(facts.conversionsInWindow).toBe(3);
  });

  it('measures NOTHING for a code-only funnel, rather than reporting seconds', async () => {
    const funnel = await seedFunnel('code-only');
    const convertedAt = new Date(Date.now() - 60 * 60 * 1_000);
    // One second between a code typed AT CHECKOUT and the conversion — the
    // shape every honest checkout-code redemption has.
    await seedConversion({
      partnerId: funnel.partnerId,
      codeId: funnel.codeId,
      touchId: funnel.codeTouchId,
      evidenceTouchKind: 'code_entry_at_checkout',
      convertedAt,
      gapSeconds: 1,
    });

    const facts = await collectRiskSignalFacts(db, {
      partnerId: funnel.partnerId,
      at: new Date(),
    });

    // ABSENT, not 1. This is the whole case: the conversion WAS counted, so the
    // producer looked and deliberately declined to answer.
    expect(facts.conversionsInWindow).toBe(1);
    expect(facts.medianClickToConversionSeconds).toBeUndefined();
    // And the signal it would otherwise have produced is not produced.
    expect(deriveRiskSignals(facts).map((signal) => signal.kind)).not.toContain(
      'click_to_conversion_pattern',
    );
  });

  it('a fast link click DOES fire the signal — the positive control', async () => {
    const funnel = await seedFunnel('fast-click');
    await seedConversion({
      partnerId: funnel.partnerId,
      codeId: funnel.codeId,
      touchId: funnel.linkTouchId,
      evidenceTouchKind: 'link_click',
      convertedAt: new Date(Date.now() - 60 * 60 * 1_000),
      gapSeconds: 1,
    });

    const facts = await collectRiskSignalFacts(db, {
      partnerId: funnel.partnerId,
      at: new Date(),
    });

    expect(facts.medianClickToConversionSeconds).toBe(1);
    expect(deriveRiskSignals(facts).map((signal) => signal.kind)).toContain(
      'click_to_conversion_pattern',
    );
  });

  it('is ABSENT for a partner with no conversions at all', async () => {
    const partnerId = await seedPartner('quiet');
    const facts = await collectRiskSignalFacts(db, { partnerId, at: new Date() });
    expect(facts.conversionsInWindow).toBe(0);
    expect(facts.medianClickToConversionSeconds).toBeUndefined();
  });
});

describe('repeated_cap_attempt — counting the refusals the reward domain wrote', () => {
  it('counts cap and budget refusals, and NOT the other reasons', async () => {
    const funnel = await seedFunnel('caps');
    const convertedAt = new Date(Date.now() - 60 * 60 * 1_000);
    const conversionIds: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      conversionIds.push(
        await seedConversion({
          partnerId: funnel.partnerId,
          codeId: funnel.codeId,
          touchId: funnel.linkTouchId,
          evidenceTouchKind: 'link_click',
          convertedAt,
          gapSeconds: 3_600,
        }),
      );
    }

    // Exactly the `<code>: <detail>` shape `reward.service.ts` writes.
    const reasons = [
      'cap_reached: the per_partner cap left no headroom',
      'cap_reached: the per_program cap left no headroom',
      'budget_exhausted: the campaign budget disappeared',
      // The negative control, and the one that matters: a conversion refused
      // for `zero_base` is an unprofitable order, not somebody probing a cap.
      'zero_base: the commission base was zero',
    ];
    for (const [index, reason] of reasons.entries()) {
      await appendReferralEvent(db, {
        subjectType: 'conversion',
        subjectId: conversionIds[index],
        action: 'reward_accrual_refused',
        actorKind: 'system',
        reason,
      });
    }

    const facts = await collectRiskSignalFacts(db, {
      partnerId: funnel.partnerId,
      at: new Date(Date.now() + 1_000),
    });

    expect(facts.capRefusalCount).toBe(3);
    expect(deriveRiskSignals(facts).map((signal) => signal.kind)).toContain('repeated_cap_attempt');
  });

  it('does not count another partner’s refusals', async () => {
    const mine = await seedFunnel('caps-mine');
    const theirs = await seedFunnel('caps-theirs');
    const convertedAt = new Date(Date.now() - 60 * 60 * 1_000);
    const theirConversionId = await seedConversion({
      partnerId: theirs.partnerId,
      codeId: theirs.codeId,
      touchId: theirs.linkTouchId,
      evidenceTouchKind: 'link_click',
      convertedAt,
      gapSeconds: 3_600,
    });
    await appendReferralEvent(db, {
      subjectType: 'conversion',
      subjectId: theirConversionId,
      action: 'reward_accrual_refused',
      actorKind: 'system',
      reason: 'cap_reached: the per_partner cap left no headroom',
    });

    const at = new Date(Date.now() + 1_000);
    // The positive control: the refusal IS counted for the partner it belongs
    // to, so a zero below means scoping rather than a query that matches
    // nothing.
    expect((await collectRiskSignalFacts(db, { partnerId: theirs.partnerId, at })).capRefusalCount).toBe(1);
    expect((await collectRiskSignalFacts(db, { partnerId: mine.partnerId, at })).capRefusalCount).toBe(0);
  });

  it('reports ZERO as a measurement, and fires no signal for it', async () => {
    const partnerId = await seedPartner('no-refusals');
    const facts = await collectRiskSignalFacts(db, { partnerId, at: new Date() });
    // Present and zero — we counted refusals and found none, exactly as
    // `conversionsInWindow: 0` is a count rather than an absence.
    expect(facts.capRefusalCount).toBe(0);
    expect(deriveRiskSignals(facts).map((signal) => signal.kind)).not.toContain(
      'repeated_cap_attempt',
    );
  });
});
