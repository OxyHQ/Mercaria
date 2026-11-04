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
 * This public read carries neither Oxy nor commerce credentials.
 * `/public/v1` has the same anonymous response for every shopper.
 */
export async function fetchStoreLocations(
  storeId: string,
  signal?: AbortSignal,
): Promise<MercariaLocation[]> {
  const locations: MercariaLocation[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ limit: String(MERCARIA_PUBLIC_PAGE_LIMIT_MAX) });
    if (cursor !== null) query.set('cursor', cursor);
    const response = await fetch(
      `${config.apiUrl}${MERCARIA_PUBLIC_API_BASE_PATH}/stores/${encodeURIComponent(storeId)}/locations?${query.toString()}`,
      {
        headers: { Accept: 'application/json' },
        credentials: 'omit',
        ...(signal ? { signal } : {}),
      },
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
