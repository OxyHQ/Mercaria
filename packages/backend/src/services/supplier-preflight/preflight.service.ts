/**
 * `runSupplierPreflight` — the common preflight service (#122).
 *
 * One function asks one supplier one question and turns the answer into a
 * durable quote. Everything that decides WHAT the answer means is pure and
 * lives elsewhere (`preflight-completeness.ts`, `adapter.ts`,
 * `quote-usage.ts`); this module is the only one that touches the database and
 * the only one that calls an adapter — the
 * `services/retail-eligibility/retail-eligibility.service.ts` split, for the
 * same reason it exists there.
 *
 * ## The order of operations is the design
 *
 * Gates first, and every gate that fails still produces a durable, blocking
 * quote rather than an exception. A disabled deployment, an unregistered
 * provider, a killed account, a suppressed market and a missing policy version
 * all answer `unknown` availability with a named block reason — because #122
 * acceptance 6 is "unknown or incomplete supplier responses block checkout
 * before charging", and an exception thrown at a caller is not an answer that
 * can be traced, counted or shown.
 *
 * Then the LEASE, then the call, then the capability boundary, then
 * completeness, then persistence. The lease is taken before the call and
 * released after it in a `finally`, so a throwing adapter cannot strand a slot;
 * the capability boundary runs before completeness, so a claim the adapter was
 * not entitled to make cannot become a `complete` answer.
 *
 * ## Idempotency is an explicit policy, stated here
 *
 * #122 concurrency 1 asks for one, and this is it:
 *
 *  - A quote already stored under the key that is still USABLE is RETURNED, and
 *    no supplier call is made. Two clicks, a retried request and a client that
 *    lost the response all converge.
 *  - A quote under the key that is expired, consumed, released or superseded is
 *    REFRESHED: the supplier is asked again and a NEW quote is stored under a
 *    generation-suffixed key, with the old one pointed at it. The key cannot be
 *    reused because it is UNIQUE, and reusing the row would mutate a record
 *    another checkout may already have consumed.
 *  - Two tasks refreshing the same expired key concurrently both call the
 *    supplier; the loser's insert loses the unique, its answer is discarded and
 *    any hold it took is released. That is stated rather than hidden: the
 *    alternative is a lock held across a provider call, which converts a slow
 *    supplier into a stuck checkout.
 */

import { randomUUID } from 'node:crypto';
import type {
  CurrencyCode,
  SupplierAdapterCapability,
  SupplierPreflightAnswer,
  SupplierPreflightBlockReason,
  SupplierPreflightCompleteness,
  SupplierPreflightDestination,
  SupplierPreflightFailureKind,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import { notFound, validationError } from '../../lib/errors/error-codes.js';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  findProcurementOfferById,
  type ProcurementOfferRecord,
} from '../../db/procurement/procurementOfferRepository.js';
import {
  findSupplierAccountById,
  type SupplierAccountRecord,
} from '../../db/procurement/supplierAccountRepository.js';
import { findSupplierById } from '../../db/procurement/supplierRepository.js';
import type { SupplierSourcingPolicyRow } from '../../db/supplierPreflight/sourcingPolicyRepository.js';
import {
  findSupplierQuoteByIdempotencyKey,
  insertSupplierQuote,
  supersedeSupplierQuote,
  type NewSupplierShippingOption,
  type SupplierQuoteRow,
} from '../../db/supplierPreflight/quoteRepository.js';
import {
  recordSupplierReservation,
  type SupplierReservationRow,
} from '../../db/supplierPreflight/reservationRepository.js';
import { findActiveSupplierSourcingPolicy } from '../../db/supplierPreflight/sourcingPolicyRepository.js';
import { listLiveSuppressionsForRoute } from '../../db/supplierPreflight/suppressionRepository.js';
import {
  claimSupplierCallLease,
  releaseSupplierCallLease,
} from '../../db/supplierPreflight/callLeaseRepository.js';
import { recordSupplierCallOutcome } from '../../db/supplierPreflight/healthRepository.js';
import { applyDeclaredCapabilities, unknownAnswer, type SupplierCapabilityDowngrade } from './adapter.js';
import { deriveSupplierPreflightCompleteness } from './preflight-completeness.js';
import { computeSupplierRequestFingerprint } from './request-fingerprint.js';
import { findSupplierAdapter } from './registry.js';
import { isSupplierQuoteUsable } from './quote-usage.js';
import { redactSupplierProviderMessage } from './redact.js';

