/**
 * Pure logic of the commerce graph services (#54) — no database.
 *
 * The realdb suite (`db/__tests__/commerce-graph.realdb.test.ts`) holds every
 * property a constraint or index enforces; this file pins the two pure
 * functions whose wrongness a green realdb run could mask: the eligibility
 * derivation (a truth table, not two happy paths) and the domain
 * normalization that feeds the collision gate (a case-variant spelling that
 * survived normalization would dodge the partial unique silently).
 */

import { describe, expect, it } from 'vitest';
import {
  deriveNativeCheckoutEligibility,
  normalizeAlias,
  normalizeDomain,
} from '../commerce-graph/merchant.service.js';
import { isMercariaError } from '../../lib/errors/error-codes.js';

describe('deriveNativeCheckoutEligibility', () => {
  // The FULL truth table: only claimed + actively linked is eligible. A
  // fixture set with only the corners a happy path visits could not tell the
  // conjunction from either single conjunct.
  it.each([
    ['unclaimed', false, false],
    ['unclaimed', true, false],
    ['claim_pending', false, false],
    ['claim_pending', true, false],
    ['claimed', false, false],
    ['claimed', true, true],
  ] as const)('claimState=%s, linked=%s → eligible=%s', (claimState, linked, eligible) => {
    const verdict = deriveNativeCheckoutEligibility({ id: 'm1', claimState }, linked);
    expect(verdict).toEqual({
      merchantId: 'm1',
      eligible,
      claimState,
      hasActiveNativeStoreLink: linked,
    });
  });
});

describe('normalizeDomain', () => {
  it.each([
    ['shop.example.com', 'shop.example.com'],
    ['  Shop.Example.COM  ', 'shop.example.com'],
    ['https://Shop.Example.com/some/path?q=1', 'shop.example.com'],
    ['http://shop.example.com:8443', 'shop.example.com'],
    ['shop.example.com.', 'shop.example.com'],
    ['xn--caf-dma.example', 'xn--caf-dma.example'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeDomain(input)).toBe(expected);
  });

  it.each([
    ['not a domain'],
    ['nodots'],
    ['-leading.example.com'],
    ['trailing-.example.com'],
    [''],
    ['https://'],
  ])('refuses %s with a 400', (input) => {
    let refused: unknown;
    try {
      normalizeDomain(input);
    } catch (error) {
      refused = error;
    }
    expect(isMercariaError(refused) && refused.httpStatus === 400).toBe(true);
  });
});

describe('normalizeAlias', () => {
  it('matches the generated column recipe: lower(btrim(…))', () => {
    // The one spelling the SQL and JS sides share; a divergence here is a
    // lookup that silently finds nothing.
    expect(normalizeAlias('  Ray-Ban OFFICIAL  ')).toBe('ray-ban official');
    expect(normalizeAlias('Rayban')).toBe('rayban');
  });
});
