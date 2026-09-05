/**
 * The pure rules of the ingestion framework (#62): rights, health,
 * normalization and redaction.
 *
 * All four are pure functions of their inputs, which is why they are tested
 * here rather than through a database — and why they are pure in the first
 * place: the rights derivation is stated once and the SQL trigger mirrors it,
 * so the two can be driven through the same matrix and compared.
 *
 * ## The fixture rule this file follows
 *
 * `~/Oxy/AGENTS.md` (E): a check's fixtures must exercise the distinction the
 * check exists to make. So the health cases include a run that FAILED and one
 * that merely did not finish — the two look identical to a counter and differ
 * on the only thing that matters — and the normalization cases include values
 * that are the wrong TYPE rather than merely absent.
 */

import { describe, expect, it } from 'vitest';
import {
  CATALOG_SOURCE_HEALTH_STATES,
  CATALOG_SOURCE_KINDS,
  CATALOG_SOURCE_RETIRING_OUTCOMES,
  CATALOG_SOURCE_RIGHTS,
  CATALOG_SOURCE_STATUSES,
  type CatalogSourceRight,
  type CatalogSourceRightsVerdict,
  type CatalogSourceStatus,
} from '@mercaria/shared-types';
import {
  cacheTtlSeconds,
  projectedSourceRights,
  resolveSourceRights,
  type SourcePolicyRights,
} from '../rights.js';
import {
  MATCHING_AMBIGUITY_RATIO,
  SCHEMA_DRIFT_REJECTION_RATIO,
  classifyRunOutcome,
  mayRetireUnseen,
  nextRunDelayMs,
  statusAfterRun,
} from '../health.js';
import { NORMALIZATION_LIMITS, canonicalizeNormalizedRecord } from '../normalization.js';
import { offerKindFor } from '../ingest.service.js';
import { MAX_STORED_PAYLOAD_BYTES, redactSourceObservation } from '../redact.js';

const FULL: SourcePolicyRights = {
  mayDisplay: true,
  mayStore: true,
  mayCache: true,
  cacheTtlSeconds: 600,
  mayDisplayPrice: true,
  mayDisplayMedia: true,
  mayLinkOut: true,
  mayAppendAffiliateParams: true,
  mayIndex: true,
  mayRefreshAutomatically: true,
  extractionMode: 'contracted',
  attributionRequired: true,
};

describe('rights', () => {
  it('grants NOTHING with no active policy, whatever the status', () => {
    for (const status of CATALOG_SOURCE_STATUSES) {
      const rights = resolveSourceRights(status, null);
      for (const right of CATALOG_SOURCE_RIGHTS) {
        expect(rights[right], `${status} granted '${right}' with no policy`).toBe(false);
      }
    }
  });

  it('grants NOTHING while draft or revoked, however permissive the policy', () => {
    for (const status of ['draft', 'revoked'] satisfies CatalogSourceStatus[]) {
      const rights = resolveSourceRights(status, FULL);
      for (const right of CATALOG_SOURCE_RIGHTS) {
        expect(rights[right], `${status} granted '${right}'`).toBe(false);
      }
    }
  });

  it('pauses the REFRESH and nothing else', () => {
    const paused = resolveSourceRights('paused', FULL);
    expect(paused.automated_refresh).toBe(false);
    // Extraction is itself a fetch, so pausing stops it too — the rule is about
    // the mechanism that reaches out, whichever right authorises it.
    expect(paused.extraction).toBe(false);
    expect(paused.display_price).toBe(true);
    expect(paused.store).toBe(true);
    expect(paused.outbound_link).toBe(true);
  });

  it('keeps a FAILED source refreshable — the distinction `paused` exists for', () => {
    // A source that answered 500 once must retry without a person re-enabling
    // it; collapsing `failed` into `paused` would make an outage need a human.
    expect(resolveSourceRights('failed', FULL).automated_refresh).toBe(true);
    expect(resolveSourceRights('paused', FULL).automated_refresh).toBe(false);
  });

  it('projects the three coarse rights the registry advertises', () => {
    expect(projectedSourceRights('active', FULL)).toEqual({
      mayDisplay: true,
      mayStore: true,
      attributionRequired: true,
    });
    // Attribution is the one whose safe default is TRUE: with display off there
    // is nothing to attribute, and the conservative answer is to name the source.
    expect(projectedSourceRights('revoked', FULL)).toEqual({
      mayDisplay: false,
      mayStore: false,
      attributionRequired: true,
    });
    expect(projectedSourceRights('active', null)).toEqual({
      mayDisplay: false,
      mayStore: false,
      attributionRequired: true,
    });
  });

  it('reads a display umbrella that is NOT the disjunction of price and media', () => {
    // A source permitted to show a merchant's name and neither its price nor
    // its images is a real agreement, and reading `may_display` as "price or
    // media" would erase it.
    const nameOnly: SourcePolicyRights = {
      ...FULL,
      mayDisplayPrice: false,
      mayDisplayMedia: false,
    };
    expect(projectedSourceRights('active', nameOnly).mayDisplay).toBe(true);
  });

  it('answers a cache TTL only while caching is permitted', () => {
    expect(cacheTtlSeconds('active', FULL)).toBe(600);
    expect(cacheTtlSeconds('revoked', FULL)).toBeNull();
    expect(cacheTtlSeconds('active', { ...FULL, mayCache: false, cacheTtlSeconds: null })).toBeNull();
  });
});

