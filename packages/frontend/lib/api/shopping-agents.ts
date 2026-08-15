import type {
  ApiResponse,
  ShoppingAgent,
  ShoppingAgentFinding,
  ShoppingAgentSplitResolution,
} from '@mercaria/shared-types';
import apiClient from './client';

/**
 * Saved shopping agents API client (#97) — the READ and MANAGE half.
 *
 * ## Nothing here can act on a shopper's behalf, and the module surface is why
 *
 * Six calls: list, read one, read its findings, pause or resume it, remove it,
 * ask for one look now, and answer a catalogue split. There is no request body
 * anywhere in this file that could carry a destination, an amount, a method or a
 * merchant, so no call site of it can compose one.
 *
 * ## The two READS unwrap and the four WRITES only assert success
 *
 * A read has a documented payload and a client that silently accepted a
 * different one would render an empty list as a working list. A write is
 * followed by an invalidation of the whole `shopping-agents` prefix, so its
 * response body is not the source of anything on screen — and `unwrap`ping a
 * body whose shape is not part of the contract (a 202 with no `data`, a delete
 * answering `{deleted}` or `{agent}`) would turn a successful write into an
 * error message about a write that happened.
 */

/** Unwrap the Mercaria envelope, or throw with whatever the server said. */
function unwrap<T>(body: ApiResponse<T>, fallback: string): T {
  if (!body.success || body.data === undefined) {
    throw new Error(body.error ?? body.message ?? fallback);
  }
  return body.data;
}

/**
 * Accept any 2xx envelope that does not declare a failure.
 *
 * axios has already thrown for a non-2xx status, so what is left is a body that
 * says `success: false` under a 200 — the one failure this layer still has to
 * notice.
 */
function assertOk(body: ApiResponse<unknown>, fallback: string): void {
  if (body.success === false) {
    throw new Error(body.error ?? body.message ?? fallback);
  }
}

export async function fetchShoppingAgents(): Promise<ShoppingAgent[]> {
  const { data } = await apiClient.get<ApiResponse<{ agents: ShoppingAgent[] }>>(
    '/shopping-agents',
  );
  return unwrap(data, 'Failed to load your shopping agents').agents;
}

export async function fetchShoppingAgent(agentId: string): Promise<ShoppingAgent> {
  const { data } = await apiClient.get<ApiResponse<{ agent: ShoppingAgent }>>(
    `/shopping-agents/${agentId}`,
  );
  return unwrap(data, 'Failed to load that shopping agent').agent;
}

export async function fetchShoppingAgentFindings(
  agentId: string,
): Promise<ShoppingAgentFinding[]> {
  const { data } = await apiClient.get<ApiResponse<{ findings: ShoppingAgentFinding[] }>>(
    `/shopping-agents/${agentId}/findings`,
  );
  return unwrap(data, 'Failed to load what that agent found').findings;
}

/**
 * The two states a SHOPPER decides.
 *
 * `blocked`, `completed` and `deleted` are the server's own and are deliberately
 * not in this type: a client that could send `blocked` could clear an ambiguity
 * nobody answered, and one that could send `completed` could claim a `once`
 * agent had fired.
 */
export type ShoppingAgentStatePatch = 'enabled' | 'paused';

export async function updateShoppingAgentState(
  agentId: string,
  state: ShoppingAgentStatePatch,
): Promise<void> {
  const { data } = await apiClient.patch<ApiResponse<unknown>>(`/shopping-agents/${agentId}`, {
    state,
  });
  assertOk(data, 'Failed to update that shopping agent');
}

export async function deleteShoppingAgent(agentId: string): Promise<void> {
  const { data } = await apiClient.delete<ApiResponse<unknown>>(`/shopping-agents/${agentId}`);
  assertOk(data, 'Failed to remove that shopping agent');
}

/**
 * Ask for one evaluation now (#97 UX 5).
 *
 * A 202 means the request was accepted, never that an answer exists — the
 * evaluation appends a finding whenever it runs, and the timeline is where it
 * shows up. Nothing here waits for one, and nothing here returns a verdict a
 * caller could render as though it had already happened.
 */
export async function requestShoppingAgentRun(agentId: string): Promise<void> {
  const { data } = await apiClient.post<ApiResponse<unknown>>(
    `/shopping-agents/${agentId}/run`,
    {},
  );
  assertOk(data, 'Failed to ask for another look');
}

export async function resolveShoppingAgentSplit(
  agentId: string,
  resolution: ShoppingAgentSplitResolution,
): Promise<void> {
  const { data } = await apiClient.post<ApiResponse<unknown>>(
    `/shopping-agents/${agentId}/resolve-split`,
    { resolution },
  );
  assertOk(data, 'Failed to record which product you meant');
}
