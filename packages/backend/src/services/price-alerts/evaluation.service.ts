/**
 * Evaluating one canonical product's alerts (#79 §"Evaluation").
 *
 * This is the impure half — `qualification.ts` is the rules. What it does, in
 * the order the issue states and never another:
 *
 *  1. read the alerts on the subject,
 *  2. group them by the only two things that change the COMPARISON (the
 *     currency and the market) — which is issue abuse rule 2's batch fan-out,
 *  3. per group, re-run #74's eligibility and facts against the LIVE offers,
 *  4. per alert, qualify, then apply the repeat policy,
 *  5. write the trigger and its delivery job in ONE transaction.
 *
 * ## Step 3 is a RE-RUN, not a cached answer (issue evaluation 2)
 *
 * `listOffers` → `buildRankingFactContext` → `selectEligibleOffers` are #74's
 * and #57's own functions, called here exactly as `/offer-comparison` calls
 * them. So a listing a jury restricted a second ago, an offer whose source
 * contract has lapsed, a suppressed merchant and an offer whose currency cannot
 * be quoted are all refused by the domains that own those facts, at the moment
 * of triggering. There is no second copy of any of those rules in this file, and
 * `price-alert-isolation.test.ts` fails the build if one appears.
 *
 * ## Step 5 is one transaction, and the trigger is written FIRST
 *
 * `insertPriceAlertTrigger` returns `undefined` when the unique index refused
 * the row, which is the "already notified about this exact observation" answer —
 * and the notification is enqueued only when a trigger was actually created. A
 * duplicate source event, an FX re-check and two concurrent workers therefore
 * produce one notification (acceptance 1), and the convergence is the DATABASE's
 * rather than a read-then-write this file could get wrong.
 */

