import { OxyServices } from '@oxy.so/core';
import { expect, test, vi } from 'vitest';
import { createCommerceCredentials } from '../../api/commerce-credentials';
import { createCommerceCredential } from '../commerce-credential';
import { commerceStorage } from '../commerce-storage';

const secure = vi.hoisted(() => ({
  values: new Map([
    ['mercaria.guest.token', 'mgs_installed_native'],
    ['mercaria.portal.token', 'mgp_installed_native'],
  ]),
  reads: [] as string[],
}));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-secure-store', () => ({
  getItemAsync: async (key: string) => {
    secure.reads.push(key);
    return secure.values.get(key) ?? null;
  },
  setItemAsync: async (key: string, value: string) => {
    secure.values.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    secure.values.delete(key);
  },
}));

test('an installed native client upgrades both raw SecureStore grants at their original keys and keeps header carriage', async () => {
  const guestCredential = createCommerceCredential(commerceStorage('mercaria.guest.token'));
  const portalCredential = createCommerceCredential(commerceStorage('mercaria.portal.token'));
  const referralCredential = createCommerceCredential({
    read: async () => null,
    write: async () => {},
    remove: async () => {},
  });
  const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });
  try {
    const transport = createCommerceCredentials(
      oxy,
      { guestCredential, portalCredential, referralCredential },
      'ios',
    );
    const snapshot = await transport.prepare({
      url: new URL('https://api.mercaria.co/cart'),
      method: 'GET',
    });
    expect(secure.reads).toEqual(['mercaria.guest.token', 'mercaria.portal.token']);
    expect(snapshot.headers.get('X-Mercaria-Guest-Token')).toBe('mgs_installed_native');
    expect(snapshot.headers.get('X-Mercaria-Portal-Token')).toBe('mgp_installed_native');
    expect(snapshot.headers.get('X-Mercaria-Guest-Transport')).toBe('header');
    expect(snapshot.headers.get('X-Mercaria-Portal-Transport')).toBe('header');
    expect(snapshot.headers.get('X-Mercaria-Guest-Client')).toBe('ios');
    expect(secure.values.get('mercaria.guest.token')).toBe('mgs_installed_native');
    const expires = new Date(Date.now() + 86400000).toISOString();
    snapshot.accept(
      new Headers({
        'X-Mercaria-Guest-Token': 'mgs_rotated',
        'X-Mercaria-Guest-Expires-At': expires,
        'X-Mercaria-Guest-Generation': '2',
      }),
    );
    await guestCredential.settled();
    const restored = createCommerceCredential(commerceStorage('mercaria.guest.token'));
    await restored.ready;
    expect(restored.current().token).toBe('mgs_rotated');
    expect(portalCredential.current().token).toBe('mgp_installed_native');
  } finally {
    oxy.dispose();
  }
});
