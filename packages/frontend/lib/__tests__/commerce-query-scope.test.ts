import { expect, test } from 'vitest';
import { OxyServices } from '@oxy.so/core';
import { createCommerceQueryScope } from '../commerce-query-scope';

const token = (id: string) =>
  `e30.${Buffer.from(JSON.stringify({ userId: id, sessionId: id, exp: 2_000_000_000 })).toString('base64url')}.fixture`;
test('cached orders/cart/merge results and late writes never cross account switches or logout', async () => {
  const oxy = new OxyServices({ baseURL: 'http://localhost:4010' });
  const scope = createCommerceQueryScope(oxy);
  let changes = 0;
  const unsubscribe = scope.subscribe(() => {
    changes++;
  });
  try {
    oxy.session.setAccessToken(token('A'));
    const a = scope.getSnapshot();
    a.client.setQueryData(['cart'], { owner: 'A' });
    a.client.setQueryData(['cart', 'merge'], { merged: true });
    oxy.session.setAccessToken(token('B'));
    const b = scope.getSnapshot();
    expect(b.client).not.toBe(a.client);
    expect(b.client.getQueryData(['cart'])).toBeUndefined();
    expect(b.client.getQueryData(['cart', 'merge'])).toBeUndefined();
    a.client.setQueryData(['orders'], { owner: 'A', late: true });
    expect(b.client.getQueryData(['orders'])).toBeUndefined();
    oxy.session.clear();
    const anonymous = scope.getSnapshot();
    expect(anonymous.client).not.toBe(b.client);
    oxy.session.setAccessToken(token('B'));
    expect(scope.getSnapshot().client).not.toBe(b.client);
    expect(changes).toBeGreaterThanOrEqual(3);
  } finally {
    unsubscribe();
    scope.dispose();
    oxy.dispose();
  }
});
