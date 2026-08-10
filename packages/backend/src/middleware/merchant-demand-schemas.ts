/**
 * Request schemas for the merchant demand and acquisition surfaces (#86).
 *
 * Every one is `.strict()`. A body that silently drops an unknown key is a body
 * that accepts `{"scoreBps": 9999}` today and applies it the day somebody adds
 * a matching field — and on this surface the fields somebody would reach for are
 * a score, a claim state and a contact value, none of which may be set by hand.
 */

import { z } from 'zod';
import {
  MERCHANT_ACQUISITION_CONTACT_SOURCE_KINDS,
  MERCHANT_ACQUISITION_EXCLUSION_REASONS,
  MERCHANT_ACQUISITION_OUTREACH_CHANNELS,
  MERCHANT_ACQUISITION_OUTREACH_OUTCOMES,
  MERCHANT_ACQUISITION_STATES,
  MERCHANT_DEMAND_WINDOW_DAYS,
} from '@mercaria/shared-types';
import { config } from '../config/index.js';

/** A shared tuple narrowed to the non-empty form `z.enum` requires. */
function enumValues<T extends string>(values: readonly T[]): readonly [T, ...T[]] {
  const [first, ...rest] = values;
  if (first === undefined) throw new Error('a closed value set may not be empty');
  return [first, ...rest];
}

/**
 * A market this deployment has opted into slicing by, or absent for "every
 * market".
 *
 * A CLOSED set, not a shape check. Overlapping SLICES difference exactly as
 * overlapping windows do — every-market minus ES is the rest of the world, and
 * on a small catalogue that is one country and sometimes one person. The set is
 * empty by default, so until a deployment names markets the only askable value
 * is the undimensioned bucket.
 */
const marketSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2}$/, 'market must be an ISO 3166-1 alpha-2 code')
  .refine(
    (market) => config.merchantDemand.markets.includes(market.toUpperCase()),
    'market is not one this deployment reports on',
  );

/**
 * One of the reporting windows the product offers.
 *
 * A CLOSED set rather than a bounded integer: 30 days minus 29 days is one day,
 * and one day of one product's demand is where a single person lives. With
 * `refresh=true` a free integer lets a claimant walk the boundary a day at a
 * time; three fixed windows never overlap by one day.
 */
const windowDaysSchema = z.coerce
  .number()
  .int()
  .refine(
    (days) => (MERCHANT_DEMAND_WINDOW_DAYS as readonly number[]).includes(days),
    `windowDays must be one of ${MERCHANT_DEMAND_WINDOW_DAYS.join(', ')}`,
  );

/** `GET /merchant-demand/:merchantId` and the preview. */
export const merchantDemandQuerySchema = z
  .object({
    market: marketSchema.optional(),
    windowDays: windowDaysSchema.optional(),
    /** Rebuild rather than read the live snapshot for the window. */
    refresh: z.enum(['true', 'false']).optional(),
    /** `csv` returns the merchant's own aggregate rows as a file. */
    format: z.enum(['json', 'csv']).optional(),
  })
  .strict();

/** `GET /internal/merchant-demand/candidates`. */
export const acquisitionListQuerySchema = z
  .object({
    state: z.enum(enumValues(MERCHANT_ACQUISITION_STATES)).optional(),
    assignedTo: z.string().trim().min(1).max(128).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    offset: z.coerce.number().int().min(0).max(10_000).optional(),
  })
  .strict();

/** `POST /internal/merchant-demand/candidates/:merchantId/assign`. */
export const acquisitionAssignSchema = z
  .object({
    /** `null` clears the assignment. */
    assignedToOxyUserId: z.string().trim().min(1).max(128).nullable(),
  })
  .strict();

/**
 * `POST /internal/merchant-demand/candidates/:merchantId/next-action`.
 *
 * `excluded` is REFUSED here even though it is a member of the state tuple:
 * excluding a candidate has its own action, its own audit line and its own
 * required reason, and the row's CHECK ties `state = 'excluded'` to an
 * `excluded_at`. Accepting it on this route would be a 500 from the database
 * rather than a 400 from the schema, and it would be a way to exclude a
 * merchant without recording why.
 *
 * The two next-action fields travel together for the same reason: the column
 * CHECK is `num_nonnulls(…) in (0, 2)`, so half a next action is a refused
 * write, and refusing it here names the field instead of the constraint.
 */
export const acquisitionNextActionSchema = z
  .object({
    state: z.enum(
      enumValues(MERCHANT_ACQUISITION_STATES.filter((state) => state !== 'excluded')),
    ),
    /** Bounded, because a next action is a step and not a case file. */
    nextAction: z.string().trim().min(1).max(500).nullable(),
    nextActionDueAt: z.string().datetime().nullable(),
  })
  .strict()
  .refine(
    (body) => (body.nextAction === null) === (body.nextActionDueAt === null),
    'nextAction and nextActionDueAt travel together: an action nobody is due to take is a note',
  );

/** `POST /internal/merchant-demand/candidates/:merchantId/exclude`. */
export const acquisitionExcludeSchema = z
  .object({
    reason: z.enum(enumValues(MERCHANT_ACQUISITION_EXCLUSION_REASONS)),
  })
  .strict();

/** `POST /internal/merchant-demand/candidates/:merchantId/do-not-contact`. */
export const acquisitionDoNotContactSchema = z
  .object({ doNotContact: z.boolean() })
  .strict();

/**
 * `POST /internal/merchant-demand/candidates/:merchantId/contact-sources`.
 *
 * There is no field here for an email, a phone number or a name, and none may
 * be added: this records WHERE a public business contact is published, and the
 * schema's shape is the outer half of that decision (the inner half is that no
 * column exists to hold one).
 *
 * `locatorNote` is refused if it contains an at-sign or a five-digit run —
 * the same shape check the column's CHECK applies — so a note cannot quietly
 * become the value it is supposed to point at.
 */
export const acquisitionContactSourceSchema = z
  .object({
    kind: z.enum(enumValues(MERCHANT_ACQUISITION_CONTACT_SOURCE_KINDS)),
    sourceUrl: z
      .string()
      .trim()
      .url()
      .max(500)
      .refine((value) => value.startsWith('https://'), 'sourceUrl must be https'),
    locatorNote: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((value) => !value.includes('@'), 'locatorNote may not contain a contact value')
      .refine(
        (value) => !/[0-9]{5}/.test(value),
        'locatorNote may not contain a contact value',
      ),
    observedAt: z.string().datetime(),
  })
  .strict();

/** `POST /internal/merchant-demand/candidates/:merchantId/outreach`. */
export const acquisitionOutreachSchema = z
  .object({
    channel: z.enum(enumValues(MERCHANT_ACQUISITION_OUTREACH_CHANNELS)),
    outcome: z.enum(enumValues(MERCHANT_ACQUISITION_OUTREACH_OUTCOMES)),
    occurredAt: z.string().datetime(),
    contactSourceId: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

/** `POST /internal/merchant-demand/candidates/:merchantId/rescore`. */
export const acquisitionRescoreSchema = z
  .object({
    market: marketSchema.optional(),
    windowDays: windowDaysSchema.optional(),
  })
  .strict();
