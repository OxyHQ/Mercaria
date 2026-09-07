import type {
  ApiResponse,
  DiscoveryFeed,
  DiscoveryScope,
  DiscoverySignal,
  DiscoverySignalPage,
} from '@mercaria/shared-types';
import apiClient from './client';

/**
 * Discovery feed API client — the explore, category and deals pages, one
 * contract with three scopes
 * (`docs/superpowers/specs/2026-09-07-discovery-feed-design.md`).
 *
 * Typed against the shared `@mercaria/shared-types` contract, unwrapping
 * `ApiResponse` and throwing on `!success`, exactly as `api/feed.ts` does.
 * `GET /discovery/feed` is public (`routes/discovery.ts` mounts only
 * `optionalAuth`) — the api client only attaches a Bearer token when one
 * exists, so this works without authentication.
 *
 * `DiscoverySignalPage` does not exist in `@mercaria/shared-types` yet — the
 * backend agent is building `GET /discovery/signal` behind it. This is
 * deliberately left to fail to compile until that lands (team-lead ruling,
 * `.superpowers/sdd/2026-09-07-discovery-feed-screens/task-4-report.md`),
 * the same discipline `DiscoveryFeed.tsx` applied to the signal route itself.
 */

const CATEGORY_SCOPE_PREFIX = 'category:';

/**
 * Serializes a {@link DiscoveryScope} into the `scope` query value
 * `routes/discovery.ts`'s `scopeSchema` parses: `root`, `deals` or
 * `category:<handle>`. Exported so `fetchDiscoverySignalPage` shares the exact
 * same serialization rather than a second copy of it.
 */
export function serializeDiscoveryScope(scope: DiscoveryScope): string {
  switch (scope.kind) {
    case 'root':
      return 'root';
    case 'deals':
      return 'deals';
    case 'category':
      return `${CATEGORY_SCOPE_PREFIX}${scope.handle}`;
  }
}

/** Fetch the discovery feed for one scope and unwrap the envelope. */
export async function fetchDiscoveryFeed(scope: DiscoveryScope): Promise<DiscoveryFeed> {
  const { data } = await apiClient.get<ApiResponse<DiscoveryFeed>>('/discovery/feed', {
    params: { scope: serializeDiscoveryScope(scope) },
  });
  if (!data.success || !data.data) {
    throw new Error(data.error ?? data.message ?? 'Failed to load discovery feed');
  }
  return data.data;
}

export interface FetchDiscoverySignalPageInput {
  signal: DiscoverySignal;
  scope: DiscoveryScope;
  limit: number;
  offset: number;
}

/**
 * Fetch one OFFSET page of one signal's listing for one scope — the
 * `/categories/:handle/s/:signal` "see all" destination.
 *
 * `hasMore` on the response is computed server-side by reading one row past
 * `limit`, never by arithmetic against a total here — the client only relays
 * it.
 */
export async function fetchDiscoverySignalPage(
  input: FetchDiscoverySignalPageInput,
): Promise<DiscoverySignalPage> {
  const { data } = await apiClient.get<ApiResponse<DiscoverySignalPage>>('/discovery/signal', {
    params: {
      signal: input.signal,
      scope: serializeDiscoveryScope(input.scope),
      limit: input.limit,
      offset: input.offset,
    },
  });
  if (!data.success || !data.data) {
    throw new Error(data.error ?? data.message ?? 'Failed to load discovery signal page');
  }
  return data.data;
}
