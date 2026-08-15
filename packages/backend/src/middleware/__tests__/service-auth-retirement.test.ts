/**
 * The legacy service-auth surface stays retired (#164), asserted by SCAN.
 *
 * #164 removed a shared-secret bearer path (`SERVICE_SECRET` →
 * `req.userId = 'system'` + an application id `internal` no Oxy Console grant
 * describes), a second shared-secret path that took the acting user's id from a
 * request HEADER (`authenticateTelegramBot`), and a local scope check over an
 * `req.apiKey` bag nothing ever populated. None of them had a mounted route,
 * which is exactly why a behavioural test cannot defend the removal: there is no
 * request to send. What can be defended is that the code is not there.
 *
 * That matters more than the usual "dead code stays dead". Each was one
 * `router.use(...)` from authorizing everything, and the failure would be
 * silent: a synthetic principal is indistinguishable from a real one downstream,
 * `getRequiredOxyUserId` would happily return the string `system`, and nothing
 * in Oxy's grant audit would record that a call had been made at all.
 *
 * Both defences from `~/Oxy/AGENTS.md` are here: a vacuity floor (a scan that
 * read nothing reports the same clean zero as a scan that found nothing, so the
 * file count and the surviving-code length are asserted) and a mutation
 * self-test (every detector runs against seeded text that SHOULD trip it and
 * text that must NOT).
 *
 * The scan reads COMMENT-STRIPPED source, and this file and `auth.ts` are
 * excluded by name: both document what they refuse to do in exactly the
 * vocabulary the detectors look for, and a gate that fires on its own
 * explanation is one the next person switches off.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(HERE, '..', '..');
const REPO_ROOT = join(SRC_ROOT, '..', '..', '..');

/**
 * The two files whose PROSE names the retired identifiers on purpose: this gate
 * and the module whose header explains what used to live in it. Excluded from
 * the source scan by path, never by a pattern somebody else could inherit.
 */
const SELF_DOCUMENTING = new Set([
  'packages/backend/src/middleware/auth.ts',
  'packages/backend/src/middleware/__tests__/service-auth-retirement.test.ts',
]);

/** The retired shared secret, in any spelling that would reach `process.env`. */
const SERVICE_SECRET_REFERENCE = /\bSERVICE_SECRET\b|\bTELEGRAM_BOT_SECRET\b/;

/**
 * The retired middleware exports.
 *
 * `requireScope` is Mercaria's local one over `req.apiKey`. `@oxyhq/core`
 * ships its own `oxy.requireScope(...)` for a real service token's scopes; if
 * that is ever mounted it arrives as a method ON the client, which is why the
 * pattern is anchored to a bare identifier and the mutation self-test pins the
 * SDK spelling as permitted.
 */
const RETIRED_MIDDLEWARE_REFERENCE =
  /\bauthenticateTokenOrApiKey\b|\bauthenticateTelegramBot\b|\boxyServiceAuth\b|(?<!\.)\brequireScope\b/;

/**
 * The synthetic principal itself.
 *
 * Deliberately NOT a bare `'system'`: that is a legitimate, widely-used
 * `actorKind` on order status history, procurement initiators and referral
 * rows, and matching it would make this gate fire on a dozen honest files. What
 * is forbidden is a synthetic value being ASSIGNED to a user-principal field, or
 * an application id Oxy never issued.
 */