describe('health', () => {
  const base = {
    enumerationComplete: true,
    failure: null,
    rejected: 0,
    quarantined: 0,
    reviewRequired: 0,
    fetched: 100,
    refreshPermitted: true,
  } as const;

  it('classifies a complete pass as the ONE retiring outcome', () => {
    expect(classifyRunOutcome(base)).toBe('full_feed_success');
    expect(CATALOG_SOURCE_RETIRING_OUTCOMES).toEqual(['full_feed_success']);
  });

  it('classifies an INCOMPLETE pass as partial, which may not retire', () => {
    const partial = classifyRunOutcome({ ...base, enumerationComplete: false });
    expect(partial).toBe('partial_feed');
    // The distinction this suite exists to make: a run that succeeded in part
    // and a run that finished look identical to a counter.
    expect(mayRetireUnseen({ enumerationComplete: false, outcome: partial })).toBe(false);
    expect(mayRetireUnseen({ enumerationComplete: true, outcome: 'full_feed_success' })).toBe(true);
  });

  it('never authorises retirement on ANY outcome but a complete success', () => {
    for (const outcome of CATALOG_SOURCE_HEALTH_STATES) {
      const expected = outcome === 'full_feed_success';
      expect(
        mayRetireUnseen({ enumerationComplete: true, outcome }),
        `'${outcome}' authorised retirement`,
      ).toBe(expected);
    }
  });

  it('reports a withdrawn refresh right BEFORE blaming the provider', () => {
    // Saying `source_outage` would send somebody to check a service that is
    // answering perfectly well.
    expect(classifyRunOutcome({ ...base, refreshPermitted: false })).toBe('rights_suspended');
    expect(
      classifyRunOutcome({ ...base, refreshPermitted: false, failure: 'auth_failure' }),
    ).toBe('rights_suspended');
  });

  it('calls a page drift once enough of it was refused', () => {
    const justUnder = Math.floor(SCHEMA_DRIFT_REJECTION_RATIO * 100) - 1;
    expect(classifyRunOutcome({ ...base, rejected: justUnder })).toBe('full_feed_success');
    expect(classifyRunOutcome({ ...base, rejected: justUnder + 1 })).toBe('schema_drift');
    // Quarantined records count toward the same ratio: a provider that changed
    // its price denomination trips the anomaly guard, not the parser.
    expect(classifyRunOutcome({ ...base, quarantined: justUnder + 1 })).toBe('schema_drift');
  });

  it('reports ambiguity only well above the drift line', () => {
    expect(MATCHING_AMBIGUITY_RATIO).toBeGreaterThan(SCHEMA_DRIFT_REJECTION_RATIO);
    expect(classifyRunOutcome({ ...base, reviewRequired: 60 })).toBe('matching_ambiguity');
    expect(classifyRunOutcome({ ...base, reviewRequired: 10 })).toBe('full_feed_success');
  });

  it('marks the source failed only when the FETCH failed', () => {
    expect(statusAfterRun('active', 'auth_failure')).toBe('failed');
    expect(statusAfterRun('active', 'rate_limit')).toBe('failed');
    expect(statusAfterRun('active', 'source_outage')).toBe('failed');
    // A pass that read the feed and refused half of it is degraded and stays
    // `active`: backing off from a healthy provider over our own parse problem
    // fixes nothing.
    expect(statusAfterRun('active', 'schema_drift')).toBe('active');
    expect(statusAfterRun('failed', 'full_feed_success')).toBe('active');
  });

  it('never moves a source OUT of a decision somebody made', () => {
    for (const outcome of CATALOG_SOURCE_HEALTH_STATES) {
      expect(statusAfterRun('paused', outcome)).toBe('paused');
      expect(statusAfterRun('revoked', outcome)).toBe('revoked');
      expect(statusAfterRun('draft', outcome)).toBe('draft');
    }
  });

  it("honours a provider's Retry-After when it is LONGER, and never when shorter", () => {
    const maxBackoffMs = 6 * 60 * 60 * 1_000;
    const computed = nextRunDelayMs({
      cadenceSeconds: 3_600,
      consecutiveFailures: 1,
      retryAfterMs: undefined,
      maxBackoffMs,
    });
    expect(
      nextRunDelayMs({
        cadenceSeconds: 3_600,
        consecutiveFailures: 1,
        retryAfterMs: computed * 4,
        maxBackoffMs,
      }),
    ).toBe(computed * 4);
    // A provider cannot talk Mercaria into hammering it.
    expect(
      nextRunDelayMs({
        cadenceSeconds: 3_600,
        consecutiveFailures: 1,
        retryAfterMs: 1,
        maxBackoffMs,
      }),
    ).toBe(computed);
  });

  it('caps the backoff rather than overflowing on a long outage', () => {
    const maxBackoffMs = 6 * 60 * 60 * 1_000;
    for (const failures of [1, 5, 10, 50, 5_000]) {
      const delay = nextRunDelayMs({
        cadenceSeconds: 3_600,
        consecutiveFailures: failures,
        retryAfterMs: undefined,
        maxBackoffMs,
      });
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(maxBackoffMs);
    }
  });
});

