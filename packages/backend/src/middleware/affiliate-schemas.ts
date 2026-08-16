/**
 * Request schemas for `/internal/affiliate/*` (#67).
 *
 * Every one is `.strict()`, so an undeclared key is REFUSED rather than
 * stripped. On this surface that matters more than usual: the thing an
 * undeclared key would most plausibly be is a destination URL somebody wanted
 * the approval endpoint to take, and silently dropping it would leave the
 * caller believing they had approved something.
 */

import { z } from 'zod';
import {
  AFFILIATE_NETWORK_IDS,
  OUTBOUND_DESTINATION_KINDS,
  type AffiliateNetworkId,
  type OutboundDestinationKind,
} from '@mercaria/shared-types';

const DESTINATION_KIND_VALUES = OUTBOUND_DESTINATION_KINDS as readonly [
  OutboundDestinationKind,
  ...OutboundDestinationKind[],
];

const NETWORK_VALUES = AFFILIATE_NETWORK_IDS as readonly [
  AffiliateNetworkId,
  ...AffiliateNetworkId[],
];

/**
 * A bare hostname: lower-case, dotted, no scheme, no path, no port, no
 * wildcard.
 *
 * The SAME shape the column's CHECK enforces, stated here so a bad value is a
 * 400 naming the field rather than a 500 naming a constraint. It is validated
 * in BOTH places deliberately — the schema is the message, the CHECK is the
 * guarantee, and a write reaching the table by any other route still meets it.
 */
const hostSchema = z
  .string()
  .min(3)
  .max(253)
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/,
    'must be a bare lower-case hostname with no scheme, path, port or wildcard',
  );

/** `POST /internal/affiliate/hosts` — approve one destination host. */
export const approveOutboundHostSchema = z
  .object({
    catalogSourceId: z.string().min(1),
    host: hostSchema,
    kind: z.enum(DESTINATION_KIND_VALUES),
    reason: z.string().min(1).max(1000),
  })
  .strict();

/** `POST /internal/affiliate/hosts/:id/revoke`. */
export const revokeOutboundHostSchema = z
  .object({
    reason: z.string().min(1).max(1000),
  })
  .strict();

/** `GET /internal/affiliate/hosts`. */
export const listOutboundHostsQuerySchema = z
  .object({
    catalogSourceId: z.string().min(1),
  })
  .strict();

/**
 * `GET /internal/affiliate/clicks` — the trace, which opens from an OFFER id
 * and NOTHING else.
 *
 * There is deliberately no host, no market, no network and no date parameter
 * here. "Show me every click that went to this merchant" and "show me
 * everything that happened in this window" are enumeration questions, and the
 * aggregate report is where a window legitimately belongs. A trace answers
 * "what happened to THIS offer".
 */
export const outboundClickTraceQuerySchema = z
  .object({
    offerId: z.string().min(1),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

/** `GET /internal/affiliate/report` — the aggregate, over one window. */
export const affiliateReportQuerySchema = z
  .object({
    network: z.enum(NETWORK_VALUES),
    from: z.coerce.date(),
    to: z.coerce.date(),
  })
  .strict()
  .refine((value) => value.from <= value.to, {
    message: 'from must not be after to',
  });
