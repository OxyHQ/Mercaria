import { describe, expect, it } from 'vitest';
import { migrateShoppingHistory } from '../shopping-history-migration';

const viewed = {
  owner: 'oxy-1',
  product: { id: 'p-1', title: 'Linen shirt' },
};

describe('migrateShoppingHistory', () => {
  it('keeps recently viewed and drops the conversations version 0 stored on the device', () => {
    expect(
      migrateShoppingHistory({
        products: [viewed],
        threads: [
          {
            id: 'private-thread',
            owner: 'another-oxy-account',
            title: 'Private shopping question',
            messages: [{ role: 'user', content: 'Private shopping question' }],
          },
        ],
      }),
    ).toEqual({ products: [viewed] });
  });

  it('starts empty from anything that is not a stored history', () => {
    expect(migrateShoppingHistory(undefined)).toEqual({ products: [] });
    expect(migrateShoppingHistory({ products: 'nope' })).toEqual({ products: [] });
  });
});
