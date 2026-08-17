/**
 * Correlation ids, the structured-log allow-list and its redaction guard
 * (#367 W17). No database.
 *
 * ## Three of these cases are controls rather than assertions
 *
 * A redaction guard is the easiest thing in a codebase to test vacuously. Assert
 * only that `buyer@example.com` is refused and you cannot tell a working guard
 * from one that refuses EVERYTHING, and you cannot tell either from a corpus that
 * was refused for an unrelated reason (an over-length bound, a typo in a sample).
 * So there are three:
 *
 *  - a POSITIVE control: a corpus of ordinary values — row ids, a schema hash, a
 *    route template, a locale, a reason code — every one of which must pass. A
 *    guard that refused these would pass every refusal case below.
 *  - a MUTATION self-test: the same forbidden corpus run through
 *    `inspectCatalogLogValue` with the pattern list EMPTIED, asserting every
 *    sample is then PERMITTED. That is what proves the patterns are what does the
 *    refusing. `composeCatalogLogLine` is driven with the emptied list too, and
 *    the raw value appears on the line — the leak, demonstrated.
 *  - a per-pattern control: every entry in
 *    `CATALOG_LOG_VALUE_REFUSAL_PATTERNS` is asserted to have a sample, by NAME,
 *    with a count equality. A pattern added later and not sampled fails the
 *    build rather than being silently untested.
 *
 * The over-length rule gets its own pair, because it is deliberately NOT
 * pattern-driven: emptying the list cannot disable it, so its control is the
 * boundary instead — exactly `CATALOG_LOG_MAX_VALUE_LENGTH` passes and one more
 * is refused.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  CORRELATION_ID_HEADER,
  CORRELATION_ID_MAX_LENGTH,
  CORRELATION_ID_MIN_LENGTH,
  CORRELATION_ID_PATTERN,
  currentCorrelationId,
  newCorrelationId,
  resolveCorrelationId,
  runWithCorrelationId,
  type CorrelationId,
} from '../correlation.js';
import {
  CATALOG_LOG_FORBIDDEN_FIELDS,
  CATALOG_LOG_MAX_VALUE_LENGTH,
  CATALOG_LOG_PERMITTED_FIELDS,
  CATALOG_LOG_REFUSED_VALUE,
  CATALOG_LOG_VALUE_REFUSAL_PATTERNS,
  catalogLogValueRefusals,
  composeCatalogLogLine,
  inspectCatalogLogValue,
  resetCatalogLogCounters,
} from '../catalog-log.js';
import {
  CATALOG_OBSERVED_ROUTES,
  resetCatalogRouteObservations,
} from '../route-observations.js';
import {
  pathnameOf,
  resolveObservedRouteTemplate,
} from '../../../middleware/catalog-observability.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** A valid id that is NOT one this module minted, for the inbound-gate cases. */
const CLIENT_SUPPLIED = 'client-supplied_ID-0001';

/* -------------------------------------------------------------------------- */
/* The shape gate                                                              */
/* -------------------------------------------------------------------------- */

