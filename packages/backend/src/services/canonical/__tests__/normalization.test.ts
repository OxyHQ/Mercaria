/**
 * The normalization vocabulary — pure functions, pinned value by value.
 *
 * The one behavioural claim that matters most here is DELIBERATE COLLAPSE:
 * "Apple" and "Apple Inc." normalizing to the same string is the intended
 * candidate-generation behaviour, and the reason it is safe is that nothing
 * merges on it — that half of acceptance criterion 1 is pinned against the
 * real database in `canonical-graph.realdb.test.ts`; this file pins the
 * collapse itself so a "fix" that stops the collapse is caught as loudly as
 * one that starts merging.
 */

import { describe, expect, it } from 'vitest';
import {
  foldAccents,
  normalizeAliasLookup,
  normalizeDomain,
  normalizeEntityName,
  slugFromName,
} from '../normalization.js';

describe('normalizeEntityName', () => {
  it('lowercases, trims and collapses punctuation to single spaces', () => {
    expect(normalizeEntityName('  Ray-Ban  ')).toBe('ray ban');
    expect(normalizeEntityName('Procter & Gamble')).toBe('procter gamble');
    expect(normalizeEntityName("L'Oréal")).toBe('l oreal');
  });

  it('folds accents', () => {
    expect(normalizeEntityName('Nestlé')).toBe('nestle');
    expect(normalizeEntityName('Müller')).toBe('muller');
    expect(normalizeEntityName('Ñandú')).toBe('nandu');
  });

  it('strips trailing legal suffixes, including punctuated and stacked ones', () => {
    expect(normalizeEntityName('Apple Inc.')).toBe('apple');
    expect(normalizeEntityName('Apple, Inc.')).toBe('apple');
    expect(normalizeEntityName('Samsung Electronics Co., Ltd.')).toBe('samsung electronics');
    expect(normalizeEntityName('Nike Inc Ltd')).toBe('nike');
    expect(normalizeEntityName('Zara S.A.')).toBe('zara');
  });

  it('collapses "Apple" and "Apple Inc." — the intended candidate grouping', () => {
    expect(normalizeEntityName('Apple')).toBe(normalizeEntityName('Apple Inc.'));
  });

  it('strips legal forms only from the END of the name', () => {
    // "co" mid-name is part of the name, not a legal form.
    expect(normalizeEntityName('Co-op Market')).toBe('co op market');
    expect(normalizeEntityName('Inc Magazine')).toBe('inc magazine');
  });

  it('never strips a name down to nothing', () => {
    // A brand that IS a legal-form word keeps it.
    expect(normalizeEntityName('Limited')).toBe('limited');
    expect(normalizeEntityName('Co Ltd')).toBe('co ltd');
  });

  it('returns the empty string only for content-free input', () => {
    expect(normalizeEntityName('!!!')).toBe('');
    expect(normalizeEntityName('   ')).toBe('');
    expect(normalizeEntityName('---')).toBe('');
  });
});

describe('normalizeAliasLookup', () => {
  it('matches the generated normalized_alias column: lower(btrim(...)) and nothing more', () => {
    expect(normalizeAliasLookup('  Ray-Ban  ')).toBe('ray-ban');
    // Deliberately NOT the deep normalization — punctuation survives, exactly
    // as it does in the database's generated column.
    expect(normalizeAliasLookup('Apple Inc.')).toBe('apple inc.');
  });
});

describe('normalizeDomain', () => {
  it('strips scheme, path, query, port and a leading www', () => {
    expect(normalizeDomain('https://www.Apple.com/es/shop?x=1')).toBe('apple.com');
    expect(normalizeDomain('http://apple.com:8080/x')).toBe('apple.com');
    expect(normalizeDomain('WWW.EXAMPLE.CO.UK')).toBe('example.co.uk');
    expect(normalizeDomain('shop.example.com')).toBe('shop.example.com');
  });

  it('refuses what carries no registrable host', () => {
    expect(normalizeDomain('')).toBeNull();
    expect(normalizeDomain('not a domain')).toBeNull();
    expect(normalizeDomain('localhost')).toBeNull();
    expect(normalizeDomain('-bad-.com')).toBeNull();
  });
});

describe('slugFromName', () => {
  it('derives a URL-safe slug, keeping legal suffixes', () => {
    // "Apple Inc." the organization must NOT collide with "apple" the brand by
    // default — the suffix stays in the slug.
    expect(slugFromName('Apple Inc.')).toBe('apple-inc');
    expect(slugFromName('Ñandú S.A.')).toBe('nandu-s-a');
  });

  it('returns null when nothing sluggable remains', () => {
    expect(slugFromName('!!!')).toBeNull();
  });
});

describe('foldAccents', () => {
  it('removes combining marks and nothing else', () => {
    expect(foldAccents('Nestlé Müller Ñ')).toBe('Nestle Muller N');
  });
});
