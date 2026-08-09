/**
 * The linkage diff and the adoption plan (#84 existing-store rules 2, 3, 4, 7).
 *
 * The fixtures deliberately include the two shapes that make an "adoptable"
 * check mean something — a canonical side that is EMPTY, and one that is
 * whitespace-only — because with only "same" and "different" fixtures a check
 * that ignored emptiness would pass every case, which is exactly the trap
 * `~/Oxy/AGENTS.md` §(E) describes.
 */

import { describe, expect, it } from 'vitest';
import type { StoreLinkageImpact } from '@mercaria/shared-types';
import { buildLinkageDiff, LINKAGE_UNCHANGED, planProfileAdoption } from '../linkage-diff.js';

const IMPACT: StoreLinkageImpact = {
  activeListings: 3,
  nativeOffers: 2,
  externalOffers: 7,
  storefronts: 2,
  placedOrders: 41,
  storeMembers: 4,
};

/**
 * `??` is deliberately NOT used for the two description overrides: an explicit
 * `null` is one of the fixture shapes under test, and `??` would collapse it
 * into the default — a helper silently testing the wrong input, which is the
 * failure mode that makes a green suite meaningless.
 */
function diff(input: {
  storeName?: string;
  storeDescription?: string | null;
  merchantName?: string;
  merchantDescription?: string | null;
}) {
  return buildLinkageDiff({
    store: {
      id: 'store-1',
      name: input.storeName ?? 'My Shop',
      description: 'storeDescription' in input ? (input.storeDescription ?? null) : 'A shop.',
    },
    merchant: {
      id: 'merchant-1',
      name: input.merchantName ?? 'Example Retail',
      description:
        'merchantDescription' in input ? (input.merchantDescription ?? null) : 'Sells things.',
    },
    verifiedDomains: ['example.com'],
    storefronts: [{ id: 'sf-1', name: 'Example ES', domain: 'example.com' }],
    impact: IMPACT,
  });
}

function fieldNamed(result: ReturnType<typeof diff>, name: 'name' | 'description') {
  const found = result.fields.find((field) => field.field === name);
  if (!found) throw new Error(`the diff has no ${name} field`);
  return found;
}

describe('the diff shows both sides and applies neither', () => {
  it('marks a differing field adoptable and reports both values', () => {
    const result = diff({});
    const name = fieldNamed(result, 'name');
    expect(name.storeValue).toBe('My Shop');
    expect(name.merchantValue).toBe('Example Retail');
    expect(name.differs).toBe(true);
    expect(name.adoptable).toBe(true);
  });

  it('marks an identical field neither differing nor adoptable', () => {
    const result = diff({ storeName: 'Example Retail' });
    const name = fieldNamed(result, 'name');
    expect(name.differs).toBe(false);
    expect(name.adoptable).toBe(false);
  });

  it('covers exactly the two safe public fields, and the handle is not one', () => {
    // Issue existing-store rule 7 / acceptance 2: `/m/<handle>` stays stable, so
    // the handle must not even appear as something a diff could offer.
    expect(diff({}).fields.map((f) => f.field)).toEqual(['name', 'description']);
  });

  it('carries verified source facts BESIDE the fields, never inside one', () => {
    // Issue store-creation rule 4: an unverified external profile field has no
    // path into a merchant-managed field. Source facts are context and are
    // structurally not adoptable — they are a different array with a different
    // shape, and `planProfileAdoption` never reads them.
    const result = diff({});
    expect(result.sourceFacts).toEqual([
      { kind: 'verified_domain', ref: 'example.com', detail: null },
      { kind: 'storefront', ref: 'sf-1', detail: 'example.com' },
    ]);
    expect(result.fields.every((field) => !('sourceValue' in field))).toBe(true);
  });

  it('states what linkage will NOT touch, in the same payload', () => {
    const result = diff({});
    expect(result.unchanged).toBe(LINKAGE_UNCHANGED);
    expect(result.unchanged).toContain('placed orders and their history');
    expect(result.unchanged).toContain('store members and their permissions');
    expect(result.unchanged.some((entry) => entry.includes('handle'))).toBe(true);
    expect(result.unchanged.some((entry) => entry.includes('follow target'))).toBe(true);
  });

  it('carries the impact preview', () => {
    expect(diff({}).impact).toEqual(IMPACT);
  });
});

describe('an EMPTY canonical value is an absence, never something to adopt', () => {
  it('refuses to offer an empty merchant description', () => {
    // Adopting it would CLEAR the store's own — a destructive act wearing an
    // identity act's clothes. Without this fixture, an implementation that only
    // compared the two strings would look correct: they do differ.
    const field = fieldNamed(diff({ merchantDescription: '' }), 'description');
    expect(field.differs).toBe(true);
    expect(field.adoptable).toBe(false);
  });

  it('and a whitespace-only one, which a naive emptiness check would admit', () => {
    const field = fieldNamed(diff({ merchantDescription: '   ' }), 'description');
    expect(field.adoptable).toBe(false);
  });

  it('and a NULL one', () => {
    const field = fieldNamed(diff({ merchantDescription: null }), 'description');
    expect(field.adoptable).toBe(false);
  });
});

describe('the adoption plan takes only what the diff permits', () => {
  it('adopts a selected, adoptable field and keeps its previous value', () => {
    const plan = planProfileAdoption({ diff: diff({}), selected: ['name'] });
    expect(plan).toEqual([
      { field: 'name', previousValue: 'My Shop', adoptedValue: 'Example Retail' },
    ]);
  });

  it('adopts nothing when nothing is selected — the default is inaction', () => {
    expect(planProfileAdoption({ diff: diff({}), selected: [] })).toEqual([]);
  });

  it('DROPS a selected field the diff marks un-adoptable', () => {
    // A client replaying a stale selection must not be able to clear a store's
    // description through a door built for adopting one.
    const plan = planProfileAdoption({
      diff: diff({ merchantDescription: '' }),
      selected: ['name', 'description'],
    });
    expect(plan.map((entry) => entry.field)).toEqual(['name']);
  });

  it('drops a field that is already identical', () => {
    const plan = planProfileAdoption({
      diff: diff({ storeName: 'Example Retail' }),
      selected: ['name'],
    });
    expect(plan).toEqual([]);
  });

  it('records a NULL previous value honestly rather than as an empty string', () => {
    const plan = planProfileAdoption({
      diff: diff({ storeDescription: null }),
      selected: ['description'],
    });
    expect(plan[0]?.previousValue).toBeNull();
  });
});
