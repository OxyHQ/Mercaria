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
