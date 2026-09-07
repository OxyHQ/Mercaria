import type { ApiResponse, DiscoveryFeed, DiscoveryScope } from '@mercaria/shared-types';
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
 */

const CATEGORY_SCOPE_PREFIX = 'category:';

/**
 * Serializes a {@link DiscoveryScope} into the `scope` query value
 * `routes/discovery.ts`'s `scopeSchema` parses: `root`, `deals` or
 * `category:<handle>`.
 */
function serializeDiscoveryScope(scope: DiscoveryScope): string {
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
