/**
 * What the REAL site actually holds, measured rather than assumed.
 *
 * Three of §7's scenarios have preconditions that are facts about the SITE, not
 * about Mercaria — more than one page of products (W3), a product with more than
 * 100 variations (W8), at least one order (W5). A driver that assumed them would
 * write a `NOT_RUN` reason that is simply false ("the site does not hold more
 * than one page of products" against a site holding 124), and a false reason in
 * an evidence document is worse than no reason: it sends the next person to
 * provision something that already exists.
 *
 * These reads are the SITE's own totals over its own REST API — `X-WP-Total` on
 * a `per_page=1` request, which is one row of transfer per question. They are
 * deliberately NOT taken through the connector: the connector's job is under
 * test, so using it to decide what to test with would make an unmet precondition
 * and a provider bug indistinguishable.
 */

/** One measured fact about the site, with the number behind it. */
export interface SiteCensus {
  readonly totalProducts: number;
  readonly variableProducts: number;
  readonly totalOrders: number;
  /** The largest declared variation count seen among the variable products. */
  readonly maxDeclaredVariations: number;
  /** Whether the site published `X-WP-TotalPages` on the products list. */
  readonly publishesTotalPagesHeader: boolean;
}

/** Basic-auth header for the WooCommerce REST API. */
function basic(consumerKey: string, consumerSecret: string): string {
  return `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64')}`;
}

/** Read `X-WP-Total` off a `per_page=1` request. Returns -1 when unreadable. */
async function readTotal(url: string, authorization: string): Promise<{ total: number; totalPages: string | null }> {
  const response = await fetch(url, { headers: { Authorization: authorization } });
  if (!response.ok) return { total: -1, totalPages: null };
  const raw = response.headers.get('x-wp-total');
  const parsed = raw === null ? Number.NaN : Number(raw);
  return {
    total: Number.isFinite(parsed) ? parsed : -1,
    totalPages: response.headers.get('x-wp-totalpages'),
  };
}

/**
 * Census the site.
 *
 * A count of -1 means the question could not be answered, which is kept distinct
 * from 0: "the site refused the request" and "the site holds none" route a
 * reader to completely different next actions.
 */
export async function censusSite(input: {
  readonly siteUrl: string;
  readonly consumerKey: string;
  readonly consumerSecret: string;
}): Promise<SiteCensus> {
  const authorization = basic(input.consumerKey, input.consumerSecret);
  const base = `${input.siteUrl}/wp-json/wc/v3`;

  const products = await readTotal(`${base}/products?per_page=1`, authorization);
  const variable = await readTotal(`${base}/products?per_page=1&type=variable`, authorization);
  const orders = await readTotal(`${base}/orders?per_page=1`, authorization);

  let maxDeclaredVariations = 0;
  if (variable.total > 0) {
    const response = await fetch(`${base}/products?per_page=20&type=variable`, {
      headers: { Authorization: authorization },
    });
    if (response.ok) {
      const rows = (await response.json()) as Array<{ variations?: unknown[] }>;
      for (const row of rows) {
        maxDeclaredVariations = Math.max(maxDeclaredVariations, (row.variations ?? []).length);
      }
    }
  }

  return {
    totalProducts: products.total,
    variableProducts: variable.total,
    totalOrders: orders.total,
    maxDeclaredVariations,
    publishesTotalPagesHeader: products.totalPages !== null,
  };
}
