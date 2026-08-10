/**
 * The buyer's own surface: creating, listing, editing, pausing and deleting an
 * alert, and SUGGESTING a target without creating one (#79 §"UX").
 *
 * ## Every read and every write is scoped to its owner in the STATEMENT
 *
 * There is no function here that takes an alert id alone. An id belonging to
 * somebody else is a 404 rather than a 403, because the id is opaque and a
 * distinguishable answer confirms that a stranger's alert exists — #80's
 * `findProductSaveByIdForOwner`, same reasoning, and the repository has no
 * owner-less read for a service bug to reach.
 *
 * ## The suggestion creates NOTHING (UX rule 2)
 *
 * `suggestPriceAlertTarget` runs the same comparison an evaluation would and
 * returns what it found. It writes no row, enqueues no evaluation and returns no
 * alert id — "suggest a target from current price WITHOUT silently creating it"
 * is the absence of a write, which is the only form of that promise a reader can
 * check.
 *
 * ## Creating one asks for an evaluation immediately
 *
 * Otherwise a buyer who sets an alert on an already-cheap product waits until
 * the next time a seller happens to change a price. The enqueue is the ordinary
 * convergence, so a hundred buyers creating alerts on one product in a minute
 * still owe one evaluation.
 */

import type {
  ConditionGroup,
  CurrencyCode,
  Money,
  PriceAlert,
  PriceAlertAvailabilityRequirement,
  PriceAlertComparisonBasis,
  PriceAlertRepeatPolicy,
  PriceAlertSellerScope,
  PriceAlertSplitResolution,
  PriceAlertState,
} from '@mercaria/shared-types';
import { assertSafeMoneyAmount, isSupportedTimeZone } from '@mercaria/shared-types';
import { eq, inArray } from 'drizzle-orm';
import { config } from '../../config/index.js';
import { getDb } from '../../db/postgres.js';
import { canonicalProducts, canonicalVariants } from '../../db/schema/canonicalCatalog.js';
import { catalogSplitJobs } from '../../db/schema/curation.js';
import {
  clearPriceAlertAmbiguity,
  countPriceAlertsCreatedSince,
  countPriceAlertsForOwner,
  findPriceAlertForOwner,
  insertPriceAlert,
  listPriceAlertsForOwner,
  softDeletePriceAlertForOwner,
  updatePriceAlertForOwner,
  type PriceAlertRow,
} from '../../db/priceAlerts/priceAlertRepository.js';
import { requestPriceAlertEvaluationForProduct } from '../../db/priceAlerts/priceAlertEvaluationRepository.js';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import { buildAlertComparison } from './evaluation.service.js';
import { toPriceAlertDTO } from './projection.js';

/** What a buyer states when they create an alert. Validated before anything else. */
export interface CreatePriceAlertInput {
  readonly oxyUserId: string;
  readonly canonicalProductId: string;
  readonly canonicalVariantId?: string;
  readonly target: Money;
  readonly basis: PriceAlertComparisonBasis;
  readonly conditionGroups?: readonly ConditionGroup[];
  readonly market?: string;
  readonly sellerScope?: PriceAlertSellerScope;
  readonly merchantId?: string;
  readonly storefrontId?: string;
  readonly availabilityRequirement?: PriceAlertAvailabilityRequirement;
  readonly minimumAvailableQuantity?: number;
  readonly requirePickupAvailable?: boolean;
  readonly repeatPolicy?: PriceAlertRepeatPolicy;
  readonly resetThreshold?: Money;
  readonly cooldownSeconds?: number;
  readonly quietHours?: { startMinute: number; endMinute: number; timeZone: string };
  readonly locale?: string;
  readonly emailOptIn?: boolean;
}

/**
 * The split jobs an alert names → the product each one MINTED.
 *
 * Read live rather than trusted from the alert's own snapshot, because a split
 * that had not reached its `mint` phase when the alert was marked has a target
 * now — and asking a buyer to choose between a product and nothing is the one
 * shape the ambiguity prompt must not take.
 */
async function readSplitTargets(rows: readonly PriceAlertRow[]): Promise<Map<string, string | null>> {
  const jobIds = [...new Set(rows.flatMap((row) => (row.splitJobId ? [row.splitJobId] : [])))];
  if (jobIds.length === 0) return new Map();
  const jobs = await getDb()
    .select({ id: catalogSplitJobs.id, targetEntityId: catalogSplitJobs.targetEntityId })
    .from(catalogSplitJobs)
    .where(inArray(catalogSplitJobs.id, jobIds));
  return new Map(jobs.map((job) => [job.id, job.targetEntityId]));
}

