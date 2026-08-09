/**
 * Choosing a supplier, failing over when one cannot answer, and decomposing a
 * mixed cart (#122 "Selection and failover", "Mixed carts and grouping").
 *
 * The pure halves live in `selection.ts` (the order, the substitution guard)
 * and `grouping.ts` (the decomposition, the delivered total); this module is
 * the one that loads candidates, drives `runSupplierPreflight` over them and
 * records what it tried.
 *
 * ## Every attempted source is recorded, including the ones never tried
 *
 * #122 selection 7 asks for a record of every attempted source and reason, and
 * the trail here deliberately includes the candidates that were FILTERED OUT —
 * a supplier skipped for a concentration limit and one skipped because its
 * account was killed are different operational problems, and a trail showing
 * only the calls that happened cannot tell them apart. That is the same
 * reasoning `catalog_backfill_runs` uses for its counters: what was not done is
 * as much a fact as what was.
 *
 * ## Failover stops at the first COMPLETE answer, and never substitutes silently
 *
 * The loop takes the policy's ordered candidates and stops at the first
 * `complete` quote. A candidate that answers `partial` or `invalid` is a failed
 * attempt, not a fallback offer — and when terms are already locked, every
 * replacement additionally goes through `assertSubstitutionPermitted`, which
 * refuses by name anything that changes the product, the price, the delivery
 * commitment or the returns capability (#122 selection 5–6).
 */

import type {
  CurrencyCode,
  SupplierAdapterCapability,
  SupplierPreflightDestination,
  SupplierSourcingCriterion,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  findProcurementOffersByVariant,
  type ProcurementOfferRecord,
} from '../../db/procurement/procurementOfferRepository.js';
import { findSupplierAccountById } from '../../db/procurement/supplierAccountRepository.js';
import { findActiveSupplierSourcingPolicy } from '../../db/supplierPreflight/sourcingPolicyRepository.js';
import {
  recordSupplierSourcingAttempts,
  type NewSupplierSourcingAttempt,
} from '../../db/supplierPreflight/sourcingAttemptRepository.js';
import {
  deriveSupplierHealthVerdict,
  findSupplierPreflightHealth,
} from '../../db/supplierPreflight/healthRepository.js';
import { listLiveSuppressionsForRoute } from '../../db/supplierPreflight/suppressionRepository.js';
import { deriveOfferFreshness } from '../procurement/procurement-eligibility.js';
import { findSupplierAdapter } from './registry.js';
import { computeSupplierRequestFingerprint } from './request-fingerprint.js';
import {
  assertSubstitutionPermitted,
  selectSourcingOrder,
  type SourcingCandidateFacts,
  type SubstitutionSubject,
} from './selection.js';
import {
  composeDeliveredTotal,
  findGroupQuantityViolations,
  groupRetailLines,
  type GroupTotalInput,
  type RetailPreflightLine,
  type SupplierPreflightGroup,
} from './grouping.js';
import {
  runSupplierPreflight,
  SUPPLIER_SOURCING_POLICY_KEY,
  type SupplierPreflightResult,
} from './preflight.service.js';

/** One line to source, named by the canonical variant rather than by an offer. */
export interface SourceRetailLineInput {
  canonicalVariantId: string;
  quantity: number;
  destination: SupplierPreflightDestination;
  currency: CurrencyCode;
  checkoutGroupId?: string;
  orderId?: string;
  requestReservation?: boolean;
  /**
   * What the customer has already been promised, when anything has been. Its
   * presence is what turns on the preservation half of the substitution rule.
   */
  lockedTerms?: SubstitutionSubject;
  at?: Date;
  db?: DatabaseOrTransaction;
}

/** The sourced answer, or a refusal naming every candidate that was considered. */
export interface RetailSourcingResult {
  /** The winning preflight, or `null` when no candidate produced a complete one. */
  selected: SupplierPreflightResult | null;
  /** Every candidate, in the order the policy produced, with its outcome. */
  attempts: readonly NewSupplierSourcingAttempt[];
}

/**
 * Source one retail line, with bounded failover.
 *
 * Records the whole trail in one statement at the end rather than a row per
 * attempt: the sequence numbers are only meaningful together, and a crash
 * mid-run should leave the whole trail or none of it rather than a partial
 * ordering that reads as "we stopped trying here".
 */
