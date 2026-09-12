/**
 * The procurement orchestrator (#1016 Workstreams 6 and 8, ADR 0011 D5–D7).
 *
 * One entry point — {@link procureDigitalLine} — and everything the epic says
 * about retries, timeouts, recovery and fallback is a consequence of the order
 * the steps are in.
 *
 * ```text
 *  1. is procurement enabled at all?          (ADR 0011 D14)
 *  2. does this line already have a fulfilment?   -> done, idempotently
 *  3. is there a LIVE attempt for this line?      -> resolve THAT, never start another
 *  4. select an eligible supplier                 (pure, deterministic)
 *  5. open a purchase order                       (derived idempotency key)
 *  6. preflight                                   (authoritative, re-checks the bound)
 *  7. purchase                                    (the irreversible step)
 *  8. fetch the artifact, seal it, deliver
 *  9. on a terminal failure: fall back            (bounded, excluding what failed)
 * 10. on an AMBIGUOUS failure: stop               (nothing may be tried until recovery)
 * ```
 *
 * ## Step 3 is the one that matters, and it is enforced by an index
 *
 * `digital_purchase_orders_live_line_key` makes a second live attempt for one
 * order line unrepresentable. This module reads the live attempt first anyway,
 * because getting a clean answer is better than getting a constraint violation —
 * but the index is what makes the property true under concurrency, and the read
 * is only what makes it legible.
 *
 * ## Why an ambiguous attempt STOPS the orchestration
 *
 * A timeout means the supplier may have sold Mercaria a key. Falling back would
 * buy a second one for a customer paying for one, and the epic's fallback rule 1
 * is exactly this: *recover the ambiguous result first, prove A did not allocate,
 * and only then evaluate the next supplier*. So `procureDigitalLine` returns
 * `ambiguous` and does nothing else; {@link recoverAmbiguousPurchaseOrder} is the
 * only way out, and it asks the supplier rather than guessing.
 */

import { randomUUID } from 'node:crypto';
import {
  assertSafeMoneyAmount,
  isSecretBearingCapability,
  type DigitalFulfilmentCapability,
  type DigitalProcurementIneligibilityReason,
  type DigitalSupplyProvenance,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  findProcurementCandidates,
  type DigitalProcurementCandidate,
} from '../../db/digitalRetail/digitalProcurementOfferRepository.js';
import {
  findAttempts,
  findLivePurchaseOrderForLine,
  findPurchaseOrdersForLine,
  openPurchaseOrder,
  recordAttempt,
  recordFinalCost,
  transitionPurchaseOrder,
  type DigitalPurchaseOrderRow,
} from '../../db/digitalRetail/digitalPurchaseOrderRepository.js';
import {
  createFulfilment,
  findFulfilmentByOrderItem,
  storeArtifact,
} from '../../db/digitalRetail/digitalFulfilmentRepository.js';
import { supplierAccounts } from '../../db/schema/procurement.js';
import { eq } from 'drizzle-orm';
import { log } from '../../lib/logger.js';
import {
  adapterFailed,
  failureIsAmbiguous,
  redactProviderMessage,
  runAdapterOperation,
  type AdapterContext,
  type AdapterFailure,
  type DigitalSupplierAdapter,
} from './adapter.js';
import { resolveDigitalSupplierAdapter } from './adapter-registry.js';
import {
  rankCandidate,
  selectProcurementCandidate,
  selectionRefused,
  type RankedCandidate,
} from './selection.js';
import {
  environmentKeyResolver,
  maskedHintFor,
  sealArtifactSecret,
  type SealingKeyResolver,
} from './secrets.js';

/** What the caller knows about the order line being procured. */
export interface ProcureDigitalLineInput {
  readonly orderId: string;
  readonly orderItemId: string;
  /** `oxy:<id>` or `guest:<sessionId>` — who ends up owning the artifact. */
  readonly buyerKey: string;
  readonly canonicalVariantId: string;
  /** What the buyer sees in their library. Frozen at purchase. */
  readonly displayTitle: string;
  /** ISO-3166-1 alpha-2 — where the product must ACTIVATE. */
  readonly activationTerritory: string;
  readonly requiredCapability: DigitalFulfilmentCapability;
  /** The ceiling this line may ever pay, minor units, in `currency`. */
  readonly maxAcceptedCostAmount: number;
  readonly currency: string;
  /** Per-account fulfilment reliability, 0..1. Absent = unmeasured, not perfect. */
  readonly reliabilityByAccount?: ReadonlyMap<string, number>;
  readonly now?: Date;
  /** Injected in tests; production resolves keys from the environment. */
  readonly keyResolver?: SealingKeyResolver;
  /** How many suppliers may be tried for one line. Bounded, never unbounded. */
  readonly maxAttempts?: number;
}

