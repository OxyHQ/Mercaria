/**
 * Request schemas for the procurement operator surface (#124).
 *
 * `.strict()`, like every internal surface beside it, and here the strictness
 * carries a specific prohibition: this file defines the COMPLETE set of things
 * an operator may send to `/internal/procurement/*`, and there is no field
 * anywhere in it for a purchase-order status, an external order id, an amount
 * or a supplier answer. An operator who could send one of those could make a
 * supplier order that never existed look fulfilled — which is why the surface
 * has no route that takes one, and why a body that tried would be refused as an
 * unrecognized key rather than quietly ignored.
 */

import { z } from 'zod';
import {
  PROCUREMENT_EXCEPTION_RESOLUTIONS,
  type ProcurementExceptionResolution,
} from '@mercaria/shared-types';

const RESOLUTION_VALUES = PROCUREMENT_EXCEPTION_RESOLUTIONS as readonly [
  ProcurementExceptionResolution,
  ...ProcurementExceptionResolution[],
];

/**
 * Closing one procurement exception.
 *
 * The note is bounded to what the column's CHECK accepts and is OPTIONAL,
 * because several resolutions are self-explanatory (`converged`,
 * `no_action_required`) and demanding prose for them produces prose nobody
 * reads. The RESOLUTION itself is mandatory and closed: "an operator looked and
 * decided" needs to say what they decided, or the audit trail records only that
 * somebody made the row go away.
 */
export const procurementExceptionResolutionSchema = z
  .object({
    resolution: z.enum(RESOLUTION_VALUES),
    note: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();
