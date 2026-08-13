/**
 * What each provider timestamp shape reads as, and what is deliberately kept
 * rather than omitted.
 *
 * Every expectation here is a MEASURED instant rather than a restatement of the
 * regex: the module's job is to decide whether a value carries a zone, and the
 * only way to observe that decision from outside is the instant that comes back.
 *
 * ONE thing these cases deliberately do NOT claim to cover. `ZONED_TIMESTAMP` is
 * anchored to a preceding `HH:MM` so a bare `2026-01-02` is classified zoneless,
 * and that classification is UNOBSERVABLE through this API: a date-only ISO
 * string is already UTC, so appending `Z` or not appending it yield the same
 * instant. The anchoring earns its place on the `+02:00` / `+0200` cases below,
 * where the two readings genuinely differ — a test named for the date-only case
 * would be asserting a difference that does not exist.
 */

import { describe, expect, it } from 'vitest';
import { parseProviderTimestamp, parseZonelessUtcTimestamp } from '../timestamps.js';

const iso = (value: Date | undefined): string | undefined => value?.toISOString();

describe('parseZonelessUtcTimestamp', () => {
  it('reads a zoneless value as UTC, which is what a `_gmt` field means', () => {
    // The whole reason the function exists: parsed as written this is LOCAL
    // time, so on a machine five hours behind UTC it would land five hours out.
    expect(iso(parseZonelessUtcTimestamp('2026-01-02T03:04:05'))).toBe('2026-01-02T03:04:05.000Z');
  });

  it('keeps a value that carries its OWN zone, in all three spellings', () => {
    // Appending `Z` to any of these produces an invalid date, and #221's first
    // fix then omitted the field — erasing a freshness the platform stated.
    expect(iso(parseZonelessUtcTimestamp('2026-01-02T03:04:05+02:00'))).toBe(
      '2026-01-02T01:04:05.000Z',
    );
    expect(iso(parseZonelessUtcTimestamp('2026-01-02T03:04:05+0200'))).toBe(
      '2026-01-02T01:04:05.000Z',
    );
    expect(iso(parseZonelessUtcTimestamp('2026-01-02T03:04:05Z'))).toBe('2026-01-02T03:04:05.000Z');
  });

  it('reads an HOUR-ONLY offset, which `new Date` alone cannot', () => {
    // Valid ISO 8601, unparseable by `new Date` in either form (`+02` and
    // `+02Z` are both invalid), so without the minute padding this shape is
    // dropped on every sync.
    expect(iso(parseZonelessUtcTimestamp('2026-01-02T03:04:05+02'))).toBe(
      '2026-01-02T01:04:05.000Z',
    );
    expect(iso(parseZonelessUtcTimestamp('2026-01-02T03:04:05-05'))).toBe(
      '2026-01-02T08:04:05.000Z',
    );
  });

  it('keeps a DATE-ONLY field as midnight UTC rather than omitting it', () => {
    expect(iso(parseZonelessUtcTimestamp('2026-01-02'))).toBe('2026-01-02T00:00:00.000Z');
  });

  it('omits what carries no instant at all', () => {
    for (const value of ['', '   ', 'not a date', '0000-00-00', '0000-00-00 00:00:00']) {
      expect(parseZonelessUtcTimestamp(value), value).toBeUndefined();
    }
    expect(parseZonelessUtcTimestamp(null)).toBeUndefined();
    expect(parseZonelessUtcTimestamp(undefined)).toBeUndefined();
  });
});

describe('parseProviderTimestamp', () => {
  it('reads a complete instant exactly as published', () => {
    expect(iso(parseProviderTimestamp('2026-01-02T03:04:05Z'))).toBe('2026-01-02T03:04:05.000Z');
    expect(iso(parseProviderTimestamp('2026-01-02T03:04:05+02:00'))).toBe(
      '2026-01-02T01:04:05.000Z',
    );
  });

  it('applies the hour-only repair too, so the two entry points agree', () => {
    // The padding lives in this function rather than in the zoneless wrapper,
    // so a Shopify field written `+02` is read rather than dropped.
    expect(iso(parseProviderTimestamp('2026-01-02T03:04:05+02'))).toBe('2026-01-02T01:04:05.000Z');
  });

  it('omits blank and unreadable alike', () => {
    for (const value of ['', 'not a date', '0000-00-00 00:00:00']) {
      expect(parseProviderTimestamp(value), value).toBeUndefined();
    }
  });
});