/** Every way procurement can end, each with what a caller needs to act on it. */
export type ProcureDigitalLineResult =
  | { readonly status: 'disabled' }
  | { readonly status: 'already_fulfilled'; readonly fulfilmentId: string }
  | {
      readonly status: 'fulfilled';
      readonly fulfilmentId: string;
      readonly purchaseOrderId: string;
      readonly artifactId: string;
    }
  | { readonly status: 'in_flight'; readonly purchaseOrderId: string }
  | { readonly status: 'ambiguous'; readonly purchaseOrderId: string }
  | {
      readonly status: 'no_eligible_supplier';
      readonly reasons: readonly DigitalProcurementIneligibilityReason[];
    }
  | {
      readonly status: 'exhausted';
      readonly purchaseOrderIds: readonly string[];
      readonly lastFailure: AdapterFailure | null;
    };

/** The default bound on how many suppliers one order line may be tried against. */
export const DEFAULT_MAX_PROCUREMENT_ATTEMPTS = 3;

/** Fold a candidate row into the shape the pure selector ranks. */
function toRanked(
  candidate: DigitalProcurementCandidate,
  input: ProcureDigitalLineInput,
  now: Date,
): RankedCandidate {
  return rankCandidate({
    offerId: candidate.offerId,
    supplierId: candidate.supplierId,
    supplierAccountId: candidate.supplierAccountId,
    provenance: candidate.provenance,
    reliability: input.reliabilityByAccount?.get(candidate.supplierAccountId) ?? null,
    supplier: { status: candidate.supplierStatus, riskLevel: candidate.supplierRiskLevel },
    account: {
      state: candidate.accountState,
      purchaseCapabilityState:
        (candidate.purchaseCapabilityState as 'enabled' | 'paused' | 'unavailable' | null) ?? null,
    },
    terms: candidate.termsId
      ? {
          provenance: candidate.provenance as DigitalSupplyProvenance,
          agreementApprovalState: candidate.agreementApprovalState ?? 'draft',
          agreementEffectiveAt: candidate.agreementEffectiveAt,
          agreementExpiresAt: candidate.agreementExpiresAt,
          termsExpiresAt: candidate.termsExpiresAt,
          resaleRightsGranted: candidate.resaleRightsGranted ?? false,
          permittedProductClasses: candidate.permittedProductClasses ?? [],
          permittedFulfilmentCapabilities: candidate.permittedFulfilmentCapabilities ?? [],
          permittedTerritories: candidate.permittedTerritories ?? [],
          excludedBrands: candidate.excludedBrands ?? [],
          maxOrderCostAmount: candidate.maxOrderCostAmount,
          maxOrderCostCurrency: candidate.maxOrderCostCurrency,
        }
      : null,
    offer: {
      id: candidate.offerId,
      status: candidate.offerStatus,
      mappingStatus: candidate.mappingStatus,
      availability: candidate.availability,
      canonicalProductId: candidate.canonicalProductId,
      canonicalVariantId: candidate.canonicalVariantId,
      productClass: candidate.productClass,
      fulfilmentCapability: candidate.fulfilmentCapability,
      brandSlug: candidate.brandSlug,
      activationTerritories: candidate.activationTerritories,
      costAmount: candidate.costAmount,
      costCurrency: candidate.costCurrency,
      quoteTtlSeconds: candidate.quoteTtlSeconds,
      expiresAt: candidate.offerExpiresAt,
      lastConfirmedAt: candidate.lastConfirmedAt,
      expectedFulfilmentSeconds: candidate.expectedFulfilmentSeconds,
    },
    activationTerritory: input.activationTerritory,
    requiredCapability: input.requiredCapability,
    maxAcceptedCostAmount: input.maxAcceptedCostAmount,
    procurementEnabled: config.digitalRetail.procurementEnabled,
    now,
  });
}