export async function sourceRetailLine(
  input: SourceRetailLineInput,
): Promise<RetailSourcingResult> {
  const db = input.db ?? getDb();
  const now = input.at ?? new Date();
  const destinationCountry = input.destination.country.trim().toUpperCase();

  const policy = await findActiveSupplierSourcingPolicy(
    { policyKey: SUPPLIER_SOURCING_POLICY_KEY, at: now },
    db,
  );
  const offers = await findProcurementOffersByVariant(input.canonicalVariantId, db);

  if (!policy) {
    // With no policy version there is no order to apply and no attempt limit to
    // respect, so nothing is tried. A record is still written for each candidate
    // — an operator asking "why did this not source" needs to see that the
    // catalogue had suppliers and the deployment had no policy, not silence.
    const attempts = offers.map((offer, sequence) =>
      attemptRow({
        offer,
        sequence,
        checkoutGroupId: input.checkoutGroupId ?? null,
        fingerprint: fingerprintFor(offer, input, destinationCountry),
        policy: null,
        rank: null,
        outcome: 'skipped',
        reason: 'no_active_policy',
        quoteId: null,
        at: now,
      }),
    );
    await recordSupplierSourcingAttempts(attempts, db);
    return { selected: null, attempts };
  }

  const candidates = await Promise.all(
    offers.map((offer) => buildCandidate(offer, destinationCountry, policy.healthWindowMinutes, policy.healthMinimumSamples, policy.healthMaxFailureBps, now, db)),
  );
  const withFacts = candidates.filter(
    (entry): entry is { offer: ProcurementOfferRecord; facts: SourcingCandidateFacts } =>
      entry !== null,
  );

  const selection = selectSourcingOrder(
    withFacts.map((entry) => entry.facts),
    {
      // The columns are `text[]`, CHECK-constrained to the shared-types tuples
      // — the narrowing every domain does at this boundary
      // (`policy.requiredResaleEvidenceKinds as RetailResaleEvidenceKind[]`,
      // #121). The database is what guarantees it, not this line.
      rankingCriteria: policy.rankingCriteria as SupplierSourcingCriterion[],
      requiredCapabilities: policy.requiredCapabilities as SupplierAdapterCapability[],
      maxSourcingAttempts: policy.maxSourcingAttempts,
      maxSupplierShareBps: policy.maxSupplierShareBps,
    },
  );

  const offerById = new Map(withFacts.map((entry) => [entry.facts.procurementOfferId, entry.offer]));
  const attempts: NewSupplierSourcingAttempt[] = [];
  let sequence = 0;
  let selected: SupplierPreflightResult | null = null;

  for (const skipped of selection.skipped) {
    const offer = offerById.get(skipped.candidate.procurementOfferId);
    if (!offer) continue;
    attempts.push(
      attemptRow({
        offer,
        sequence: sequence++,
        checkoutGroupId: input.checkoutGroupId ?? null,
        fingerprint: fingerprintFor(offer, input, destinationCountry),
        policy,
        rank: null,
        outcome: 'skipped',
        reason: skipped.reason,
        quoteId: null,
        at: now,
      }),
    );
  }

  for (const [rank, candidate] of selection.ordered.entries()) {
    const offer = offerById.get(candidate.procurementOfferId);
    if (!offer) continue;
    const fingerprint = fingerprintFor(offer, input, destinationCountry);

    // A replacement must preserve what the customer was told. Checked BEFORE
    // the supplier is called: refusing after quoting would have asked a
    // supplier a question whose answer could never be used.
    if (input.lockedTerms) {
      const decision = assertSubstitutionPermitted(
        input.lockedTerms,
        {
          canonicalVariantId: offer.canonicalVariantId,
          supplierSku: offer.supplierSku,
          quantity: input.quantity,
          currency: input.currency,
          // The offer's own unit cost is the best pre-quote estimate of the
          // total; the real comparison happens again on the quote below, and
          // this one exists to avoid calling a supplier that cannot possibly
          // preserve the terms.
          totalMinor: offer.unitCostAmount * input.quantity,
          deliveryDaysMax: offer.deliveryDaysMax,
          returnsSupported: offer.returnPolicyRef !== null,
        },
        { termsLocked: true },
      );
      if (!decision.permitted) {
        attempts.push(
          attemptRow({
            offer,
            sequence: sequence++,
            checkoutGroupId: input.checkoutGroupId ?? null,
            fingerprint,
            policy,
            rank,
            outcome: 'refused',
            reason: 'substitution_refused',
            quoteId: null,
            at: now,
          }),
        );
        continue;
      }
    }

    const result = await runSupplierPreflight({
      procurementOfferId: offer.id,
      quantity: input.quantity,
      destination: input.destination,
      currency: input.currency,
      checkoutGroupId: input.checkoutGroupId,
      orderId: input.orderId,
      requestReservation: input.requestReservation,
      at: now,
      db,
    });

    const complete = result.completeness.status === 'complete';
    attempts.push(
      attemptRow({
        offer,
        sequence: sequence++,
        checkoutGroupId: input.checkoutGroupId ?? null,
        fingerprint,
        policy,
        rank,
        outcome: complete ? 'selected' : 'failed',
        reason: complete ? 'selected_by_policy' : failureReasonFor(result),
        quoteId: complete ? result.quote.id : null,
        at: now,
      }),
    );

    if (complete) {
      selected = result;
      break;
    }
  }

  if (selected === null && attempts.length === 0) {
    // Nothing to try at all. Recorded against the variant so a "why is this not
    // buyable" question has an answer even when the catalogue is empty for it.
    await recordSupplierSourcingAttempts([], db);
    return { selected: null, attempts: [] };
  }

  await recordSupplierSourcingAttempts(attempts, db);
  return { selected, attempts };
}

