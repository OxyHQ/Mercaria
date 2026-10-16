import { describe, expect, it } from 'vitest';
import { searchRows, toItem } from '../providers/steam-store.js';

describe('Steam search content across the shipped scripts', () => {
  it.each(['Café', 'لعبة', 'খেলা', 'Игра', 'खेल', '游戏', 'あそび', 'ゲーム'])(
    'preserves %s in titles and source facts while decoding markup',
    (name) => {
      const html = `<a href="https://store.steampowered.com/app/123/?snr=search" data-ds-appid="123" class="search_result_row">
        <span class="title">${name} &amp; Friends</span>
        <div class="search_released">${name} 2026</div>
        <span data-tooltip-html="${name} &amp; reviews&lt;br&gt;100 reviews"></span>
        <span class="platform_img win"></span>
        <div data-price-final="5999" data-discount="25"></div>
        <div class="discount_original_price">79,99€</div>
      </a>`;
      const rows = searchRows(html);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        title: `${name} & Friends`,
        released: `${name} 2026`,
        review: `${name} & reviews`,
        platforms: ['win'],
      });
      const item = toItem(rows[0]!, { country: 'ES', currency: 'EUR' });
      expect(item?.normalized).toMatchObject({
        title: `${name} & Friends`,
        productGroupKey: '123',
        price: { amount: 5999, currency: 'EUR' },
        compareAtPrice: { amount: 7999, currency: 'EUR' },
        sourceUrl: 'https://store.steampowered.com/app/123/',
      });
      expect(item?.normalized.facts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: 'steam.release_date', value: `${name} 2026` }),
          expect.objectContaining({ key: 'steam.review_summary', value: `${name} & reviews` }),
        ]),
      );
    },
  );
});
