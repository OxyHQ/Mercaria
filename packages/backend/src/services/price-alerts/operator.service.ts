/**
 * The operator surface (#79 abuse and operations 3, 5, 6).
 *
 * ## What it can be asked, and what it structurally cannot
 *
 * A trace opens from an ALERT ID and from nothing else. There is no route, and
 * no function here, that takes a canonical product, a merchant or an Oxy account
 * — so "who is watching this product" and "show me everything this person is
 * waiting for" are not questions this surface can be asked, which is issue abuse
 * rule 6 held by the shape of the API rather than by a filter.
 *
 * The trace does carry the alert's own target, because an operator answering
 * "why was I not told" cannot answer it otherwise. That is why the router sits
 * behind an allow-list and why the one handle is an id somebody has to have been
 * given.
 *
 * ## The metrics are the four the issue names, and one vacuity floor
 *
 * Evaluation lag, trigger count, delivery rate and stale-link suppression —
 * plus `neverEvaluated`, which is what makes a stalled evaluator distinguishable
 * from an idle one. Ages are ABSENT rather than zero when nothing is
 * outstanding, the `oldestPendingRebuildAgeSeconds` decision.
 */

import type {
  PriceAlert,
  PriceAlertLastEvaluation,
  PriceAlertNotificationView,
  PriceAlertTrigger,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import {
  findPriceAlertEvaluationForProduct,
  requestPriceAlertEvaluationForProduct,
  summarizePriceAlertEvaluations,
  type PriceAlertEvaluationRow,
} from '../../db/priceAlerts/priceAlertEvaluationRepository.js';
import {
  findPriceAlertById,
  readOldestEvaluationAge,
  summarizePriceAlerts,
} from '../../db/priceAlerts/priceAlertRepository.js';
import {
  listPriceAlertNotifications,
  summarizePriceAlertNotifications,
} from '../../db/priceAlerts/priceAlertNotificationRepository.js';
import {
  listPriceAlertTriggerQuotes,
  listPriceAlertTriggers,
  countPriceAlertTriggersSince,
} from '../../db/priceAlerts/priceAlertTriggerRepository.js';
import { notFound } from '../../lib/errors/error-codes.js';
import {
  toPriceAlertDTO,
  toPriceAlertNotificationView,
  toPriceAlertTriggerDTO,
} from './projection.js';

/** Everything one alert's history says. */
export interface PriceAlertTrace {
  readonly alert: PriceAlert;
  /**
   * Why THIS alert did not fire, from its own last evaluation (#752).
   *
   * The answer to the question the surface exists for. It is separate from
   * `evaluation` below and neither substitutes for the other: that one is the
   * PRODUCT's queue row and reports how the sweep went (state, lease, attempts,
   * how many alerts it looked at), while this is the verdict on the ONE alert
   * being traced. A sweep can complete perfectly and still leave this alert
   * blocked, which is the ordinary case and the one an operator is asking about.
   *
   * ABSENT when the alert has never been evaluated — which `evaluation.state`
   * and the queue's own age are what explain.
   */
  readonly lastEvaluation?: PriceAlertLastEvaluation;
  readonly triggers: readonly PriceAlertTrigger[];
  readonly notifications: readonly PriceAlertNotificationView[];
  /** The subject's queue row — how long ago it was evaluated, and what it saw. */
  readonly evaluation?: {
    readonly state: PriceAlertEvaluationRow['state'];
    readonly requestedRevision: number;
    readonly claimedRevision?: number;
    readonly attempts: number;
    readonly lastEvaluatedAt?: string;
    readonly lastEvaluatedAlerts?: number;
    readonly lastQualifiedAlerts?: number;
    readonly lastFailure?: string;
  };
}

/** Trace one alert. Opens from an ALERT ID and nothing else. */
export async function tracePriceAlert(alertId: string): Promise<PriceAlertTrace> {
  const alert = await findPriceAlertById(alertId);
  if (!alert) throw notFound('No such price alert.');

  const triggerRows = await listPriceAlertTriggers(alertId, config.priceAlerts.traceLimit);
  const triggers: PriceAlertTrigger[] = [];
  for (const row of triggerRows) {
    triggers.push(toPriceAlertTriggerDTO(row, await listPriceAlertTriggerQuotes(row.id)));
  }

  const deliveries = await listPriceAlertNotifications(alertId, config.priceAlerts.traceLimit);
  const evaluation = await findPriceAlertEvaluationForProduct(alert.canonicalProductId);

  return {
    alert: toPriceAlertDTO(alert),
    ...(alert.lastEvaluatedAt
      ? {
          lastEvaluation: {
            evaluatedAt: alert.lastEvaluatedAt.toISOString(),
            // Derived from the reasons rather than stored a second time: a
            // stored outcome column could disagree with the list beside it.
            outcome: alert.lastBlockReasons.length > 0 ? ('blocked' as const) : ('qualified' as const),
            reasons: alert.lastBlockReasons,
          },
        }
      : {}),
    triggers,
    notifications: deliveries.map((entry) =>
      toPriceAlertNotificationView(entry.row, entry.openedAt),
    ),
    ...(evaluation
      ? {
          evaluation: {
            state: evaluation.state,
            requestedRevision: evaluation.requestedRevision,
            ...(evaluation.claimedRevision === null
              ? {}
              : { claimedRevision: evaluation.claimedRevision }),
            attempts: evaluation.attempts,
            ...(evaluation.lastEvaluatedAt
              ? { lastEvaluatedAt: evaluation.lastEvaluatedAt.toISOString() }
              : {}),
            ...(evaluation.lastEvaluatedAlerts === null
              ? {}
              : { lastEvaluatedAlerts: evaluation.lastEvaluatedAlerts }),
            ...(evaluation.lastQualifiedAlerts === null
              ? {}
              : { lastQualifiedAlerts: evaluation.lastQualifiedAlerts }),
            ...(evaluation.lastFailure ? { lastFailure: evaluation.lastFailure } : {}),
          },
        }
      : {}),
  };
}

/** Issue operations 3's four measurements, plus the floors that make them readable. */
export interface PriceAlertMetrics {
  readonly alerts: Awaited<ReturnType<typeof summarizePriceAlerts>>;
  readonly evaluationQueue: Awaited<ReturnType<typeof summarizePriceAlertEvaluations>>;
  /** How long ago the LEAST recently evaluated live alert was looked at. */
  readonly oldestEvaluationAgeSeconds?: number;
  readonly triggersLast24h: number;
  readonly delivery: Awaited<ReturnType<typeof summarizePriceAlertNotifications>>;
  /** The three levers, echoed, so a dashboard shows WHY a number is zero. */
  readonly levers: {
    readonly enabled: boolean;
    readonly evaluationEnabled: boolean;
    readonly notificationsEnabled: boolean;
  };
}

export async function readPriceAlertMetrics(
  now: Date = new Date(),
): Promise<PriceAlertMetrics> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1_000);
  const oldest = await readOldestEvaluationAge(now);
  return {
    alerts: await summarizePriceAlerts(),
    evaluationQueue: await summarizePriceAlertEvaluations(now),
    ...(oldest === undefined ? {} : { oldestEvaluationAgeSeconds: oldest }),
    triggersLast24h: await countPriceAlertTriggersSince(since),
    delivery: await summarizePriceAlertNotifications(),
    levers: {
      enabled: config.priceAlerts.enabled,
      evaluationEnabled: config.priceAlerts.evaluationEnabled,
      notificationsEnabled: config.priceAlerts.notificationsEnabled,
    },
  };
}

/**
 * Ask for one alert's subject to be evaluated now.
 *
 * DRIVES the existing idempotent path and adds no new way to notify anybody:
 * there is deliberately no "trigger this alert", no "send this notification
 * again" and no "set this alert triggered" — every one of those would be a way
 * to tell a buyer something no price ever justified.
 *
 * It takes an ALERT id rather than a product id, so the surface still cannot be
 * pointed at a product to find out who is watching it.
 */
export async function requestPriceAlertReevaluation(alertId: string): Promise<void> {
  const alert = await findPriceAlertById(alertId);
  if (!alert) throw notFound('No such price alert.');
  await requestPriceAlertEvaluationForProduct(alert.canonicalProductId);
}
