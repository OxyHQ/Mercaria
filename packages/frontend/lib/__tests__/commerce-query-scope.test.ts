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

test('local domain clear and portal replacement clear private cache; same-owner guest rotation keeps it', async () => {
  const { createCommerceCredential } = await import('../stores/commerce-credential');
  const storage = (token: string) => ({
    read: async () => token,
    write: async () => {},
    remove: async () => {},
  });
  const guest = createCommerceCredential(storage('mgs_ownerA'), Date.now, false, {
    rotationPreservesAuthority: true,
  });
  const portal = createCommerceCredential(storage('mgp_groupA'));
  await Promise.all([guest.ready, portal.ready]);
  const oxy = new OxyServices({ baseURL: 'http://localhost:4010' });
  const scope = createCommerceQueryScope(
    oxy,
    [guest, portal].map(({ store }) => ({
      revision: () => store.getState().authorityRevision,
      subscribe: (listener: () => void) => store.subscribe(listener),
    })),
  );
  const unsubscribe = scope.subscribe(() => {});
  const expiry = new Date(Date.now() + 86400000).toISOString();
  try {
    const original = scope.getSnapshot();
    original.client.setQueryData(['cart'], { owner: 'A' });
    guest.snapshot().accept('mgs_ownerA_rotated', expiry, '1');
    await guest.settled();
    expect(scope.getSnapshot().client).toBe(original.client);
    guest.clear();
    await guest.settled();
    const cleared = scope.getSnapshot();
    expect(cleared.client).not.toBe(original.client);
    expect(cleared.client.getQueryData(['cart'])).toBeUndefined();
    cleared.client.setQueryData(['guestPortal'], { group: 'A' });
    portal.snapshot().accept('mgp_groupB', expiry, '2');
    await portal.settled();
    const replaced = scope.getSnapshot();
    expect(replaced.client).not.toBe(cleared.client);
    expect(replaced.client.getQueryData(['guestPortal'])).toBeUndefined();
    original.client.setQueryData(['cart'], { owner: 'A', late: true });
    expect(replaced.client.getQueryData(['cart'])).toBeUndefined();
  } finally {
    unsubscribe();
    scope.dispose();
    oxy.dispose();
  }
});
