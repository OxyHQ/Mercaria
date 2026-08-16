/**
 * Tying a network-reported transaction to a Mercaria click — or refusing to
 * (#67 conversion requirement 6).
 *
 * ## Every real transaction is `unmatched` today, and that is a MEASURED fact
 *
 * `AFFILIATE_CLICK_REFERENCE_SUPPORT` records both networks as `not_supported`,
 * and it is not an omission: #65 forbids composing or mutating an EPN link and
 * #66 forbids composing an Awin one, because attribution lives entirely in the
 * network's own parameters and a rebuilt link is indistinguishable from a
 * working one until a month of revenue is missing. Mercaria therefore sends no
 * per-click reference, so there is nothing for a network to echo back, so
 * `network_supplies_no_reference` is the answer for every transaction either
 * network reports.
 *
 * That is requirement 6 satisfied ("marked as unmatched rather than guessed"),
 * not deferred. The function below is complete and every branch is exercised —
 * `referenceSupport` is an ARGUMENT rather than a lookup precisely so the
 * `publisher_supplied` branches can be driven directly, including the one where
 * a reference resolves to a real click.
 *
 * **What would close it**, exactly: a network whose contract grants a publisher
 * reference (Awin's `clickref`, which its own terms currently reserve to links
 * the publisher composes) would need (a) that member flipped to
 * `publisher_supplied` in shared-types, (b) the redirect appending the Mercaria
 * click id to the destination it hands over — which is the operation #66's
 * `AWIN_FORBIDDEN_ADVERTISER_CLAIMS` and #65's `EBAY_FORBIDDEN_LINK_OPERATIONS`
 * forbid today — and (c) a resolver reading `affiliate_outbound_clicks` by id.
 * Nothing in THIS file changes.
 *
 * ## There is no third match state and no confidence score
 *
 * `AffiliateMatchState` has two members. A `probable` would be exactly where a
 * guess would live, and a guess here attributes somebody else's conversion to a
 * click Mercaria happened to record near it — which reads as a working
 * attribution system and is discovered, if ever, by a partner disputing a
 * statement.
 */

import type {
  AffiliateClickReferenceSupport,
  AffiliateNetworkId,
  AffiliateUnmatchedReason,
} from '@mercaria/shared-types';

/**
 * A Mercaria click a reference resolved to.
 *
 * `network` is the network the CLICK was recorded against — free text on
 * `affiliate_outbound_clicks.affiliate_network`, mirroring what the offer
 * declared — and it is here so the mismatch case can be told apart from the
 * unknown one.
 */
export interface ResolvedAffiliateClick {
  readonly id: string;
  readonly network: string | null;
}

/**
 * A STRING discriminant, not a boolean.
 *
 * This package compiles with `strict: false`, so TypeScript does not narrow a
 * union on the truthiness of a boolean-literal discriminant — `if
 * (!outcome.matched)` would leave the caller holding both branches and unable
 * to read either payload (#68's finding, and #110's, hit again here).
 */
export type AffiliateMatchOutcome =
  | { readonly state: 'matched'; readonly clickId: string }
  | { readonly state: 'unmatched'; readonly reason: AffiliateUnmatchedReason };

/**
 * Decide whether a reported transaction is attributable to a Mercaria click.
 *
 * PURE. The caller reads `AFFILIATE_CLICK_REFERENCE_SUPPORT[network]` and
 * resolves the click; this decides, and it decides in one place so that the
 * four unmatched reasons stay four distinguishable facts rather than one
 * message with four spellings.
 *
 * The order is load-bearing:
 *
 * 1. **The adapter contract first.** When Mercaria supplies no reference,
 *    anything the network echoed is somebody else's value or a coincidence, and
 *    reporting `no_reference_reported` for it would read as the network having
 *    DROPPED something it was sent — sending an operator to check an
 *    integration that is behaving exactly as designed.
 * 2. No reference on the row.
 * 3. A reference that names no click Mercaria recorded.
 * 4. A reference that names a click recorded against a DIFFERENT network. Kept
 *    apart from (3) because they mean opposite things: one is a stranger's
 *    value, the other is a Mercaria click being claimed by the wrong network,
 *    which is a routing fault worth an alarm.
 */