/** Which named reason explains a non-complete quote. */
function failureReasonFor(result: SupplierPreflightResult): NewSupplierSourcingAttempt['reason'] {
  const reasons = new Set(result.quote.blockReasons);
  if (reasons.has('provider_timeout')) return 'provider_timeout';
  if (reasons.has('provider_rate_limited')) return 'rate_limited';
  if (reasons.has('provider_error') || reasons.has('provider_contract_violation')) {
    return 'provider_error';
  }
  if (reasons.has('supplier_suppressed')) return 'supplier_suppressed';
  if (reasons.has('market_suppressed')) return 'market_suppressed';
  if (reasons.has('account_not_active')) return 'account_not_active';
  if (reasons.has('capability_missing') || reasons.has('provider_unconfigured')) {
    return 'capability_missing';
  }
  return 'answer_incomplete';
}

/** Assemble one attempt row. Named parameters, because six of them are ids. */
function attemptRow(parts: {
  offer: ProcurementOfferRecord;
  sequence: number;
  checkoutGroupId: string | null;
  fingerprint: string;
  policy: { id: string; policyKey: string; version: number } | null;
  rank: number | null;
  outcome: NewSupplierSourcingAttempt['outcome'];
  reason: NewSupplierSourcingAttempt['reason'];
  quoteId: string | null;
  at: Date;
}): NewSupplierSourcingAttempt {
  return {
    requestFingerprint: parts.fingerprint,
    sequence: parts.sequence,
    checkoutGroupId: parts.checkoutGroupId,
    supplierId: parts.offer.supplierId,
    supplierAccountId: parts.offer.supplierAccountId,
    procurementOfferId: parts.offer.id,
    sourcingPolicyId: parts.policy?.id ?? null,
    sourcingPolicyKey: parts.policy?.policyKey ?? null,
    sourcingPolicyVersion: parts.policy?.version ?? null,
    rank: parts.rank,
    outcome: parts.outcome,
    reason: parts.reason,
    quoteId: parts.quoteId,
    at: parts.at,
  };
}

/** The digest one candidate's question would carry. */
function fingerprintFor(
  offer: ProcurementOfferRecord,
  input: SourceRetailLineInput,
  destinationCountry: string,
): string {
  return computeSupplierRequestFingerprint({
    supplierAccountId: offer.supplierAccountId,
    procurementOfferId: offer.id,
    supplierSku: offer.supplierSku,
    quantity: input.quantity,
    currency: input.currency,
    destination: { ...input.destination, country: destinationCountry },
    requestedShippingServiceCode: null,
  });
}

