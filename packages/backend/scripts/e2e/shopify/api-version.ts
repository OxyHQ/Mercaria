/**
 * Which Shopify Admin API version actually serves this deployment's requests.
 *
 * Shopify does not fail a request for a retired version — it falls forward to
 * the oldest accessible stable version and reports the truth only in the
 * `X-Shopify-API-Version` response header. Its own guidance is to compare that
 * header against what was requested. So this is the whole discriminator between
 * "the pin is honoured" and "every scenario passed against a version nobody
 * chose", and a #69 run that does not record it cannot say what it measured.
 *
 * ## Two readers, because neither alone covers the run
 *
 * The API records the AUTHENTICATED answer itself (`connectors/shopify/http.ts`
 * warns once per host when the served version differs), which is the guaranteed
 * one — Shopify documents the header on API responses. But the driver runs in a
 * SEPARATE process, so that observation is not reachable from here.
 *
 * This probe is therefore an UNAUTHENTICATED request to the shop's own admin
 * API. Whether Shopify attaches the version header to the 401 it answers with is
 * not something the documentation settles, so the outcome is THREE-valued and
 * `not_disclosed` is a first-class answer rather than a failure. Reporting a
 * missing header as agreement is the one reading that would make this worse than
 * having no probe: it would state a version nobody observed.
 */

/** What the probe could establish. A string discriminant — this package compiles
 * with `strict: false`, so a boolean-literal one does not narrow (the #68
 * finding), and the caller genuinely acts on all three. */
export type ServedApiVersionProbe =
  | { readonly outcome: 'served'; readonly requested: string; readonly served: string }
  | { readonly outcome: 'not_disclosed'; readonly requested: string; readonly httpStatus: number }
  | { readonly outcome: 'unreachable'; readonly requested: string; readonly reason: string };

/**
 * Ask `shopDomain` which version it serves for `requested`, without credentials.
 *
 * Sends no token deliberately: the probe wants the version header, not data, and
 * an unauthenticated 401 or 404 carries it if Shopify attaches one. Nothing here
 * is retried — a probe that cannot answer is reported, never waited on.
 */
export async function probeServedApiVersion(
  shopDomain: string,
  requested: string,
  timeoutMs = 10_000,
): Promise<ServedApiVersionProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(
      `https://${shopDomain}/admin/api/${requested}/shop.json`,
      { method: 'GET', signal: controller.signal },
    );
    const served = response.headers.get('x-shopify-api-version');
    if (!served) {
      return { outcome: 'not_disclosed', requested, httpStatus: response.status };
    }
    return { outcome: 'served', requested, served };
  } catch (err) {
    return { outcome: 'unreachable', requested, reason: (err as Error).name };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One line an operator can act on.
 *
 * The mismatch sentence names what a run taken under it would be worth, because
 * "2024-10 vs 2025-10" on its own reads as a version number somebody can shrug
 * at rather than as evidence that the whole run measured something else.
 */
export function describeServedApiVersion(probe: ServedApiVersionProbe): string {
  switch (probe.outcome) {
    case 'served':
      return probe.served === probe.requested
        ? `Shopify served ${probe.served}, which is what the code pins.`
        : `Shopify served ${probe.served} for a request pinned at ${probe.requested}. ` +
            'The pin is not being honoured — Shopify fell forward — so every scenario ' +
            'in this run exercised a version nobody selected, and the evidence cannot ' +
            'say which version it measured.';
    case 'not_disclosed':
      return (
        `The shop answered HTTP ${probe.httpStatus} with no X-Shopify-API-Version header, ` +
        'so an unauthenticated probe cannot settle which version serves this deployment. ' +
        "The API records the AUTHENTICATED answer itself: grep its log for " +
        '"served a DIFFERENT Admin API version".'
      );
    case 'unreachable':
      return (
        `The shop could not be reached (${probe.reason}), so the served version is unknown. ` +
        'This says nothing about the pin — check the domain and the network first.'
      );
  }
}
