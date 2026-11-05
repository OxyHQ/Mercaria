/**
 * Request schemas for the paid store-page merchandising rules (#89,
 * `advanced_merchandising_rules`).
 *
 * `.strict()` everywhere: a field the schema does not declare — a boost, a
 * weight, a placement on some other surface — is REFUSED rather than stripped,
 * so nobody believes they configured something the server silently ignored.
 * The kind-specific combinations (a spotlight's item limit, a best-selling
 * window) are checked by the service against the merged row, because an update
 * is only valid or invalid together with what it is merged onto.
 */

import { z } from 'zod';
import { isLiveEntityId } from '@oxy.so/db';
import {
  MAX_MERCHANDISED_PAGE_SIZE,
  MAX_MERCHANDISING_BEST_SELLING_WINDOW_DAYS,
  MAX_MERCHANDISING_PINS,
  MAX_MERCHANDISING_RULE_TITLE_LENGTH,
  MAX_MERCHANDISING_SPOTLIGHT_ITEMS,
  MERCHANDISING_RULE_KINDS,
  MERCHANDISING_RULE_TARGETS,
  MERCHANDISING_SORT_STRATEGIES,
  MIN_MERCHANDISING_BEST_SELLING_WINDOW_DAYS,
  MIN_MERCHANDISING_SPOTLIGHT_ITEMS,
} from '@mercaria/shared-types';

const idSchema = z.string().trim().refine(isLiveEntityId, 'Must be a valid id');
const titleSchema = z.string().trim().min(1).max(MAX_MERCHANDISING_RULE_TITLE_LENGTH);
const instantSchema = z.string().datetime({ offset: true });
const windowDaysSchema = z
  .number()
  .int()
  .min(MIN_MERCHANDISING_BEST_SELLING_WINDOW_DAYS)
  .max(MAX_MERCHANDISING_BEST_SELLING_WINDOW_DAYS);
const spotlightLimitSchema = z
  .number()
  .int()
  .min(MIN_MERCHANDISING_SPOTLIGHT_ITEMS)
  .max(MAX_MERCHANDISING_SPOTLIGHT_ITEMS);
const pinsSchema = z.array(idSchema).max(MAX_MERCHANDISING_PINS);

export const createMerchandisingRuleSchema = z
  .object({
    kind: z.enum(MERCHANDISING_RULE_KINDS),
    title: titleSchema,
    target: z.enum(MERCHANDISING_RULE_TARGETS),
    collectionId: idSchema.optional(),
    enabled: z.boolean().optional(),
    startsAt: instantSchema.nullable().optional(),
    endsAt: instantSchema.nullable().optional(),
    sortStrategy: z.enum(MERCHANDISING_SORT_STRATEGIES).optional(),
    bestSellingWindowDays: windowDaysSchema.optional(),
    inStockFirst: z.boolean().optional(),
    pinnedListingIds: pinsSchema.optional(),
    spotlightItemLimit: spotlightLimitSchema.optional(),
  })
  .strict();

export const updateMerchandisingRuleSchema = z
  .object({
    title: titleSchema.optional(),
    enabled: z.boolean().optional(),
    startsAt: instantSchema.nullable().optional(),
    endsAt: instantSchema.nullable().optional(),
    sortStrategy: z.enum(MERCHANDISING_SORT_STRATEGIES).optional(),
    bestSellingWindowDays: windowDaysSchema.nullable().optional(),
    inStockFirst: z.boolean().optional(),
    pinnedListingIds: pinsSchema.optional(),
    spotlightItemLimit: spotlightLimitSchema.optional(),
  })
  .strict();

export const merchandisingPreviewSchema = z
  .object({
    target: z.enum(MERCHANDISING_RULE_TARGETS),
    collectionId: idSchema.optional(),
    sortStrategy: z.enum(MERCHANDISING_SORT_STRATEGIES),
    bestSellingWindowDays: windowDaysSchema.optional(),
    inStockFirst: z.boolean().optional(),
    pinnedListingIds: pinsSchema.optional(),
    limit: z.number().int().min(1).max(MAX_MERCHANDISED_PAGE_SIZE).optional(),
  })
  .strict();

/** `GET /stores/:handle/merchandising/listings`. */
export const merchandisedPageQuerySchema = z
  .object({
    collectionId: idSchema.optional(),
    page: z.coerce.number().int().min(1).max(10_000).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_MERCHANDISED_PAGE_SIZE).optional(),
  })
  .strict();
