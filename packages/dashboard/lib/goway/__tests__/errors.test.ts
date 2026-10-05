/**
 * Every failure the location editor meets, as the sentence key it shows.
 *
 * A forbidden GoWay write is the ORDINARY answer while the store's claim is
 * pending, so it must not read as a generic failure; and a 409 from Mercaria is
 * "another location already uses this place", which a merchant can act on.
 */

import { describe, expect, it } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import {
  GoWayForbiddenError,
  GoWayNetworkError,
  GoWayUnavailableError,
  GoWayValidationError,
} from '@goway.to/sdk';
import { goWayErrorKey, publicationErrorKey } from '../errors';

function httpError(status: number): AxiosError {
  const headers = new AxiosHeaders();
  return new AxiosError('failed', 'ERR_BAD_REQUEST', { headers }, null, {
    status,
    statusText: '',
    headers: {},
    config: { headers },
    data: {},
  });
}

describe('goWayErrorKey', () => {
  it('names a pending claim, an outage and a refused input', () => {
    expect(goWayErrorKey(new GoWayForbiddenError('no'))).toBe('settings.locations.editor.errors.gowayForbidden');
    expect(goWayErrorKey(new GoWayUnavailableError('down'))).toBe('settings.locations.editor.errors.gowayUnavailable');
    expect(goWayErrorKey(new GoWayNetworkError('offline'))).toBe('settings.locations.editor.errors.gowayUnavailable');
    expect(goWayErrorKey(new GoWayValidationError('bad'))).toBe('settings.locations.editor.errors.gowayInvalid');
    expect(goWayErrorKey(new Error('?'))).toBe('settings.locations.editor.errors.gowayFailed');
  });
});

describe('publicationErrorKey', () => {
  it.each([
    [400, 'settings.locations.editor.errors.publicationRefused'],
    [409, 'settings.locations.editor.errors.placeTaken'],
    [503, 'settings.locations.editor.errors.gowayUnavailable'],
    [500, 'settings.locations.editor.errors.publicationFailed'],
  ])('maps %i', (status, key) => {
    expect(publicationErrorKey(httpError(status))).toBe(key);
  });
});
