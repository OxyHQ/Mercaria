/**
 * The completeness gate (#120) — the four worked examples from the issue, plus
 * the boundaries between "show a starting price", "show nothing" and "charge".
 *
 * Every case here is the SAME function on different facts, which is the point:
 * an unknown cost fails closed by one rule, not by four surfaces each
 * remembering to check.
 */

import { describe, expect, it } from 'vitest';
import { RETAIL_COST_COMPONENT_KINDS } from '@mercaria/shared-types';
import {
  deriveRetailCompleteness,
  isRetailQuoteChargeable,
  type RetailCompletenessInput,
} from '../retail-completeness.js';

const ALL_ALLOWED = [...RETAIL_COST_COMPONENT_KINDS];

/** A quote where everything applicable is quoted, into a determined market. */
function baseline(overrides: Partial<RetailCompletenessInput> = {}): RetailCompletenessInput {
  return {
    allowedComponentKinds: ALL_ALLOWED,
    applicableKinds: ['supplier_item', 'destination_shipping', 'tax_duty'],
    quotedKinds: ['supplier_item', 'destination_shipping', 'tax_duty'],
    destinationCountry: 'ES',
    taxTreatmentDetermined: true,
    marketSupported: true,
    ...overrides,
  };
}

describe('the retail completeness gate', () => {
  it('a fully quoted offer into a determined market is an exact cost-only price', () => {
    const verdict = deriveRetailCompleteness(baseline());
    expect(verdict.completeness).toBe('complete');
    expect(verdict.presentation).toBe('exact_cost_only');
    expect(verdict.blockReasons).toEqual([]);
    expect(verdict.publishable).toBe(true);
    expect(verdict.checkoutEligible).toBe(true);
  });

  it('example 1: shipping is destination-dependent — informational, never a final total', () => {
    const verdict = deriveRetailCompleteness(
      baseline({ destinationCountry: undefined, quotedKinds: ['supplier_item'] }),
    );
    expect(verdict.completeness).toBe('awaiting_destination');
    // A clearly qualified STARTING item cost, and nothing more.
    expect(verdict.presentation).toBe('starting_item_cost');
    expect(verdict.blockReasons).toEqual(['destination_unknown']);
    expect(verdict.publishable).toBe(true);
    // The load-bearing half: no checkout total may be claimed.
    expect(verdict.checkoutEligible).toBe(false);
  });

  it('example 2: an undocumented supplier handling fee leaves the offer ineligible', () => {
    const verdict = deriveRetailCompleteness(
      baseline({
        applicableKinds: ['supplier_item', 'supplier_handling', 'destination_shipping', 'tax_duty'],
        undocumentedKinds: ['supplier_handling'],
      }),
    );
    expect(verdict.completeness).toBe('blocked_undocumented_cost');
    expect(verdict.presentation).toBe('not_purchasable');
    expect(verdict.blockReasons).toContain('undocumented_supplier_fee');
    // Not merely unchargeable — not showable either.
    expect(verdict.publishable).toBe(false);
    expect(verdict.checkoutEligible).toBe(false);
  });

  it('example 3: an undeterminable tax treatment blocks that market rather than inventing zero', () => {
    const verdict = deriveRetailCompleteness(baseline({ taxTreatmentDetermined: false }));
    expect(verdict.completeness).toBe('blocked_tax_undetermined');
    expect(verdict.presentation).toBe('not_purchasable');
    expect(verdict.blockReasons).toContain('tax_undetermined');
    expect(verdict.checkoutEligible).toBe(false);

    // And the SAME offer into a market whose treatment IS determined is fine —
    // it is the market that is blocked, not the product.
    expect(deriveRetailCompleteness(baseline()).checkoutEligible).toBe(true);
  });

  it('example 4: a complete quote that expired is still complete, and not chargeable', () => {
    const now = new Date('2026-08-09T12:00:00.000Z');
    const expired = deriveRetailCompleteness(
      baseline({ expiresAt: new Date('2026-08-09T11:59:59.000Z'), now }),
    );
    // Expiry is NOT a completeness value: the costs were known.
    expect(expired.completeness).toBe('complete');
    expect(expired.blockReasons).toEqual([]);
    // What it is not is chargeable — #117 requires revalidation before capture.
    expect(expired.checkoutEligible).toBe(false);

    const live = deriveRetailCompleteness(
      baseline({ expiresAt: new Date('2026-08-09T12:00:01.000Z'), now }),
    );
    expect(live.checkoutEligible).toBe(true);
  });

  it('case 5: an unquotable applicable cost blocks checkout', () => {
    const verdict = deriveRetailCompleteness(
      baseline({ quotedKinds: ['supplier_item', 'tax_duty'] }),
    );
    expect(verdict.completeness).toBe('blocked_unquotable_cost');
    expect(verdict.blockReasons).toContain('shipping_not_quotable');
    expect(verdict.checkoutEligible).toBe(false);
    expect(verdict.publishable).toBe(false);
  });

  it('a component the policy has not approved blocks the quote', () => {
    const verdict = deriveRetailCompleteness(
      baseline({
        allowedComponentKinds: ['supplier_item', 'destination_shipping', 'tax_duty'],
        quotedKinds: ['supplier_item', 'destination_shipping', 'tax_duty', 'payment_processing'],
      }),
    );
    expect(verdict.blockReasons).toContain('component_not_permitted_by_policy');
    expect(verdict.checkoutEligible).toBe(false);
  });

  it('no active policy blocks everything — there is no default policy', () => {
    const verdict = deriveRetailCompleteness(
      baseline({ allowedComponentKinds: [], quotedKinds: [] }),
    );
    expect(verdict.blockReasons).toContain('policy_missing');
    expect(verdict.checkoutEligible).toBe(false);
  });

  it('an unsupported market blocks, even with everything quoted', () => {
    const verdict = deriveRetailCompleteness(baseline({ marketSupported: false }));
    expect(verdict.blockReasons).toContain('market_not_supported');
    expect(verdict.checkoutEligible).toBe(false);
    expect(verdict.publishable).toBe(false);
  });

  it('the HARDEST fact wins: an ineligible offer is never published as a starting price', () => {
    // Both undocumented AND missing a destination. Reporting the softer verdict
    // would publish an ineligible offer as an informational figure.
    const verdict = deriveRetailCompleteness(
      baseline({
        destinationCountry: undefined,
        applicableKinds: ['supplier_item', 'supplier_handling'],
        quotedKinds: ['supplier_item'],
        undocumentedKinds: ['supplier_handling'],
      }),
    );
    expect(verdict.completeness).toBe('blocked_undocumented_cost');
    expect(verdict.publishable).toBe(false);
  });

  it('block reasons are sorted and deduped — two derivations are byte-identical', () => {
    const input = baseline({
      allowedComponentKinds: ['supplier_item'],
      applicableKinds: ['supplier_item', 'destination_shipping', 'tax_duty', 'fx_cost'],
      quotedKinds: ['supplier_item', 'payment_processing'],
      taxTreatmentDetermined: false,
      marketSupported: false,
    });
    const first = deriveRetailCompleteness(input);
    const second = deriveRetailCompleteness(input);
    expect(first.blockReasons).toEqual(second.blockReasons);
    expect([...first.blockReasons].sort()).toEqual(first.blockReasons);
    expect(new Set(first.blockReasons).size).toBe(first.blockReasons.length);
  });

  it('isRetailQuoteChargeable re-derives both facts from the row and the clock', () => {
    const at = new Date('2026-08-09T12:00:00.000Z');
    expect(
      isRetailQuoteChargeable(
        { completeness: 'complete', expiresAt: new Date('2026-08-09T12:00:01.000Z') },
        at,
      ),
    ).toBe(true);
    expect(
      isRetailQuoteChargeable(
        { completeness: 'complete', expiresAt: new Date('2026-08-09T12:00:00.000Z') },
        at,
      ),
    ).toBe(false);
    expect(
      isRetailQuoteChargeable(
        { completeness: 'awaiting_destination', expiresAt: new Date('2030-01-01T00:00:00.000Z') },
        at,
      ),
    ).toBe(false);
  });
});