/** Refuse what a CHECK would refuse, with a sentence instead of a `23514`. */
function assertRepeatPolicyShape(input: {
  readonly repeatPolicy: PriceAlertRepeatPolicy;
  readonly target: Money;
  readonly resetThreshold?: Money;
  readonly cooldownSeconds?: number;
}): void {
  if (input.repeatPolicy === 'reset_threshold') {
    if (input.resetThreshold === undefined) {
      throw validationError('A reset_threshold alert needs a resetThreshold.');
    }
    if (input.resetThreshold.currency !== input.target.currency) {
      throw validationError('The reset threshold must be in the same currency as the target.');
    }
    if (input.resetThreshold.amount <= input.target.amount) {
      // A threshold at or below the target could never be crossed by a price
      // that was under the target, so the alert would fire once and never
      // again — `once` under another name, and the CHECK refuses it too.
      throw validationError('The reset threshold must be above the target amount.');
    }
  } else if (input.resetThreshold !== undefined) {
    throw validationError('A resetThreshold applies only to a reset_threshold alert.');
  }

  if (input.repeatPolicy === 'cooldown_better_low') {
    if (input.cooldownSeconds === undefined) {
      throw validationError('A cooldown_better_low alert needs a cooldownSeconds.');
    }
  } else if (input.cooldownSeconds !== undefined) {
    throw validationError('A cooldownSeconds applies only to a cooldown_better_low alert.');
  }
}

/** A zone the RUNTIME can evaluate, never a fixed list somebody has to maintain. */
function assertQuietHours(quietHours?: { timeZone: string }): void {
  if (quietHours === undefined) return;
  if (!isSupportedTimeZone(quietHours.timeZone)) {
    throw validationError('Unknown time zone.');
  }
}

/** Create one alert. */
export async function createPriceAlert(input: CreatePriceAlertInput): Promise<PriceAlert> {
  assertSafeMoneyAmount(input.target.amount, 'priceAlert.target');
  if (input.target.amount <= 0) throw validationError('The target must be a positive amount.');
  if (input.resetThreshold) {
    assertSafeMoneyAmount(input.resetThreshold.amount, 'priceAlert.resetThreshold');
  }
  const repeatPolicy = input.repeatPolicy ?? 'once';
  assertRepeatPolicyShape({
    repeatPolicy,
    target: input.target,
    ...(input.resetThreshold ? { resetThreshold: input.resetThreshold } : {}),
    ...(input.cooldownSeconds === undefined ? {} : { cooldownSeconds: input.cooldownSeconds }),
  });
  assertQuietHours(input.quietHours);

  const db = getDb();
  const product = await db
    .select({ id: canonicalProducts.id, status: canonicalProducts.status })
    .from(canonicalProducts)
    .where(eq(canonicalProducts.id, input.canonicalProductId))
    .limit(1);
  const found = product[0];
  if (!found) throw notFound('No such product.');
  if (found.status === 'merged') {
    // A tombstone is a dead identity; an alert on one would never be evaluated
    // because every offer moved to the winner. The remedy is to alert on the
    // winner, which the redirect the merge left behind already resolves.
    throw validationError('That product has been merged; alert on the product it merged into.');
  }

  if (input.canonicalVariantId) {
    const variant = await db
      .select({ productId: canonicalVariants.productId })
      .from(canonicalVariants)
      .where(eq(canonicalVariants.id, input.canonicalVariantId))
      .limit(1);
    if (variant[0]?.productId !== input.canonicalProductId) {
      throw validationError('That variant does not belong to that product.');
    }
  }

  // Issue abuse rule 1: both axes, both durable, both counted in Postgres —
  // "how many alerts does this ACCOUNT hold, across every ECS task" is not a
  // question an in-process limiter can answer (#83's device).
  const active = await countPriceAlertsForOwner(input.oxyUserId, db);
  if (active >= config.priceAlerts.maxActivePerUser) {
    throw conflict(
      `You already have ${config.priceAlerts.maxActivePerUser} price alerts. Delete one to add another.`,
    );
  }
  const since = new Date(Date.now() - config.priceAlerts.createRateWindowMs);
  const recent = await countPriceAlertsCreatedSince(input.oxyUserId, since, db);
  if (recent >= config.priceAlerts.createRateLimit) {
    throw conflict('You have created a lot of price alerts recently. Try again later.');
  }

  const row = await insertPriceAlert(
    {
      oxyUserId: input.oxyUserId,
      canonicalProductId: input.canonicalProductId,
      canonicalVariantId: input.canonicalVariantId ?? null,
      targetAmount: input.target.amount,
      targetCurrency: input.target.currency,
      basis: input.basis,
      conditionGroups: input.conditionGroups ?? [],
      market: input.market ?? null,
      sellerScope: input.sellerScope ?? 'any',
      // The only value the API offers — see `PriceAlertProximityScope`, and the
      // route schema, which refuses the other one by NAME.
      proximityScope: 'any',
      merchantId: input.merchantId ?? null,
      storefrontId: input.storefrontId ?? null,
      availabilityRequirement: input.availabilityRequirement ?? 'any',
      minimumAvailableQuantity: input.minimumAvailableQuantity ?? null,
      requirePickupAvailable: input.requirePickupAvailable ?? false,
      repeatPolicy,
      resetThresholdAmount: input.resetThreshold?.amount ?? null,
      cooldownSeconds: input.cooldownSeconds ?? null,
      quietHoursStartMinute: input.quietHours?.startMinute ?? null,
      quietHoursEndMinute: input.quietHours?.endMinute ?? null,
      quietHoursTimeZone: input.quietHours?.timeZone ?? null,
      locale: input.locale ?? null,
      emailOptIn: input.emailOptIn ?? false,
    },
    db,
  );

  await requestPriceAlertEvaluationForProduct(input.canonicalProductId, db);
  return toPriceAlertDTO(row);
}

