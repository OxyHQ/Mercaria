/**
 * The commerce form → Mercaria's publication PUT.
 *
 * The interval is the field worth pinning: it has NO default anywhere in the
 * stack (#68), so a location never saved shows an empty field and refuses to
 * save until the merchant states one — and minutes become the seconds the
 * backend's CHECK bounds.
 */

import { describe, expect, it } from 'vitest';
import type { MerchantLocationPublication } from '@mercaria/shared-types';
import { publicationDraftOf, publicationInputOf } from '../publication-form';

describe('publicationDraftOf', () => {
  it('invents no stock interval for a location never published', () => {
    expect(publicationDraftOf(null).stockIntervalMinutes).toBe('');
  });

  it('reads a saved publication back in minutes', () => {
    const saved: MerchantLocationPublication = {
      id: 'pub_1',
      locationId: 'loc_1',
      goWayPlaceId: 'gw_1',
      publicationState: 'draft',
      pickupOffered: true,
      identityRequirement: 'collection_code',
      paymentRequirement: 'prepaid',
      restricted: false,
      inventorySource: 'pos',
      stockConfirmationIntervalSeconds: 900,
      disclosesExactStock: false,
      lowStockThreshold: 2,
      updatedAt: '2026-10-01T00:00:00.000Z',
    };
    expect(publicationDraftOf(saved)).toMatchObject({
      stockIntervalMinutes: '15',
      lowStockThreshold: '2',
    });
  });
});

describe('publicationInputOf', () => {
  const draft = {
    ...publicationDraftOf(null),
    stockIntervalMinutes: '15',
    pickupInstructions: '  Ring the bell ',
  };

  it('sends the place, the commerce fields and the interval in seconds', () => {
    expect(publicationInputOf(draft, 'gw_1')).toEqual({
      ok: true,
      input: {
        goWayPlaceId: 'gw_1',
        pickupOffered: false,
        pickupInstructions: 'Ring the bell',
        identityRequirement: 'collection_code',
        inventorySource: 'manual',
        stockConfirmationIntervalSeconds: 900,
        disclosesExactStock: false,
        lowStockThreshold: 3,
      },
    });
  });

  it('refuses with no place, an empty or out-of-range interval, or a bad threshold', () => {
    expect(publicationInputOf(draft, undefined)).toMatchObject({
      errorKey: 'settings.locations.editor.publication.placeRequired',
    });
    expect(publicationInputOf({ ...draft, stockIntervalMinutes: '' }, 'gw_1')).toMatchObject({
      errorKey: 'settings.locations.editor.publication.intervalInvalid',
    });
    expect(publicationInputOf({ ...draft, stockIntervalMinutes: '0.5' }, 'gw_1')).toMatchObject({
      ok: false,
    });
    expect(publicationInputOf({ ...draft, stockIntervalMinutes: '43201' }, 'gw_1')).toMatchObject({
      ok: false,
    });
    expect(publicationInputOf({ ...draft, lowStockThreshold: '-1' }, 'gw_1')).toMatchObject({
      errorKey: 'settings.locations.editor.publication.thresholdInvalid',
    });
  });
});