/** The adapter context for one account, read from the account's own row. */
async function contextFor(
  supplierAccountId: string,
  db: DatabaseOrTransaction,
): Promise<{ adapter: DigitalSupplierAdapter; context: AdapterContext }> {
  const [account] = await db
    .select({
      provider: supplierAccounts.provider,
      environment: supplierAccounts.environment,
    })
    .from(supplierAccounts)
    .where(eq(supplierAccounts.id, supplierAccountId))
    .limit(1);
  if (!account) throw new Error(`supplier account ${supplierAccountId} does not exist`);
  return {
    adapter: resolveDigitalSupplierAdapter(account.provider),
    context: {
      supplierAccountId,
      environment: account.environment,
      timeoutMs: 20_000,
    },
  };
}

/** Record one adapter call and hand its result back unchanged. */
async function withAttemptLog<T>(
  purchaseOrderId: string,
  operation: Parameters<typeof recordAttempt>[0]['operation'],
  run: () => Promise<{ ok: true; value: T } | { ok: false; failure: AdapterFailure }>,
  db: DatabaseOrTransaction,
): Promise<{ ok: true; value: T } | { ok: false; failure: AdapterFailure }> {
  const startedAt = new Date();
  const result = await runAdapterOperation(run);
  const finishedAt = new Date();
  const failed = adapterFailed(result);
  await recordAttempt(
    {
      purchaseOrderId,
      operation,
      outcome: failed ? (failureIsAmbiguous(result.failure) ? 'ambiguous' : 'failed') : 'succeeded',
      errorKind: failed ? result.failure.kind : null,
      errorMessageRedacted: failed ? result.failure.messageRedacted : null,
      providerRequestId: failed
        ? (result.failure.providerRequestId ?? null)
        : ((result as { providerRequestId?: string | null }).providerRequestId ?? null),
      providerReference: null,
      startedAt,
      finishedAt,
    },
    db,
  );
  return result;
}

/**
 * Seal an artifact and deliver it, creating the buyer's durable record.
 *
 * The plaintext exists between the adapter's answer and `sealArtifactSecret`, in
 * one stack frame, and is never logged, returned or stored. A capability that
 * hands over no secret stores none — the CHECK on the table enforces the pairing
 * in both directions, so a `direct_account_activation` carrying a key is a failed
 * write rather than a key nobody should have been shown.
 */
async function deliverArtifact(
  purchaseOrder: DigitalPurchaseOrderRow,
  input: ProcureDigitalLineInput,
  adapter: DigitalSupplierAdapter,
  context: AdapterContext,
  now: Date,
  db: DatabaseOrTransaction,
): Promise<ProcureDigitalLineResult> {
  const providerOrderId = purchaseOrder.providerOrderId;
  if (!providerOrderId) {
    throw new Error(`purchase order ${purchaseOrder.id} is accepted with no provider order id`);
  }
  const fetched = await withAttemptLog(
    purchaseOrder.id,
    'fulfilment_fetch',
    () => adapter.getFulfilment(providerOrderId, context),
    db,
  );
  if (adapterFailed(fetched)) {
    // The supplier accepted and cannot hand it over yet. This is NOT a failure of
    // the order: the artifact may arrive on a later poll or callback, and moving
    // the PO to `failed` here would strand a paid, accepted purchase.
    return { status: 'in_flight', purchaseOrderId: purchaseOrder.id };
  }

  const payload = fetched.value;
  const secretBearing = isSecretBearingCapability(payload.capability);
  if (secretBearing !== (payload.secret !== null)) {
    throw new Error(
      `adapter ${adapter.provider} returned a ${payload.capability} artifact whose secret ` +
        `presence (${payload.secret !== null}) contradicts its capability`,
    );
  }

  const sealed =
    payload.secret !== null
      ? await sealArtifactSecret(
          payload.secret,
          config.digitalRetail.sealKeyReference,
          input.keyResolver ?? environmentKeyResolver(),
        )
      : null;

  const { fulfilment } = await createFulfilment(
    {
      purchaseOrderId: purchaseOrder.id,
      orderId: input.orderId,
      orderItemId: input.orderItemId,
      buyerKey: input.buyerKey,
      capability: payload.capability,
      productClass: purchaseOrder.productClass,
      canonicalVariantId: purchaseOrder.canonicalVariantId,
      displayTitle: input.displayTitle,
      platform: purchaseOrder.platform,
      activationEcosystem: purchaseOrder.activationEcosystem,
      edition: purchaseOrder.edition,
      now,
    },
    db,
  );

  const artifactId = await storeArtifact(
    {
      fulfilmentId: fulfilment.id,
      capability: payload.capability,
      source: 'supplier_api',
      sealedSecret: sealed?.sealedSecret ?? null,
      keyReference: sealed?.keyReference ?? null,
      sealAlgorithm: sealed?.sealAlgorithm ?? null,
      plaintextSha256: sealed?.plaintextSha256 ?? null,
      maskedHint: sealed ? maskedHintFor(payload.secret ?? '') : null,
      instructions: payload.instructions,
      providerArtifactId: payload.providerArtifactId,
      replacesArtifactId: null,
      incidentId: null,
      operatorOxyUserId: null,
      expiresAt: payload.expiresAt,
      now,
    },
    db,
  );

  const moved = await transitionPurchaseOrder(
    { purchaseOrderId: purchaseOrder.id, from: 'accepted', to: 'fulfilled', now },
    db,
  );
  if (moved.outcome !== 'updated') {
    // The artifact is stored and the buyer owns it; the PO moved under us. Log
    // rather than throw: undoing a delivered key is the one repair this domain
    // must never perform automatically.
    log.general.warn(
      { purchaseOrderId: purchaseOrder.id, outcome: moved.outcome },
      'digital purchase order could not be marked fulfilled after delivery',
    );
  }
  return {
    status: 'fulfilled',
    fulfilmentId: fulfilment.id,
    purchaseOrderId: purchaseOrder.id,
    artifactId,
  };
}

