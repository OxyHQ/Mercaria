import { and, eq, isNull, or } from 'drizzle-orm';
import { OxyServices } from '@oxy.so/core';
import { moovoForOxy } from '@oxy.so/moovo-sdk';
import { MaterialTransportLinkSchema, type MaterialTransportLink } from '@mercaria/contracts';
import type { StoreCaller } from '../store-access.service';
import { PublicApiError } from '../public-api/errors';
import { getDb } from '../../db/postgres';
import { materialReservations } from '../../db/schema/materials';
import { getMaterialReservation } from './materials.service';

export async function linkMaterialTransport(
  caller: StoreCaller | null,
  id: string,
  input: MaterialTransportLink,
) {
  const body = MaterialTransportLinkSchema.parse(input);
  const reservation = await getMaterialReservation(caller, id, body.actingAccountId);
  if (!caller) throw new PublicApiError('unauthorized', 'Sign in to manage transport');
  const oxy = new OxyServices({ baseURL: process.env.OXY_API_URL || 'https://api.oxy.so' });
  oxy.session.setAccessToken(caller.accessToken);
  // `@oxy.so/moovo-sdk` takes `@oxy.so/core` as a PEER, and the one hoisted copy
  // resolves it at the repository root — the Expo apps' core (pinned by
  // `@oxy.so/services`) — while the backend runs its own newer core for Oxy ADR
  // 0041. The two `OxyServices` types differ only in private members; moovo
  // calls nothing but `createLinkedClient`, which both expose alike.
  const moovo = moovoForOxy(oxy as unknown as Parameters<typeof moovoForOxy>[0], {
    apiBaseUrl: process.env.MOOVO_API_URL || 'https://api.moovo.now',
  });
  try {
    const transport = await moovo.transports.get(body.transportId, body.actingAccountId);
    if (transport.reservationId !== id)
      throw new PublicApiError('conflict', 'This transport belongs to a different reservation');
    if (reservation.moovoTransportId && reservation.moovoTransportId !== transport.id) {
      const previous = await moovo.transports.get(
        reservation.moovoTransportId,
        body.actingAccountId,
      );
      if (previous.status !== 'cancelled')
        throw new PublicApiError('conflict', 'This reservation already has transport');
    }
    const [linked] = await getDb()
      .update(materialReservations)
      .set({ moovoTransportId: transport.id, updatedAt: new Date() })
      .where(
        and(
          eq(materialReservations.id, id),
          or(
            isNull(materialReservations.moovoTransportId),
            eq(materialReservations.moovoTransportId, reservation.moovoTransportId ?? transport.id),
          ),
        ),
      )
      .returning({ id: materialReservations.id });
    if (!linked)
      throw new PublicApiError(
        'conflict',
        'The transport reference changed; refresh the reservation',
      );
  } catch (err) {
    if (err instanceof PublicApiError) throw err;
    throw new PublicApiError('service_unavailable', 'Transport could not be verified with Moovo');
  } finally {
    moovo.dispose();
    oxy.dispose();
  }
  return getMaterialReservation(caller, id, body.actingAccountId);
}
