/**
 * The pluggable verification contract (#83) — one table, no branching.
 *
 * Every property that differs between proof methods lives HERE: what the proof
 * is about, how much it is worth, whether proving it verifies the claim
 * outright, and whether this deployment can take it at all. The state machine
 * (`merchant-claim.service.ts`) reads this table and never asks "is the method
 * dns_txt", so adding a method is a row plus a verifier — which is what makes
 * the contract pluggable rather than a switch statement with six arms.
 *
 * ## The one property that is load-bearing: `autoVerifies`
 *
 * Issue acceptance 2 — "a matching email domain alone cannot complete a claim"
 * — is enforced by `role_email` carrying `autoVerifies: false`. A method with
 * that flag can reach `review_pending` and NOTHING else; only a human decision
 * moves it to `verified`, and the state machine has no path around that. There
 * is deliberately no per-claim override, because an override is exactly how a
 * low-assurance proof ends up self-verifying six months later.
 *
 * ## Availability is not membership
 *
 * A method whose prerequisites are unconfigured is UNAVAILABLE, not absent:
 * the value stays in the closed set, so the state machine, the review path,
 * the audit vocabulary and the database CHECK all exist for it before its
 * transport does. `role_email` is the live instance of that today — Mercaria
 * has no outbound email transport at all (there is no SMTP/SES client in this
 * service), and a token that cannot be delivered to the role address is not a
 * proof of anything. Issue #83 asks for a SAFE SUBSET at launch; this is how
 * the excluded member stays honest instead of being quietly dropped.
 */

import type {
  MerchantClaimAssurance,
  MerchantClaimChallengeSubjectKind,
  MerchantClaimMethod,
  MerchantClaimMethodOption,
} from '@mercaria/shared-types';
import { MERCHANT_CLAIM_METHODS } from '@mercaria/shared-types';

/** Why a method is not offered. `null` means it is. */
export type MerchantClaimMethodUnavailableReason = 'no_email_transport';

/** One row of the contract. */
export interface MerchantClaimMethodSpec {
  method: MerchantClaimMethod;
  /**
   * What the proof is ABOUT — the thing the challenge's `subject_ref` names.
   * `null` for `business_document`, which has no challenge: an operator reads
   * papers, and there is nothing for a claimant to publish or present.
   */
  subjectKind: MerchantClaimChallengeSubjectKind | null;
  assurance: MerchantClaimAssurance;
  /** Whether a successful proof reaches `verified` without a reviewer. */
  autoVerifies: boolean;
  /**
   * Whether the claimant carries the one-time token themselves. True for the
   * methods where the token IS the proof (published in DNS, served from the
   * site, mailed to a role address); false where the proof is a platform
   * credential the claimant already holds.
   */
  tokenIsCarriedByClaimant: boolean;
  /** `null` when the method is offered on this deployment. */
  unavailableReason: MerchantClaimMethodUnavailableReason | null;
}

/**
 * The contract itself.
 *
 * Assurance reasoning, per row rather than in the abstract:
 *
 *  - `dns_txt` — publishing a TXT record under a zone requires control of the
 *    zone's nameservers, which no HTTP-level compromise gives you. `high`.
 *  - `well_known_file` / `meta_tag` — control of what the site SERVES. Real
 *    control, one rung down: a CDN misconfiguration, a shared host or an
 *    upload path can produce it without the zone. `standard`.
 *  - `platform_oauth` — the platform already authenticated this account
 *    against the shop, and Mercaria holds the connection that flow produced.
 *    `high`, and scoped to THAT shop (issue scope rule 2).
 *  - `channel_key` — possession of a Mercaria-minted key bound to one site and
 *    one connection. Same strength as the connection it is bound to. `high`.
 *  - `role_email` — an address at the domain, which the issue itself calls
 *    lower-assurance. `low`, and never auto-verifying.
 *  - `business_document` — papers a human reads. `standard`, and by
 *    construction a review: there is no automatic step to skip.
 */
const SPECS: Readonly<Record<MerchantClaimMethod, MerchantClaimMethodSpec>> = Object.freeze({
  dns_txt: {
    method: 'dns_txt',
    subjectKind: 'domain',
    assurance: 'high',
    autoVerifies: true,
    tokenIsCarriedByClaimant: true,
    unavailableReason: null,
  },
  well_known_file: {
    method: 'well_known_file',
    subjectKind: 'domain',
    assurance: 'standard',
    autoVerifies: true,
    tokenIsCarriedByClaimant: true,
    unavailableReason: null,
  },
  meta_tag: {
    method: 'meta_tag',
    subjectKind: 'domain',
    assurance: 'standard',
    autoVerifies: true,
    tokenIsCarriedByClaimant: true,
    unavailableReason: null,
  },
  platform_oauth: {
    method: 'platform_oauth',
    subjectKind: 'connection',
    assurance: 'high',
    autoVerifies: true,
    tokenIsCarriedByClaimant: false,
    unavailableReason: null,
  },
  channel_key: {
    method: 'channel_key',
    subjectKind: 'connection',
    assurance: 'high',
    autoVerifies: true,
    tokenIsCarriedByClaimant: false,
    unavailableReason: null,
  },
  role_email: {
    method: 'role_email',
    subjectKind: 'email',
    assurance: 'low',
    autoVerifies: false,
    tokenIsCarriedByClaimant: true,
    // Mercaria has no outbound email transport. Until one exists the token
    // cannot reach the role address, so the method is registered and refused
    // rather than offered and broken.
    unavailableReason: 'no_email_transport',
  },
  business_document: {
    method: 'business_document',
    subjectKind: null,
    assurance: 'standard',
    autoVerifies: false,
    tokenIsCarriedByClaimant: false,
    unavailableReason: null,
  },
});

/** The spec for a method. Total over the closed set, so it cannot return undefined. */
export function methodSpec(method: MerchantClaimMethod): MerchantClaimMethodSpec {
  return SPECS[method];
}

/** Whether this deployment offers a method at all. */
export function isMethodAvailable(method: MerchantClaimMethod): boolean {
  return SPECS[method].unavailableReason === null;
}

/**
 * Whether a method's proof, once made, verifies the claim outright.
 *
 * The `autoVerifies` read the state machine makes, named so the acceptance
 * criterion it enforces is greppable from the test that pins it.
 */
export function methodAutoVerifies(method: MerchantClaimMethod): boolean {
  return SPECS[method].autoVerifies;
}

/** How much a method's proof is worth — DERIVED, never a stored column. */
export function methodAssurance(method: MerchantClaimMethod): MerchantClaimAssurance {
  return SPECS[method].assurance;
}

/**
 * The methods a client may offer, in the closed set's own order so the list is
 * stable across requests. An unavailable method is omitted entirely rather
 * than sent with a flag — a disabled option a user can click is worse than one
 * they never see.
 */
export function availableMethodOptions(): MerchantClaimMethodOption[] {
  return MERCHANT_CLAIM_METHODS.filter(isMethodAvailable).map((method) => {
    const spec = SPECS[method];
    return {
      method: spec.method,
      assurance: spec.assurance,
      autoVerifies: spec.autoVerifies,
      subjectKind: spec.subjectKind,
    };
  });
}