export function matchReportedTransaction(input: {
  readonly network: AffiliateNetworkId;
  readonly referenceSupport: AffiliateClickReferenceSupport;
  readonly networkClickRef: string | null;
  /** The click the reference named, resolved by the caller; `null` when none did. */
  readonly resolvedClick: ResolvedAffiliateClick | null;
}): AffiliateMatchOutcome {
  if (input.referenceSupport === 'not_supported') {
    return { state: 'unmatched', reason: 'network_supplies_no_reference' };
  }
  if (input.networkClickRef === null || input.networkClickRef.trim() === '') {
    return { state: 'unmatched', reason: 'no_reference_reported' };
  }
  if (input.resolvedClick === null) {
    return { state: 'unmatched', reason: 'reference_not_recognized' };
  }
  if (input.resolvedClick.network !== input.network) {
    return { state: 'unmatched', reason: 'reference_network_mismatch' };
  }
  return { state: 'matched', clickId: input.resolvedClick.id };
}

/**
 * How a resolver is supplied, for the day a network's contract grants a
 * reference.
 *
 * A PORT rather than a direct read of `affiliate_outbound_clicks`: the click
 * record is #67's redirect half and this is its reconciliation half, and the
 * two meet at exactly one narrow question — "is this string a click id I
 * recorded, and for which network". Nothing else about a click reaches here,
 * which is what keeps a commercial record free of a per-request row it has no
 * business reading.
 *
 * There is deliberately NO default implementation. A default that answered
 * `null` would be indistinguishable from a resolver that looked and found
 * nothing, and `reference_not_recognized` would then be reported for a lookup
 * nobody performed. The caller consults a resolver only when the network's
 * support is `publisher_supplied`, so today it is never consulted at all.
 */
export type AffiliateClickResolver = (input: {
  readonly network: AffiliateNetworkId;
  readonly reference: string;
}) => Promise<ResolvedAffiliateClick | null>;

let clickResolver: AffiliateClickResolver | undefined;

/** Register the resolver. Called by the redirect half when a network gains a reference. */
export function registerAffiliateClickResolver(resolver: AffiliateClickResolver): void {
  clickResolver = resolver;
}

/** Drop the registration. For tests, which must be able to drive both states. */
export function resetAffiliateClickResolver(): void {
  clickResolver = undefined;
}

/**
 * Resolve a reference, or answer that nothing looked.
 *
 * A STRING discriminant again, and `not_supported` is a genuinely different
 * answer from `not_found`: the first says Mercaria never sent a reference, the
 * second says it sent one and cannot place what came back.
 */
export type AffiliateClickLookup =
  | { readonly outcome: 'not_supported' }
  | { readonly outcome: 'resolver_unavailable' }
  | { readonly outcome: 'resolved'; readonly click: ResolvedAffiliateClick | null };

/**
 * Ask the registered resolver, when the network supports a reference at all.
 *
 * `resolver_unavailable` is reported rather than treated as "no click": a
 * deployment whose redirect half is not wired up must not be able to publish
 * `reference_not_recognized` about references it never looked up.
 */
export async function lookupAffiliateClick(input: {
  readonly network: AffiliateNetworkId;
  readonly referenceSupport: AffiliateClickReferenceSupport;
  readonly reference: string | null;
}): Promise<AffiliateClickLookup> {
  if (input.referenceSupport === 'not_supported') return { outcome: 'not_supported' };
  if (input.reference === null || input.reference.trim() === '') {
    return { outcome: 'resolved', click: null };
  }
  if (!clickResolver) return { outcome: 'resolver_unavailable' };
  const click = await clickResolver({ network: input.network, reference: input.reference });
  return { outcome: 'resolved', click };
}