/**
 * Procure one digital-retail order line, end to end.
 *
 * Safe to call again with the same input: step 2 returns the existing fulfilment,
 * step 3 returns the live attempt, and the derived idempotency key converges on
 * the same purchase order rather than opening a second.
 */
export async function procureDigitalLine(
  input: ProcureDigitalLineInput,
  tx?: DatabaseOrTransaction,
): Promise<ProcureDigitalLineResult> {
  const db = tx ?? getDb();
  const now = input.now ?? new Date();
  assertSafeMoneyAmount(input.maxAcceptedCostAmount, 'digital retail procurement bound');

  if (!config.digitalRetail.procurementEnabled) return { status: 'disabled' };

  const existing = await findFulfilmentByOrderItem(input.orderItemId, db);
  if (existing) return { status: 'already_fulfilled', fulfilmentId: existing.id };

  const live = await findLivePurchaseOrderForLine(input.orderItemId, db);
  if (live) {
    if (live.status === 'ambiguous') return { status: 'ambiguous', purchaseOrderId: live.id };
    if (live.status === 'accepted') {
      const { adapter, context } = await contextFor(live.supplierAccountId, db);
      return deliverArtifact(live, input, adapter, context, now, db);
    }
    return { status: 'in_flight', purchaseOrderId: live.id };
  }

  const previous = await findPurchaseOrdersForLine(input.orderItemId, db);
  const tried = new Set(
    previous.flatMap((row) => (row.digitalProcurementOfferId ? [row.digitalProcurementOfferId] : [])),
  );
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_PROCUREMENT_ATTEMPTS;
  const purchaseOrderIds: string[] = previous.map((row) => row.id);
  let lastFailure: AdapterFailure | null = null;
  let attemptOrdinal = previous.length + 1;
  let previousPurchaseOrderId = previous.at(-1)?.id ?? null;

  const rawCandidates = await findProcurementCandidates(input.canonicalVariantId, db);
  const ranked = rawCandidates.map((candidate) => toRanked(candidate, input, now));

  while (attemptOrdinal <= maxAttempts) {
    const selection = selectProcurementCandidate(ranked, [...tried]);
    if (selectionRefused(selection)) {
      const reasons: DigitalProcurementIneligibilityReason[] = [
        ...new Set(selection.refusals.flatMap((candidate) => candidate.eligibility.reasons)),
      ].sort();
      return purchaseOrderIds.length > 0
        ? { status: 'exhausted', purchaseOrderIds, lastFailure }
        : { status: 'no_eligible_supplier', reasons };
    }

    const chosen = selection.candidate;
    tried.add(chosen.offerId);
    const source = rawCandidates.find((candidate) => candidate.offerId === chosen.offerId);
    if (!source || !source.termsId) {
      // Eligibility already refused a candidate with no rider, so reaching here
      // means the two disagree — a bug, not a supplier problem.
      throw new Error(`candidate ${chosen.offerId} passed eligibility with no supply terms`);
    }

    const { purchaseOrder, created } = await openPurchaseOrder(
      {
        orderId: input.orderId,
        orderItemId: input.orderItemId,
        attemptOrdinal,
        previousPurchaseOrderId,
        supplierId: source.supplierId,
        supplierAccountId: source.supplierAccountId,
        digitalSupplyTermsId: source.termsId,
        digitalProcurementOfferId: source.offerId,
        canonicalVariantId: source.canonicalVariantId,
        supplierSku: source.supplierSku,
        productClass: source.productClass,
        fulfilmentCapability: source.fulfilmentCapability,
        platform: source.platform,
        activationEcosystem: source.activationEcosystem,
        edition: source.edition,
        quotedCostAmount: source.costAmount,
        quotedCostCurrency: source.costCurrency,
        maxAcceptedCostAmount: input.maxAcceptedCostAmount,
        now,
      },
      db,
    );
    purchaseOrderIds.push(purchaseOrder.id);
    if (!created) {
      // Somebody else is already procuring this line. Whatever they are doing is
      // the thing that finishes it, and starting a second attempt is exactly the
      // failure the live-line index exists to prevent.
      return purchaseOrder.status === 'ambiguous'
        ? { status: 'ambiguous', purchaseOrderId: purchaseOrder.id }
        : { status: 'in_flight', purchaseOrderId: purchaseOrder.id };
    }

    const { adapter, context } = await contextFor(source.supplierAccountId, db);

    const preflight = await withAttemptLog(
      purchaseOrder.id,
      'preflight',
      () =>
        adapter.preflight(
          {
            supplierSku: source.supplierSku,
            quantity: 1,
            activationTerritory: input.activationTerritory,
            expectedCapability: input.requiredCapability,
            expectedCurrency: input.currency,
          },
          context,
        ),
      db,
    );
    if (adapterFailed(preflight)) {
      lastFailure = preflight.failure;
      await failAttempt(purchaseOrder, 'pending', preflight.failure, now, db);
      attemptOrdinal += 1;
      previousPurchaseOrderId = purchaseOrder.id;
      continue;
    }

    // The preflight is AUTHORITATIVE, so its answer is re-checked against the
    // bound and against what the customer bought. A cost that has risen above the
    // ceiling is a refusal here, not an absorption — and a capability that has
    // changed under us is a different product, which is the substitution ADR 0011
    // D9 forbids.
    if (
      preflight.value.costAmount > input.maxAcceptedCostAmount ||
      preflight.value.capability !== input.requiredCapability ||
      preflight.value.costCurrency !== input.currency ||
      preflight.value.available === 'out_of_stock' ||
      preflight.value.available === 'discontinued' ||
      !preflight.value.fundingReady
    ) {
      lastFailure = {
        kind: preflight.value.costAmount > input.maxAcceptedCostAmount ? 'price_changed' : 'out_of_stock',
        messageRedacted: 'preflight answer no longer matches what the customer bought',
      };
      await failAttempt(purchaseOrder, 'pending', lastFailure, now, db);
      attemptOrdinal += 1;
      previousPurchaseOrderId = purchaseOrder.id;
      continue;
    }

    const preflighted = await transitionPurchaseOrder(
      { purchaseOrderId: purchaseOrder.id, from: 'pending', to: 'preflighted', now },
      db,
    );
    if (preflighted.outcome !== 'updated') {
      return { status: 'in_flight', purchaseOrderId: purchaseOrder.id };
    }
    const claimed = await transitionPurchaseOrder(
      { purchaseOrderId: purchaseOrder.id, from: 'preflighted', to: 'submitting', now },
      db,
    );
    if (claimed.outcome !== 'updated') {
      // Somebody else claimed it between the two statements. Theirs is the
      // attempt that finishes; ours must not submit anything.
      return { status: 'in_flight', purchaseOrderId: purchaseOrder.id };
    }

    const purchase = await withAttemptLog(
      purchaseOrder.id,
      'purchase',
      () =>
        adapter.purchase(
          {
            idempotencyKey: purchaseOrder.idempotencyKey,
            supplierSku: source.supplierSku,
            quantity: 1,
            activationTerritory: input.activationTerritory,
            maxAcceptedCostAmount: input.maxAcceptedCostAmount,
            currency: input.currency,
          },
          context,
        ),
      db,
    );

    if (adapterFailed(purchase)) {
      lastFailure = purchase.failure;
      if (failureIsAmbiguous(purchase.failure)) {
        // STOP. The supplier may have sold us a key, and nothing may be tried for
        // this line until `recoverAmbiguousPurchaseOrder` asks them.
        await transitionPurchaseOrder(
          {
            purchaseOrderId: purchaseOrder.id,
            from: 'submitting',
            to: 'ambiguous',
            now,
            errorKind: purchase.failure.kind,
            errorMessageRedacted: purchase.failure.messageRedacted,
          },
          db,
        );
        return { status: 'ambiguous', purchaseOrderId: purchaseOrder.id };
      }
      await failAttempt(purchaseOrder, 'submitting', purchase.failure, now, db);
      attemptOrdinal += 1;
      previousPurchaseOrderId = purchaseOrder.id;
      continue;
    }

    const accepted = await acceptPurchase(purchaseOrder, purchase.value, now, db);
    if (!accepted) {
      lastFailure = {
        kind: 'provider_rejected',
        messageRedacted: 'supplier did not accept the order',
      };
      attemptOrdinal += 1;
      previousPurchaseOrderId = purchaseOrder.id;
      continue;
    }
    return deliverArtifact(accepted, input, adapter, context, now, db);
  }

  return { status: 'exhausted', purchaseOrderIds, lastFailure };
}

