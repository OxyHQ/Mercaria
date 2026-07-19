/**
 * Unit tests for the WooCommerce inventory pull (`fetchInventory`). No network: a fake
 * transport serves the `/products` + `/products/{id}/variations` pages. WooCommerce has
 * no inventory-item endpoint, so `fetchInventory` re-reads product/variation stock and
 * emits one `NormalizedInventoryLevel` per REQUESTED item that TRACKS stock — keyed by
 * the same product/variation id stamped on the variant at import
 * (`source.externalInventoryItemId`), so the provider-agnostic inventory sync maps it back.
 */

import { describe, it, expect } from 'vitest';
import { createWooCommerceProvider } from '../index.js';
import type { WooCommerceHttpResponse, WooCommerceTransport } from '../http.js';
import type { ConnectorAuth } from '../../types.js';

const AUTH: ConnectorAuth = { accessToken: 'ck:cs', shopDomain: 'https://shop.example.com' };

const ok = (body: unknown, headers: Record<string, string> = {}): WooCommerceHttpResponse => ({
  status: 200,
  headers,
  body: JSON.stringify(body),
});

/** A GET-only fake transport routed by URL substring. */
function getTransport(handler: (url: string) => WooCommerceHttpResponse): {
  transport: WooCommerceTransport;
  urls: string[];
} {
  const urls: string[] = [];
  const transport: WooCommerceTransport = {
    async get(url) {
      urls.push(url);
      return handler(url);
    },
    post: () => Promise.reject(new Error('unexpected post')),
    del: () => Promise.reject(new Error('unexpected del')),
  };
  return { transport, urls };
}

/** A catalog page: one tracked simple, one untracked simple, one variable, one parent-inheriting. */
function catalogPage(headers: Record<string, string> = { 'x-wp-totalpages': '1' }) {
  return ok(
    [
      { id: 111, name: 'Tracked Simple', type: 'simple', price: '5.00', manage_stock: true, stock_quantity: 7, attributes: [], images: [], categories: [] },
      { id: 222, name: 'Untracked Simple', type: 'simple', price: '5.00', manage_stock: false, stock_quantity: null, attributes: [], images: [], categories: [] },
      { id: 333, name: 'Variable', type: 'variable', attributes: [], images: [], categories: [] },
      { id: 555, name: 'Parent-tracked', type: 'variable', manage_stock: true, stock_quantity: 9, attributes: [], images: [], categories: [] },
    ],
    headers,
  );
}

function variationsFor(url: string): WooCommerceHttpResponse | undefined {
  if (url.includes('/products/333/variations')) {
    return ok(
      [
        { id: 3001, price: '5.00', regular_price: '5.00', sale_price: '', manage_stock: true, stock_quantity: 3, attributes: [] },
        { id: 3002, price: '5.00', regular_price: '5.00', sale_price: '', manage_stock: false, stock_quantity: null, attributes: [] },
      ],
      { 'x-wp-totalpages': '1' },
    );
  }
  if (url.includes('/products/555/variations')) {
    // A variation deferring to its parent's stock (`manage_stock: 'parent'`).
    return ok(
      [{ id: 5001, price: '5.00', regular_price: '5.00', sale_price: '', manage_stock: 'parent', stock_quantity: null, attributes: [] }],
      { 'x-wp-totalpages': '1' },
    );
  }
  return undefined;
}

describe('woocommerce fetchInventory', () => {
  it('emits a level per REQUESTED tracked item, keyed by product/variation id', async () => {
    const { transport } = getTransport((url) => variationsFor(url) ?? catalogPage());
    const provider = createWooCommerceProvider(transport);

    const levels = await provider.fetchInventory(AUTH, {
      inventoryItemIds: ['111', '222', '3001', '3002', '5001', '999-unknown'],
    });

    // 111 tracked (7); 3001 tracked (3); 5001 inherits its tracked parent (9).
    // 222/3002 untracked → omitted; 999-unknown not in catalog → omitted.
    expect(levels).toEqual([
      { externalInventoryItemId: '111', available: 7 },
      { externalInventoryItemId: '3001', available: 3 },
      { externalInventoryItemId: '5001', available: 9 },
    ]);
  });

  it('returns [] (and makes no request) for an empty id set', async () => {
    const { transport, urls } = getTransport(() => catalogPage());
    const provider = createWooCommerceProvider(transport);

    const levels = await provider.fetchInventory(AUTH, { inventoryItemIds: [] });
    expect(levels).toEqual([]);
    expect(urls).toHaveLength(0);
  });

  it('paginates the product catalog until the last page', async () => {
    const { transport, urls } = getTransport((url) => {
      const variations = variationsFor(url);
      if (variations) return variations;
      // Page 1 carries an unrelated product (more pages remain); page 2 (the last)
      // carries the tracked item 111.
      return url.includes('page=2')
        ? catalogPage({ 'x-wp-totalpages': '2' })
        : ok(
            [{ id: 888, name: 'Other', type: 'simple', price: '1.00', manage_stock: true, stock_quantity: 1, attributes: [], images: [], categories: [] }],
            { 'x-wp-totalpages': '2' },
          );
    });
    const provider = createWooCommerceProvider(transport);

    const levels = await provider.fetchInventory(AUTH, { inventoryItemIds: ['111'] });
    expect(levels).toEqual([{ externalInventoryItemId: '111', available: 7 }]);
    // Two product-list requests (page 1 then page 2).
    expect(urls.filter((u) => u.includes('/products?'))).toHaveLength(2);
  });
});
