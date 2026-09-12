import type { MercariaPage } from './contract';
import { MercariaResponseError } from './errors';

/**
 * Walk a paginated read page by page.
 *
 * ```ts
 * for await (const page of iterateMercariaPages((cursor) =>
 *   mercaria.stores.products(store, { cursor, limit: 50 }),
 * )) {
 *   render(page.items);
 * }
 * ```
 *
 * Stops when `nextCursor` is `null`. A cursor the server hands back twice in a
 * row would loop forever, so that is reported as a
 * {@link MercariaResponseError} instead. Breaking out of the loop stops
 * fetching.
 */
export async function* iterateMercariaPages<T>(
  load: (cursor: string | undefined) => Promise<MercariaPage<T>>,
): AsyncGenerator<MercariaPage<T>, void, undefined> {
  let cursor: string | undefined;
  for (;;) {
    const page = await load(cursor);
    yield page;
    if (page.nextCursor === null) return;
    if (page.nextCursor === cursor) {
      throw new MercariaResponseError('Mercaria returned the same page cursor twice; pagination stopped');
    }
    cursor = page.nextCursor;
  }
}