/**
 * The policy key every sourcing decision is made under.
 *
 * A code CONSTANT and not an environment variable, the
 * `RETAIL_ELIGIBILITY_POLICY_KEY` reasoning verbatim: which policy governs
 * `mercaria_retail` sourcing is not a per-deployment choice, and a variable
 * holding it could only ever disagree with the rows it names. Publishing a NEW
 * VERSION under this key is how the policy changes.
 */
export const SUPPLIER_SOURCING_POLICY_KEY = 'mercaria-retail-sourcing';

/**
 * The TTL a BLOCKED quote gets when no policy version supplies one.
 *
 * A blocked quote cannot fund anything, so its deadline decides only how long
 * the row reads as "recent" in the operator trace. Short, because the situation
 * it records — no active policy, a disabled deployment — is one somebody is
 * about to change.
 */
const FALLBACK_BLOCKED_QUOTE_TTL_SECONDS = 300;

/** What one preflight run answers with. */
export interface SupplierPreflightResult {
  quote: SupplierQuoteRow;
  completeness: SupplierPreflightCompleteness;
  /** The hold the supplier actually made, or `null` — the absence IS the answer. */
  reservation: SupplierReservationRow | null;
  /** True when a stored, still-usable quote satisfied the key with no supplier call. */
  reused: boolean;
}

/** One preflight question, as the service takes it. */
export interface RunSupplierPreflightInput {
  procurementOfferId: string;
  quantity: number;
  destination: SupplierPreflightDestination;
  currency: CurrencyCode;
  requestedShippingServiceCode?: string;
  checkoutGroupId?: string;
  orderId?: string;
  idempotencyKey?: string;
  /** Whether to ASK for a hold. An adapter without the capability ignores it. */
  requestReservation?: boolean;
  /** The #120 pricing policy the caller is operating under, when it has one. */
  pricingPolicyKey?: string;
  pricingPolicyVersion?: number;
  /** The #121 eligibility policy the caller is operating under, when it has one. */
  eligibilityPolicyKey?: string;
  eligibilityPolicyVersion?: number;
  at?: Date;
  db?: DatabaseOrTransaction;
}

/**
 * Ask one supplier about one line, durably.
 *
 * Throws only for a MALFORMED question — an unknown offer, a non-positive
 * quantity, a destination that is not an ISO-3166 alpha-2 country. Everything
 * else is an ANSWER: a blocking quote with bounded reasons, never an exception
 * a caller might catch and treat as a transient failure.
 */
