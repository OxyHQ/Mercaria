import type { z } from 'zod';
import {
  MaterialOfferCreateSchema,
  MaterialOfferSchema,
  MaterialOfferPageSchema,
  MaterialRequestCreateSchema,
  MaterialActionSchema,
  MaterialReservationSchema,
  MaterialReservationPageSchema,
  MaterialOfferQuerySchema,
  MaterialReservationQuerySchema,
  type MaterialOfferCreate,
  type MaterialRequestCreate,
  type MaterialAction,
  type MaterialOfferQuery,
  type MaterialReservationQuery,
} from '@mercaria/contracts';
import type { MercariaRequestOptions } from './client';
import { MercariaValidationError } from './errors';
import { request, pathSegment, type TransportConfig } from './transport';
import { iterateMercariaPages } from './pagination';

function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new MercariaValidationError('Invalid materials input');
  return parsed.data;
}
function query(schema: z.ZodType, value: Record<string, unknown>) {
  const wire = Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, String(v)]),
  );
  input(schema, wire);
  return wire;
}
/** Mutations never retry automatically. Reuse the same idempotencyKey after an uncertain response. */
export function createMaterialsApi(config: TransportConfig) {
  const listOffers = (filters: MaterialOfferQuery = {}, options: MercariaRequestOptions = {}) =>
    request(
      config,
      '/materials/offers',
      query(MaterialOfferQuerySchema, filters),
      MaterialOfferPageSchema,
      options.signal,
    );
  const listReservations = (
    filters: MaterialReservationQuery,
    options: MercariaRequestOptions = {},
  ) =>
    request(
      config,
      '/materials/reservations',
      query(MaterialReservationQuerySchema, filters),
      MaterialReservationPageSchema,
      options.signal,
    );
  const transition = (
    action: string,
    id: string,
    body: MaterialAction,
    options: MercariaRequestOptions = {},
  ) =>
    request(
      config,
      `/materials/reservations/${pathSegment(id, 'reservation id')}/${action}`,
      {},
      MaterialReservationSchema,
      options.signal,
      { body: input(MaterialActionSchema, body) },
    );
  return Object.freeze({
    listOffers,
    iterateOffers: (filters: MaterialOfferQuery = {}, options: MercariaRequestOptions = {}) =>
      iterateMercariaPages((cursor) => listOffers({ ...filters, cursor }, options)),
    getOffer: (id: string, options: MercariaRequestOptions = {}) =>
      request(
        config,
        `/materials/offers/${pathSegment(id, 'offer id')}`,
        {},
        MaterialOfferSchema,
        options.signal,
      ),
    createOffer: (body: MaterialOfferCreate, options: MercariaRequestOptions = {}) =>
      request(config, '/materials/offers', {}, MaterialOfferSchema, options.signal, {
        body: input(MaterialOfferCreateSchema, body),
      }),
    closeOffer: (id: string, body: MaterialAction, options: MercariaRequestOptions = {}) =>
      request(
        config,
        `/materials/offers/${pathSegment(id, 'offer id')}/close`,
        {},
        MaterialOfferSchema,
        options.signal,
        { body: input(MaterialActionSchema, body) },
      ),
    request: (id: string, body: MaterialRequestCreate, options: MercariaRequestOptions = {}) =>
      request(
        config,
        `/materials/offers/${pathSegment(id, 'offer id')}/requests`,
        {},
        MaterialReservationSchema,
        options.signal,
        { body: input(MaterialRequestCreateSchema, body) },
      ),
    listReservations,
    iterateReservations: (
      filters: MaterialReservationQuery,
      options: MercariaRequestOptions = {},
    ) => iterateMercariaPages((cursor) => listReservations({ ...filters, cursor }, options)),
    getReservation: (id: string, accountId: string, options: MercariaRequestOptions = {}) =>
      request(
        config,
        `/materials/reservations/${pathSegment(id, 'reservation id')}`,
        { accountId },
        MaterialReservationSchema,
        options.signal,
      ),
    accept: (id: string, body: MaterialAction, options?: MercariaRequestOptions) =>
      transition('accept', id, body, options),
    cancel: (id: string, body: MaterialAction, options?: MercariaRequestOptions) =>
      transition('cancel', id, body, options),
    confirmDelivery: (id: string, body: MaterialAction, options?: MercariaRequestOptions) =>
      transition('confirm-delivery', id, body, options),
  });
}
export type MercariaMaterialsApi = ReturnType<typeof createMaterialsApi>;
export type {
  MaterialOffer,
  MaterialOfferCreate,
  MaterialRequestCreate,
  MaterialAction,
  MaterialReservation,
  MaterialOfferQuery,
  MaterialReservationQuery,
} from '@mercaria/contracts';