import type {
  CurrencyCode,
  Money,
  Offer,
  PriceAlertQualification,
} from '@mercaria/shared-types';
import {
  ALL_CURRENCY_CODES,
  PRICE_ALERT_POLICY_VERSION,
  repeatPolicySatisfied,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { getDb } from '../../db/postgres.js';
import { readLatestObservedPriceVersions } from '../../db/priceAlerts/observedPriceVersionRepository.js';
import {
  listEvaluableAlertsForProduct,
  rearmPriceAlert,
  recordPriceAlertEvaluated,
  recordPriceAlertTriggered,
  type PriceAlertRow,
} from '../../db/priceAlerts/priceAlertRepository.js';
import { enqueuePriceAlertNotification } from '../../db/priceAlerts/priceAlertNotificationRepository.js';
import { insertPriceAlertTrigger } from '../../db/priceAlerts/priceAlertTriggerRepository.js';
import { getRates } from '../fx.service.js';
import { listOffers } from '../offers/offer.service.js';
import { buildOfferRankingFacts, buildRankingFactContext } from '../ranking/facts.js';
import { selectEligibleOffers, type OfferEligibilityContext } from '../ranking/eligibility.js';
import { log } from '../../lib/logger.js';
import { qualifyAlert, type AlertCandidate } from './qualification.js';

/** What one subject's evaluation did, for the queue row's own counters. */
export interface PriceAlertEvaluationOutcome {
  readonly evaluatedAlerts: number;
  readonly qualifiedAlerts: number;
  readonly triggersCreated: number;
}

/**
 * The two facts that decide which COMPARISON an alert is answered from.
 *
 * Not the condition segments and not the seller scope: those narrow WITHIN one
 * comparison and are applied per alert in `qualification.ts`. Putting them in
 * the key would multiply the offer reads by the number of distinct scopes on a
 * popular product for no change in the answer.
 */
function comparisonKey(alert: PriceAlertRow): string {
  return `${alert.targetCurrency}|${alert.market ?? ''}`;
}

/** One comparison's admitted offers, with the observation behind each price. */
export interface AlertComparison {
  readonly candidates: readonly AlertCandidate[];
}

/**
 * Run #74's eligibility over one product's live offers, in one currency and one
 * market.
 *
 * The excluded offers are deliberately DISCARDED here, unlike
 * `/offer-comparison`, which carries them so a seller can be told why theirs is
 * missing. An alert evaluation has no such reader, and keeping them would put
 * the reasons an offer is ineligible one step from a buyer-facing payload.
 */
export async function buildAlertComparison(input: {
  readonly canonicalProductId: string;
  readonly comparisonCurrency: CurrencyCode;
  readonly market?: string;
  readonly limit: number;
}): Promise<AlertComparison> {
  const page = await listOffers({
    canonicalProductId: input.canonicalProductId,
    ...(input.market ? { country: input.market } : {}),
    limit: input.limit,
  });

  if (page.offers.length === 0) return { candidates: [] };

  const quotes = [
    ...new Set(
      page.offers.flatMap((offer) => {
        const currencies = [
          offer.price?.currency,
          offer.delivery.known ? offer.delivery.cost.currency : undefined,
        ];
        return currencies.filter((currency): currency is string => currency !== undefined);
      }),
    ),
  ].filter((currency): currency is CurrencyCode =>
    (ALL_CURRENCY_CODES as readonly string[]).includes(currency),
  );
  const rates = await getRates(input.comparisonCurrency, quotes);

  const factContext = await buildRankingFactContext({
    offers: page.offers,
    comparisonCurrency: input.comparisonCurrency,
    rates,
    ...(input.market === undefined ? {} : { market: input.market }),
  });

  const eligibilityContext: OfferEligibilityContext = {
    canonicalVariantIds: new Set(page.offers.map((offer) => offer.canonicalVariantId)),
    ...(input.market === undefined ? {} : { market: input.market }),
    customerClasses: [],
    // `buy_now`, deliberately: an alert exists so somebody can go and buy the
    // thing, so an offer whose source DECLARED it unbuyable must not fire one.
    // `browse` would admit exactly those.
    experience: 'buy_now',
    suppressedMerchantIds: factContext.suppressedMerchantIds,
    suppressedStorefrontIds: factContext.suppressedStorefrontIds,
  };

  const selection = selectEligibleOffers({
    offers: page.offers,
    context: eligibilityContext,
    buildFacts: (offer: Offer) => buildOfferRankingFacts(offer, factContext),
  });

  const offersById = new Map(page.offers.map((offer) => [offer.id, offer]));
  const versions = await readLatestObservedPriceVersions(
    selection.eligible.map((admitted) => admitted.offerId),
  );

  const candidates: AlertCandidate[] = [];
  for (const admitted of selection.eligible) {
    const offer = offersById.get(admitted.offerId);
    if (offer === undefined) continue;
    const observedPriceVersion = versions.get(admitted.offerId);
    candidates.push({
      offer,
      admitted,
      ...(observedPriceVersion === undefined ? {} : { observedPriceVersion }),
    });
  }
  return { candidates };
}

/**
 * Whether this alert's repeat policy permits another notification now.
 *
 * A pure call over the alert's own two timestamps and its last amount — see
 * `repeatPolicySatisfied`, which is where rules 1–3 live. Read here rather than
 * in `qualification.ts` because it is a fact about the alert's HISTORY and not
 * about the offers, and mixing the two would make a trace unable to say which
 * of them refused.
 */
function mayRepeat(alert: PriceAlertRow, amount: Money, now: Date): boolean {
  return repeatPolicySatisfied({
    policy: alert.repeatPolicy,
    ...(alert.lastTriggeredAt ? { lastTriggeredAt: alert.lastTriggeredAt } : {}),
    ...(alert.rearmedAt ? { rearmedAt: alert.rearmedAt } : {}),
    ...(alert.lastTriggeredAmount === null
      ? {}
      : { lastTriggeredAmountMinor: alert.lastTriggeredAmount }),
    ...(alert.cooldownSeconds === null ? {} : { cooldownSeconds: alert.cooldownSeconds }),
    candidateAmountMinor: amount.amount,
    now,
  });
}

/**
 * Re-arm a `reset_threshold` alert when an evaluation SAW the price above its
 * threshold.
 *
 * Runs on every evaluation, qualifying or not, and that is the whole point: an
 * alert re-arms because the market climbed back, which is a fact about a price
 * that did NOT qualify. Re-arming only from a qualification would make repeat
 * rule 1 unreachable.
 */
async function applyReset(alert: PriceAlertRow, best: Money | undefined, now: Date): Promise<void> {
  if (alert.repeatPolicy !== 'reset_threshold') return;
  if (alert.resetThresholdAmount === null || best === undefined) return;
  if (best.currency !== alert.targetCurrency) return;
  if (best.amount <= alert.resetThresholdAmount) return;
  await rearmPriceAlert(alert.id, now);
}

/**
 * Record a qualification: the trigger and its delivery job, in ONE transaction.
 *
 * @returns whether a trigger was actually created. `false` means the unique
 * index refused it because this exact observation had already been notified —
 * acceptance 1, answered by the database rather than by a read.
 */
async function recordQualification(
  alert: PriceAlertRow,
  qualification: Extract<PriceAlertQualification, { outcome: 'qualified' }>,
  now: Date,
): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    const trigger = await insertPriceAlertTrigger(
      {
        alertId: alert.id,
        offerId: qualification.offerId,
        observedPriceVersion: qualification.observedPriceVersion,
        alertPolicyVersion: PRICE_ALERT_POLICY_VERSION,
        canonicalProductId: alert.canonicalProductId,
        canonicalVariantId: qualification.canonicalVariantId,
        basis: alert.basis,
        amountAmount: qualification.amount.amount,
        amountCurrency: qualification.amount.currency,
        targetAmount: alert.targetAmount,
        targetCurrency: alert.targetCurrency,
        nativeItemAmount: qualification.nativeItemAmount,
        nativeItemCurrency: qualification.nativeItemCurrency,
        ...(qualification.nativeDeliveryAmount === undefined
          ? {}
          : {
              nativeDeliveryAmount: qualification.nativeDeliveryAmount,
              nativeDeliveryCurrency: qualification.nativeDeliveryCurrency ?? null,
            }),
        ...(qualification.conditionGroup ? { conditionGroup: qualification.conditionGroup } : {}),
        ...(qualification.merchantId ? { merchantId: qualification.merchantId } : {}),
        offerKind: qualification.offerKind as Parameters<
          typeof insertPriceAlertTrigger
        >[0]['offerKind'],
        nativeCheckoutEligible: qualification.nativeCheckoutEligible,
        quotes: qualification.quotes,
      },
      tx,
    );

    if (trigger === undefined) return false;

    // The ecosystem channel always; email ONLY on the buyer's explicit
    // preference (issue notification 2). Both are durable rows — whether either
    // can actually be delivered is the dispatcher's business, and a queued
    // email on a deployment with no transport is a VISIBLE failure rather than
    // a feature that silently does nothing.
    await enqueuePriceAlertNotification(
      { triggerId: trigger.id, alertId: alert.id, channel: 'oxy_notification', availableAt: now },
      tx,
    );
    if (alert.emailOptIn) {
      await enqueuePriceAlertNotification(
        { triggerId: trigger.id, alertId: alert.id, channel: 'email', availableAt: now },
        tx,
      );
    }

    await recordPriceAlertTriggered(
      { id: alert.id, amountMinor: qualification.amount.amount, now },
      tx,
    );
    return true;
  });
}

