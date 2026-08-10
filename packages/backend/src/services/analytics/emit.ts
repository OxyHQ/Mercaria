/**
 * The ONE entry point every instrumented code path calls.
 *
 * ## Why the surface is this narrow
 *
 * `emitAnalyticsEvent` returns `void` and never throws, inheriting both from
 * `sink.ts`. That is what lets a discovery or checkout handler call it on the
 * happy path with no `try`, no `await` and no error branch — and what makes the
 * "analytics loss can never block commerce" gate (`sink-never-blocks-commerce`)
 * a statement about the real call sites rather than about a mock.
 *
 * It is also the ONLY analytics module a discovery or commerce path is allowed
 * to import. `analytics-ranking-isolation.test.ts` enforces exactly that: a
 * search, feed or catalogue module may reach this file and the shared-types
 * contract, and nothing else in the domain — so no ranking function can read a
 * rollup, an aggregate or a metric, and "popularity we measured" can never
 * become an organic ranking input by accident.
 *
 * ## Identity derivation is asynchronous and this function is not
 *
 * Deriving the pseudonym may need to read (and, once per rotation, WRITE) the
 * salt. Doing that inline would put a database round trip on the commerce path,
 * which is the exact thing this domain must never do. So the derivation runs on
 * a detached promise whose rejection is swallowed and counted, and the event is
 * enqueued from its continuation. The observable consequence is that an event's
 * `receivedAt` may trail the request by a few milliseconds; nothing reads it at
 * that resolution.
 */

import type { Request } from 'express';
import type {
  AnalyticsBuyerOrigin,
  AnalyticsClientSurface,
  AnalyticsEntityIds,
  AnalyticsEventType,
  AnalyticsMeasures,
  AnalyticsReasonCode,
  AnalyticsTrafficClass,
  GuestPaymentMethodCategory,
} from '@mercaria/shared-types';
import type { CommerceActor } from '../commerce-actor.js';
import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import { buildAnalyticsEvent } from './envelope.js';
import { deriveAnalyticsIdentity } from './identity.js';
import { recordAnalyticsEvent } from './sink.js';
import { readAnalyticsRequestContext, type AnalyticsRequestContext } from './request-context.js';

/** What a call site says about one event. The request supplies the rest. */
export interface EmitAnalyticsInput {
  readonly eventType: AnalyticsEventType;
  readonly entities?: AnalyticsEntityIds;
  readonly measures?: AnalyticsMeasures;
  readonly reasonCode?: AnalyticsReasonCode;
  readonly buyerOrigin?: AnalyticsBuyerOrigin;
  /** RESTRICTED — kept only on the four payment event types (#111). */
  readonly paymentMethodCategory?: GuestPaymentMethodCategory;
  /** RESTRICTED — kept only on the event types field 5 admits. */
  readonly checkoutGroupId?: string;
  /** RESTRICTED — same rule. */
  readonly orderId?: string;
  readonly searchPolicyVersion?: string;
  readonly rankingPolicyVersion?: string;
  readonly occurredAt?: Date;
}

/**
 * Emit one event for the current request.
 *
 * Returns immediately. Nothing a caller does with the result can make it block,
 * because there is no result.
 */
export function emitAnalyticsEvent(req: Request, input: EmitAnalyticsInput): void {
  if (!config.analytics.enabled) return;
  const context = readAnalyticsRequestContext(req);
  emitWithContext(context, req.commerceActor ?? { kind: 'anonymous' }, input);
}

/**
 * Emit outside a request — a background job, a webhook handler, a sweep.
 *
 * Takes the dimensions explicitly, because there is no request to read them
 * from. The surface is `api`, which is honest: nothing rendered.
 */
export function emitServerAnalyticsEvent(
  actor: CommerceActor,
  input: EmitAnalyticsInput & { market?: string },
): void {
  if (!config.analytics.enabled) return;
  emitWithContext(
    {
      clientSurface: 'api',
      trafficClass: 'internal',
      consentState: 'not_required',
      ...(input.market === undefined ? {} : { market: input.market }),
    },
    actor,
    input,
  );
}

/**
 * The shared path.
 *
 * The detached promise is the whole mechanism, and the `catch` on it is the
 * second deliberate swallow in this domain (the first is the sink's flush). A
 * rejection here means the salt could not be read or opened — a genuine
 * database problem, worth a log line, and worth nothing at all to the shopper
 * whose request has already been answered.
 */
function emitWithContext(
  context: AnalyticsRequestContext,
  actor: CommerceActor,
  input: EmitAnalyticsInput,
): void {
  const now = new Date();
  void deriveAnalyticsIdentity({
    actor,
    ...(context.surfaceSessionId === undefined
      ? {}
      : { surfaceSessionId: context.surfaceSessionId }),
    // Envelope field 3's "and permitted". `denied` is the only value that
    // withholds the account id: `unknown` and `not_required` are jurisdictions
    // and states in which no refusal was expressed, and treating them as a
    // refusal would silently blank the identity on every deployment that has not
    // wired a consent banner yet — a change to what is COLLECTED that nobody
    // asked for and nobody would notice.
    consentPermitsIdentity: context.consentState !== 'denied',
    now,
  })
    .then((identity) => {
      recordAnalyticsEvent(
        buildAnalyticsEvent(
          {
            eventType: input.eventType,
            identity,
            clientSurface: context.clientSurface,
            trafficClass: context.trafficClass,
            consentState: context.consentState,
            ...(context.appVersion === undefined ? {} : { appVersion: context.appVersion }),
            ...(context.market === undefined ? {} : { market: context.market }),
            ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
            ...(input.entities === undefined ? {} : { entities: input.entities }),
            ...(input.measures === undefined ? {} : { measures: input.measures }),
            ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
            ...(input.buyerOrigin === undefined ? {} : { buyerOrigin: input.buyerOrigin }),
            ...(input.checkoutGroupId === undefined
              ? {}
              : { checkoutGroupId: input.checkoutGroupId }),
            ...(input.orderId === undefined ? {} : { orderId: input.orderId }),
            ...(input.searchPolicyVersion === undefined
              ? {}
              : { searchPolicyVersion: input.searchPolicyVersion }),
            ...(input.rankingPolicyVersion === undefined
              ? {}
              : { rankingPolicyVersion: input.rankingPolicyVersion }),
          },
          now,
        ),
      );
    })
    .catch((error: unknown) => {
      // Deliberate swallow. The request has already been answered; there is no
      // caller to propagate to, and a rejected detached promise would otherwise
      // become an unhandled rejection and take the task down.
      log.general.error(
        { err: error, eventType: input.eventType },
        '[Analytics] identity derivation failed; the event is dropped',
      );
    });
}

/** The surface an event came from, re-exported so call sites need one import. */
export type { AnalyticsClientSurface, AnalyticsTrafficClass };
