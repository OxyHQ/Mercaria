/**
 * Stage 1 — every ACTIVE native store mints a canonical merchant and a verified
 * `native_store_links` row (ADR 0002 D23 phase 1, first clause).
 *
 * ## Why the link is `verified` and not `asserted`
 *
 * D23 says the store owner's authenticated ownership IS the evidence, "recorded
 * as such". That is a real, checkable fact held in Mercaria's own tables: a
 * `store_members` row with role `owner` names an Oxy account that authenticated
 * to this deployment and holds the store. So the METHOD is `owner_authentication`
 * — the evidence — and the ACTOR is the operator who opened the run, because
 * they are who performed the linking act. Collapsing the two (recording the
 * owner as the verifier) would put a verification in somebody's name that they
 * never performed, which is the kind of claim `native_store_links`' NOT NULL
 * actor column exists to make attributable.
 *
 * The note names the owner account, so an auditor can check the evidence without
 * reconstructing the store's membership as it was on the day of the migration.
 *
 * ## What this stage deliberately does not do
 *
 * It creates NO relationship (#55), asserts NO brand, and touches NOTHING on the
 * `stores` row — not its handle, not its rating, not its members. #54's realdb
 * test already pins that linking leaves a store byte-identical; this stage stays
 * on the far side of that guarantee by going through
 * `CanonicalGraphWriter.linkMerchantToStore` and never opening the store table
 * for a write.
 */

import { and, asc, eq, gt } from 'drizzle-orm';
import { getDb } from '../../../db/postgres.js';
import { isMercariaError } from '../../../lib/errors/error-codes.js';
import { ErrorCodes } from '../../../utils/api-response.js';
import { stores, storeMembers } from '../../../db/schema/stores.js';
import { findActiveLinkByStore } from '../../../db/commerce-graph/nativeStoreLinkRepository.js';
import {
  examineSubject,
  nextKeysetCursor,
  type StageContext,
  type StagePageResult,
  type SubjectVerdict,
} from '../stage-context.js';
import { addCounters, EMPTY_COUNTERS } from '../../../db/backfill/backfillRunRepository.js';
import { CATALOG_BACKFILL_RULE_ID } from '../mapping-version.js';

/** One store, reduced to what the stage decides on. */
interface StoreRow {
  readonly id: string;
  readonly handle: string;
  readonly name: string;
  readonly status: string;
}

/**
 * The store's owning Oxy account, if it has one.
 *
 * A store with no `owner` member is possible in principle (every member removed
 * but the store row left behind), and this stage treats it as evidence it does
 * not have: without an authenticated owner there is nothing
 * `owner_authentication` could be naming, so the store is skipped rather than
 * linked on weaker grounds.
 */
async function findStoreOwner(storeId: string): Promise<string | undefined> {
  const rows = await getDb()
    .select({ oxyUserId: storeMembers.oxyUserId })
    .from(storeMembers)
    .where(and(eq(storeMembers.storeId, storeId), eq(storeMembers.role, 'owner')))
    .orderBy(asc(storeMembers.joinedAt))
    .limit(1);
  return rows[0]?.oxyUserId;
}

export async function runStoreMerchantsPage(context: StageContext): Promise<StagePageResult> {
  const db = getDb();
  const rows: StoreRow[] = await db
    .select({
      id: stores.id,
      handle: stores.handle,
      name: stores.name,
      status: stores.status,
    })
    .from(stores)
    .where(context.cursor === null ? undefined : gt(stores.id, context.cursor))
    .orderBy(asc(stores.id))
    .limit(context.limit);

  let counters = EMPTY_COUNTERS;
  for (const store of rows) {
    counters = addCounters(
      counters,
      await examineSubject(context, { kind: 'store', storeId: store.id }, () =>
        decideStore(context, store),
      ),
    );
  }

  return { counters, nextCursor: nextKeysetCursor(rows, context.limit) };
}

async function decideStore(context: StageContext, store: StoreRow): Promise<SubjectVerdict> {
  if (store.status !== 'active') {
    return { reasonCode: 'store_not_active', detail: `store status is '${store.status}'` };
  }

  const existing = await findActiveLinkByStore(getDb(), store.id);
  if (existing) {
    return {
      reasonCode: 'store_already_linked',
      detail: `merchant ${existing.merchantId}`,
    };
  }

  const ownerOxyUserId = await findStoreOwner(store.id);
  if (ownerOxyUserId === undefined) {
    // No `owner` member means there is no authenticated ownership for
    // `owner_authentication` to be naming. Linking anyway would record evidence
    // that does not exist, so the store waits for an operator instead.
    return {
      reasonCode: 'store_owner_unresolved',
      detail: 'no store member with role owner to evidence owner authentication',
    };
  }

  const merchant = await context.writer.createMerchantForStore({
    name: store.name,
    storeHandle: store.handle,
    actorOxyUserId: context.actorOxyUserId,
  });

  try {
    const link = await context.writer.linkMerchantToStore({
      merchantId: merchant.id,
      storeId: store.id,
      method: 'owner_authentication',
      note: `${CATALOG_BACKFILL_RULE_ID}: native store owner ${ownerOxyUserId} is authenticated in Mercaria's own membership records`,
      actorOxyUserId: context.actorOxyUserId,
      reason: `${CATALOG_BACKFILL_RULE_ID} store_merchants stage`,
    });
    return {
      reasonCode: 'merchant_minted',
      detail: `merchant ${merchant.id}, link ${link.id}`,
    };
  } catch (error: unknown) {
    if (!isMercariaError(error) || error.code !== ErrorCodes.CONFLICT) throw error;
    /**
     * Somebody linked this store between the read above and this write.
     *
     * The mint that preceded it is now an unclaimed merchant with no storefront
     * and no link — harmless, and NAMED in the detail so an operator can retire
     * it rather than discovering it later with no explanation. The window is
     * narrow by construction (the run's open-key partial unique plus the page
     * lease mean two backfill pages cannot race each other over one store), so
     * the realistic cause is an operator linking by hand mid-migration, which is
     * exactly the case worth reporting rather than swallowing.
     */
    return {
      reasonCode: 'store_link_conflict',
      detail: `${error.message} — merchant ${merchant.id} was minted and is unlinked`,
    };
  }
}
