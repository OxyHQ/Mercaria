import {
  MERCARIA_PUBLIC_API_BASE_PATH,
  MERCARIA_PUBLIC_PAGE_LIMIT_MAX,
  MercariaLocationPageSchema,
  type MercariaLocation,
} from '@mercaria/contracts';
import config from '../config';

/** A store with more shop fronts than this many pages of them is not one a store page lists. */
const MAX_PAGES = 4;

/**
 * A store's public shop fronts — read from Mercaria's own public surface,
 * `GET /public/v1/stores/:id/locations`.
 *
 * The SAME answer GoWay's place page reads "products at this store" from, so
 * the store page and the map cannot disagree about which shop fronts are
 * public: published, live, unrestricted and named back by their GoWay place
 * (ADR 0013). The body is parsed with the contract's own schema.
 *
 * Deliberately NOT through `apiClient`: that client sends the guest cookie
 * (`withCredentials`), and `/public/v1` answers browsers with a wildcard origin
 * and no credentials — a pair the browser refuses to combine. This read is
 * public and carries nothing of the shopper.
 */
export async function fetchStoreLocations(storeId: string): Promise<MercariaLocation[]> {
  const locations: MercariaLocation[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ limit: String(MERCARIA_PUBLIC_PAGE_LIMIT_MAX) });
    if (cursor !== null) query.set('cursor', cursor);
    const response = await fetch(
      `${config.apiUrl}${MERCARIA_PUBLIC_API_BASE_PATH}/stores/${encodeURIComponent(storeId)}/locations?${query.toString()}`,
      { headers: { Accept: 'application/json' }, credentials: 'omit' },
    );
    if (!response.ok)
      throw new Error(`The store's locations could not be read (${response.status})`);
    const body = MercariaLocationPageSchema.parse(await response.json());
    locations.push(...body.items);
    cursor = body.nextCursor;
    if (cursor === null) break;
  }
  return locations;
}