/**
 * Evaluate every alert on one canonical product.
 *
 * Alerts are stamped `last_evaluated_at` whatever the outcome, which is what
 * makes issue operations 3's evaluation lag measurable at all: an alert that has
 * never been looked at and one that was looked at and did not qualify are
 * different facts, and only the first is a problem.
 */
export async function evaluatePriceAlertsForProduct(
  canonicalProductId: string,
  now: Date = new Date(),
): Promise<PriceAlertEvaluationOutcome> {
  const alerts = await listEvaluableAlertsForProduct(
    canonicalProductId,
    // Bounded, so one product with an implausible number of watchers cannot
    // make one claim unbounded work. The remainder is picked up by the next
    // enqueue, and the queue row's counters make the shortfall visible.
    config.priceAlerts.maxActivePerUser * 50,
  );
  if (alerts.length === 0) {
    return { evaluatedAlerts: 0, qualifiedAlerts: 0, triggersCreated: 0 };
  }

  const comparisons = new Map<string, AlertComparison>();
  let qualifiedAlerts = 0;
  let triggersCreated = 0;

  for (const alert of alerts) {
    const key = comparisonKey(alert);
    let comparison = comparisons.get(key);
    if (comparison === undefined) {
      comparison = await buildAlertComparison({
        canonicalProductId,
        comparisonCurrency: alert.targetCurrency,
        ...(alert.market ? { market: alert.market } : {}),
        limit: config.priceAlerts.evaluationOfferLimit,
      });
      comparisons.set(key, comparison);
    }

    const qualification = qualifyAlert({ alert, candidates: comparison.candidates });
    const best =
      qualification.outcome === 'qualified'
        ? qualification.amount
        : qualification.bestInScopeAmount;
    await applyReset(alert, best, now);

    if (qualification.outcome !== 'qualified') continue;
    if (!mayRepeat(alert, qualification.amount, now)) continue;

    qualifiedAlerts += 1;
    if (await recordQualification(alert, qualification, now)) triggersCreated += 1;
  }

  await recordPriceAlertEvaluated(
    alerts.map((alert) => alert.id),
    now,
  );

  log.general.debug(
    { canonicalProductId, evaluated: alerts.length, qualified: qualifiedAlerts, triggersCreated },
    '[PriceAlerts] evaluated a subject',
  );

  return { evaluatedAlerts: alerts.length, qualifiedAlerts, triggersCreated };
}