/** Move a failed attempt to its terminal state, recording the normalized reason. */
async function failAttempt(
  purchaseOrder: DigitalPurchaseOrderRow,
  from: 'pending' | 'submitting',
  failure: AdapterFailure,
  now: Date,
  db: DatabaseOrTransaction,
): Promise<void> {
  // `rejected` when the supplier ANSWERED and the answer was no; `failed` when
  // the call did not produce an answer at all. The distinction is what an
  // operator reads to tell "they will not sell us this" from "our integration is
  // broken", and it is the reason the error taxonomy is closed.
  const answered =
    failure.kind === 'out_of_stock' ||
    failure.kind === 'price_changed' ||
    failure.kind === 'sku_unknown' ||
    failure.kind === 'region_not_served' ||
    failure.kind === 'rights_restricted' ||
    failure.kind === 'provider_rejected';
  const moved = await transitionPurchaseOrder(
    {
      purchaseOrderId: purchaseOrder.id,
      from,
      to: answered ? 'rejected' : 'failed',
      now,
      errorKind: failure.kind,
      errorMessageRedacted: failure.messageRedacted,
    },
    db,
  );
  if (moved.outcome !== 'updated') {
    // A refused transition here is not cosmetic: the attempt stays non-terminal,
    // and the partial unique over the live statuses then blocks that order line
    // FOREVER. Loud, because the remedy is a code change rather than a retry.
    log.general.warn(
      { purchaseOrderId: purchaseOrder.id, from, outcome: moved.outcome, kind: failure.kind },
      'digital purchase order could not be moved to a terminal state after a failure',
    );
  }
}

