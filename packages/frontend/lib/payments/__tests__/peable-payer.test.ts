import { describe, expect, it } from 'vitest';
import { checkoutReturnUrl, sheetOutcome } from '../peable-payer';

describe('the 3-D Secure return', () => {
  it('returns to the polling route with the group only', () => {
    expect(checkoutReturnUrl('https://mercaria.co', 'group-1')).toBe(
      'https://mercaria.co/checkout/return?checkoutGroupId=group-1',
    );
  });
});

describe('what the sheet is told', () => {
  it('shows paid only when the server says the payment succeeded', () => {
    expect(sheetOutcome('succeeded')).toBe('succeeded');
    expect(sheetOutcome('canceled')).toBe('failed');
  });

  it('keeps waiting on every other answer, a declined attempt included', () => {
    for (const status of ['created', 'requires_action', 'processing', 'failed'] as const) {
      expect(sheetOutcome(status)).toBeNull();
    }
    expect(sheetOutcome(undefined)).toBeNull();
  });
});
