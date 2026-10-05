/**
 * Stage 1 — every ACTIVE native store mints a canonical merchant and a verified
 * `native_store_links` row (ADR 0002 D23 phase 1, first clause).
 *
 * ## Why the link is `verified` and not `asserted`
 *
 * D23 says the store owner's authenticated ownership IS the evidence, "recorded
 * as such". That is a real, checkable fact held in Mercaria's own tables:
 * `stores.oxy_account_id` names the Oxy account that owns the store (ADR 0012),
 * and only an account that authenticated to this deployment — or somebody who
 * governs it — can have put a store under it. So the METHOD is `owner_authentication`
 * — the evidence — and the ACTOR is the operator who opened the run, because
 * they are who performed the linking act. Collapsing the two (recording the
 * owner as the verifier) would put a verification in somebody's name that they
 * never performed, which is the kind of claim `native_store_links`' NOT NULL
 * actor column exists to make attributable.
 *
 * The note names the owning account, so an auditor can check the evidence
 * without reconstructing the store's ownership as it was on the day of the
 * migration.
 *
 * ## What this stage deliberately does not do
 *
 * It creates NO relationship (#55), asserts NO brand, and touches NOTHING on the
 * `stores` row — not its handle, not its rating, not its owning account. #54's realdb
 * test already pins that linking leaves a store byte-identical; this stage stays
 * on the far side of that guarantee by going through
 * `CanonicalGraphWriter.linkMerchantToStore` and never opening the store table
 * for a write.
 */

import { asc, gt } from 'drizzle-orm';
import { getDb } from '../../../db/postgres.js';
import { isMercariaError } from '../../../lib/errors/error-codes.js';
import { ErrorCodes } from '../../../utils/api-response.js';
import { stores } from '../../../db/schema/stores.js';
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
  readonly oxyAccountId: string;
}

export async function runStoreMerchantsPage(context: StageContext): Promise<StagePageResult> {
  const db = getDb();
  const rows: StoreRow[] = await db
    .select({
      id: stores.id,
      handle: stores.handle,
      name: stores.name,
      status: stores.status,
      oxyAccountId: stores.oxyAccountId,
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
      note: `${CATALOG_BACKFILL_RULE_ID}: native store is owned by Oxy account ${store.oxyAccountId} in Mercaria's own records`,
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