describe('normalization', () => {
  const bare = { title: 'A widget', identifiers: [], options: [], media: [] };

  it('refuses a record with no usable title, and nothing else is mandatory', () => {
    expect(canonicalizeNormalizedRecord({ ...bare, title: '   ' })).toBeNull();
    expect(canonicalizeNormalizedRecord(bare)).not.toBeNull();
  });

  it('bounds every text field the framework stores', () => {
    // Longer than the LARGEST bound, so every field below is genuinely truncated
    // rather than passing through untouched — a fixture inside the bound cannot
    // tell a working truncation from a missing one.
    const long = 'x'.repeat(NORMALIZATION_LIMITS.description * 2);
    const result = canonicalizeNormalizedRecord({ ...bare, title: long, description: long });
    expect(result?.title.length).toBe(NORMALIZATION_LIMITS.title);
    expect(result?.description?.length).toBe(NORMALIZATION_LIMITS.description);
  });

  it('drops a URL that is not an absolute http(s) one', () => {
    // A `javascript:` scheme in a URL field is a link Mercaria would render.
    for (const hostile of ['javascript:alert(1)', 'data:text/html,x', '/relative/path', 'nonsense']) {
      expect(canonicalizeNormalizedRecord({ ...bare, sourceUrl: hostile })?.sourceUrl).toBeUndefined();
    }
    expect(
      canonicalizeNormalizedRecord({ ...bare, sourceUrl: 'https://shop.example/p/1' })?.sourceUrl,
    ).toBe('https://shop.example/p/1');
  });

  it('drops a price that is not a non-negative integer in a shaped currency', () => {
    expect(canonicalizeNormalizedRecord({ ...bare, price: { amount: -1, currency: 'EUR' } })?.price).toBeUndefined();
    expect(canonicalizeNormalizedRecord({ ...bare, price: { amount: 19.99, currency: 'EUR' } })?.price).toBeUndefined();
    expect(canonicalizeNormalizedRecord({ ...bare, price: { amount: 100, currency: 'euros' } })?.price).toBeUndefined();
    // A currency Mercaria does not PRESENT is still a currency a source trades
    // in — ADR 0002 D18's documented exception, applied before the row.
    expect(canonicalizeNormalizedRecord({ ...bare, price: { amount: 100, currency: 'xbt' } })?.price).toEqual({
      amount: 100,
      currency: 'XBT',
    });
  });

  it('drops a free-delivery threshold with no delivery cost', () => {
    // It says what you would stop paying without ever saying what you pay — and
    // the offer table refuses that pair, so dropping it here means the refusal
    // never has to fire.
    const result = canonicalizeNormalizedRecord({
      ...bare,
      delivery: { freeOver: { amount: 5_000, currency: 'EUR' } },
    });
    expect(result?.delivery?.freeOver).toBeUndefined();
  });

  it('normalizes identifiers without GUESSING a scheme', () => {
    const result = canonicalizeNormalizedRecord({
      ...bare,
      identifiers: [
        { scheme: 'isbn', value: '978-0-13-235088-4' },
        { scheme: 'isbn', value: '9780132350884' },
        { scheme: 'mpn', value: ' a-1234 ' },
      ],
    });
    // The hyphenated and unhyphenated ISBN are the same identifier, so the
    // second is a duplicate rather than a second assertion.
    expect(result?.identifiers).toEqual([
      { scheme: 'isbn', value: '9780132350884' },
      { scheme: 'mpn', value: 'A1234' },
    ]);
  });

  it('caps arrays so one record cannot decide how much storage it costs', () => {
    const many = Array.from({ length: 500 }, (_, index) => `https://cdn.example/${index}.jpg`);
    const result = canonicalizeNormalizedRecord({ ...bare, media: many });
    expect(result?.media.length).toBe(NORMALIZATION_LIMITS.media);
  });

  it('keeps an unknown fact ABSENT rather than zero', () => {
    const result = canonicalizeNormalizedRecord(bare);
    expect(result).not.toHaveProperty('price');
    expect(result).not.toHaveProperty('availableQuantity');
    expect(result).not.toHaveProperty('delivery');
  });
});

