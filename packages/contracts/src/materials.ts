import { z } from 'zod';
import { MercariaIdSchema, MercariaTimestampSchema } from './primitives';
import { MercariaPageQuerySchema } from './requests';

import { MATERIAL_RESERVATION_STATUSES, MATERIAL_OFFER_STATUSES } from '@mercaria/shared-types';
export { MATERIAL_RESERVATION_STATUSES, MATERIAL_OFFER_STATUSES } from '@mercaria/shared-types';
export const MaterialQuantitySchema = z.number().int().min(1).max(1_000_000);
export const MaterialIdempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
export const MaterialOfferCreateSchema = z.strictObject({
  ownerAccountId: MercariaIdSchema,
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(4000),
  publicArea: z.string().trim().min(1).max(160),
  quantity: MaterialQuantitySchema,
  unit: z.string().trim().min(1).max(40),
  pickupInstructions: z.string().trim().min(1).max(2000),
  idempotencyKey: MaterialIdempotencyKeySchema,
});
export const MaterialOfferSchema = z.object({
  id: MercariaIdSchema,
  ownerAccountId: MercariaIdSchema,
  title: z.string(),
  description: z.string(),
  publicArea: z.string(),
  unit: z.string(),
  status: z.enum(MATERIAL_OFFER_STATUSES),
  quantity: MaterialQuantitySchema,
  availableQuantity: z.number().int().min(0),
  committedQuantity: z.number().int().min(0),
  receivedQuantity: z.number().int().min(0),
  createdAt: MercariaTimestampSchema,
});
export const MaterialRequestCreateSchema = z.strictObject({
  requesterAccountId: MercariaIdSchema,
  quantity: MaterialQuantitySchema,
  idempotencyKey: MaterialIdempotencyKeySchema,
});
export const MaterialActionSchema = z.strictObject({
  actingAccountId: MercariaIdSchema,
  idempotencyKey: MaterialIdempotencyKeySchema,
});
export const MaterialReservationSchema = z.object({
  id: MercariaIdSchema,
  offerId: MercariaIdSchema,
  donorAccountId: MercariaIdSchema,
  requesterAccountId: MercariaIdSchema,
  moovoTransportId: MercariaIdSchema.nullable().default(null),
  quantity: MaterialQuantitySchema,
  status: z.enum(MATERIAL_RESERVATION_STATUSES),
  // Private collection details are disclosed only while accepted/delivered.
  pickupInstructions: z.string().nullable(),
  createdAt: MercariaTimestampSchema,
  updatedAt: MercariaTimestampSchema,
});
export const MaterialOfferQuerySchema = MercariaPageQuerySchema.extend({
  ownerAccountId: MercariaIdSchema.optional(),
});
export const MaterialReservationQuerySchema = MercariaPageQuerySchema.extend({
  accountId: MercariaIdSchema,
  status: z.enum(MATERIAL_RESERVATION_STATUSES).optional(),
  offerId: MercariaIdSchema.optional(),
});
export const MaterialReservationReadQuerySchema = z.strictObject({ accountId: MercariaIdSchema });
export const MaterialOfferPageSchema = z.object({
  items: z.array(MaterialOfferSchema),
  nextCursor: z.string().nullable(),
});
export const MaterialReservationPageSchema = z.object({
  items: z.array(MaterialReservationSchema),
  nextCursor: z.string().nullable(),
});
export type MaterialOffer = z.infer<typeof MaterialOfferSchema>;
export type MaterialOfferCreate = z.infer<typeof MaterialOfferCreateSchema>;
export type MaterialRequestCreate = z.infer<typeof MaterialRequestCreateSchema>;
export type MaterialAction = z.infer<typeof MaterialActionSchema>;
export type MaterialReservation = z.infer<typeof MaterialReservationSchema>;
export type MaterialOfferQuery = z.infer<typeof MaterialOfferQuerySchema>;
export type MaterialReservationQuery = z.infer<typeof MaterialReservationQuerySchema>;

export const MaterialTransportLinkSchema = z.strictObject({
  actingAccountId: MercariaIdSchema,
  transportId: MercariaIdSchema,
});
export type MaterialTransportLink = z.infer<typeof MaterialTransportLinkSchema>;