/** A buyer's own alerts, newest first. */
export async function listPriceAlerts(input: {
  readonly oxyUserId: string;
  readonly canonicalProductId?: string;
  readonly limit: number;
  readonly offset?: number;
}): Promise<PriceAlert[]> {
  const rows = await listPriceAlertsForOwner(input);
  const splitTargets = await readSplitTargets(rows);
  return rows.map((row) => toPriceAlertDTO(row, splitTargets));
}

/** One alert, scoped to its owner. */
export async function getPriceAlert(id: string, oxyUserId: string): Promise<PriceAlert> {
  const row = await findPriceAlertForOwner(id, oxyUserId);
  if (!row) throw notFound('No such price alert.');
  const splitTargets = await readSplitTargets([row]);
  return toPriceAlertDTO(row, splitTargets);
}

/** What a buyer may change. `state` covers issue notification 8's one-tap pause. */
export interface UpdatePriceAlertInput {
  readonly target?: Money;
  readonly basis?: PriceAlertComparisonBasis;
  readonly conditionGroups?: readonly ConditionGroup[];
  readonly market?: string | null;
  readonly sellerScope?: PriceAlertSellerScope;
  readonly merchantId?: string | null;
  readonly storefrontId?: string | null;
  readonly availabilityRequirement?: PriceAlertAvailabilityRequirement;
  readonly minimumAvailableQuantity?: number | null;
  readonly requirePickupAvailable?: boolean;
  readonly repeatPolicy?: PriceAlertRepeatPolicy;
  readonly resetThreshold?: Money | null;
  readonly cooldownSeconds?: number | null;
  readonly quietHours?: { startMinute: number; endMinute: number; timeZone: string } | null;
  readonly locale?: string | null;
  readonly emailOptIn?: boolean;
  readonly state?: Extract<PriceAlertState, 'enabled' | 'paused'>;
}

/**
 * Apply a buyer's edit.
 *
 * The repeat-policy shape is re-checked against the MERGED alert rather than
 * against the patch, because a patch that changes only the policy has to satisfy
 * the CHECK using values already on the row — and a patch that changes only the
 * target has to keep satisfying "the reset threshold is above the target".
 *
 * Re-enabling asks for an evaluation, for the reason creating one does: a buyer
 * un-pausing an alert on a product that got cheap while it was paused should be
 * told, not made to wait for the next seller to move a price.
 */
