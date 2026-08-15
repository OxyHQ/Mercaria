import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ShoppingAgent,
  ShoppingAgentFinding,
  ShoppingAgentSplitResolution,
} from '@mercaria/shared-types';
import { useOxy } from '@oxyhq/services';
import {
  deleteShoppingAgent,
  fetchShoppingAgent,
  fetchShoppingAgentFindings,
  fetchShoppingAgents,
  requestShoppingAgentRun,
  resolveShoppingAgentSplit,
  updateShoppingAgentState,
  type ShoppingAgentStatePatch,
} from '../api/shopping-agents';
import { queryKeys } from './query-keys';

/**
 * Saved shopping agents (#97) — the shopper's own objectives.
 *
 * ## Everything is gated on `canUsePrivateApi`, not on `isAuthenticated`
 *
 * The device-first cold boot can take seconds to restore a session and every
 * call here is user-delegated, so until it settles there is no session to make
 * the request under. Firing anyway would 401 — the same gate the saves and
 * price-alert hooks already use.
 *
 * ## Invalidation reaches the PREFIX
 *
 * Pausing, resuming, removing, asking for another look and answering a split all
 * change the list AND the open agent AND its timeline. One prefix key covers
 * every read, so no write has to remember which of the three it touched.
 *
 * ## Nothing here polls
 *
 * An agent evaluates when the catalogue moves under it, which can be minutes or
 * days away; a client that polled for it would spend a shopper's battery waiting
 * for something that arrives as a notification. Asking for one look now
 * invalidates the timeline once and the answer lands on the next read.
 */

/** Ten seconds — a personal surface that re-reads cheaply. */
const STALE_TIME = 1000 * 10;

/** Every agent this account has saved. */
export function useShoppingAgents() {
  const { canUsePrivateApi } = useOxy();

  return useQuery<ShoppingAgent[]>({
    queryKey: queryKeys.shoppingAgents.all,
    enabled: canUsePrivateApi,
    staleTime: STALE_TIME,
    queryFn: () => fetchShoppingAgents(),
  });
}

/**
 * One agent, re-read when the shopper opens it.
 *
 * The list already carries the whole row, so this exists for the case the list
 * cannot cover: a manual look, a pause or a split answer changes the agent while
 * it is open, and the row a shopper is reading should be the one the timeline
 * beside it was produced under.
 */
export function useShoppingAgent(agentId?: string) {
  const { canUsePrivateApi } = useOxy();

  return useQuery<ShoppingAgent>({
    queryKey: queryKeys.shoppingAgents.detail(agentId ?? ''),
    enabled: canUsePrivateApi && agentId !== undefined && agentId.length > 0,
    staleTime: STALE_TIME,
    queryFn: () => fetchShoppingAgent(agentId ?? ''),
  });
}

/** One agent's appended observations, newest first as the server returns them. */
export function useShoppingAgentFindings(agentId?: string) {
  const { canUsePrivateApi } = useOxy();

  return useQuery<ShoppingAgentFinding[]>({
    queryKey: queryKeys.shoppingAgents.findings(agentId ?? ''),
    enabled: canUsePrivateApi && agentId !== undefined && agentId.length > 0,
    staleTime: STALE_TIME,
    queryFn: () => fetchShoppingAgentFindings(agentId ?? ''),
  });
}

/** Invalidate every shopping-agent read — see the module docblock. */
function useInvalidateShoppingAgents() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.shoppingAgents.all });
  };
}

/** Pause an agent, or resume a paused one. The two states a shopper decides. */
export function useUpdateShoppingAgentState() {
  const invalidate = useInvalidateShoppingAgents();
  return useMutation({
    mutationFn: (input: { agentId: string; state: ShoppingAgentStatePatch }) =>
      updateShoppingAgentState(input.agentId, input.state),
    onSuccess: invalidate,
  });
}

export function useDeleteShoppingAgent() {
  const invalidate = useInvalidateShoppingAgents();
  return useMutation({
    mutationFn: (agentId: string) => deleteShoppingAgent(agentId),
    onSuccess: invalidate,
  });
}

/**
 * Ask for one evaluation now (#97 UX 5).
 *
 * The answer is a finding, not a response body, so success here means the
 * request was accepted and the invalidation is what eventually shows it.
 */
export function useRunShoppingAgentNow() {
  const invalidate = useInvalidateShoppingAgents();
  return useMutation({
    mutationFn: (agentId: string) => requestShoppingAgentRun(agentId),
    onSuccess: invalidate,
  });
}

/** Answer a catalogue split — which of the two products the agent meant. */
export function useResolveShoppingAgentSplit() {
  const invalidate = useInvalidateShoppingAgents();
  return useMutation({
    mutationFn: (input: { agentId: string; resolution: ShoppingAgentSplitResolution }) =>
      resolveShoppingAgentSplit(input.agentId, input.resolution),
    onSuccess: invalidate,
  });
}
