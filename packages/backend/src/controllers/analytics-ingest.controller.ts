/**
 * `POST /analytics/events` — the ONLY way a browser or app contributes an event.
 *
 * ## Acceptance 3 is enforced here, and it is enforced by SUBTRACTION
 *
 * "Native paid orders and network-reported affiliate conversions cannot be
 * forged by client analytics." The handler refuses every event type outside
 * `ANALYTICS_CLIENT_EMITTABLE_EVENT_TYPES`, which contains impressions, clicks,
 * views and errors — and contains no event that asserts a payment, a session
 * being issued, a cart merging, a claim completing or an eligibility verdict.
 * Those exist only where a server wrote them.
 *
 * ## What a client may set, and what is taken from it
 *
 * A client may say WHAT happened and WHEN, on what surface, about which
 * entities, at what position, with what bounded reason code. A client may NOT
 * set:
 *
 *  - `eventId` or `receivedAt` — both are ours, so a client cannot place an
 *    event outside a metric's window or collide two rows.
 *  - any identity field — the actor is resolved server-side from the request,
 *    and the pseudonym is derived under a salt the client never sees.
 *  - `trafficClass` — it is classified from the request, so a bot cannot
 *    declare itself human and inflate the very metrics that exclude it.
 *  - `checkoutGroupId` or `orderId` — the RESTRICTED correlation. A client
 *    holding one could attach unrelated browsing to a commerce record, which is
 *    exactly the join envelope field 5 restricts. They are not read from the
 *    body at all; the field does not exist in the accepted shape.
 *
 * ## Bounded and cheap to refuse
 *
 * A batch is capped, each entry is validated against closed tuples before it can
 * become a column, and the whole handler runs before any database access —
 * enqueueing is in-process. So the cost of an abusive caller is bounded by the
 * rate limiter and by `express.json`'s size limit, and never by a write.
 *
 * The response is always 202. Not 200 and not 201: what happened is that the
 * events were ACCEPTED into a bounded queue that may drop them, and telling a
 * client they were stored would be the same overstatement `POST /reports`
 * refuses one domain over.
 */

import type { Request, Response } from 'express';
import {
  ANALYTICS_CLIENT_EMITTABLE_EVENT_TYPES,
  ANALYTICS_REASON_CODES,
  GUEST_PAYMENT_METHOD_CATEGORIES,
  type AnalyticsClientEmittableEventType,
  type AnalyticsEntityIds,
  type AnalyticsMeasures,
  type AnalyticsReasonCode,
  type GuestPaymentMethodCategory,
} from '@mercaria/shared-types';
import { config } from '../config/index.js';
import { ErrorCodes, sendError, sendSuccess } from '../utils/api-response.js';
import { emitAnalyticsEvent } from '../services/analytics/emit.js';

/** The most events one request may carry. */
const MAX_BATCH = 50;

/** How far in the past a client-supplied `occurredAt` may be, in milliseconds. */
const MAX_BACKDATE_MS = 6 * 60 * 60 * 1_000;

/** One entry of the accepted batch, before validation. */
interface RawEventEntry {
  eventType?: unknown;
  occurredAt?: unknown;
  entities?: unknown;
  measures?: unknown;
  reasonCode?: unknown;
  paymentMethodCategory?: unknown;
  searchPolicyVersion?: unknown;
  rankingPolicyVersion?: unknown;
}

/** The entity keys a client may set. An allow-list, checked key by key. */
const ENTITY_KEYS = [
  'queryEventId',
  'listingId',
  'productVariantId',
  'canonicalProductId',
  'canonicalVariantId',
  'offerId',
  'merchantId',
  'storefrontId',
  'categoryId',
  'storeId',
] as const;

/** The measure keys a client may set. */
const MEASURE_KEYS = ['position', 'resultCount', 'latencyMs', 'quantity', 'itemCount'] as const;

/** An opaque id shape — bounded, so no prose can arrive in an entity column. */
const ID_SHAPE = /^[A-Za-z0-9:_.-]{1,128}$/;

/** Read the entity ids a client supplied, dropping anything unrecognised. */
function readEntities(value: unknown): AnalyticsEntityIds {
  if (typeof value !== 'object' || value === null) return {};
  const source = value as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const key of ENTITY_KEYS) {
    const raw = source[key];
    if (typeof raw === 'string' && ID_SHAPE.test(raw)) {
      out[key] = raw;
    }
  }
  return out as AnalyticsEntityIds;
}