export async function runSupplierPreflight(
  input: RunSupplierPreflightInput,
): Promise<SupplierPreflightResult> {
  const db = input.db ?? getDb();
  const requestedAt = input.at ?? new Date();
  assertWellFormed(input);

  const offer = await findProcurementOfferById(input.procurementOfferId, db);
  if (!offer) throw notFound(`Procurement offer ${input.procurementOfferId} does not exist.`);

  const [supplier, account] = await Promise.all([
    findSupplierById(offer.supplierId, db),
    findSupplierAccountById(offer.supplierAccountId, db),
  ]);
  if (!supplier) throw notFound(`Supplier ${offer.supplierId} does not exist.`);
  if (!account) throw notFound(`Supplier account ${offer.supplierAccountId} does not exist.`);

  const destinationCountry = input.destination.country.trim().toUpperCase();
  const fingerprint = computeSupplierRequestFingerprint({
    supplierAccountId: account.id,
    procurementOfferId: offer.id,
    supplierSku: offer.supplierSku,
    quantity: input.quantity,
    currency: input.currency,
    destination: { ...input.destination, country: destinationCountry },
    requestedShippingServiceCode: input.requestedShippingServiceCode ?? null,
  });
  const callerKey = input.idempotencyKey?.trim() || fingerprint;

  // #122 concurrency 1, first branch: a still-usable answer under this key is
  // the answer, and the supplier is not asked again.
  const existing = await findSupplierQuoteByIdempotencyKey(callerKey, db);
  if (existing && isSupplierQuoteUsable(existing, requestedAt)) {
    return {
      quote: existing,
      completeness: completenessOf(existing),
      reservation: null,
      reused: true,
    };
  }

  const policy = await findActiveSupplierSourcingPolicy(
    { policyKey: SUPPLIER_SOURCING_POLICY_KEY, at: requestedAt },
    db,
  );

  const gateReasons = await collectGateReasons(
    {
      supplierStatus: supplier.status,
      accountState: account.state,
      supplierId: supplier.id,
      supplierAccountId: account.id,
      destinationCountry,
      provider: account.provider,
      hasPolicy: policy !== undefined,
      now: requestedAt,
    },
    db,
  );

  const adapter = gateReasons.includes('provider_unconfigured')
    ? undefined
    : findSupplierAdapter(account.provider);

  // Every gate that fails still produces a durable, blocking quote — see the
  // module docblock. No lease is taken and no supplier is called.
  if (gateReasons.length > 0 || !adapter || !policy) {
    return persist({
      db,
      offer,
      account,
      policy,
      input,
      callerKey,
      fingerprint,
      destinationCountry,
      requestedAt,
      answer: unknownAnswer(),
      declaredCapabilities: adapter?.capabilities ?? [],
      downgrades: [],
      gateReasons,
      failureKind: null,
      latencyMs: null,
      existing,
      ttlSeconds: policy?.quoteTtlSeconds ?? FALLBACK_BLOCKED_QUOTE_TTL_SECONDS,
    });
  }

  const leaseOwner = `supplier-preflight-${randomUUID()}`;
  const lease = await claimSupplierCallLease(
    {
      budget: {
        supplierAccountId: account.id,
        maxConcurrency: policy.maxProviderConcurrency,
        maxCallsPerMinute: account.rateLimitPerMinute ?? policy.maxProviderCallsPerMinute,
      },
      leaseOwner,
      leaseMs: policy.providerTimeoutMs * 2,
      now: requestedAt,
    },
    db,
  );

  if (!lease.granted) {
    // Both refusals block, and neither is a guess about stock: the supplier was
    // not asked, so the answer is `unknown` (#122 concurrency 7's rule applied
    // to a call that never left).
    await recordSupplierCallOutcome(
      {
        supplierAccountId: account.id,
        succeeded: false,
        failureKind: 'rate_limited',
        latencyMs: null,
        windowMinutes: policy.healthWindowMinutes,
        now: requestedAt,
      },
      db,
    );
    return persist({
      db,
      offer,
      account,
      policy,
      input,
      callerKey,
      fingerprint,
      destinationCountry,
      requestedAt,
      answer: unknownAnswer(),
      declaredCapabilities: adapter.capabilities,
      downgrades: [],
      gateReasons: [],
      failureKind: 'rate_limited',
      latencyMs: null,
      existing,
      ttlSeconds: policy.quoteTtlSeconds,
    });
  }

  const startedAt = Date.now();
  let raw: SupplierPreflightAnswer = unknownAnswer();
  let failureKind: SupplierPreflightFailureKind | null = null;
  let failureMessage: string | null = null;

  try {
    raw = await withTimeout(
      adapter.quote({
        providerAccountId: account.providerAccountId,
        environment: account.environment,
        supplierSku: offer.supplierSku,
        supplierExternalId: offer.supplierExternalId,
        quantity: input.quantity,
        destination: { ...input.destination, country: destinationCountry },
        currency: input.currency,
        requestedShippingServiceCode: input.requestedShippingServiceCode ?? null,
        requestReservation: input.requestReservation === true,
        timeoutMs: policy.providerTimeoutMs,
      }),
      policy.providerTimeoutMs,
    );
  } catch (err) {
    failureKind = classifyFailure(err);
    failureMessage = redactSupplierProviderMessage(
      err instanceof Error ? err.message : 'The supplier adapter threw a non-Error value.',
    );
    // The answer stays `unknownAnswer()` — a timeout is `unknown`, never stock
    // (#122 concurrency 7). There is deliberately no branch that could produce
    // anything else from a failed call.
    log.general.warn(
      {
        supplierAccountId: account.id,
        provider: account.provider,
        procurementOfferId: offer.id,
        failureKind,
      },
      '[SupplierPreflight] provider call failed; answering unknown',
    );
  } finally {
    await releaseSupplierCallLease({ leaseId: lease.leaseId, leaseOwner, now: new Date() }, db);
  }

  const latencyMs = Date.now() - startedAt;
  const { answer, downgrades } = applyDeclaredCapabilities(raw, adapter.capabilities);
  if (downgrades.length > 0) {
    log.general.error(
      {
        provider: account.provider,
        supplierAccountId: account.id,
        downgrades: downgrades.map((entry) => entry.commitment),
      },
      '[SupplierPreflight] adapter claimed capabilities it did not declare; the claims were removed',
    );
  }

  await recordSupplierCallOutcome(
    {
      supplierAccountId: account.id,
      succeeded: failureKind === null && downgrades.length === 0,
      failureKind: failureKind ?? (downgrades.length > 0 ? 'contract_violation' : null),
      latencyMs: failureKind === 'timeout' ? null : latencyMs,
      windowMinutes: policy.healthWindowMinutes,
      now: requestedAt,
    },
    db,
  );

  return persist({
    db,
    offer,
    account,
    policy,
    input,
    callerKey,
    fingerprint,
    destinationCountry,
    requestedAt,
    answer,
    declaredCapabilities: adapter.capabilities,
    downgrades,
    gateReasons: [],
    failureKind,
    failureMessage,
    latencyMs: failureKind === 'timeout' ? null : latencyMs,
    existing,
    ttlSeconds: policy.quoteTtlSeconds,
    releaseOrphanedHold: async (providerReservationId) => {
      if (!adapter.releaseReservation) return;
      await adapter.releaseReservation({
        providerAccountId: account.providerAccountId,
        environment: account.environment,
        providerReservationId,
        reason: 'quote_superseded',
        timeoutMs: policy.providerTimeoutMs,
      });
    },
  });
}