/** Record an acceptance and its final cost, returning the moved row. */
async function acceptPurchase(
  purchaseOrder: DigitalPurchaseOrderRow,
  response: { providerOrderId: string; accepted: boolean; finalCostAmount: number | null; finalCostCurrency: string | null },
  now: Date,
  db: DatabaseOrTransaction,
): Promise<DigitalPurchaseOrderRow | null> {
  if (!response.accepted) {
    await transitionPurchaseOrder(
      {
        purchaseOrderId: purchaseOrder.id,
        from: 'submitting',
        to: 'rejected',
        now,
        errorKind: 'provider_rejected',
        errorMessageRedacted: 'supplier did not accept the order',
      },
      db,
    );
    return null;
  }
  const moved = await transitionPurchaseOrder(
    {
      purchaseOrderId: purchaseOrder.id,
      from: 'submitting',
      to: 'accepted',
      now,
      providerOrderId: response.providerOrderId,
    },
    db,
  );
  if (moved.outcome !== 'updated' || !moved.purchaseOrder) return null;
  if (response.finalCostAmount !== null && response.finalCostCurrency !== null) {
    await recordFinalCost(
      purchaseOrder.id,
      response.finalCostAmount,
      response.finalCostCurrency,
      now,
      db,
    );
  }
  return moved.purchaseOrder;
}

