/**
 * The ONE browser-origin authority this backend maintains.
 *
 * Two consumers, deliberately reading the same list so there is nothing to
 * drift (ADR 0003 D10):
 *
 *  - the CORS layer in `app.ts`, which decides whose scripts may read
 *    responses;
 *  - the guest CSRF gate in `middleware/commerce-actor.ts`, which refuses a
 *    cookie-authenticated state-changing request whose `Origin` (or, absent
 *    that, `Referer`) is not listed here.
 *
 * D10 chose strict Origin verification over double-submit precisely because
 * this list already exists — a second CSRF secret would be a second authority
 * to keep consistent, and its classic failure mode is only closed by the
 * `__Host-` cookie prefix the transport requires anyway.
 */

/** Production web origins. `PRODUCTION_ORIGINS` per `AGENTS.md` §CORS. */
export const PRODUCTION_ORIGINS: readonly string[] = [
  'https://mercaria.co',
  'https://console.mercaria.co',
  'https://gateway.mercaria.co',
  'https://dashboard.mercaria.co',
  'https://pos.mercaria.co',
];

/**
 * Local development origins. Mercaria's Expo apps own the 816x block of the
 * per-app local dev port map (frontend 8160, dashboard 8161, pos 8162), so
 * several Oxy apps can run side by side on one machine.
 */
export const DEV_ORIGINS: readonly string[] = [
  'http://localhost:4160',
  'http://localhost:5173',
  'http://localhost:8160',
  'exp://localhost:8160',
  'http://10.0.2.2:8160',
  'http://localhost:8161',
  'exp://localhost:8161',
  'http://10.0.2.2:8161',
  'http://localhost:8162',
  'exp://localhost:8162',
  'http://10.0.2.2:8162',
];

/**
 * Every origin a browser may act from: an optional deployment override plus
 * the two lists above. Frozen — a mutation would widen CORS and CSRF at once.
 */
export const ALLOWED_ORIGINS: readonly string[] = Object.freeze([
  ...(process.env.WEB_URL ? [process.env.WEB_URL] : []),
  ...PRODUCTION_ORIGINS,
  ...DEV_ORIGINS,
]);

/** Membership test both consumers share. `null`/`undefined` is NOT allowed. */
export function isAllowedBrowserOrigin(origin: string | undefined): boolean {
  return origin !== undefined && ALLOWED_ORIGINS.includes(origin);
}

// ── The public integration surface (#1017) ──────────────────────────────────

/**
 * The path prefix the credential-less, any-origin CORS allowance applies under.
 *
 * Spelled out rather than imported from `@mercaria/shared-types`
 * (`MERCARIA_PUBLIC_API_BASE_PATH`) so this module stays dependency-free — and
 * `routes/__tests__/public-api.realdb.test.ts` asserts the two are equal, so a
 * contract that moved its base path fails the build rather than leaving the
 * allowance behind on a path nothing serves.
 */
export const PUBLIC_READ_CORS_BASE_PATH = '/public/v1';

/** The only methods the public allowance covers. `OPTIONS` is the preflight. */
export const PUBLIC_READ_CORS_METHODS: readonly string[] = Object.freeze(['GET', 'HEAD', 'OPTIONS']);

/**
 * Request headers a foreign browser client may send to the public surface.
 * `Authorization` carries an Oxy bearer token — never a cookie — so a caller's
 * own session can forward authority (`viewer.saved`) without credentials mode.
 */
export const PUBLIC_READ_CORS_ALLOWED_HEADERS: readonly string[] = Object.freeze([
  'Authorization',
  'Content-Type',
  'Accept',
  'Accept-Language',
]);

/**
 * Whether a request takes the PUBLIC read CORS policy instead of the
 * credentialed allow-list above.
 *
 * Another Oxy web application (Mention at `mention.earth`, Goway, an agent's
 * browser) reads Mercaria products through `@mercaria.co/sdk`, so the public
 * integration GETs must be readable from ANY origin. That is safe for exactly
 * the population this function admits, and the reasons are what the three
 * conditions are:
 *
 *  - **Under the public base path only.** Every route there is a GET over
 *    publicly live catalogue facts; nothing under it writes or reads a cart, an
 *    order or an account.
 *  - **GET, HEAD and the preflight only.** A preflight asking for any other
 *    method is answered with this policy's method list, which the browser then
 *    refuses — so no write anywhere can borrow the allowance.
 *  - **Never credentialed.** The allowance is `Access-Control-Allow-Origin: *`
 *    with NO `Access-Control-Allow-Credentials`, and a browser refuses to attach
 *    cookies to a wildcard response. Authority travels only as a bearer token the
 *    calling application already holds.
 *
 * It widens NOTHING else: {@link ALLOWED_ORIGINS} and
 * {@link isAllowedBrowserOrigin} are unchanged, so the guest CSRF gate — which
 * guards cookie-authenticated writes, none of which live under this path — reads
 * exactly the list it read before. The prefix match is case-SENSITIVE while
 * Express routing is not; a request spelled `/PUBLIC/v1/...` therefore reaches
 * the public router under the credentialed policy, which is the restrictive
 * direction.
 */
export function isPublicReadCorsRequest(method: string, path: string): boolean {
  if (!PUBLIC_READ_CORS_METHODS.includes(method.toUpperCase())) return false;
  return path === PUBLIC_READ_CORS_BASE_PATH || path.startsWith(`${PUBLIC_READ_CORS_BASE_PATH}/`);
}