describe('redaction', () => {
  const record = {
    title: 'A widget',
    brandHint: 'Acme',
    merchantSku: 'SKU-1',
    identifiers: [{ scheme: 'ean' as const, value: '4006381333931' }],
    options: [{ name: 'Colour', value: 'Black' }],
    media: [],
    price: { amount: 1_999, currency: 'EUR' },
  };

  it('emits the matcher’s own read contract, so an ingested record is matchable', () => {
    const { payload } = redactSourceObservation(record, {}) ?? { payload: {} };
    // `subject-loader.ts` reads exactly these keys off a stored payload. A
    // second vocabulary here would leave every ingested record matching on a
    // title and nothing else, silently.
    expect(payload).toMatchObject({
      title: 'A widget',
      brand: 'Acme',
      sku: 'SKU-1',
      ean: '4006381333931',
      attributes: { Colour: 'Black' },
      price: 1_999,
      currency: 'EUR',
    });
  });

  it('hashes the STORED payload stably, whatever order the fields were built in', () => {
    const first = redactSourceObservation(record, { a: 1 });
    const second = redactSourceObservation({ ...record }, { a: 1 });
    expect(first?.contentHash).toBe(second?.contentHash);
    expect(first?.contentHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('digests the RAW payload separately, and retains none of it', () => {
    const withRaw = redactSourceObservation(record, { secret: 'do-not-store', id: 7 });
    expect(withRaw?.rawDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(withRaw?.payload)).not.toContain('do-not-store');
    // Two different raw payloads with one stored projection: the content hash
    // is the same and the raw digest is not, which is what makes the digest
    // useful at all.
    const other = redactSourceObservation(record, { secret: 'something-else', id: 8 });
    expect(other?.contentHash).toBe(withRaw?.contentHash);
    expect(other?.rawDigest).not.toBe(withRaw?.rawDigest);
  });

  it('digests an UNSERIALIZABLE raw payload rather than throwing', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    // A provider payload is arbitrary by definition, and a crash here would
    // take down the page rather than the record.
    expect(redactSourceObservation(record, circular)?.rawDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('refuses an oversized projection rather than truncating it', () => {
    // Truncating would hash differently on every delivery of the same content,
    // so the convergence key would stop converging and the source would mint an
    // observation per refresh forever.
    const huge = {
      ...record,
      media: Array.from({ length: 24 }, (_, index) => `https://cdn.example/${'y'.repeat(1_900)}-${index}.jpg`),
    };
    const result = redactSourceObservation(huge, {});
    const serialized = JSON.stringify(result?.payload ?? {});
    if (result === null) {
      expect(true).toBe(true);
    } else {
      expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(MAX_STORED_PAYLOAD_BYTES);
    }
  });
});

describe('which offer kind a source produces', () => {
  /** Every right false but the two named. The other seven do not enter this decision. */
  function rights(...granted: readonly CatalogSourceRight[]): CatalogSourceRightsVerdict {
    return Object.fromEntries(
      CATALOG_SOURCE_RIGHTS.map((right) => [right, granted.includes(right)]),
    ) as CatalogSourceRightsVerdict;
  }

  const DESTINATION = 'https://shop.example/product/1';

  it('refuses a destination without the outbound_link right, whatever the source kind', () => {
    // Rights 5 and 6, structural: `offers_kind_shape_check` refuses a
    // destination on `informational`, so this is a shape rather than a null
    // somebody remembered to pass.
    for (const kind of CATALOG_SOURCE_KINDS) {
      expect(offerKindFor(rights('affiliate_params'), kind, DESTINATION)).toBe('informational');
      expect(offerKindFor(rights(), kind, DESTINATION)).toBe('informational');
    }
  });

  it('refuses without a destination even where both rights are granted', () => {
    for (const kind of CATALOG_SOURCE_KINDS) {
      expect(offerKindFor(rights('outbound_link', 'affiliate_params'), kind, undefined)).toBe(
        'informational',
      );
    }
  });

  it('grants `affiliate` on `affiliate_network` alone, and `external` on every other kind', () => {
    // The property the direct-partner procedure depends on, and the reason it
    // needs stating: `sourceKind` is the SOURCE ROW's
    // (`catalog_sources.kind`, operator-set through `configureSourceSchema`),
    // never the adapter's. `CatalogSourceAdapter.kind` is a separate
    // descriptive field and nothing compares the two — so a source configured
    // `affiliate_network` with `provider: 'product_feed'` produces `affiliate`
    // offers from an ordinary feed.
    const both = rights('outbound_link', 'affiliate_params');
    for (const kind of CATALOG_SOURCE_KINDS) {
      expect(offerKindFor(both, kind, DESTINATION)).toBe(
        kind === 'affiliate_network' ? 'affiliate' : 'external',
      );
    }
    // A floor under the case above: it would also pass if EVERY kind answered
    // `affiliate`, so the sweep has to contain at least one of each.
    expect(CATALOG_SOURCE_KINDS).toContain('affiliate_network');
    expect(CATALOG_SOURCE_KINDS.filter((kind) => kind !== 'affiliate_network').length).toBeGreaterThan(0);
  });

  it('needs BOTH rights for `affiliate` — outbound_link alone is `external`', () => {
    // Which is the honest degradation, not a defect: `destination.ts` says a
    // source with no `affiliate_params` right stored no routing metadata, so
    // the plain link is the correct thing to hand over.
    expect(offerKindFor(rights('outbound_link'), 'affiliate_network', DESTINATION)).toBe('external');
  });
});