/** What a recovery established. Each one leaves the line in a different place. */
export type RecoveryOutcome =
  | { readonly resolved: 'accepted'; readonly purchaseOrderId: string }
  | { readonly resolved: 'nothing_bought'; readonly purchaseOrderId: string }
  | { readonly resolved: 'still_unknown'; readonly purchaseOrderId: string };

/**
 * Ask the supplier what actually happened to an ambiguous attempt (ADR 0011 D5).
 *
 * The ONLY way out of `ambiguous`, and it never guesses:
 *
 *  - the supplier HAS the order  → the attempt rejoins the machine at `accepted`,
 *    and its artifact is fetched from provider truth;
 *  - the supplier has NO record  → nothing was bought, the attempt is `failed`,
 *    and the line is free for a fallback;
 *  - the recovery call itself fails → still unknown, and the attempt stays
 *    `ambiguous`. Nothing is tried. A sweep retries later.
 *
 * The third branch is the one a naive implementation gets wrong by treating a
 * failed recovery as "nothing was bought", which is exactly the assumption that
 * buys a second key.
 */
export async function recoverAmbiguousPurchaseOrder(
  purchaseOrder: DigitalPurchaseOrderRow,
  now: Date = new Date(),
  tx?: DatabaseOrTransaction,
): Promise<RecoveryOutcome> {
  const db = tx ?? getDb();
  if (purchaseOrder.status !== 'ambiguous') {
    throw new Error(`purchase order ${purchaseOrder.id} is ${purchaseOrder.status}, not ambiguous`);
  }
  const { adapter, context } = await contextFor(purchaseOrder.supplierAccountId, db);
  const recovery = await withAttemptLog(
    purchaseOrder.id,
    'purchase_recovery',
    () => adapter.recoverPurchase(purchaseOrder.idempotencyKey, context),
    db,
  );
  if (adapterFailed(recovery)) {
    return { resolved: 'still_unknown', purchaseOrderId: purchaseOrder.id };
  }
  if (!recovery.value.found) {
    await transitionPurchaseOrder(
      {
        purchaseOrderId: purchaseOrder.id,
        from: 'ambiguous',
        to: 'failed',
        now,
        errorKind: purchaseOrder.errorKind ?? 'timeout',
        errorMessageRedacted: 'recovered: the supplier has no record of this order',
      },
      db,
    );
    return { resolved: 'nothing_bought', purchaseOrderId: purchaseOrder.id };
  }
  const moved = await transitionPurchaseOrder(
    {
      purchaseOrderId: purchaseOrder.id,
      from: 'ambiguous',
      to: 'accepted',
      now,
      providerOrderId: recovery.value.purchase.providerOrderId,
    },
    db,
  );
  if (moved.outcome !== 'updated') {
    return { resolved: 'still_unknown', purchaseOrderId: purchaseOrder.id };
  }
  const { finalCostAmount, finalCostCurrency } = recovery.value.purchase;
  if (finalCostAmount !== null && finalCostCurrency !== null) {
    await recordFinalCost(purchaseOrder.id, finalCostAmount, finalCostCurrency, now, db);
  }
  return { resolved: 'accepted', purchaseOrderId: purchaseOrder.id };
}

/**
 * A correlation id for one procurement run, for the log lines only.
 *
 * Deliberately NOT the idempotency key: that key is sent to a supplier and
 * appears in their system, and a log correlation that doubled as a provider-side
 * identifier would tempt somebody to reconstruct one from the other.
 */
export function procurementRunId(): string {
  return `dpr_${randomUUID()}`;
}

/** Every adapter call made for one attempt — the support view's own read. */
export const purchaseOrderAttempts = findAttempts;

/** Redaction, re-exported so an adapter author has one obvious place to find it. */
export { redactProviderMessage };