export async function updatePriceAlert(
  id: string,
  oxyUserId: string,
  patch: UpdatePriceAlertInput,
): Promise<PriceAlert> {
  const existing = await findPriceAlertForOwner(id, oxyUserId);
  if (!existing) throw notFound('No such price alert.');
  if (existing.resolutionState === 'ambiguous_after_split') {
    throw conflict(
      'That product was split. Choose which product you meant before editing this alert.',
    );
  }

  const target = patch.target ?? { amount: existing.targetAmount, currency: existing.targetCurrency };
  assertSafeMoneyAmount(target.amount, 'priceAlert.target');
  if (target.amount <= 0) throw validationError('The target must be a positive amount.');

  const repeatPolicy = patch.repeatPolicy ?? existing.repeatPolicy;
  const resetThreshold =
    patch.resetThreshold === undefined
      ? existing.resetThresholdAmount === null
        ? undefined
        : { amount: existing.resetThresholdAmount, currency: existing.targetCurrency }
      : (patch.resetThreshold ?? undefined);
  const cooldownSeconds =
    patch.cooldownSeconds === undefined
      ? (existing.cooldownSeconds ?? undefined)
      : (patch.cooldownSeconds ?? undefined);
  assertRepeatPolicyShape({
    repeatPolicy,
    target,
    ...(resetThreshold ? { resetThreshold } : {}),
    ...(cooldownSeconds === undefined ? {} : { cooldownSeconds }),
  });
  if (patch.quietHours) assertQuietHours(patch.quietHours);

  const row = await updatePriceAlertForOwner(id, oxyUserId, {
    ...(patch.target ? { targetAmount: target.amount, targetCurrency: target.currency } : {}),
    ...(patch.basis === undefined ? {} : { basis: patch.basis }),
    ...(patch.conditionGroups === undefined ? {} : { conditionGroups: patch.conditionGroups }),
    ...(patch.market === undefined ? {} : { market: patch.market }),
    ...(patch.sellerScope === undefined ? {} : { sellerScope: patch.sellerScope }),
    ...(patch.merchantId === undefined ? {} : { merchantId: patch.merchantId }),
    ...(patch.storefrontId === undefined ? {} : { storefrontId: patch.storefrontId }),
    ...(patch.availabilityRequirement === undefined
      ? {}
      : { availabilityRequirement: patch.availabilityRequirement }),
    ...(patch.minimumAvailableQuantity === undefined
      ? {}
      : { minimumAvailableQuantity: patch.minimumAvailableQuantity }),
    ...(patch.requirePickupAvailable === undefined
      ? {}
      : { requirePickupAvailable: patch.requirePickupAvailable }),
    ...(patch.repeatPolicy === undefined ? {} : { repeatPolicy: patch.repeatPolicy }),
    ...(patch.resetThreshold === undefined
      ? {}
      : { resetThresholdAmount: patch.resetThreshold?.amount ?? null }),
    ...(patch.cooldownSeconds === undefined ? {} : { cooldownSeconds: patch.cooldownSeconds }),
    ...(patch.quietHours === undefined
      ? {}
      : {
          quietHoursStartMinute: patch.quietHours?.startMinute ?? null,
          quietHoursEndMinute: patch.quietHours?.endMinute ?? null,
          quietHoursTimeZone: patch.quietHours?.timeZone ?? null,
        }),
    ...(patch.locale === undefined ? {} : { locale: patch.locale }),
    ...(patch.emailOptIn === undefined ? {} : { emailOptIn: patch.emailOptIn }),
    ...(patch.state === undefined ? {} : { state: patch.state }),
  });
  if (!row) throw notFound('No such price alert.');

  if (patch.state === 'enabled' || patch.target !== undefined) {
    await requestPriceAlertEvaluationForProduct(row.canonicalProductId);
  }
  return toPriceAlertDTO(row);
}

/** Delete one — a state, and a repeat converges rather than 404ing. */
export async function deletePriceAlert(id: string, oxyUserId: string): Promise<void> {
  await softDeletePriceAlertForOwner(id, oxyUserId);
}

