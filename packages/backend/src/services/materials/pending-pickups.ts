import { and, desc, eq, lt, or } from 'drizzle-orm';
import { getDb } from '../../db/postgres.js';
import { materialOffers, materialReservations } from '../../db/schema/materials.js';
import { validationError } from '../../lib/errors/error-codes.js';

/** Internal catalog entry: caller authority is a live, exact-account Oxy ticket, not a fabricated user session. */
export async function listPendingMaterialPickups(
  accountId: string,
  input: { limit: number; cursor?: string },
) {
  let after: string | undefined;
  if (input.cursor) {
    try {
      const value = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
      if (value.accountId !== accountId || typeof value.id !== 'string') throw new Error();
      after = value.id;
    } catch {
      throw validationError('Invalid pickup cursor for this account');
    }
  }
  const rows = await getDb()
    .select({
      reservationId: materialReservations.id,
      offerId: materialReservations.offerId,
      donorAccountId: materialOffers.ownerAccountId,
      requesterAccountId: materialReservations.requesterAccountId,
      quantity: materialReservations.quantity,
      unit: materialOffers.unit,
      publicArea: materialOffers.publicArea,
      moovoTransportId: materialReservations.moovoTransportId,
    })
    .from(materialReservations)
    .innerJoin(materialOffers, eq(materialOffers.id, materialReservations.offerId))
    .where(
      and(
        eq(materialReservations.status, 'accepted'),
        or(
          eq(materialOffers.ownerAccountId, accountId),
          eq(materialReservations.requesterAccountId, accountId),
        ),
        after ? lt(materialReservations.id, after) : undefined,
      ),
    )
    .orderBy(desc(materialReservations.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  return {
    items: page.map((row) => ({
      ...row,
      reviewUrl: 'https://mercaria.co/materials',
      requiresHumanConfirmation: true,
    })),
    nextCursor:
      rows.length > input.limit
        ? Buffer.from(JSON.stringify({ accountId, id: page.at(-1)?.reservationId })).toString(
            'base64url',
          )
        : null,
  };
}