describe('the correlation id shape gate', () => {
  it('the literal pattern and the two exported bounds describe one rule', () => {
    // The pattern is a REGEX LITERAL on purpose (a template-built RegExp loses
    // backslashes), which costs a duplicated pair of numbers. This is the gate
    // on that duplication: it cannot drift without failing here.
    expect(CORRELATION_ID_PATTERN.source).toBe(
      `^[A-Za-z0-9_-]{${CORRELATION_ID_MIN_LENGTH},${CORRELATION_ID_MAX_LENGTH}}$`,
    );
    // And nothing in the class is an escape, so there was nothing for a template
    // to have eaten in the first place.
    expect(CORRELATION_ID_PATTERN.source).not.toContain('\\');
  });

  it('mints ids that satisfy its own gate, and are distinct', () => {
    const minted = new Set<string>();
    for (let index = 0; index < 500; index += 1) {
      const id = newCorrelationId();
      expect(CORRELATION_ID_PATTERN.test(id)).toBe(true);
      expect(id.startsWith('mco_')).toBe(true);
      minted.add(id);
    }
    expect(minted.size, 'minted ids collided').toBe(500);
  });

  it.each([
    ['a newline', 'ok-id-0001\ninjected: line'],
    ['a bare newline', '\n'],
    ['a carriage return', 'ok-id-0001\rSET-COOKIE: x'],
    ['a tab', 'ok-id-0001\tvalue'],
    ['a double quote', 'ok-id-0001"'],
    ['a colon', 'ok-id-0001:injected'],
    ['a space', 'ok id 0001'],
    ['a brace', '{"level":30}'],
    ['a dot', 'ok.id.0001'],
    ['too short', 'abc'],
    ['too long', 'a'.repeat(CORRELATION_ID_MAX_LENGTH + 1)],
    ['empty', ''],
  ])('refuses %s', (_label, candidate) => {
    expect(CORRELATION_ID_PATTERN.test(candidate)).toBe(false);
  });

  it('admits the boundary lengths, so the bounds are inclusive as documented', () => {
    expect(CORRELATION_ID_PATTERN.test('a'.repeat(CORRELATION_ID_MIN_LENGTH))).toBe(true);
    expect(CORRELATION_ID_PATTERN.test('a'.repeat(CORRELATION_ID_MAX_LENGTH))).toBe(true);
    expect(CORRELATION_ID_PATTERN.test('a'.repeat(CORRELATION_ID_MIN_LENGTH - 1))).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Resolving an inbound id                                                     */
/* -------------------------------------------------------------------------- */

describe('resolveCorrelationId', () => {
  it('mints when nothing was presented', () => {
    for (const presented of [undefined, null, '']) {
      const resolution = resolveCorrelationId(presented);
      expect(resolution.origin).toBe('minted');
      if (resolution.origin !== 'minted') throw new Error('unreachable');
      expect(resolution.reason).toBe('none_presented');
      expect(CORRELATION_ID_PATTERN.test(resolution.correlationId)).toBe(true);
    }
  });

  it('mints when the header repeated, which Express hands back as an array', () => {
    const resolution = resolveCorrelationId(['one-valid-id-01', 'another-valid-01']);
    expect(resolution.origin).toBe('minted');
    if (resolution.origin !== 'minted') throw new Error('unreachable');
    expect(resolution.reason).toBe('not_a_string');
  });

  it('MINTS rather than refusing when a presented id is malformed', () => {
    // The header a client got wrong must never be the reason its request fails:
    // the gate exists to keep the value out of the logs, not to police clients.
    const resolution = resolveCorrelationId('bad id\nwith: a newline');
    expect(resolution.origin).toBe('minted');
    if (resolution.origin !== 'minted') throw new Error('unreachable');
    expect(resolution.reason).toBe('malformed');
    expect(resolution.correlationId).not.toContain('\n');
    expect(CORRELATION_ID_PATTERN.test(resolution.correlationId)).toBe(true);
  });

  it('accepts a well-formed inbound id verbatim, and reports where it came from', () => {
    const resolution = resolveCorrelationId(CLIENT_SUPPLIED);
    expect(resolution.origin).toBe('client_supplied');
    expect(resolution.correlationId).toBe(CLIENT_SUPPLIED);
  });

  it('names the header in lower case, which is how Node presents it', () => {
    expect(CORRELATION_ID_HEADER).toBe(CORRELATION_ID_HEADER.toLowerCase());
  });
});

/* -------------------------------------------------------------------------- */
/* Propagation and isolation                                                   */
/* -------------------------------------------------------------------------- */

describe('the correlation context', () => {
  it('is undefined outside a request', () => {
    expect(currentCorrelationId()).toBeUndefined();
  });

  it('survives await boundaries', async () => {
    const id = newCorrelationId();
    const seen = await runWithCorrelationId(id, async () => {
      const before = currentCorrelationId();
      await sleep(1);
      const afterOne = currentCorrelationId();
      await Promise.all([sleep(1), sleep(2)]);
      const afterTwo = currentCorrelationId();
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
      return [before, afterOne, afterTwo, currentCorrelationId()];
    });
    expect(seen).toEqual([id, id, id, id]);
  });

  it('leaves nothing behind after the context exits', async () => {
    await runWithCorrelationId(newCorrelationId(), async () => {
      await sleep(1);
    });
    expect(currentCorrelationId()).toBeUndefined();
  });

  it('keeps two OVERLAPPING contexts apart, and proves they overlapped', async () => {
    const idA = newCorrelationId();
    const idB = newCorrelationId();
    expect(idA).not.toBe(idB);

    /**
     * The window control.
     *
     * Two contexts running one after the other would pass the id assertions
     * while proving nothing about isolation — both arms green with no overlap is
     * the measured trap (`~/.claude` memory: a race experiment needs a window
     * control). `timeline` records which arm was executing at each step, and the
     * assertions below require B to have run steps INSIDE A's first sleep.
     */
    const timeline: string[] = [];

    async function traced(tag: string, sleepMs: number, steps: number): Promise<readonly unknown[]> {
      const seen: unknown[] = [];
      for (let step = 0; step < steps; step += 1) {
        timeline.push(tag);
        seen.push(currentCorrelationId());
        await sleep(sleepMs);
      }
      seen.push(currentCorrelationId());
      return seen;
    }

    const [seenA, seenB] = await Promise.all([
      runWithCorrelationId(idA, () => traced('a', 25, 3)),
      runWithCorrelationId(idB, () => traced('b', 1, 6)),
    ]);

    expect(seenA).toEqual([idA, idA, idA, idA]);
    expect(seenB).toEqual([idB, idB, idB, idB, idB, idB, idB]);

    // B took at least two steps before A took its second: the contexts were
    // genuinely live at the same time.
    const firstBIndex = timeline.indexOf('b');
    const secondAIndex = timeline.indexOf('a', timeline.indexOf('a') + 1);
    expect(firstBIndex, 'B never started').toBeGreaterThanOrEqual(0);
    expect(secondAIndex, 'A never took a second step').toBeGreaterThanOrEqual(0);
    expect(
      firstBIndex < secondAIndex,
      `the two contexts did not overlap; timeline was ${timeline.join('')}`,
    ).toBe(true);
    expect(timeline.filter((tag) => tag === 'b').length).toBeGreaterThan(1);
  });

  it('does not let a nested context leak out of itself', async () => {
    const outer = newCorrelationId();
    const inner = newCorrelationId();
    await runWithCorrelationId(outer, async () => {
      expect(currentCorrelationId()).toBe(outer);
      await runWithCorrelationId(inner, async () => {
        await sleep(1);
        expect(currentCorrelationId()).toBe(inner);
      });
      await sleep(1);
      expect(currentCorrelationId()).toBe(outer);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* The field allow-list                                                        */
/* -------------------------------------------------------------------------- */

describe('the catalog log field allow-list', () => {
  it('is DISJOINT from the forbidden list, with a floor on both', () => {
    // The vacuity floor first: two empty lists are trivially disjoint, and a
    // tuple somebody emptied would pass the intersection test in silence.
    expect(CATALOG_LOG_FORBIDDEN_FIELDS.length, 'the prohibition list is empty').toBeGreaterThan(20);
    expect(CATALOG_LOG_PERMITTED_FIELDS.length, 'the permitted list is empty').toBeGreaterThan(20);

    const permitted = new Set<string>(CATALOG_LOG_PERMITTED_FIELDS);
    const overlap = CATALOG_LOG_FORBIDDEN_FIELDS.filter((field) => permitted.has(field));
    expect(overlap, 'a forbidden field name is also a permitted one').toEqual([]);

    process.stdout.write(
      `[census] catalog log fields: ${CATALOG_LOG_PERMITTED_FIELDS.length} permitted, `
        + `${CATALOG_LOG_FORBIDDEN_FIELDS.length} forbidden, 0 overlapping\n`,
    );
  });

  it('names every category of prohibited data the issue lists', () => {
    // Named individually rather than by counting, because the point is the
    // categories: a later reader can see which prohibition is missing.
    for (const required of [
      'buyerEmail',
      'sellerEmail',
      'phone',
      'token',
      'address',
      'rawQuery',
      'displayName',
      'oxyUserId',
    ]) {
      expect(CATALOG_LOG_FORBIDDEN_FIELDS, `${required} is not named`).toContain(required);
    }
  });

  it('has no field that could carry a person, and keeps storeId, which is a tenant', () => {
    const permitted = CATALOG_LOG_PERMITTED_FIELDS.map((field) => field.toLowerCase());
    for (const fragment of ['email', 'phone', 'token', 'oxyuser', 'address', 'cookie', 'session']) {
      expect(
        permitted.filter((field) => field.includes(fragment)),
        `a permitted field name contains "${fragment}"`,
      ).toEqual([]);
    }
    expect(CATALOG_LOG_PERMITTED_FIELDS).toContain('storeId');
  });
});

/* -------------------------------------------------------------------------- */
/* The redaction guard, its positive control and its mutation self-test        */
/* -------------------------------------------------------------------------- */

/** One sample per pattern kind, and nothing else. Kept as data for the census. */
const FORBIDDEN_SAMPLES: readonly { readonly kind: string; readonly value: string }[] = [
  { kind: 'email_address', value: 'buyer@example.com' },
  { kind: 'bearer_credential', value: 'Bearer abcdefghijkl' },
  {
    kind: 'jwt',
    value: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dBjftJeZ4CVPmB92K27uhbUJU1p1r',
  },
  { kind: 'guest_session_token', value: 'mgs_abcdefghijklmnopqrst' },
  { kind: 'guest_portal_token', value: 'mgx_abcdefghijklmnopqrst' },
  { kind: 'mercaria_developer_key', value: 'mercaria_sk_abcdefghijklmn' },
  { kind: 'stripe_secret_key', value: 'sk_test_abcdefghijklmnop' },
  { kind: 'phone_number', value: '+34 600 123 456' },
];

/**
 * Ordinary values that must pass.
 *
 * The positive control. A guard that refused everything would satisfy every
 * refusal case above; this is what tells the two apart.
 */
const PERMITTED_SAMPLES: readonly string[] = [
  '01998b1e-3c2e-7c1a-8f0a-6b1d2e3f4a5b',
  'zz-obs-trace-draft-published',
  '/catalog-authoring/schemas/:productTypeKey',
  'GET',
  'es-es',
  'ES',
  'no_canonical_attachment',
  'draft:present,listing:absent',
  'electronics.phones.smartphones',
  'merchant_declared',
  'mco_0123456789abcdef0123456789abcdef',
  /**
   * REGRESSION SAMPLES — every one of these is a real value the guard once ate,
   * or the shape that ate it.
   *
   * `trace.realdb.test.ts` caught the phone pattern refusing a `schema_hash`
   * whose hex happened to contain a `00` digit run, so the trace's own log line
   * carried `[refused]` where the schema version pin belonged. The original
   * corpus here used `'a'.repeat(64)` as its hash sample — all letters, no digit
   * run — which is precisely why the positive control missed it. A control's
   * corpus has to look like production, not like a placeholder.
   */
  '7a7a2d6f62732d74726163652d70726976616379000000000000000000000000',
  '0000000000000000000000000000000000000000000000000000000000000000',
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  '00000000-0000-7000-8000-000000000000',
  // A version pin, and the `00`-prefixed forms the pattern deliberately no
  // longer looks at — see the note on `phone_number`.
  '1.0.0',
  '00123',
  '0034-600-123-456',
];

describe('the log value redaction guard', () => {
  beforeEach(() => {
    resetCatalogLogCounters();
  });

  it('has a sample for EVERY pattern, by name and by count', () => {
    const patternKinds = CATALOG_LOG_VALUE_REFUSAL_PATTERNS.map((entry) => entry.kind).sort();
    const sampleKinds = FORBIDDEN_SAMPLES.map((entry) => entry.kind).sort();
    expect(patternKinds.length, 'no patterns are registered').toBeGreaterThan(5);
    expect(sampleKinds).toEqual(patternKinds);
  });

  it('refuses each forbidden sample, and reports the RIGHT kind', () => {
    for (const sample of FORBIDDEN_SAMPLES) {
      const verdict = inspectCatalogLogValue(sample.value);
      expect(verdict.verdict, `${sample.kind} was permitted`).toBe('refused');
      if (verdict.verdict !== 'refused') throw new Error('unreachable');
      expect(verdict.kind, `${sample.kind} was refused as ${verdict.kind}`).toBe(sample.kind);
    }
  });

  it('permits ordinary values — the positive control', () => {
    for (const value of PERMITTED_SAMPLES) {
      const verdict = inspectCatalogLogValue(value);
      expect(verdict.verdict, `an ordinary value was refused: ${value}`).toBe('permitted');
    }
    process.stdout.write(
      `[census] guard corpus: ${FORBIDDEN_SAMPLES.length} refused, `
        + `${PERMITTED_SAMPLES.length} permitted, `
        + `${CATALOG_LOG_VALUE_REFUSAL_PATTERNS.length} patterns\n`,
    );
  });

  it('documents its own gap: a `00`-prefixed phone number is NOT detected', () => {
    // Not an oversight — a decision, with two measured false positives behind it
    // (see the `phone_number` note). Pinned so the trade-off is visible in the
    // suite rather than only in a comment, and so re-adding the `00` branch
    // fails HERE, next to the corpus that shows why it was removed.
    expect(inspectCatalogLogValue('0034600123456').verdict).toBe('permitted');
    expect(inspectCatalogLogValue('+34600123456').verdict).toBe('refused');
  });

  it('MUTATION SELF-TEST: with the patterns emptied, every forbidden sample passes', () => {
    // If this went green with the patterns in place, the refusals above would be
    // coming from somewhere other than the guard and would prove nothing.
    for (const sample of FORBIDDEN_SAMPLES) {
      const verdict = inspectCatalogLogValue(sample.value, []);
      expect(
        verdict.verdict,
        `${sample.kind} is refused even with no patterns — the refusal is not the guard's`,
      ).toBe('permitted');
    }
  });

  it('MUTATION SELF-TEST: with the patterns emptied, the raw value reaches the line', () => {
    const leaked = composeCatalogLogLine(
      { event: 'publication_trace_read', reasonCode: 'buyer@example.com' },
      [],
    );
    expect(leaked.reasonCode).toBe('buyer@example.com');
    expect(leaked.logValueRefusals).toBeUndefined();

    const guarded = composeCatalogLogLine({
      event: 'publication_trace_read',
      reasonCode: 'buyer@example.com',
    });
    expect(guarded.reasonCode).toBe(CATALOG_LOG_REFUSED_VALUE);
    expect(guarded.logValueRefusals).toEqual(['reasonCode:email_address']);
  });

  it('refuses over-length values, and the boundary is exact', () => {
    const atBound = 'a'.repeat(CATALOG_LOG_MAX_VALUE_LENGTH);
    const overBound = 'a'.repeat(CATALOG_LOG_MAX_VALUE_LENGTH + 1);
    expect(inspectCatalogLogValue(atBound).verdict).toBe('permitted');
    const verdict = inspectCatalogLogValue(overBound);
    expect(verdict.verdict).toBe('refused');
    if (verdict.verdict !== 'refused') throw new Error('unreachable');
    expect(verdict.kind).toBe('over_length');

    // The length rule is deliberately NOT pattern-driven, so emptying the list
    // cannot disable it. Stated as an assertion so the divergence is visible.
    expect(inspectCatalogLogValue(overBound, []).verdict).toBe('refused');
  });

  it('counts every refusal it makes, and the counter starts at zero', () => {
    expect(catalogLogValueRefusals()).toBe(0);
    composeCatalogLogLine({
      event: 'publication_trace_read',
      reasonCode: 'buyer@example.com',
      outcome: 'Bearer abcdefghijkl',
      hop: 'listing',
    });
    expect(catalogLogValueRefusals()).toBe(2);
  });

  it('replaces a refused value rather than truncating it', () => {
    const line = composeCatalogLogLine({
      event: 'publication_trace_read',
      reasonCode: 'contact sold-by@merchant.example for the rest',
    });
    // Not one character of the original survives, in either direction.
    expect(line.reasonCode).toBe(CATALOG_LOG_REFUSED_VALUE);
    expect(JSON.stringify(line)).not.toContain('merchant.example');
    expect(JSON.stringify(line)).not.toContain('sold-by');
  });
});

/* -------------------------------------------------------------------------- */
/* Composing a line                                                            */
/* -------------------------------------------------------------------------- */

describe('composeCatalogLogLine', () => {
  beforeEach(() => {
    resetCatalogLogCounters();
  });

  it('carries the correlation id in scope, and omits it outside one', () => {
    const outside = composeCatalogLogLine({ event: 'route_observed' });
    expect(outside.correlationId).toBeUndefined();

    const id: CorrelationId = newCorrelationId();
    const inside = runWithCorrelationId(id, () =>
      composeCatalogLogLine({ event: 'route_observed' }),
    );
    expect(inside.correlationId).toBe(id);
  });

  it('stamps the domain and the event, and drops absent fields', () => {
    const line = composeCatalogLogLine({
      event: 'route_observed',
      route: '/search',
      method: 'GET',
      statusCode: 200,
      durationMs: 12.5,
      listingId: undefined,
      storeId: null,
    });
    expect(line.domain).toBe('catalog');
    expect(line.event).toBe('route_observed');
    expect(line.route).toBe('/search');
    expect(line.durationMs).toBe(12.5);
    expect('listingId' in line).toBe(false);
    expect('storeId' in line).toBe(false);
  });

  it('emits nothing that is not a permitted field name', () => {
    const line = composeCatalogLogLine({
      event: 'publication_trace_read',
      draftId: 'zz-draft',
      listingId: 'zz-listing',
      storeId: 'zz-store',
      schemaHash: 'a'.repeat(64),
      count: 3,
    });
    const allowed = new Set<string>([
      ...CATALOG_LOG_PERMITTED_FIELDS,
      'domain',
      'correlationId',
      'logValueRefusals',
    ]);
    const unexpected = Object.keys(line).filter((key) => !allowed.has(key));
    expect(unexpected, 'a line carried a field nobody declared').toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Route template resolution                                                   */
/* -------------------------------------------------------------------------- */

describe('resolveObservedRouteTemplate', () => {
  beforeEach(() => {
    resetCatalogRouteObservations();
  });

  it('has a non-empty closed set to resolve against', () => {
    // The vacuity floor: with no observed routes every case below would pass by
    // resolving nothing, and the middleware would be a no-op reporting health.
    expect(CATALOG_OBSERVED_ROUTES.length).toBeGreaterThan(0);
    process.stdout.write(
      `[census] observed route templates: ${CATALOG_OBSERVED_ROUTES.length} `
        + `(${CATALOG_OBSERVED_ROUTES.join(', ')})\n`,
    );
  });

  it('resolves every member of the closed set from its own path', () => {
    for (const key of CATALOG_OBSERVED_ROUTES) {
      const separator = key.indexOf(' ');
      const method = key.slice(0, separator);
      const route = key.slice(separator + 1);
      // A template with no `:param` IS a concrete path, so this is a real
      // round trip for the whole set as it stands today.
      if (route.includes(':')) continue;
      expect(resolveObservedRouteTemplate(method, route), `${key} did not resolve`).toBe(route);
    }
  });

  it('tolerates a trailing slash and the wrong case, as Express routing does', () => {
    expect(resolveObservedRouteTemplate('GET', '/categories/')).toBe('/categories');
    expect(resolveObservedRouteTemplate('get', '/CATEGORIES')).toBe('/categories');
    // A parameterised template, which is the case that matters: `:productTypeKey`
    // must match exactly one segment and must not span a `/`.
    expect(
      resolveObservedRouteTemplate('GET', '/catalog-authoring/schemas/smartphone/'),
    ).toBe('/catalog-authoring/schemas/:productTypeKey');
    expect(
      resolveObservedRouteTemplate('GET', '/CATALOG-AUTHORING/schemas/smartphone'),
    ).toBe('/catalog-authoring/schemas/:productTypeKey');
    // ...and must NOT absorb a deeper path, which is how a template matcher ends
    // up reporting a bucket for traffic it never served.
    expect(
      resolveObservedRouteTemplate('GET', '/catalog-authoring/schemas/smartphone/history'),
    ).toBeUndefined();
  });

  it('resolves NOTHING for a path outside the closed set', () => {
    for (const path of [
      '/health/live',
      '/orders/zz-order-1',
      '/admin/stores/zz-store/reports/summary',
      '/webhooks/stripe',
      '/',
      '',
      '/categories/electronics',
      '/search/suggestions',
    ]) {
      expect(resolveObservedRouteTemplate('GET', path), `${path} resolved`).toBeUndefined();
    }
  });

  it('will not let a :param segment span a slash', () => {
    // Guards a template the budget list may grow later: `/categories/:id` must
    // not absorb `/categories/a/b`, which is how a matcher reports a bucket for
    // traffic it never served. Asserted through the segment-count rule, which is
    // what makes it true.
    expect(resolveObservedRouteTemplate('GET', '/categories/a/b')).toBeUndefined();
  });

  it('resolves nothing for the wrong method', () => {
    expect(resolveObservedRouteTemplate('POST', '/categories')).toBeUndefined();
    expect(resolveObservedRouteTemplate('DELETE', '/search')).toBeUndefined();
  });
});

describe('pathnameOf', () => {
  it.each([
    ['/search', '/search'],
    ['/search?q=phone', '/search'],
    ['/search?q=a%20b&limit=10', '/search'],
    ['/categories#frag', '/categories'],
    ['/categories?a=1#frag', '/categories'],
    ['/', '/'],
  ])('%s -> %s', (input, expected) => {
    expect(pathnameOf(input)).toBe(expected);
  });

  it('never returns a query string, so a shopper term cannot reach a bucket key', () => {
    expect(pathnameOf('/search?q=buyer@example.com')).not.toContain('@');
  });
});
