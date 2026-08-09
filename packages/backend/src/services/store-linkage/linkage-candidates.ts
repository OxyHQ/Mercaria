/**
 * Which native stores could be this merchant — as a PURE function over ids and
 * proven facts (#84 linkage cases 1–4).
 *
 * ## This is the file "no name-only automatic linkage" is about
 *
 * Everything a candidate can be proposed FOR arrives as a parameter below, and
 * not one of those parameters is a name. There is no store name, no merchant
 * name, no handle, no slug, no similarity function and no threshold — so a
 * name-based proposal is not refused here, it is unconstructible. That is the
 * fourth of the four walls (`shared-types/src/store-linkage.ts` names the other
 * three: the vocabulary has no `name_match` source, the schema has no name or
 * score column, and every request schema is `.strict()` and carries ids only).
 *
 * `store-linkage-isolation.test.ts` scans this module for the identifiers a
 * name-based path would need, so the property survives a refactor rather than
 * resting on the current author's discipline.
 *
 * ## Evidence, ranked, with the ranking stated once
 *
 * A store can be proposed by more than one fact at a time — a claimant who runs
 * the store AND proved its domain. {@link CANDIDATE_SOURCE_STRENGTH} is the
 * total order that decides which fact the candidate row records, so
 * rediscovering the same store twice converges on the same source rather than
 * on whichever fact happened to be evaluated last.
 */

import {
  STORE_LINKAGE_AUTO_LINK_SOURCES,
  type StoreLinkageCandidateSource,
} from '@mercaria/shared-types';

/**
 * The facts the caller has PROVEN or READ, per store. Ids and roles only.
 *
 * `hasStoreManage` is Mercaria's own membership fact, resolved from
 * `store_members` through the existing effective-permission matrix — not a
 * guess and not a name. `connectedDomains` are the hostnames the store's
 * connector connections actually report; `connectionIds` the connections
 * themselves.
 */
export interface CandidateStoreFacts {
  storeId: string;
  /** Whether the claimant holds `store:manage` on this store today. */
  hasStoreManage: boolean;
  /** Normalized lowercase hostnames this store's channels are addressed by. */
  connectedDomains: readonly string[];
  /** Connector connection ids this store owns. */
  connectionIds: readonly string[];
}

/** What the verified claim actually proved, in the vocabulary this file reads. */
export interface ProvenClaimFacts {
  /** Hostnames the claim proved control of. Already normalized. */
  verifiedDomains: readonly string[];
  /** The connector connection whose OAuth round trip the claim consumed, if any. */
  provenConnectionId: string | null;
  /** #83's `merchant_claims.native_store_id` — an INTENT the claimant recorded. */
  intendedStoreId: string | null;
  /** A store id the claimant named on THIS request. Also an intent. */
  namedStoreId: string | null;
}

/** One proposal: which store, on what evidence, and whether it can link alone. */
export interface DiscoveredCandidate {
  storeId: string;
  source: StoreLinkageCandidateSource;
  /** The proven fact itself — a hostname, a connection id, or NULL for an intent. */
  evidenceRef: string | null;
  autoLinkable: boolean;
}

/**
 * The total order over evidence, strongest first.
 *
 * A proof of the store's own domain outranks a proof of its platform account,
 * which outranks Mercaria's own membership record, which outranks either of the
 * two INTENTS — a store the claimant named on the claim, or on this request.
 * `operator` sits at the top because a person looked at all of it.
 *
 * Stated as a list rather than as comparisons, so "which evidence wins" is one
 * thing to read and one thing to change.
 */
export const CANDIDATE_SOURCE_STRENGTH: readonly StoreLinkageCandidateSource[] = [
  'operator',
  'claim_verified_domain',
  'claim_platform_connection',
  'claimant_store_membership',
  'claim_native_store_intent',
  'claimant_named',
];

function strengthOf(source: StoreLinkageCandidateSource): number {
  const index = CANDIDATE_SOURCE_STRENGTH.indexOf(source);
  // A source missing from the order would silently sort first and quietly
  // outrank a real proof, so an unranked value is a build-time-visible throw
  // rather than a default.
  if (index === -1) {
    throw new Error(`Unranked candidate source: ${source}. Add it to CANDIDATE_SOURCE_STRENGTH.`);
  }
  return index;
}