/** Answer a split ambiguity (#59 split invariant 3, #80's three-way choice). */
export async function resolvePriceAlertSplit(input: {
  readonly id: string;
  readonly oxyUserId: string;
  readonly resolution: PriceAlertSplitResolution;
}): Promise<PriceAlert> {
  const existing = await findPriceAlertForOwner(input.id, input.oxyUserId);
  if (!existing) throw notFound('No such price alert.');
  if (existing.resolutionState !== 'ambiguous_after_split' || !existing.splitJobId) {
    throw conflict('That alert is not waiting on a split decision.');
  }

  const jobs = await getDb()
    .select({ targetEntityId: catalogSplitJobs.targetEntityId })
    .from(catalogSplitJobs)
    .where(eq(catalogSplitJobs.id, existing.splitJobId))
    .limit(1);
  const targetId = jobs[0]?.targetEntityId ?? existing.splitTargetCanonicalProductId;

  if (input.resolution !== 'keep_source' && !targetId) {
    throw conflict('That split has not produced a second product yet.');
  }

  const destination = input.resolution === 'keep_source' ? existing.canonicalProductId : targetId;
  if (!destination) throw conflict('That split has not produced a second product yet.');

  const row = await clearPriceAlertAmbiguity({
    id: input.id,
    oxyUserId: input.oxyUserId,
    canonicalProductId: destination,
  });
  if (!row) throw conflict('That alert is not waiting on a split decision.');

  if (input.resolution === 'keep_both' && targetId) {
    // A second alert on the other side, with the SAME condition. `keep_both` is
    // the honest reading of a split that was always two things, and refusing it
    // would push a buyer to answer a question wrongly rather than completely —
    // #80's own wording for the same choice.
    await insertPriceAlert(
      {
        oxyUserId: input.oxyUserId,
        canonicalProductId:
          destination === existing.canonicalProductId ? targetId : existing.canonicalProductId,
        canonicalVariantId: null,
        targetAmount: existing.targetAmount,
        targetCurrency: existing.targetCurrency,
        basis: existing.basis,
        conditionGroups: existing.conditionGroups as readonly ConditionGroup[],
        market: existing.market,
        sellerScope: existing.sellerScope,
        proximityScope: existing.proximityScope,
        merchantId: existing.merchantId,
        storefrontId: existing.storefrontId,
        availabilityRequirement: existing.availabilityRequirement,
        minimumAvailableQuantity: existing.minimumAvailableQuantity,
        requirePickupAvailable: existing.requirePickupAvailable,
        repeatPolicy: existing.repeatPolicy,
        resetThresholdAmount: existing.resetThresholdAmount,
        cooldownSeconds: existing.cooldownSeconds,
        quietHoursStartMinute: existing.quietHoursStartMinute,
        quietHoursEndMinute: existing.quietHoursEndMinute,
        quietHoursTimeZone: existing.quietHoursTimeZone,
        locale: existing.locale,
        emailOptIn: existing.emailOptIn,
      },
      getDb(),
    );
  }

  await requestPriceAlertEvaluationForProduct(row.canonicalProductId);
  return toPriceAlertDTO(row);
}

/** What the current market looks like, so a buyer can pick a target (UX 2 and 3). */
export interface PriceAlertSuggestion {
  readonly canonicalProductId: string;
  readonly currency: CurrencyCode;
  /** The lowest eligible ITEM price right now, if there is one. */
  readonly bestItemPrice?: Money;
  /** The lowest eligible KNOWN TOTAL right now. Absent is a real answer. */
  readonly bestKnownTotal?: Money;
  /** How many eligible offers the figures came from — the vacuity floor. */
  readonly eligibleOfferCount: number;
  /**
   * A target a client may PREFILL, never one anybody has set.
   *
   * The current best, unchanged: suggesting a discount off it would be Mercaria
   * predicting a price move, which is not a thing it knows. Absent when there is
   * no eligible offer, because a suggestion derived from nothing is a guess
   * wearing a number.
   */
  readonly suggestedTarget?: Money;
}

/**
 * Answer "what is this worth today" without creating anything.
 *
 * Runs the SAME comparison an evaluation would, so the number a buyer is shown
 * and the number their alert is judged against come from one derivation.
 */
export async function suggestPriceAlertTarget(input: {
  readonly canonicalProductId: string;
  readonly currency: CurrencyCode;
  readonly market?: string;
  readonly conditionGroups?: readonly ConditionGroup[];
}): Promise<PriceAlertSuggestion> {
  const comparison = await buildAlertComparison({
    canonicalProductId: input.canonicalProductId,
    comparisonCurrency: input.currency,
    ...(input.market ? { market: input.market } : {}),
    limit: config.priceAlerts.evaluationOfferLimit,
  });

  const wanted = input.conditionGroups ?? [];
  const inSegment = comparison.candidates.filter((candidate) => {
    if (wanted.length === 0) return true;
    const group = candidate.offer.condition.group;
    return group !== undefined && wanted.includes(group);
  });

  let bestItem: Money | undefined;
  let bestTotal: Money | undefined;
  for (const candidate of inSegment) {
    // `in`, not `.known` — `qualification.ts`'s note on `strict: false`.
    const { itemPrice, total } = candidate.admitted.facts;
    if ('amount' in itemPrice && (bestItem === undefined || itemPrice.amount.amount < bestItem.amount)) {
      bestItem = itemPrice.amount;
    }
    if ('amount' in total && (bestTotal === undefined || total.amount.amount < bestTotal.amount)) {
      bestTotal = total.amount;
    }
  }

  return {
    canonicalProductId: input.canonicalProductId,
    currency: input.currency,
    ...(bestItem ? { bestItemPrice: bestItem } : {}),
    ...(bestTotal ? { bestKnownTotal: bestTotal } : {}),
    eligibleOfferCount: inSegment.length,
    ...(bestItem ? { suggestedTarget: bestItem } : {}),
  };
}
