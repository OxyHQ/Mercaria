/**
 * A request must never pass through two limiters on the SAME scope.
 *
 * ## The defect this exists to stop coming back
 *
 * `app.ts` mounts `makeRateLimiter('general')` above every route. Twelve router
 * mounts named that same scope again beneath it — `routes/me.ts`,
 * `routes/auth.ts` and nine in `routes/notifications.ts` — and because the
 * Redis key prefix is derived from the SCOPE NAME, both limiters incremented
 * one key. Measured on the real `createApp()` chain against a real Redis, one
 * request to `/me` consumed **2** where `/cart` and `/rates` consumed 1:
 *
 * ```
 * /me    401   rl:general: = 2
 * /cart  200   rl:cart: = 1   rl:general: = 1
 * /rates 200   rl:rates: = 1  rl:general: = 1
 * ```
 *
 * So `/me` gave an anonymous caller 300 of the intended 600, and the two
 * post-authentication mounts halved 5,000 to 2,500.
 *
 * ## Why nothing caught it
 *
 * It needs Redis. Without `REDIS_URL` each limiter builds its OWN MemoryStore,
 * consumption is 1, and the defect does not exist — measured. So it is absent
 * from every local run and every test, and present in production, which does
 * set `REDIS_URL`.
 *
 * express-rate-limit's own `ERR_ERL_DOUBLE_COUNT` validator DOES fire, and in
 * `production` as well as `test` — measured, after predicting the opposite. It
 * is a `console.error` that does not fail the request, in the one environment
 * where the bug exists and in a log nobody greps.
 *
 * ## Why this gate is STATIC
 *
 * The honest gate would be the runtime one: build the app, probe every mount
 * prefix, assert no bucket is incremented more than once per request. That
 * needs Redis, and `ci.yml` has one service container and it is Postgres. So
 * this asserts the SHAPE instead — the `general` scope is mounted exactly once,
 * in `app.ts` — and the runtime measurement lives in the PR that removed the
 * twelve. A CI Redis is what would upgrade it, and that is a decision about the
 * workflow rather than about this file.
 *
 * The scope is narrowed to `general` deliberately rather than "no scope twice",
 * which sounds stronger and is not checkable here: whether two mounts of one
 * scope lie on a single request path depends on the mount ORDER in `app.ts` and
 * on which routes match, neither of which survives a source census. `general`
 * is the one scope where the answer is knowable without running anything —
 * every route is under the global mount, so a second mount anywhere below it is
 * on the path by construction.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { reportPopulation } from '../../__tests__/report-population.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A walk that read almost nothing reports the same clean zero as a clean estate. */
const SCANNED_FILE_FLOOR = 1_500;

/**
 * Every limiter mount in the backend, floored so a detector that stopped
 * matching reds instead of reporting an empty, compliant estate.
 */
const MOUNT_FLOOR = 100;

/** The one mount that is allowed to name the global scope. */
const GLOBAL_MOUNT_FILE = 'app.ts';

/** Both factories. A population derived from one producer when two produce it
 *  is how the original census reported 25 scopes where there are 29. */
const FACTORIES = ['makeRateLimiter', 'makeActorRateLimiter'] as const;

/**
 * Blank `//` and `/* *\/` comments, preserving offsets.
 *
 * A census over source must exclude comments: `lib/rate-limit.ts` and both
 * pre-existing rate-limit tests all NAME `makeRateLimiter('general')` in prose,
 * and counting those would make this gate red on a clean tree — which is the
 * failure mode where somebody deletes the gate.
 */
export function blankComments(source: string): string {
  const out = [...source];
  let i = 0;
  while (i < source.length) {
    if (source[i] === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') {
        out[i] = ' ';
        i += 1;
      }
    } else if (source[i] === '/' && source[i + 1] === '*') {
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] !== '\n') out[i] = ' ';
        i += 1;
      }
      if (i < source.length) {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
      }
    } else {
      i += 1;
    }
  }
  return out.join('');
}

export interface LimiterMount {
  readonly factory: string;
  readonly scope: string;
}

