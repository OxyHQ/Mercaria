import type { ApiResponse, Feed } from '@mercaria/shared-types';
import apiClient from './client';

/**
 * Home-feed API client.
 *
 * Typed against the shared `@mercaria/shared-types` contract so the frontend
 * and backend agree on the feed/shelf/product shapes. `GET /feed` is public
 * (anonymous-friendly) — the api client only attaches a Bearer token when one
 * exists, so this works without authentication.
 */

/** Fetch the home feed (shelves of product cards) and unwrap the envelope. */
export async function fetchFeed(): Promise<Feed> {
  const { data } = await apiClient.get<ApiResponse<Feed>>('/feed');
  if (!data.success || !data.data) {
    throw new Error(data.error ?? data.message ?? 'Failed to load feed');
  }
  return data.data;
}