/** Read the measures a client supplied, dropping anything unrecognised. */
function readMeasures(value: unknown): AnalyticsMeasures {
  if (typeof value !== 'object' || value === null) return {};
  const source = value as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const key of MEASURE_KEYS) {
    const raw = source[key];
    // Bounded on both sides: the CHECK refuses a negative, and an unbounded
    // positive would let a client write a number that breaks every average it
    // enters. 1e7 is far past any real page, cart or latency.
    if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 10_000_000) {
      out[key] = raw;
    }
  }
  return out as AnalyticsMeasures;
}

/**
 * Read a client-supplied event time.
 *
 * Clamped into `[now - MAX_BACKDATE_MS, now]`. A client clock that is wrong (or
 * lying) must not be able to place an event outside the window a metric is
 * computed over, and a FUTURE timestamp would sit in a bucket the rollup has
 * already written and never be counted at all.
 */
function readOccurredAt(value: unknown, now: Date): Date {
  if (typeof value !== 'string') return now;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return now;
  const floor = now.getTime() - MAX_BACKDATE_MS;
  return new Date(Math.min(Math.max(parsed, floor), now.getTime()));
}

/**
 * POST /analytics/events — accept a bounded batch of client-emittable events.
 */
export function ingestAnalyticsEventsHandler(req: Request, res: Response): void {
  // A deployment that collects nothing answers 202 and records nothing, rather
  // than 404: the endpoint's existence is not a secret, and a client that got a
  // 404 would retry it forever.
  if (!config.analytics.enabled) {
    sendSuccess(res, { accepted: 0, rejected: 0 }, 202);
    return;
  }

  const body = req.body as { events?: unknown };
  if (!Array.isArray(body.events)) {
    sendError(res, ErrorCodes.VALIDATION_ERROR, 'events must be an array', 400);
    return;
  }
  if (body.events.length > MAX_BATCH) {
    sendError(res, ErrorCodes.VALIDATION_ERROR, `at most ${String(MAX_BATCH)} events`, 400);
    return;
  }

  const now = new Date();
  let accepted = 0;
  let rejected = 0;

  for (const raw of body.events as RawEventEntry[]) {
    const eventType = raw.eventType;
    if (
      typeof eventType !== 'string' ||
      !(ANALYTICS_CLIENT_EMITTABLE_EVENT_TYPES as readonly string[]).includes(eventType)
    ) {
      // Counted, not fatal. One bad entry in a batch must not discard the
      // fifteen good ones beside it, and a client that keeps sending a
      // server-only type sees a non-zero `rejected` rather than a 400 it will
      // mis-attribute to the whole batch.
      rejected += 1;
      continue;
    }

    const reasonCode = raw.reasonCode;
    const validReason =
      typeof reasonCode === 'string' &&
      (ANALYTICS_REASON_CODES as readonly string[]).includes(reasonCode);

    // #111's four payment types and two claim types are client-emittable, and
    // the payment ones carry a BOUNDED method category. A value outside the
    // tuple is DROPPED rather than rejecting the entry: the category is a
    // dimension, not the fact, so an unrecognised one costs a slice and losing
    // the whole event costs the funnel. `envelope.ts` drops it again for any
    // event type the CHECK would refuse it on, so a client cannot attach one to
    // an impression by sending it here.
    const methodCategory = raw.paymentMethodCategory;
    const validMethodCategory =
      typeof methodCategory === 'string' &&
      (GUEST_PAYMENT_METHOD_CATEGORIES as readonly string[]).includes(methodCategory);

    emitAnalyticsEvent(req, {
      eventType: eventType as AnalyticsClientEmittableEventType,
      ...(validMethodCategory
        ? { paymentMethodCategory: methodCategory as GuestPaymentMethodCategory }
        : {}),
      occurredAt: readOccurredAt(raw.occurredAt, now),
      entities: readEntities(raw.entities),
      measures: readMeasures(raw.measures),
      ...(validReason ? { reasonCode: reasonCode as AnalyticsReasonCode } : {}),
      ...(typeof raw.searchPolicyVersion === 'string'
        ? { searchPolicyVersion: raw.searchPolicyVersion.slice(0, 64) }
        : {}),
      ...(typeof raw.rankingPolicyVersion === 'string'
        ? { rankingPolicyVersion: raw.rankingPolicyVersion.slice(0, 64) }
        : {}),
    });
    accepted += 1;
  }

  // 202: accepted into a bounded queue that may drop them. Never 201.
  sendSuccess(res, { accepted, rejected }, 202);
}