/** A malformed question is refused before anything is loaded or recorded. */
function assertWellFormed(input: RunSupplierPreflightInput): void {
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw validationError('quantity must be a positive integer.');
  }
  if (!/^[A-Za-z]{2}$/.test(input.destination.country.trim())) {
    throw validationError('destination.country must be an ISO-3166-1 alpha-2 code.');
  }
}

/** The facts a gate reads, gathered so the check itself stays readable. */
interface GateContext {
  supplierStatus: string;
  accountState: string;
  supplierId: string;
  supplierAccountId: string;
  destinationCountry: string;
  provider: string;
  hasPolicy: boolean;
  now: Date;
}

/**
 * Everything that blocks BEFORE the supplier is asked.
 *
 * Collected rather than short-circuited: an operator looking at a blocked quote
 * needs to know that the account was killed AND the market was suppressed, not
 * whichever check happened to run first — two separate things have to be undone.
 */
async function collectGateReasons(
  context: GateContext,
  db: DatabaseOrTransaction,
): Promise<SupplierPreflightBlockReason[]> {
  const reasons: SupplierPreflightBlockReason[] = [];

  if (!config.supplierPreflight.enabled) reasons.push('preflight_disabled');
  if (!context.hasPolicy) reasons.push('sourcing_policy_missing');
  if (context.supplierStatus !== 'active' || context.accountState !== 'active') {
    reasons.push('account_not_active');
  }
  if (!findSupplierAdapter(context.provider)) reasons.push('provider_unconfigured');

  const suppressions = await listLiveSuppressionsForRoute(
    {
      supplierId: context.supplierId,
      supplierAccountId: context.supplierAccountId,
      marketCountry: context.destinationCountry,
      now: context.now,
    },
    db,
  );
  for (const suppression of suppressions) {
    reasons.push(
      suppression.scope === 'market' ? 'market_suppressed' : 'supplier_suppressed',
    );
  }

  return [...new Set(reasons)].sort();
}

