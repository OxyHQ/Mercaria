/**
 * Native store linkage (#54, ADR 0002 D4): the verified, reversible mapping
 * between a canonical merchant and an existing native `stores` row.
 *
 * ## Why there is no name-match path, structurally
 *
 * Issue #54 forbids creating this mapping from a matching name alone. That is
 * not enforced by a check on the inputs — it is enforced by there being no
 * signature through which a name could arrive: linking demands explicit ids,
 * a verification METHOD from a closed set with no name-match member, and a
 * named ACTOR. The schema then refuses a link without all three
 * (`verification_method`, `verified_by_oxy_user_id`, `verified_at` are NOT
 * NULL), so even a future caller bypassing this service cannot store an
 * unverified link.
 *
 * ## What linking changes, and what it deliberately does not
 *
 * Nothing on the native store: members, permissions, policies, inventory,
 * orders, handle and follow graph are untouched (issue linkage rule 2 /
 * acceptance 4 — pinned by the realdb test comparing the store row
 * byte-for-byte around a link). The link's row IS its audit record: method,
 * actor, time and note on creation; actor, time and reason on revocation.
 */

import type { NativeStoreLink, NativeStoreLinkMethod } from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import {
  findActiveLinkByMerchant,
  findActiveLinkByStore,
  insertNativeStoreLink,
  revokeNativeStoreLink,
  type NativeStoreLinkRow,
} from '../../db/commerce-graph/nativeStoreLinkRepository.js';
import {
  findMerchantById,
  type MerchantRow,
} from '../../db/commerce-graph/merchantRepository.js';
import { findStoreById } from '../../db/stores/storeRepository.js';
import { toMerchantDTO } from './merchant.service.js';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import { log } from '../../lib/logger.js';

/** Map a link row onto its DTO. Actor ids surface on the operator surface only. */
export function toNativeStoreLinkDTO(row: NativeStoreLinkRow): NativeStoreLink {
  return {
    id: row.id,
    merchantId: row.merchantId,
    storeId: row.storeId,
    status: row.status,
    verificationMethod: row.verificationMethod,
    verificationNote: row.verificationNote,
    verifiedAt: row.verifiedAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokeReason: row.revokeReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface LinkNativeStoreParams {
  merchantId: string;
  storeId: string;
  method: NativeStoreLinkMethod;
  note?: string;
  actorOxyUserId: string;
  /** Why this link is being made — required, logged, part of the audit trail. */
  reason: string;
}

/**
 * Create the verified link. Refusals, each a distinct answer:
 *
 *  - unknown merchant or store → 404;
 *  - a merged/suppressed merchant → 409 (link the WINNER, or nothing);
 *  - either side already actively linked → 409 naming the taken side, read
 *    back AFTER the refused insert so a concurrent racer is reported
 *    truthfully rather than as a phantom success.
 */
export async function linkNativeStore(params: LinkNativeStoreParams): Promise<NativeStoreLinkRow> {
  if (params.reason.trim() === '') {
    throw validationError('Linking a native store requires a reason.');
  }
  const db = getDb();
  const [merchant, store] = await Promise.all([
    findMerchantById(db, params.merchantId),
    findStoreById(params.storeId, db),
  ]);
  if (!merchant) throw notFound('Merchant not found');
  if (!store) throw notFound('Store not found');
  if (merchant.status !== 'active') {
    throw conflict(
      `Merchant ${params.merchantId} is ${merchant.status}; only an active merchant can be linked.`,
    );
  }

  const inserted = await insertNativeStoreLink(db, {
    merchantId: params.merchantId,
    storeId: params.storeId,
    verificationMethod: params.method,
    verificationNote: params.note,
    verifiedByOxyUserId: params.actorOxyUserId,
    verifiedAt: new Date(),
  });
  if (!inserted) {
    const [byStore, byMerchant] = await Promise.all([
      findActiveLinkByStore(db, params.storeId),
      findActiveLinkByMerchant(db, params.merchantId),
    ]);
    if (byStore) {
      throw conflict(
        `Store ${params.storeId} is already linked to merchant ${byStore.merchantId}.`,
      );
    }
    if (byMerchant) {
      throw conflict(
        `Merchant ${params.merchantId} is already linked to store ${byMerchant.storeId}.`,
      );
    }
    // Neither side is taken NOW but the insert was refused — the concurrent
    // holder was revoked in the gap. A retry is the honest answer.
    throw conflict('The link raced a concurrent change; retry.');
  }

  log.general.info(
    {
      linkId: inserted.id,
      merchantId: params.merchantId,
      storeId: params.storeId,
      method: params.method,
      actorOxyUserId: params.actorOxyUserId,
      reason: params.reason,
    },
    '[CommerceGraph] native store linked to merchant',
  );
  return inserted;
}

export interface RevokeNativeStoreLinkParams {
  linkId: string;
  actorOxyUserId: string;
  reason: string;
}

/** Reverse a link (issue linkage rule 1). The revoked row remains as history. */
export async function revokeLink(params: RevokeNativeStoreLinkParams): Promise<NativeStoreLinkRow> {
  if (params.reason.trim() === '') {
    throw validationError('Revoking a native store link requires a reason.');
  }
  const db = getDb();
  const revoked = await revokeNativeStoreLink(db, {
    linkId: params.linkId,
    revokedByOxyUserId: params.actorOxyUserId,
    revokedAt: new Date(),
    reason: params.reason,
  });
  if (!revoked) {
    throw notFound('No active native store link with that id.');
  }
  log.general.info(
    {
      linkId: revoked.id,
      merchantId: revoked.merchantId,
      storeId: revoked.storeId,
      actorOxyUserId: params.actorOxyUserId,
      reason: params.reason,
    },
    '[CommerceGraph] native store link revoked',
  );
  return revoked;
}

/**
 * Reverse lookup (issue API rule 3): which canonical merchant does a native
 * store resolve to? Public shape — the merchant DTO plus when the link was
 * verified; the link's actors stay on the operator surface.
 */
export async function findMerchantForNativeStore(storeId: string): Promise<{
  merchant: ReturnType<typeof toMerchantDTO>;
  linkedAt: string;
}> {
  const db = getDb();
  const link = await findActiveLinkByStore(db, storeId);
  if (!link) {
    throw notFound('This store is not linked to a canonical merchant.');
  }
  const merchant: MerchantRow | undefined = await findMerchantById(db, link.merchantId);
  if (!merchant || merchant.status === 'suppressed') {
    throw notFound('This store is not linked to a canonical merchant.');
  }
  return { merchant: toMerchantDTO(merchant), linkedAt: link.verifiedAt.toISOString() };
}
