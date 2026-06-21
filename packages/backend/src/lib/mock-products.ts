/**
 * Mock home-feed data.
 *
 * Seed product/shelf data backing the PUBLIC `GET /feed` endpoint while the
 * marketplace domain (real products, shelves, persistence) is built on top of
 * the shell. Typed strictly against the shared `Shelf` contract so the feed
 * endpoint exercises `@mercaria/shared-types` end to end.
 */

import type { Shelf } from '@mercaria/shared-types';

/** Deterministic square placeholder image for a given seed. */
function placeholderImage(seed: string): string {
  return `https://picsum.photos/seed/${seed}/600/600`;
}

/** Newly listed items — a mix of full-price and discounted products. */
const NEW_ARRIVALS: Shelf = {
  id: 'new-arrivals',
  title: 'New arrivals',
  products: [
    {
      id: 'na-1',
      brand: 'Aurora Audio',
      title: 'Wireless Over-Ear Headphones',
      imageUrl: placeholderImage('aurora-headphones'),
      rating: 4.9,
      reviewCount: 10300,
      price: { amount: 14800, currency: 'USD' },
    },
    {
      id: 'na-2',
      brand: 'Northwind',
      title: 'Merino Wool Crew Sweater',
      imageUrl: placeholderImage('northwind-sweater'),
      rating: 4.6,
      reviewCount: 842,
      price: { amount: 8900, currency: 'USD' },
      compareAtPrice: { amount: 12000, currency: 'USD' },
    },
    {
      id: 'na-3',
      brand: 'Field & Co.',
      title: 'Waxed Canvas Weekender Bag',
      imageUrl: placeholderImage('field-weekender'),
      rating: 4.8,
      reviewCount: 349,
      price: { amount: 19900, currency: 'USD' },
    },
    {
      id: 'na-4',
      brand: 'Lumen',
      title: 'Adjustable LED Desk Lamp',
      imageUrl: placeholderImage('lumen-lamp'),
      rating: 4.3,
      reviewCount: 1280,
      price: { amount: 5400, currency: 'USD' },
    },
    {
      id: 'na-5',
      brand: 'Terra Goods',
      title: 'Stoneware Coffee Mug Set',
      imageUrl: placeholderImage('terra-mugs'),
      rating: 4.7,
      reviewCount: 2110,
      price: { amount: 3600, currency: 'USD' },
    },
    {
      id: 'na-6',
      brand: 'Cascade',
      title: 'Insulated Stainless Bottle',
      imageUrl: placeholderImage('cascade-bottle'),
      rating: 4.5,
      reviewCount: 5600,
      price: { amount: 2900, currency: 'USD' },
    },
  ],
};

/** Discounted items — every entry carries a `compareAtPrice`. */
const ON_SALE: Shelf = {
  id: 'on-sale',
  title: 'On sale',
  products: [
    {
      id: 'os-1',
      brand: 'Vega Tech',
      title: 'Mechanical Keyboard, Tactile',
      imageUrl: placeholderImage('vega-keyboard'),
      rating: 4.8,
      reviewCount: 3420,
      price: { amount: 7900, currency: 'USD' },
      compareAtPrice: { amount: 11900, currency: 'USD' },
    },
    {
      id: 'os-2',
      brand: 'Solace',
      title: 'Linen Throw Blanket',
      imageUrl: placeholderImage('solace-blanket'),
      rating: 4.4,
      reviewCount: 690,
      price: { amount: 4500, currency: 'USD' },
      compareAtPrice: { amount: 6500, currency: 'USD' },
    },
    {
      id: 'os-3',
      brand: 'Pace Athletics',
      title: 'Lightweight Running Trainers',
      imageUrl: placeholderImage('pace-trainers'),
      rating: 4.6,
      reviewCount: 8740,
      price: { amount: 7200, currency: 'USD' },
      compareAtPrice: { amount: 11000, currency: 'USD' },
    },
    {
      id: 'os-4',
      brand: 'Orchard',
      title: 'Cast Iron Skillet, 10-inch',
      imageUrl: placeholderImage('orchard-skillet'),
      rating: 4.9,
      reviewCount: 15400,
      price: { amount: 3300, currency: 'USD' },
      compareAtPrice: { amount: 4900, currency: 'USD' },
    },
    {
      id: 'os-5',
      brand: 'Halcyon',
      title: 'Noise-Isolating Earbuds',
      imageUrl: placeholderImage('halcyon-earbuds'),
      rating: 4.2,
      reviewCount: 1960,
      price: { amount: 5900, currency: 'USD' },
      compareAtPrice: { amount: 9900, currency: 'USD' },
    },
    {
      id: 'os-6',
      brand: 'Maple Row',
      title: 'Solid Oak Cutting Board',
      imageUrl: placeholderImage('maple-board'),
      rating: 4.7,
      reviewCount: 503,
      price: { amount: 4100, currency: 'USD' },
      compareAtPrice: { amount: 5800, currency: 'USD' },
    },
  ],
};

/** Ordered shelves rendered top-to-bottom on the home feed. */
export const FEED_SHELVES: Shelf[] = [NEW_ARRIVALS, ON_SALE];
