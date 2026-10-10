import { describe, expect, it } from 'vitest';
import { AxiosError } from 'axios';
import { canRetainDetailData } from '../detail-query-state';

function failure(status?: number) {
  const error = new AxiosError('read failed');
  if (status !== undefined) error.response = { status, statusText: '', data: {}, headers: {}, config: { headers: {} } } as NonNullable<AxiosError['response']>;
  return error;
}

describe('cached merchant detail visibility', () => {
  it.each([401, 403, 404, 410, 400])('hides previous data after HTTP %i', status => {
    expect(canRetainDetailData(failure(status))).toBe(false);
  });
  it.each([undefined, 408, 429, 500, 503])('keeps edits through transient failure %s', status => {
    expect(canRetainDetailData(failure(status))).toBe(true);
  });
  it('fails closed on an unrecognized failure and accepts a successful read', () => {
    expect(canRetainDetailData(new Error('invalid response'))).toBe(false);
    expect(canRetainDetailData(null)).toBe(true);
  });
});