/**
 * Whether one hostname is covered by another, LABEL-wise.
 *
 * The same containment `claim-scope.ts` uses, and for the same reason: a
 * substring test makes `notapple.com` a subdomain of `apple.com`. It is spelled
 * again here rather than imported because importing it would make this module
 * depend on the merchant-claim domain, which `relationship-isolation.test.ts`
 * scans in the other direction — and the rule is four tokens long, so the
 * duplication is cheaper than the coupling. Both are pinned by their own tests.
 */
function domainCoveredBy(candidate: string, proven: string): boolean {
  return candidate === proven || candidate.endsWith(`.${proven}`);
}

/**
 * Discover the candidate stores for one request.
 *
 * Every store the caller supplies facts for is considered; a store the claimant
 * cannot manage is DROPPED entirely rather than proposed and refused later,
 * because a proposal a claimant may not act on is an answer to "does this store
 * exist" that the surface has no business giving.
 *
 * The result is sorted by evidence strength then store id, so two runs over the
 * same facts produce the same order — which is what lets the caller treat
 * `[0]` as "the one to link" without a tie ever being decided by a hash.
 */
export function discoverLinkageCandidates(input: {
  claim: ProvenClaimFacts;
  stores: readonly CandidateStoreFacts[];
}): DiscoveredCandidate[] {
  const best = new Map<string, DiscoveredCandidate>();

  const consider = (
    storeId: string,
    source: StoreLinkageCandidateSource,
    evidenceRef: string | null,
  ): void => {
    const incumbent = best.get(storeId);
    if (incumbent && strengthOf(incumbent.source) <= strengthOf(source)) return;
    best.set(storeId, {
      storeId,
      source,
      evidenceRef,
      autoLinkable: STORE_LINKAGE_AUTO_LINK_SOURCES.includes(source),
    });
  };

  for (const store of input.stores) {
    // The floor: without `store:manage` the claimant cannot link this store at
    // all (issue existing-store rule 1), so it is not a candidate — it is
    // somebody else's store.
    if (!store.hasStoreManage) continue;

    consider(store.storeId, 'claimant_store_membership', null);

    for (const domain of store.connectedDomains) {
      const proven = input.claim.verifiedDomains.find((verified) =>
        domainCoveredBy(domain, verified),
      );
      if (proven !== undefined) consider(store.storeId, 'claim_verified_domain', domain);
    }

    if (
      input.claim.provenConnectionId !== null &&
      store.connectionIds.includes(input.claim.provenConnectionId)
    ) {
      consider(store.storeId, 'claim_platform_connection', input.claim.provenConnectionId);
    }
  }

  // The two INTENTS are recorded only for stores that already cleared the
  // membership floor above: naming a store you cannot manage proposes nothing,
  // and must not even confirm the id exists.
  const manageable = new Set(
    input.stores.filter((store) => store.hasStoreManage).map((store) => store.storeId),
  );
  if (input.claim.intendedStoreId !== null && manageable.has(input.claim.intendedStoreId)) {
    consider(input.claim.intendedStoreId, 'claim_native_store_intent', null);
  }
  if (input.claim.namedStoreId !== null && manageable.has(input.claim.namedStoreId)) {
    consider(input.claim.namedStoreId, 'claimant_named', null);
  }

  return [...best.values()].sort(
    (a, b) => strengthOf(a.source) - strengthOf(b.source) || a.storeId.localeCompare(b.storeId),
  );
}

/**
 * Which candidate a request should link to WITHOUT a person looking, if any.
 *
 * Three outcomes, and the middle one is issue case 3:
 *
 *  - exactly one candidate the claimant NAMED — that one, whatever its
 *    evidence, because naming a store you hold `store:manage` on under a
 *    verified claim IS the conjunction the issue asks for (existing-store rule
 *    1). The intent alone is never enough; the permission and the verified
 *    claim are what carry it, and both are established before this is called.
 *  - exactly one candidate overall — that one.
 *  - more than one and none named — NOTHING. Several native stores may be this
 *    merchant and a person has to choose, which is the case the whole review
 *    path exists for.
 */
export function selectAutomaticCandidate(input: {
  candidates: readonly DiscoveredCandidate[];
  namedStoreId: string | null;
}): DiscoveredCandidate | null {
  if (input.namedStoreId !== null) {
    return input.candidates.find((c) => c.storeId === input.namedStoreId) ?? null;
  }
  const [only] = input.candidates;
  return input.candidates.length === 1 && only ? only : null;
}
