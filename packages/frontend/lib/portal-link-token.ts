/**
 * Taking a guest portal exchange token (`mgx_`) out of the browser URL.
 *
 * ADR 0003 T4 puts the token in the URL FRAGMENT because a fragment never
 * reaches a server, a proxy log or a `Referer`. A link that arrives in another
 * shape — `?token=mgx_…`, which anything rewriting a link can produce — is in
 * every one of those, plus browser history. The M8 review (M8-11) found the
 * portal accepted that shape and left it in the address bar. Both shapes are
 * now captured and STRIPPED before anything renders, in that order: after the
 * `replaceState` the value is gone, so the order of the two statements is the
 * feature.
 *
 * Pure over a `Location`/`History` pair so the strip is testable without a
 * browser.
 */

/** The prefix an exchange token carries. Anything else is not one. */
export const EXCHANGE_PREFIX = 'mgx_';

/** The two browser objects this needs, narrowed to what it touches. */
export interface UrlCarrier {
  readonly location: Pick<Location, 'hash' | 'pathname' | 'search'>;
  readonly history: Pick<History, 'replaceState' | 'state'>;
}

/**
 * Read an exchange token from the fragment or the `token` query parameter, and
 * remove every copy from the address bar.
 *
 * The fragment wins when both are present. A `token` query parameter is
 * stripped even when it is not an exchange token, because whatever it is, it
 * has no business surviving into history.
 */
export function takeExchangeTokenFromUrl(carrier: UrlCarrier): string | null {
  const fragment = carrier.location.hash.replace(/^#/, '');
  const query = new URLSearchParams(carrier.location.search);
  const queried = query.get('token');
  const fromFragment = fragment.startsWith(EXCHANGE_PREFIX) ? fragment : null;
  if (fromFragment === null && queried === null) return null;

  query.delete('token');
  const search = query.toString();
  const keepHash = fromFragment === null && fragment !== '' ? `#${fragment}` : '';
  carrier.history.replaceState(
    carrier.history.state,
    '',
    `${carrier.location.pathname}${search === '' ? '' : `?${search}`}${keepHash}`,
  );

  if (fromFragment !== null) return fromFragment;
  return queried?.startsWith(EXCHANGE_PREFIX) ? queried : null;
}