/** Everything `persist` needs. Assembled once so the call site stays readable. */
interface PersistInput {
  db: DatabaseOrTransaction;
  offer: ProcurementOfferRecord;
  account: SupplierAccountRecord;
  policy: SupplierSourcingPolicyRow | undefined;
  input: RunSupplierPreflightInput;
  callerKey: string;
  fingerprint: string;
  destinationCountry: string;
  requestedAt: Date;
  answer: SupplierPreflightAnswer;
  declaredCapabilities: readonly SupplierAdapterCapability[];
  downgrades: readonly SupplierCapabilityDowngrade[];
  gateReasons: readonly SupplierPreflightBlockReason[];
  failureKind: SupplierPreflightFailureKind | null;
  failureMessage?: string | null;
  latencyMs: number | null;
  existing: SupplierQuoteRow | undefined;
  ttlSeconds: number;
  /** Hands back a hold whose quote lost the idempotency race. */
  releaseOrphanedHold?: (providerReservationId: string) => Promise<void>;
}

/**
 * Derive the verdict, store the quote, store any real reservation.
 *
 * The idempotency key of a REFRESH is `<callerKey>#<generation>`, derived from
 * how many quotes already exist in this chain. Deterministic, so two tasks
 * refreshing concurrently compute the same key and exactly one wins the unique
 * — the loser reads the winner back, discards its own answer and releases any
 * hold it took, which is the only shape that does not either mutate a record
 * somebody may have consumed or leave a supplier holding stock for nobody.
 */
