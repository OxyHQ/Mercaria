/**
 * Wire fixtures shaped exactly like the public contract. Each factory returns
 * a FRESH object so a test can mutate one without affecting another.
 */

export const WEB = 'https://mercaria.co';

export function productSummaryWire(id = 'prod_1'): Record<string, unknown> {
  return {
    ref: { kind: 'product', id },
    title: 'Cyberpunk 2077',
    primaryImage: { url: 'https://cdn.mercaria.co/p/1.jpg', alt: 'Box art' },
    price: { amount: 2999, currency: 'EUR' },
    compareAtPrice: { amount: 5999, currency: 'EUR' },
    priceRange: { min: { amount: 2999, currency: 'EUR' }, max: { amount: 3999, currency: 'EUR' } },
    availability: 'in_stock',
    condition: { key: 'used_good', group: 'used' },
    seller: {
      kind: 'store',
      store: { kind: 'store', id: 'store_1' },
      handle: 'night-city-games',
      name: 'Night City Games',
      logoUrl: null,
    },
    url: `${WEB}/products/${encodeURIComponent(id)}`,
  };
}

export function productWire(id = 'prod_1'): Record<string, unknown> {
  return {
    ...productSummaryWire(id),
    description: 'An open-world RPG.',
    images: [{ url: 'https://cdn.mercaria.co/p/1.jpg', alt: null }],
    purchaseOptions: [
      {
        ref: { kind: 'variant', productId: id, variantId: 'var_ps5' },
        title: 'PS5',
        price: { amount: 2999, currency: 'EUR' },
        compareAtPrice: null,
        availability: 'in_stock',
      },
      {
        ref: { kind: 'variant', productId: id, variantId: 'var_xbox' },
        title: 'Xbox',
        price: { amount: 3999, currency: 'EUR' },
        compareAtPrice: null,
        availability: 'out_of_stock',
      },
    ],
    updatedAt: '2026-09-01T12:00:00.000Z',
    viewer: null,
  };
}

export function personSellerWire(): Record<string, unknown> {
  return {
    kind: 'person',
    oxyUserId: 'oxy_42',
    displayName: 'Ada',
    username: 'ada',
    avatarUrl: 'https://cdn.oxy.so/a.png',
    isVerified: true,
  };
}

export function storeWire(id = 'store_1', handle = 'night-city-games'): Record<string, unknown> {
  return {
    ref: { kind: 'store', id },
    handle,
    name: 'Night City Games',
    description: null,
    logoUrl: 'https://cdn.mercaria.co/s/logo.png',
    coverImageUrl: null,
    brandColor: '#FF00AA',
    rating: 4.5,
    reviewCount: 12,
    url: `${WEB}/stores/${encodeURIComponent(handle)}`,
  };
}

export function collectionWire(id = 'col_1', handle = 'night-city-games'): Record<string, unknown> {
  return {
    ref: { kind: 'collection', id },
    store: { kind: 'store', id: 'store_1' },
    title: 'Launch titles',
    description: 'Day-one picks',
    image: null,
    url: `${WEB}/stores/${encodeURIComponent(handle)}?collection=${encodeURIComponent(id)}`,
  };
}

export function pageWire(items: unknown[], nextCursor: string | null = null): Record<string, unknown> {
  return { items, nextCursor };
}
