/**
 * Who may read one merchant's demand analytics (#86 privacy 3 and 6).
 *
 * ## Two routes in, ONE reason code out
 *
 * A caller is admitted if they are the merchant's CLAIMANT — `claim_state =
 * 'claimed'` plus `claimed_by_oxy_user_id`, ADR 0002 D9's one stored verdict, or if they are a member of the native store an active
 * `native_store_links` row ties to the merchant AND hold `analytics:read`.
 * Both are needed and neither subsumes the other: an affiliate merchant that
 * claimed itself has no native store, and a native store has members other than
 * whoever completed the claim.
 *
 * Every refusal is the SAME 404 under the same reason code
 * (`MERCHANT_DEMAND_REFUSAL_REASON`). An unclaimed merchant, a pending claim, a
 * revoked one, a store membership without the permission and a caller who is
 * simply somebody else are indistinguishable — a refusal that varied would let
 * anybody enumerate which merchants have been claimed and by roughly whom, one
 * request at a time. That is #86's "a refusal spanning several conditions gets
 * ONE reason code" and it is why this function returns a union with no detail on
 * the refused branch.
 *
 * ## Revocation removes access with no sweep
 *
 * Both routes read a LIVE verdict — `merchants.claim_state` and the link's
 * `status` — so revoking a claim or a link removes this surface in the statement
 * that revokes it. Nothing here is cached and nothing is stored.
 */

import { and, eq } from 'drizzle-orm';
import { MERCHANT_DEMAND_REFUSAL_REASON } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { merchants, nativeStoreLinks } from '../../db/schema/merchants.js';
import { findStoreById } from '../../db/stores/storeRepository.js';
import { effectivePermissions } from '../../middleware/store-authz.js';

/**
 * The verdict. A STRING discriminant, not `granted: true | false` — this
 * backend compiles without `strictNullChecks` and does not narrow a union on a
 * boolean-literal discriminant (#68's finding).
 */
export type MerchantDemandAccess =
  | {
      readonly outcome: 'granted';
      /** How the caller got in. For the audit line, never for the response. */
      readonly via: 'claimant' | 'linked_store_member';
      readonly merchantId: string;
      readonly merchantName: string;
      /** The native store behind the merchant, when there is a live link. */
      readonly nativeStoreId?: string;
    }
  | { readonly outcome: 'refused'; readonly reason: typeof MERCHANT_DEMAND_REFUSAL_REASON };

/** The one refusal, built in one place so no caller can invent a second. */
const REFUSED: MerchantDemandAccess = {
  outcome: 'refused',
  reason: MERCHANT_DEMAND_REFUSAL_REASON,
};

/** May this Oxy account read this merchant's demand analytics? */
export async function resolveMerchantDemandAccess(
  input: { readonly merchantId: string; readonly oxyUserId: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<MerchantDemandAccess> {
  const merchantRows = await db
    .select({
      id: merchants.id,
      name: merchants.name,
      claimState: merchants.claimState,
      claimedByOxyUserId: merchants.claimedByOxyUserId,
    })
    .from(merchants)
    .where(eq(merchants.id, input.merchantId))
    .limit(1);
  const merchant = merchantRows[0];
  if (merchant === undefined) return REFUSED;

  const linkRows = await db
    .select({ storeId: nativeStoreLinks.storeId })
    .from(nativeStoreLinks)
    .where(
      and(
        eq(nativeStoreLinks.merchantId, input.merchantId),
        eq(nativeStoreLinks.status, 'active'),
      ),
    )
    .limit(1);
  const nativeStoreId = linkRows[0]?.storeId;

  if (
    merchant.claimState === 'claimed' &&
    merchant.claimedByOxyUserId === input.oxyUserId
  ) {
    return {
      outcome: 'granted',
      via: 'claimant',
      merchantId: merchant.id,
      merchantName: merchant.name,
      ...(nativeStoreId === undefined ? {} : { nativeStoreId }),
    };
  }

  if (nativeStoreId !== undefined) {
    const store = await findStoreById(nativeStoreId);
    const membership = store?.members.find((member) => member.oxyUserId === input.oxyUserId);
    // The permission is checked against the EFFECTIVE set — role defaults union
    // explicit grants — so a store that wants a staff member to see demand
    // grants `analytics:read` explicitly, which is what "explicit analytics
    // permission" means for a role that does not hold it by default.
    if (membership !== undefined && effectivePermissions(membership).has('analytics:read')) {
      return {
        outcome: 'granted',
        via: 'linked_store_member',
        merchantId: merchant.id,
        merchantName: merchant.name,
        nativeStoreId,
      };
    }
  }

  return REFUSED;
}