async function persist(parts: PersistInput): Promise<SupplierPreflightResult> {
  const { offer, account, policy, input, answer } = parts;
  const quotedAt = new Date();
  const completeness = deriveSupplierPreflightCompleteness({
    answer,
    requestedQuantity: input.quantity,
    requestedCurrency: input.currency,
    contractViolations: parts.downgrades,
    gateReasons: parts.gateReasons,
    failureKind: parts.failureKind,
    requireDeliveryEstimate: policy?.requiredCapabilities.includes('delivery_estimate') ?? false,
    requireTaxTreatment: policy?.requiredCapabilities.includes('tax_duty_estimate') ?? false,
  });

  // The supplier's own deadline wins when it stated one and it is sooner: a
  // quote outliving the answer it records is the shape that lets a checkout
  // charge against stock the supplier stopped holding.
  const policyExpiry = new Date(quotedAt.getTime() + parts.ttlSeconds * 1_000);
  const providerExpiry = answer.providerExpiresAt ? new Date(answer.providerExpiresAt) : null;
  const expiresAt =
    providerExpiry && !Number.isNaN(providerExpiry.getTime()) && providerExpiry < policyExpiry
      ? providerExpiry
      : policyExpiry;

  // The refresh key names the quote it supersedes. Deterministic — two tasks
  // refreshing concurrently both found the SAME expired quote, so both compute
  // this exact string and exactly one wins the unique index; the loser's branch
  // below reads the winner back. A counter would need a round trip to answer a
  // question the index already answers, and a random suffix would let both
  // inserts succeed and leave two live quotes for one question.
  const idempotencyKey = parts.existing
    ? `${parts.callerKey}#${parts.existing.id}`
    : parts.callerKey;

  const shippingOptions: NewSupplierShippingOption[] = answer.shippingOptions.map((option) => ({
    serviceCode: option.serviceCode,
    carrier: option.carrier,
    serviceName: option.serviceName,
    costAmount: option.cost.amount,
    costCurrency: option.cost.currency,
    basis: option.basis === 'unknown' ? 'per_item' : option.basis,
    deliveryDaysMin: option.deliveryDaysMin,
    deliveryDaysMax: option.deliveryDaysMax,
    guaranteed: option.guaranteed,
  }));

  const selectedServiceCode =
    answer.shipping.basis === 'unknown' ? null : answer.shipping.serviceCode;
  const shippingCostAmount =
    answer.shipping.basis === 'basket'
      ? answer.shipping.cost.amount
      : answer.shipping.basis === 'per_item'
        ? answer.shipping.costs.reduce((sum, cost) => sum + cost.amount, 0)
        : null;

  let quote: SupplierQuoteRow;
  try {
    quote = await insertSupplierQuote(
      {
        idempotencyKey,
        requestFingerprint: parts.fingerprint,
        supplierId: offer.supplierId,
        supplierAccountId: account.id,
        environment: account.environment,
        provider: account.provider,
        declaredCapabilities: parts.declaredCapabilities,
        procurementOfferId: offer.id,
        canonicalProductId: offer.canonicalProductId,
        canonicalVariantId: offer.canonicalVariantId,
        supplierSku: offer.supplierSku,
        quantity: input.quantity,
        checkoutGroupId: input.checkoutGroupId ?? null,
        orderId: input.orderId ?? null,
        requestedCurrency: input.currency,
        destinationCountry: parts.destinationCountry,
        destinationRegion: input.destination.region?.trim().toUpperCase() ?? null,
        identityConfirmation: answer.identity,
        availability: answer.availability,
        maxOrderableQuantity: answer.maxOrderableQuantity,
        minimumOrderQuantity: answer.minimumOrderQuantity,
        packSize: answer.packSize,
        unitCostAmount: answer.unitCost?.amount ?? null,
        supplierFeesAmount: answer.supplierFees?.amount ?? null,
        shippingCostAmount,
        shippingBasis: answer.shipping.basis,
        selectedShippingServiceCode: selectedServiceCode,
        handlingDaysMin: answer.handlingDaysMin,
        handlingDaysMax: answer.handlingDaysMax,
        dispatchDaysMin: answer.dispatchDaysMin,
        dispatchDaysMax: answer.dispatchDaysMax,
        deliveryDaysMin: answer.deliveryDaysMin,
        deliveryDaysMax: answer.deliveryDaysMax,
        taxAmount: answer.tax?.amount ?? null,
        dutyAmount: answer.duty?.amount ?? null,
        importResponsibility: answer.importResponsibility,
        fulfilmentOriginCountry: answer.fulfilmentOriginCountry,
        destinationRestrictions: answer.destinationRestrictions,
        providerQuoteReference: answer.providerQuoteReference,
        priceGuarantee: answer.priceGuarantee,
        stockGuarantee: answer.stockGuarantee,
        providerReasonCodes: answer.reasonCodes,
        sourceRecordRef: answer.sourceRecordRef,
        status: completeness.status,
        blockReasons: completeness.blockReasons,
        exceptionKind: completeness.exceptionKind,
        // All THREE from the same source. `supplier_quotes_sourcing_policy_check`
        // requires 0 or 3 of them, and taking the id from one place and the
        // snapshot names from another is exactly how 2 arrives: a gated quote
        // (no adapter, a kill switch) still HAS a policy, and an earlier draft
        // passed its key and version while leaving the id null. The realdb
        // suite caught it; tsc could not.
        sourcingPolicyId: policy?.id ?? null,
        sourcingPolicyKey: policy?.policyKey ?? null,
        sourcingPolicyVersion: policy?.version ?? null,
        pricingPolicyKey: input.pricingPolicyKey ?? null,
        pricingPolicyVersion: input.pricingPolicyVersion ?? null,
        eligibilityPolicyKey: input.eligibilityPolicyKey ?? null,
        eligibilityPolicyVersion: input.eligibilityPolicyVersion ?? null,
        requestedAt: parts.requestedAt,
        quotedAt,
        expiresAt,
        attempts: 1,
        lastFailureKind: parts.failureKind,
        lastFailureAt: parts.failureKind ? quotedAt : null,
        lastFailureMessage: parts.failureMessage ?? null,
        latencyMs: parts.latencyMs,
        shippingOptions,
      },
      parts.db,
    );
  } catch (err) {
    // The idempotency race, resolved: somebody else stored this generation
    // first. Their quote is the answer; ours is discarded and any hold we took
    // is handed back, because two quotes cannot both hold the same stock.
    const winner = await findSupplierQuoteByIdempotencyKey(idempotencyKey, parts.db);
    if (!winner) throw err;
    if (answer.reservation.supported && answer.reservation.state === 'reserved') {
      await releaseOrphanedHold(parts, answer.reservation.providerReservationId);
    }
    return { quote: winner, completeness: completenessOf(winner), reservation: null, reused: true };
  }

  if (parts.existing) {
    await supersedeSupplierQuote(
      {
        quoteId: parts.existing.id,
        supersededByQuoteId: quote.id,
        reason: 're_preflight',
        now: quotedAt,
      },
      parts.db,
    );
  }

  // A reservation row exists only when the supplier committed. The `if` reads
  // the union's discriminant, so there is no branch here that could store one
  // from an `unsupported` or `refused` outcome — see `reservationRepository`.
  let reservation: SupplierReservationRow | null = null;
  if (answer.reservation.supported && answer.reservation.state === 'reserved') {
    reservation = await recordSupplierReservation(
      {
        quoteId: quote.id,
        supplierId: offer.supplierId,
        supplierAccountId: account.id,
        procurementOfferId: offer.id,
        supplierSku: offer.supplierSku,
        quantity: input.quantity,
        reservedAt: quotedAt,
        declaredCapabilities: parts.declaredCapabilities,
        outcome: answer.reservation,
      },
      parts.db,
    );
  }

  return { quote, completeness, reservation, reused: false };
}