const SYNTHETIC_PRINCIPAL_REFERENCE =
  /\buserId\s*=\s*['"]system['"]|\buser\s*=\s*\{\s*id:\s*['"]system['"]|appId:\s*['"]internal['"]|appName:\s*['"]internal['"]/;

/**
 * A hand-rolled credential comparison in the auth middleware layer.
 *
 * Not a ban on `timingSafeEqual` (the provider webhooks and `verifySecret` need
 * it, and they live elsewhere): a ban on the middleware directory growing a
 * bearer-token comparison of its own, which is the shape both retired paths had.
 */
const HANDROLLED_BEARER_COMPARE_REFERENCE =
  /timingSafeEqual|createHmac|jwt\.verify|jwksClient|decodeJwt/;

/** Every tracked TypeScript file under the backend's `src`. */
function trackedBackendSources(): string[] {
  const listing = execFileSync(
    'git',
    ['ls-files', '-z', '--', 'packages/backend/src'],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  return listing
    .split('\0')
    .filter((path) => path.endsWith('.ts') && !SELF_DOCUMENTING.has(path));
}

/** Source with comments removed — what every detector below reads. */
function readCode(repoRelative: string): string {
  return readFileSync(join(REPO_ROOT, repoRelative), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('the legacy service-auth surface is gone and stays gone (#164)', () => {
  const sources = trackedBackendSources();

  it('scans a real corpus (vacuity floor)', () => {
    // A broken `git ls-files`, a moved directory or a filter that matched
    // nothing all produce the same silent pass below.
    expect(sources.length, 'the source listing looks empty — did the scan break?').toBeGreaterThan(
      500,
    );
    expect(sources).toContain('packages/backend/src/routes/internal-payments.ts');
    // …and the two excluded files must really exist, or the exclusion is
    // covering a typo rather than a file.
    for (const path of SELF_DOCUMENTING) {
      expect(readFileSync(join(REPO_ROOT, path), 'utf8').length).toBeGreaterThan(200);
    }
  });

  it('the exemption list is EXACTLY two files', () => {
    // An exemption list is how this gate would switch itself off, one defensible
    // line at a time: the cheapest way to green a re-added `SERVICE_SECRET` is
    // not to delete it, it is to add the offending file here. An exact count —
    // not a ceiling — makes that a decision somebody has to argue for in review
    // rather than a line that slips through with the change it excuses.
    //
    // Two is the whole justified set: a file may sit here ONLY because its own
    // prose must name the retired identifiers to explain the prohibition. Any
    // other file naming them is the thing this gate exists to catch.
    expect([...SELF_DOCUMENTING].sort()).toEqual([
      'packages/backend/src/middleware/__tests__/service-auth-retirement.test.ts',
      'packages/backend/src/middleware/auth.ts',
    ]);
  });

  it('no source reads the retired shared secrets', () => {
    const offenders = sources.filter((path) => SERVICE_SECRET_REFERENCE.test(readCode(path)));
    expect(
      offenders,
      'SERVICE_SECRET / TELEGRAM_BOT_SECRET are retired: a service caller is a registered Oxy Application (#164)',
    ).toEqual([]);
  });

  it('no source names the retired middleware', () => {
    const offenders = sources.filter((path) => RETIRED_MIDDLEWARE_REFERENCE.test(readCode(path)));
    expect(
      offenders,
      'a retired auth middleware is back; mount `oxyClient.serviceAuth(...)` on the route that needs it instead',
    ).toEqual([]);
  });

  it('no source mints a synthetic user or a synthetic application', () => {
    const offenders = sources.filter((path) => SYNTHETIC_PRINCIPAL_REFERENCE.test(readCode(path)));
    expect(
      offenders,
      'an application call must never be dressed as a person; Oxy owns identity',
    ).toEqual([]);
  });

  it('the middleware layer hand-rolls no credential verification', () => {
    const middleware = sources.filter((path) => path.startsWith('packages/backend/src/middleware/'));
    expect(middleware.length, 'no middleware files scanned').toBeGreaterThan(5);
    const offenders = middleware.filter((path) =>
      HANDROLLED_BEARER_COMPARE_REFERENCE.test(readCode(path)),
    );
    expect(
      offenders,
      'credential verification belongs to @oxyhq/core/server, not to a Mercaria middleware',
    ).toEqual([]);
  });

  it('the env template offers neither retired secret', () => {
    const template = readFileSync(join(SRC_ROOT, '..', '.env.example'), 'utf8');
    expect(template.length).toBeGreaterThan(500);
    // Stripped of comments the template is nearly empty, so this one scans RAW:
    // a commented-out `# SERVICE_SECRET=` is exactly the thing being removed —
    // an operator reads it as a supported setting.
    expect(/^#?\s*SERVICE_SECRET=/m.test(template)).toBe(false);
    expect(/^#?\s*TELEGRAM_BOT_SECRET=/m.test(template)).toBe(false);
    // Positive control: the scan can see a variable that IS there.
    expect(/^OXY_API_URL=/m.test(template)).toBe(true);
  });

  it('the deploy workflow no longer syncs the retired secret', () => {
    const workflow = readFileSync(join(REPO_ROOT, '.github/workflows/deploy-aws.yml'), 'utf8');
    expect(workflow.length).toBeGreaterThan(1000);
    // The workflow's own comment explains the retirement by name, so this
    // matches the two BINDING shapes rather than the word.
    expect(/SYNC_SERVICE_SECRET:/.test(workflow)).toBe(false);
    expect(/^\s*APP_SECRETS=".*\bSERVICE_SECRET\b.*"/m.test(workflow)).toBe(false);
    // Positive control: a secret that IS still synced matches both shapes.
    expect(/SYNC_DATABASE_URL:/.test(workflow)).toBe(true);
    expect(/^\s*APP_SECRETS=".*\bDATABASE_URL\b.*"/m.test(workflow)).toBe(true);
  });

  /**
   * The mutation self-test. A regex broken into matching nothing reports the
   * same clean pass as a clean codebase, so every detector is run against text
   * that must trip it and text that must not.
   */
  it('each detector actually detects (mutation self-test)', () => {
    expect(SERVICE_SECRET_REFERENCE.test('const s = process.env.SERVICE_SECRET;')).toBe(true);
    expect(SERVICE_SECRET_REFERENCE.test('process.env.TELEGRAM_BOT_SECRET')).toBe(true);
    // A different secret with a similar shape is not this one.
    expect(SERVICE_SECRET_REFERENCE.test('config.stripe.webhookSecret')).toBe(false);
    expect(SERVICE_SECRET_REFERENCE.test("strEnv('ANALYTICS_INTERNAL_TRAFFIC_TOKEN', '')")).toBe(
      false,
    );

    expect(RETIRED_MIDDLEWARE_REFERENCE.test('router.use(authenticateTokenOrApiKey);')).toBe(true);
    expect(RETIRED_MIDDLEWARE_REFERENCE.test('router.use(oxyServiceAuth);')).toBe(true);
    expect(RETIRED_MIDDLEWARE_REFERENCE.test('await authenticateTelegramBot(req, res, next);')).toBe(
      true,
    );
    expect(RETIRED_MIDDLEWARE_REFERENCE.test("router.use(requireScope('files:write'));")).toBe(true);
    // The SDK's own scope guard is a METHOD on the client and is permitted —
    // that is the sanctioned mechanism arriving, not the local one returning.
    expect(RETIRED_MIDDLEWARE_REFERENCE.test("oxyClient.requireScope('files:write')")).toBe(false);
    expect(RETIRED_MIDDLEWARE_REFERENCE.test('router.use(authenticateToken);')).toBe(false);

    expect(SYNTHETIC_PRINCIPAL_REFERENCE.test("req.userId = 'system';")).toBe(true);
    expect(SYNTHETIC_PRINCIPAL_REFERENCE.test("req.user = { id: 'system' };")).toBe(true);
    expect(SYNTHETIC_PRINCIPAL_REFERENCE.test("serviceApp = { appId: 'internal' }")).toBe(true);
    // `system` as an ACTOR KIND is a real, widely-used value and must not trip.
    expect(SYNTHETIC_PRINCIPAL_REFERENCE.test("actorKind: 'system',")).toBe(false);
    expect(SYNTHETIC_PRINCIPAL_REFERENCE.test("initiator: 'system',")).toBe(false);
    expect(SYNTHETIC_PRINCIPAL_REFERENCE.test("req.userId = getRequiredOxyUserId(req);")).toBe(
      false,
    );

    expect(HANDROLLED_BEARER_COMPARE_REFERENCE.test('crypto.timingSafeEqual(a, b)')).toBe(true);
    expect(HANDROLLED_BEARER_COMPARE_REFERENCE.test('jwt.verify(token, key)')).toBe(true);
    expect(
      HANDROLLED_BEARER_COMPARE_REFERENCE.test('createOxyAuthMiddleware(oxyClient, options)'),
    ).toBe(false);
  });
});
