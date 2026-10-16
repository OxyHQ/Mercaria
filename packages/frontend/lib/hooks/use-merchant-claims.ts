import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services';
import type {
  MerchantClaim,
  MerchantClaimChallengeInstructions,
  MerchantClaimMethod,
} from '@mercaria/shared-types';
import { MERCHANT_CLAIM_ACTIVE_STATES } from '@mercaria/shared-types';
import {
  contestMerchantClaim,
  fetchMyMerchantClaims,
  issueMerchantClaimChallenge,
  openMerchantClaim,
  submitMerchantClaim,
  type MerchantClaimEvidenceInput,
  verifyMerchantClaim,
} from '../api/merchant-claims';
import { queryKeys } from './query-keys';

/**
 * The claimant's merchant-claim state (#83), for the claim flow.
 *
 * ## Every mutation writes the server's answer back
 *
 * Each response is the claim as it now stands, so it REPLACES the cached row
 * rather than being merged into it: the flow renders whatever state the server
 * says, and a client that guessed the next state would be a second state
 * machine to keep in step with the real one.
 *
 * ## No mutation retries
 *
 * The app default retries a mutation once. Here that would be wrong for every
 * call: a retried challenge supersedes the one just shown, a retried verify
 * spends attempt budget, and a retried open or contest answers 409 for the
 * claim the first try already created.
 */

/** Ten seconds — a claim moves when a reviewer acts, never on a timer the client sees. */
const STALE_TIME = 1000 * 10;

/**
 * The states in which a claim on a merchant is still the one to show: every
 * LIVE state (the server's own tuple) plus the merchant's current verification.
 */
const CURRENT_STATES: ReadonlySet<MerchantClaim['state']> = new Set([
  ...MERCHANT_CLAIM_ACTIVE_STATES,
  'verified',
]);

/** The caller's claim on this merchant that is live or verified, if any. */
export function currentClaimFor(
  claims: readonly MerchantClaim[] | undefined,
  merchantId: string,
): MerchantClaim | undefined {
  return claims?.find(
    (claim) => claim.merchantId === merchantId && CURRENT_STATES.has(claim.state),
  );
}

/** The caller's most recent claim on this merchant that has ENDED (rejected, expired, revoked). */
export function endedClaimFor(
  claims: readonly MerchantClaim[] | undefined,
  merchantId: string,
): MerchantClaim | undefined {
  return claims?.find(
    (claim) => claim.merchantId === merchantId && !CURRENT_STATES.has(claim.state),
  );
}

/** Put the server's copy of one claim into the list, newest first. */
function storeClaim(client: QueryClient, claim: MerchantClaim): void {
  client.setQueryData<MerchantClaim[]>(queryKeys.merchantClaims.mine, (current) => [
    claim,
    ...(current ?? []).filter((row) => row.id !== claim.id),
  ]);
}

export function useMyMerchantClaims(enabled: boolean) {
  const { canUsePrivateApi } = useOxy();
  return useQuery<MerchantClaim[]>({
    queryKey: queryKeys.merchantClaims.mine,
    queryFn: fetchMyMerchantClaims,
    enabled: enabled && canUsePrivateApi,
    staleTime: STALE_TIME,
  });
}

/**
 * The challenge instructions issued for a claim in this session.
 *
 * Never fetched — there is no endpoint that returns a token twice — so the
 * query exists only to READ what `useIssueMerchantClaimChallenge` stored, and
 * `gcTime: Infinity` keeps it for as long as the app is open, since a DNS
 * record can take longer to propagate than the default cache lifetime.
 */
export function useMerchantClaimChallenge(claimId: string | undefined) {
  return useQuery<MerchantClaimChallengeInstructions | null>({
    queryKey: queryKeys.merchantClaims.challenge(claimId ?? ''),
    queryFn: () => null,
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * Open a claim and, for a proof that needs one, issue its first challenge — as
 * ONE pending action, so the claimant goes from "Continue" straight to the
 * instructions without passing through an intermediate step.
 *
 * `afterOpen` runs inside the mutation, the moment the claim exists, whatever
 * happens to the component that started it (the step it renders is replaced as
 * soon as the claim list changes). It is the caller's hook for work that must
 * follow an open and must never hold it up; its result is not awaited.
 *
 * When the open succeeds and the challenge does not, the claim is a `draft` on
 * the server; the list is re-read either way, so the flow resumes at "get a
 * code" rather than offering to open a second claim the server would refuse.
 */
export function useStartMerchantClaim(afterOpen?: (claim: MerchantClaim) => void) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      merchantId: string;
      method: MerchantClaimMethod;
      domain?: string;
      withChallenge: boolean;
    }) => {
      const claim = await openMerchantClaim({
        merchantId: input.merchantId,
        method: input.method,
        ...(input.domain !== undefined ? { domain: input.domain } : {}),
      });
      afterOpen?.(claim);
      const instructions = input.withChallenge
        ? await issueMerchantClaimChallenge(claim.id)
        : undefined;
      return { claim, instructions };
    },
    retry: 0,
    onSuccess: async ({ claim, instructions }) => {
      if (instructions) {
        client.setQueryData(queryKeys.merchantClaims.challenge(claim.id), instructions);
      } else {
        storeClaim(client, claim);
      }
      // Issuing moved the claim to `challenge_pending` and that response carries
      // instructions rather than the claim, so the list is re-read — awaited, so
      // the action stays pending until the step it leads to can render.
      await client.invalidateQueries({ queryKey: queryKeys.merchantClaims.mine });
    },
    onError: () => client.invalidateQueries({ queryKey: queryKeys.merchantClaims.mine }),
  });
}

/** Issue a new challenge for an existing claim (the first one, or a replacement). */
export function useIssueMerchantClaimChallenge() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (claim: MerchantClaim) => issueMerchantClaimChallenge(claim.id),
    retry: 0,
    onSuccess: async (instructions, claim) => {
      client.setQueryData(queryKeys.merchantClaims.challenge(claim.id), instructions);
      await client.invalidateQueries({ queryKey: queryKeys.merchantClaims.mine });
    },
  });
}

export function useVerifyMerchantClaim() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { claimId: string; token: string }) => verifyMerchantClaim(input),
    retry: 0,
    onSuccess: (claim) => {
      storeClaim(client, claim);
      // A verified claim changes the merchant's public standing.
      void client.invalidateQueries({ queryKey: ['merchants', 'page'] });
    },
    // A refusal can also have moved the claim (an expired challenge is
    // recorded), so the list is re-read either way.
    onError: () => void client.invalidateQueries({ queryKey: queryKeys.merchantClaims.mine }),
  });
}

export function useSubmitMerchantClaim() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { claimId: string; evidence: readonly MerchantClaimEvidenceInput[] }) =>
      submitMerchantClaim(input),
    retry: 0,
    onSuccess: (claim) => storeClaim(client, claim),
  });
}

export function useContestMerchantClaim() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      merchantId: string;
      reason: string;
      evidence?: readonly MerchantClaimEvidenceInput[];
    }) => contestMerchantClaim(input),
    retry: 0,
    onSuccess: (claim) => storeClaim(client, claim),
  });
}