/**
 * Hand back a hold whose quote lost the idempotency race.
 *
 * Best effort and never rethrown: the winner's quote is already the answer, and
 * failing the caller's preflight because a cleanup call failed would turn a
 * successful race into a failed checkout. The supplier's own expiry is the
 * backstop, and the failure is logged at `error` because a hold Mercaria could
 * not release is stock nobody can sell until it lapses.
 */
async function releaseOrphanedHold(parts: PersistInput, providerReservationId: string): Promise<void> {
  if (!parts.releaseOrphanedHold) return;
  try {
    await parts.releaseOrphanedHold(providerReservationId);
  } catch (err) {
    log.general.error(
      { err, supplierAccountId: parts.account.id },
      '[SupplierPreflight] could not release a hold orphaned by an idempotency race; it will ' +
        'lapse on the supplier’s own clock',
    );
  }
}

/** The stored verdict, read back off a row without re-deriving it. */
function completenessOf(quote: SupplierQuoteRow): SupplierPreflightCompleteness {
  return {
    status: quote.status,
    blockReasons: quote.blockReasons as SupplierPreflightBlockReason[],
    exceptionKind: quote.exceptionKind,
    mayCheckout: quote.status === 'complete',
  };
}

/** Map a thrown value onto the closed failure vocabulary. */
function classifyFailure(err: unknown): SupplierPreflightFailureKind {
  if (err instanceof PreflightTimeout) return 'timeout';
  if (!(err instanceof Error)) return 'provider_error';
  const message = err.message.toLowerCase();
  if (message.includes('rate limit') || message.includes('rate_limited')) return 'rate_limited';
  if (message.includes('unauthor') || message.includes('forbidden') || message.includes('credential')) {
    return 'authentication_failed';
  }
  if (message.includes('econnrefused') || message.includes('enotfound') || message.includes('socket')) {
    return 'transport_error';
  }
  return 'provider_error';
}

/** The deadline a provider exceeded. */
class PreflightTimeout extends Error {
  constructor(timeoutMs: number) {
    super(`The supplier adapter did not answer within ${String(timeoutMs)}ms.`);
    this.name = 'PreflightTimeout';
  }
}

/**
 * Bound a provider call.
 *
 * The timer is cleared in a `finally` so a fast answer does not hold the event
 * loop open for the rest of the deadline — the `setInterval().unref()` rule one
 * primitive over, and the thing that makes a suite of these tests exit.
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new PreflightTimeout(timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
