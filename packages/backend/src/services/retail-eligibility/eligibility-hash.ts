/**
 * The eligibility decision's content hash (#121 acceptance 7) — PURE.
 *
 * "Every eligibility result is reproducible from versioned policy and evidence"
 * needs an identity a later read can verify: re-run the derivation against the
 * same policy version and the same evidence rows, hash it, and compare. Two
 * runs that agree produce the same digest; one that does not is a change
 * somebody has to explain.
 *
 * ## Determinism is the whole contract
 *
 * The `retail-quote-hash.ts` rule verbatim, one domain over: nothing may vary
 * between two hashings of one answer. Reasons and evidence ids are sorted
 * rather than trusted in arrival order (the derivation already sorts them —
 * this restates the requirement rather than relying on it), every number is
 * serialized as a string, the clock is never read here, and an absent optional
 * serializes as the empty string, which is a value and not a hole.
 *
 * ## What the hash covers, and why the evaluation time does not
 *
 * It covers the QUESTION, the policy version, the verdict, the reasons, the
 * action, the evidence the answer rested on and any exception applied. It does
 * NOT cover `evaluated_at`: two evaluations a minute apart that read the same
 * facts and reached the same conclusion ARE the same answer, and a digest that
 * moved with the clock would make "did anything change?" unanswerable — which
 * is the one question the hash exists to answer.
 */

import { createHash } from 'node:crypto';
import type {
  CurrencyCode,
  RetailCustomerType,
  RetailEligibilityAction,
  RetailEligibilityEvidenceRef,
  RetailEligibilityReason,
  RetailEligibilityVerdict,
  RetailFulfilmentMethod,
} from '@mercaria/shared-types';

/** Everything one decision's identity is composed from. */
export interface RetailEligibilityHashInput {
  policyKey: string;
  policyVersion: number;
  procurementOfferId: string;
  canonicalVariantId: string | null;
  destinationCountry: string;
  fulfilmentOriginCountry: string | null;
  channel: string;
  currency: CurrencyCode;
  quantity: number;
  fulfilmentMethod: RetailFulfilmentMethod;
  customerType: RetailCustomerType;
  verdict: RetailEligibilityVerdict;
  reasons: readonly RetailEligibilityReason[];
  nextRequiredAction: RetailEligibilityAction;
  evidence: readonly RetailEligibilityEvidenceRef[];
  appliedExceptionId: string | null;
}

/** The field separator. A control character, so no value can contain one. */
const FIELD = '\u001f';

/** The record separator between evidence references. */
const RECORD = '\u001e';

/** An absent optional is the EMPTY STRING — a value, never a skipped field. */
function opt(value: string | null | undefined): string {
  return value ?? '';
}

/**
 * The canonical serialization. Exported so a mismatch can be DIAGNOSED — an
 * operator comparing two decisions needs to see which field moved, and a hash
 * alone never tells anyone that.
 */
export function serializeRetailEligibilityDecision(input: RetailEligibilityHashInput): string {
  const evidence = input.evidence
    .map((ref) => [ref.registry, ref.id, ref.kind, ref.state, opt(ref.expiresAt)].join(FIELD))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  return [
    'mercaria.retail.eligibility-decision.v1',
    input.policyKey,
    String(input.policyVersion),
    input.procurementOfferId,
    opt(input.canonicalVariantId),
    input.destinationCountry,
    opt(input.fulfilmentOriginCountry),
    input.channel,
    input.currency,
    String(input.quantity),
    input.fulfilmentMethod,
    input.customerType,
    input.verdict,
    [...input.reasons].sort().join(','),
    input.nextRequiredAction,
    opt(input.appliedExceptionId),
    evidence.join(RECORD),
  ].join(FIELD);
}

/** The sha-256 hex digest of {@link serializeRetailEligibilityDecision}. */
export function hashRetailEligibilityDecision(input: RetailEligibilityHashInput): string {
  return createHash('sha256')
    .update(serializeRetailEligibilityDecision(input), 'utf8')
    .digest('hex');
}
