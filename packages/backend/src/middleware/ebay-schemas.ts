/**
 * Request schemas for `/internal/ebay/*` — issue #65's operator surface.
 *
 * `.strict()` everywhere, for the reason every other operator surface in this
 * repo is: an unrecognised key is a caller with a different idea of the contract
 * than the server has, and silently dropping it is how a rollout decision
 * somebody typed never takes effect.
 */

import { z } from 'zod';
import {
  EBAY_DISCOVERY_QUERY_KINDS,
  EBAY_MARKETPLACE_IDS,
  EBAY_SEARCH_MAX_OFFSET,
} from '@mercaria/shared-types';

/**
 * Add or reconfigure one discovery query — the ROLLOUT COHORT (#65 acceptance
 * 7).
 *
 * `maxOffset` is bounded by eBay's own refusal point rather than left open: a
 * depth beyond it is a request the provider answers with an error, so accepting
 * one would let an operator configure a query that can only ever fail.
 */
export const upsertEbayDiscoveryQuerySchema = z
  .object({
    marketplaceId: z.enum(EBAY_MARKETPLACE_IDS as unknown as [string, ...string[]]),
    queryKind: z.enum(EBAY_DISCOVERY_QUERY_KINDS as unknown as [string, ...string[]]),
    queryValue: z.string().trim().min(1).max(200),
    position: z.number().int().min(0).max(10_000).optional(),
    enabled: z.boolean().optional(),
    maxOffset: z.number().int().min(1).max(EBAY_SEARCH_MAX_OFFSET).optional(),
    note: z.string().trim().max(2_000).optional(),
  })
  .strict();

/** Run one reconciliation sweep now. It takes no parameters an operator could tune. */
export const reconcileEbaySourceSchema = z.object({}).strict();