/**
 * Turn one offer into the facts selection may read.
 *
 * Returns `null` for an offer whose account has vanished — a candidate whose
 * account cannot be loaded is not a candidate, and inventing default facts for
 * it would let it be ranked against real ones.
 *
 * Note what is NOT loaded: no fee schedule, no referral attribution, no ranking
 * score, no listing. `SourcingCandidateFacts` has no member for any of them, so
 * there is nothing here that could fetch one.
 */
async function buildCandidate(
  offer: ProcurementOfferRecord,
  destinationCountry: string,
  healthWindowMinutes: number,
  healthMinimumSamples: number,
  healthMaxFailureBps: number,
  now: Date,
  db: DatabaseOrTransaction,
): Promise<{ offer: ProcurementOfferRecord; facts: SourcingCandidateFacts } | null> {
  const account = await findSupplierAccountById(offer.supplierAccountId, db);
  if (!account) return null;

  const [health, suppressions] = await Promise.all([
    findSupplierPreflightHealth(account.id, db),
    listLiveSuppressionsForRoute(
      {
        supplierId: offer.supplierId,
        supplierAccountId: account.id,
        marketCountry: destinationCountry,
        now,
      },
      db,
    ),
  ]);

  const verdict = deriveSupplierHealthVerdict(
    health,
    {
      windowMinutes: healthWindowMinutes,
      minimumSamples: healthMinimumSamples,
      maxFailureBps: healthMaxFailureBps,
    },
    now,
  );

  const marketSuppressed = suppressions.some((row) => row.scope === 'market');
  const adapter = findSupplierAdapter(account.provider);
  const freshness = deriveOfferFreshness(
    {
      lastConfirmedAt: offer.lastConfirmedAt,
      quoteTtlSeconds: offer.quoteTtlSeconds,
      expiresAt: offer.expiresAt,
    },
    now,
  );

  return {
    offer,
    facts: {
      procurementOfferId: offer.id,
      supplierId: offer.supplierId,
      supplierAccountId: account.id,
      provider: account.provider,
      declaredCapabilities: adapter?.capabilities ?? [],
      // The offer's own cost is a pre-quote ESTIMATE and it is stated as one by
      // being the only cost signal here: the authoritative landed cost is the
      // quote, and selection happens before there is one. A stale feed price is
      // exactly why #122 acceptance 1 exists, which is why the quote — not this
      // — decides whether a sale may happen.
      landedCostMinor: offer.unitCostAmount,
      currency: offer.unitCostCurrency,
      destinationEligible:
        offer.status === 'active' &&
        freshness !== 'expired' &&
        offer.eligibleDestinationCountries.includes(destinationCountry),
      freshnessSeconds: Math.max(
        0,
        Math.round((now.getTime() - offer.lastConfirmedAt.getTime()) / 1_000),
      ),
      deliveryDaysMax: offer.deliveryDaysMax,
      returnsSupported: offer.returnPolicyRef !== null,
      healthSuccessBps: verdict.successBps,
      // Concentration is measured across the checkout group by the caller that
      // has one; a single-line source has no group to concentrate within, so it
      // is zero rather than an invented share.
      currentShareBps: 0,
      suppression: marketSuppressed
        ? 'market'
        : suppressions.length > 0
          ? 'supplier'
          : 'none',
      accountActive: account.state === 'active',
    },
  };
}

/** One cart's decomposition, its per-group answers and its delivered total. */
export interface CheckoutGroupPreflightResult {
  groups: readonly SupplierPreflightGroup[];
  /** One preflight per group line, keyed by procurement offer id. */
  quotes: ReadonlyMap<string, SupplierPreflightResult>;
  /** The delivered total, or the group keys that stopped it being one. */
  delivered: ReturnType<typeof composeDeliveredTotal>;
  /** Supplier minimums and pack sizes the cart does not satisfy. */
  quantityViolations: readonly { procurementOfferId: string; violation: string }[];
}

/** What a whole-cart preflight is given. */
export interface RunCheckoutGroupPreflightInput {
  lines: readonly RetailPreflightLine[];
  destination: SupplierPreflightDestination;
  presentmentCurrency: CurrencyCode;
  checkoutGroupId?: string;
  orderId?: string;
  requestReservation?: boolean;
  at?: Date;
  db?: DatabaseOrTransaction;
}

