/**
 * The walls #156 asks for, as a build failure (#156 acceptances 1, 3, 4, 7 and
 * test 12: "source invariant forbids direct carrier clients and duplicate
 * service-token code").
 *
 * These are the criteria that CAN be enforced today. The ones that cannot —
 * "Mercaria authenticates as its existing Oxy Application" (2), "environment
 * and audience are enforced by default" (5) — need an audience-aware service
 * client that `@oxyhq/core` does not have, and a service-authenticated surface
 * Moovo does not expose. `docs/moovo/2026-08-16-moovo-service-client-survey.md`
 * records both measurements; this file makes sure that while they are open,
 * nobody closes them the wrong way.
 *
 * **The wrong way is specific and it is available right now.** The only route
 * from Mercaria to Moovo that works today is forwarding a buyer's own Oxy
 * bearer through `createLinkedClient` — Moovo's logistics routes all run
 * `authenticateToken` plus "the caller IS the sender". That is impersonation,
 * acceptance 3 forbids it, and it would look exactly like a working
 * integration. WALL 3 is aimed at it.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOMAIN_DIR = join(HERE, '..');
const SRC_ROOT = join(HERE, '..', '..', '..');

/** Every module in the domain, DISCOVERED rather than listed (#126's rule). */
function domainModules(): string[] {
  return readdirSync(DOMAIN_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(DOMAIN_DIR, entry.name));
}

/** Source with comments removed — what every REACHABILITY detector scans. */
function readCode(path: string): string {
  const source = readFileSync(path, 'utf8');
  expect(source.length, `${path} looks empty — did it move?`).toBeGreaterThan(200);
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  expect(
    stripped.replace(/\s+/g, '').length,
    `${path} has almost no code left after comment stripping — check the stripper`,
  ).toBeGreaterThan(80);
  return stripped;
}

/** A carrier's own client. Mercaria integrates carriers through Moovo or not at all. */
const CARRIER_CLIENT =
  /from\s+['"][^'"]*(dhl|fedex|\bups\b|usps|correos|seur|\bgls\b|\bdpd\b|royalmail|shippo|easypost|aftership|shipengine)[^'"]*['"]/i;

/** Raw HTTP. Everything outbound belongs to the transport, which is a port. */
const OUTBOUND_HTTP =
  /\bfetch\s*\(|\bsafeFetch\b|from\s+['"](axios|undici|node-fetch|got|node:http|node:https)['"]/;

/**
 * Buyer impersonation — the shortcut that actually works today.
 *
 * `createLinkedClient` forwards the CALLER's own bearer, which is exactly how a
 * Mercaria request could reach a Moovo route right now, and exactly what
 * acceptance 3 forbids.
 */
const BUYER_IMPERSONATION =
  /createLinkedClient|setTokens\s*\(|req\.accessToken|getRequiredOxyUserId|X-Oxy-User-Id/i;

/** A second token cache, verifier or scope implementation (#156 acceptance 4). */
const DUPLICATE_SERVICE_AUTH =
  /createOxyAuthMiddleware|createOptionalOxyAuth|requireOxyAuth|serviceAuth\s*\(|jwtVerify|jwks|decodeJwt|new\s+JwksClient|tokenCache|cachedToken/i;

/** A credential read straight out of the environment (#156 acceptance 7). */
const INLINE_CREDENTIAL =
  /process\.env\.[A-Z_]*(SECRET|TOKEN|API_KEY|APIKEY|CREDENTIAL|PASSWORD)/;

describe('#156 — the Moovo client is the only way out, and it holds no credential', () => {
  it('scans every module in the domain, and there are some', () => {
    // The vacuity floor. An empty traversal passes every detector below.
    const modules = domainModules();
    expect(modules.length).toBeGreaterThanOrEqual(4);
  });

  it('WALL 1: contains no carrier client', () => {
    for (const path of domainModules()) {
      expect(CARRIER_CLIENT.test(readCode(path)), `${path} reaches a carrier`).toBe(false);
    }
  });

  it('WALL 2: makes no outbound HTTP call of its own', () => {
    // The transport is a PORT precisely so this can be true of the client. When
    // #159 writes a real transport it lands in its own module and this wall
    // moves to exempt exactly that file, by name.
    for (const path of domainModules()) {
      expect(OUTBOUND_HTTP.test(readCode(path)), `${path} calls out directly`).toBe(false);
    }
  });

  it('WALL 3: never impersonates a buyer', () => {
    for (const path of domainModules()) {
      expect(BUYER_IMPERSONATION.test(readCode(path)), `${path} forwards a user credential`).toBe(
        false,
      );
    }
  });

  it('WALL 4: implements no second token cache, verifier or scope check', () => {
    for (const path of domainModules()) {
      expect(
        DUPLICATE_SERVICE_AUTH.test(readCode(path)),
        `${path} re-implements service auth — it belongs to @oxyhq/core`,
      ).toBe(false);
    }
  });

  it('WALL 5: reads no credential from the environment', () => {
    for (const path of domainModules()) {
      expect(INLINE_CREDENTIAL.test(readCode(path)), `${path} reads a secret directly`).toBe(false);
    }
  });

  it('mutation self-test: every detector fires on source that breaks its wall', () => {
    // Each probe is a POSITIVE control in the same currency as the measurement.
    // Without these, a regex broken by a later edit would report a clean domain.
    expect(CARRIER_CLIENT.test("import x from '@easypost/api';")).toBe(true);
    expect(OUTBOUND_HTTP.test('await fetch(url);')).toBe(true);
    expect(OUTBOUND_HTTP.test("import got from 'got';")).toBe(true);
    expect(BUYER_IMPERSONATION.test('oxyServices.createLinkedClient({ baseURL })')).toBe(true);
    expect(BUYER_IMPERSONATION.test('const id = getRequiredOxyUserId(req);')).toBe(true);
    expect(DUPLICATE_SERVICE_AUTH.test('const m = oxy.serviceAuth({ jwtSecret });')).toBe(true);
    expect(DUPLICATE_SERVICE_AUTH.test('const tokenCache = new Map();')).toBe(true);
    expect(INLINE_CREDENTIAL.test('process.env.MOOVO_CLIENT_SECRET')).toBe(true);
    // And a negative control: ordinary code in this domain must NOT trip them.
    expect(OUTBOUND_HTTP.test("import { config } from '../../config/index.js';")).toBe(false);
    expect(INLINE_CREDENTIAL.test('process.env.MOOVO_ENVIRONMENT')).toBe(false);
  });
});

describe('#156 acceptance 1 — one typed module, and the retail domain still owns no transport', () => {
  it('the retail-fulfilment domain does not import this one', () => {
    // The direction that matters. `retail-logistics-isolation.test.ts` already
    // forbids outbound HTTP there; this asserts the complementary fact, that it
    // has not started reaching into the client either. It talks to
    // `moovo.port.ts` and nothing else.
    const retailDir = join(SRC_ROOT, 'services', 'retail-fulfilment');
    const modules = readdirSync(retailDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => join(retailDir, entry.name));
    expect(modules.length).toBeGreaterThanOrEqual(5);
    for (const path of modules) {
      expect(/services\/moovo\//.test(readCode(path)), `${path} imports the Moovo client`).toBe(
        false,
      );
    }
  });

  it('only `register.ts` installs the logistics port', () => {
    // Acceptance 1 as a census: a second registrar would be a second answer to
    // "which client is Mercaria using".
    const registrars = domainModules().filter((path) =>
      /registerMoovoLogisticsPort/.test(readCode(path)),
    );
    expect(registrars.map((path) => path.split('/').pop())).toEqual(['register.ts']);
  });
});