/** Every limiter CALL in one source, comments excluded. */
export function limiterMounts(source: string): LimiterMount[] {
  const code = blankComments(source);
  const found: LimiterMount[] = [];
  for (const factory of FACTORIES) {
    // The `(` is required so a name that merely CONTAINS one of these — an
    // import line, a docblock reference the blanker missed — is not a call.
    const pattern = new RegExp(`\\b${factory}\\s*\\(\\s*'([a-zA-Z-]+)'`, 'gu');
    for (const match of code.matchAll(pattern)) {
      const lineStart = code.lastIndexOf('\n', match.index) + 1;
      const line = code.slice(lineStart, code.indexOf('\n', match.index));
      if (line.includes('import ')) continue;
      found.push({ factory, scope: match[1] });
    }
  }
  return found;
}

function sources(): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.endsWith('.ts')) continue;
      files.set(relative(SRC_ROOT, path).split(sep).join('/'), readFileSync(path, 'utf8'));
    }
  };
  walk(SRC_ROOT);
  return files;
}

describe('the rate-limit scope census', () => {
  const files = sources();
  // Test files are excluded from the POPULATION and not from the walk: a test
  // legitimately builds its own limiters on any scope, and one of them is this
  // file's own mutation fixture.
  const production = [...files].filter(([path]) => !path.includes('__tests__/'));
  const mounts = production.flatMap(([path, source]) =>
    limiterMounts(source).map((mount) => ({ path, ...mount })),
  );

  it('walked a plausible source tree and found limiter mounts', () => {
    expect(files.size, 'the walk read almost nothing — did the layout move?').toBeGreaterThan(
      SCANNED_FILE_FLOOR,
    );
    expect(
      mounts.length,
      'no limiter mount was found at all — the detector or the walk stopped working',
    ).toBeGreaterThanOrEqual(MOUNT_FLOOR);
    reportPopulation(
      `[rate-limit census] files=${String(files.size)} production mounts=${String(mounts.length)} ` +
        `distinct scopes=${String(new Set(mounts.map((m) => m.scope)).size)}`,
    );
  });

  it('mounts the global scope exactly once, in app.ts', () => {
    const globals = mounts.filter((mount) => mount.scope === 'general');
    // The positive control comes first and is the half that matters: a detector
    // that stopped recognising the call would report ZERO global mounts, which
    // satisfies "not more than one" while measuring nothing.
    expect(
      globals.length,
      'the global mount was not found at all — this gate is measuring nothing',
    ).toBeGreaterThanOrEqual(1);
    expect(
      globals.map((mount) => mount.path),
      'a router mounts the `general` scope beneath the global limiter, so every request through ' +
        'it increments `rl:general:` TWICE and gets HALF the intended budget. Give the router ' +
        'its own scope, or rely on the global mount, which already covers every route.',
    ).toEqual([GLOBAL_MOUNT_FILE]);
  });

  it('detects a re-mounted scope, and clears the compliant shape — the self-test', () => {
    // The mutation: exactly the defect this gate exists to stop.
    const remount = `
      import { makeRateLimiter } from '../lib/rate-limit.js';
      const router = Router();
      router.use(makeRateLimiter('general'), authenticateToken);
    `;
    expect(limiterMounts(remount).map((m) => m.scope)).toEqual(['general']);

    // ...and the compliant shape it must NOT flag, or it is asserting the
    // presence of a limiter rather than a re-mount of THIS scope.
    const compliant = `router.use(makeRateLimiter('listings'), optionalAuth);`;
    expect(limiterMounts(compliant).map((m) => m.scope)).toEqual(['listings']);

    // The actor-aware factory is in the population too. Counting only
    // `makeRateLimiter` is what made the original census miss three scopes.
    expect(limiterMounts(`router.use(makeActorRateLimiter('cart'));`)).toEqual([
      { factory: 'makeActorRateLimiter', scope: 'cart' },
    ]);

    // Comments and imports are not mounts. Without this the gate reds on a
    // clean tree, because `lib/rate-limit.ts` names the call in prose.
    expect(limiterMounts(`// app.ts mounts makeRateLimiter('general') above every route`)).toEqual(
      [],
    );
    expect(limiterMounts(`/* makeRateLimiter('general') */`)).toEqual([]);
    expect(limiterMounts(`import { makeRateLimiter } from '../lib/rate-limit.js';`)).toEqual([]);
  });
});
