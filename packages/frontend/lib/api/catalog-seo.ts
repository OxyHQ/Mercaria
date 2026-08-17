import type { ApiResponse, SeoResolution } from '@mercaria/shared-types';
import apiClient from './client';

/**
 * `GET /seo/resolve?path=` — what one public URL resolves to (#75).
 *
 * This is the storefront's redirect, canonical-URL and `hreflang` authority,
 * and it is the reason the category routes do not carry a second one. #367
 * workstream 9 asks a storefront to "resolve deprecated/localized slugs through
 * redirects", "preserve stable canonical URLs" and "add SEO metadata, canonical
 * URLs and `hreflang` behavior". All four are properties of an ADDRESS rather
 * than of a category, they are already decided server-side against the redirect
 * registry and the indexability policy, and deciding them again here would be a
 * second answer that disagrees the first time a policy moves.
 *
 * ## The mount is a lever, and its off state is not an error
 *
 * `SEO_ROUTES_ENABLED` defaults false, so this 404s on most deployments. A page
 * that cannot resolve its own address still renders: it shows the content it
 * fetched by handle and emits no canonical tag and no alternates, which is the
 * honest degradation — emitting a canonical URL composed on the client would
 * assert an indexing decision nobody made.
 */
export async function resolveSeoPath(path: string): Promise<SeoResolution> {
  const { data } = await apiClient.get<ApiResponse<SeoResolution>>('/seo/resolve', {
    params: { path },
  });
  if (!data.success || !data.data) {
    throw new Error(data.error ?? data.message ?? 'Failed to resolve path');
  }
  return data.data;
}