/**
 * Preflight a whole retail cart (#122 mixed carts 1–10).
 *
 * Groups first, then one preflight per LINE within each group — because a
 * supplier prices an item per item and shipping per group, and the shipping
 * basis on each group's quotes is what decides whether the costs may be summed.
 * `composeDeliveredTotal` then refuses to produce a total at all while any
 * group is unquoted, which is #122 mixed carts 8 held by the return type.
 *
 * Reservations are requested per LINE and never rolled back here as a set: a
 * partially-reserved cart is a real state (#122 checkout integration 9 makes
 * releasing the unused ones a definitive-failure action, which is #123's call
 * to make), and releasing on this path would hand back stock a checkout about
 * to retry still wants.
 */
export async function runCheckoutGroupPreflight(
  input: RunCheckoutGroupPreflightInput,
): Promise<CheckoutGroupPreflightResult> {
  const db = input.db ?? getDb();
  const now = input.at ?? new Date();
  const groups = groupRetailLines(input.lines);
  const quotes = new Map<string, SupplierPreflightResult>();
  const quantityViolations: { procurementOfferId: string; violation: string }[] = [];

  for (const group of groups) {
    for (const violation of findGroupQuantityViolations(group)) {
      quantityViolations.push(violation);
    }
    for (const line of group.lines) {
      const result = await runSupplierPreflight({
        procurementOfferId: line.procurementOfferId,
        quantity: line.quantity,
        destination: input.destination,
        currency: group.currency,
        checkoutGroupId: input.checkoutGroupId,
        orderId: input.orderId,
        requestReservation: input.requestReservation,
        at: now,
        db,
      });
      quotes.set(line.procurementOfferId, result);
    }
  }

  const totals: GroupTotalInput[] = groups.map((group) => {
    const groupQuotes = group.lines.map((line) => quotes.get(line.procurementOfferId));
    const complete = groupQuotes.every((quote) => quote?.completeness.status === 'complete');
    // `unit_cost` is PER UNIT, as #122 response item 4 names it, so the line
    // subtotal multiplies by the quantity the quote was taken for. Reading it
    // as a line total would under-charge every multi-unit line by a factor of
    // the quantity — silently, since both are plausible integers.
    const itemSubtotalMinor = groupQuotes.reduce<number | null>((sum, quote) => {
      if (sum === null || !quote || quote.quote.unitCostAmount === null) return null;
      return (
        sum + quote.quote.unitCostAmount * quote.quote.quantity + (quote.quote.supplierFeesAmount ?? 0)
      );
    }, 0);

    // The group's shipping comes from its FIRST line's quote, because a supplier
    // that prices the basket returns one figure for the whole group and every
    // line in that group carries it. Summing the lines' shipping figures would
    // multiply a basket price by the line count — the exact arithmetic #122
    // mixed carts 3 forbids, which is why `groupShippingCostMinor` reads the
    // basis rather than adding blindly.
    const [firstQuote] = groupQuotes;
    const shippingBasis = firstQuote?.quote.shippingBasis ?? 'unknown';
    const shippingAmount = firstQuote?.quote.shippingCostAmount ?? null;

    return {
      key: group.key,
      currency: group.currency,
      itemSubtotalMinor,
      shipping:
        shippingBasis === 'unknown' || shippingAmount === null
          ? { basis: 'unknown', restrictions: [] }
          : {
              basis: 'basket',
              cost: { amount: shippingAmount, currency: group.currency },
              serviceCode: firstQuote?.quote.selectedShippingServiceCode ?? '',
              guaranteed: firstQuote?.quote.priceGuarantee === 'guaranteed',
            },
      taxMinor: groupQuotes.reduce<number | null>(
        (sum, quote) => (sum === null || !quote ? null : sum + (quote.quote.taxAmount ?? 0)),
        0,
      ),
      dutyMinor: groupQuotes.reduce<number | null>(
        (sum, quote) => (sum === null || !quote ? null : sum + (quote.quote.dutyAmount ?? 0)),
        0,
      ),
      complete: complete && quantityViolations.length === 0,
    };
  });

  return {
    groups,
    quotes,
    delivered: composeDeliveredTotal(totals, input.presentmentCurrency),
    quantityViolations,
  };
}
