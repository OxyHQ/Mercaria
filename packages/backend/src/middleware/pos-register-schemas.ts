/**
 * Request schemas for the named POS registers (`/admin/stores/:storeId/pos-registers`,
 * the paid `expanded_pos_registers` tool). Strict bodies: an unknown field is a
 * 400, not silently ignored.
 */

import { z } from 'zod';
import { POS_REGISTER_NAME_MAX_LENGTH } from '@mercaria/shared-types';

const registerName = z.string().trim().min(1).max(POS_REGISTER_NAME_MAX_LENGTH);

/** Body for `POST /pos-registers` (CreatePosRegisterInput). */
export const createPosRegisterSchema = z
  .object({
    locationId: z.string().trim().min(1),
    name: registerName,
  })
  .strict();

/** Body for `PATCH /pos-registers/:id` (UpdatePosRegisterInput). */
export const updatePosRegisterSchema = z.object({ name: registerName }).strict();

/** Query for `GET /pos-registers`. */
export const listPosRegistersQuerySchema = z.object({
  locationId: z.string().trim().min(1).optional(),
  includeArchived: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

/** Query for `GET /pos-registers/summary`. */
export const posRegisterSummaryQuerySchema = z.object({
  from: z.string().trim().min(1).optional(),
  to: z.string().trim().min(1).optional(),
  locationId: z.string().trim().min(1).optional(),
});
