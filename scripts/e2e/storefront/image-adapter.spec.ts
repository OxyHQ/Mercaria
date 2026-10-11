import { expect, test } from '@playwright/test';
import type { StoreSummary } from '../../../packages/shared-types/src';

test('merchant cover combines web classes and absolute-fill styles without corrupting CSS', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && message.text().includes('styleq:'))
      errors.push(message.text());
  });
  const feed = await (await request.get('http://localhost:4160/feed')).json();
  const merchant = feed.data.sections
    .flatMap((section: { merchants?: StoreSummary[] }) => section.merchants ?? [])
    .find((item: StoreSummary) => item.coverFileId);
  expect(merchant, 'Requires a synchronized merchant cover in the local seed').toBeTruthy();
  await page.goto('/');
  // The same merchant may appear in the animated hero; inspect its shelf card.
  const image = page.locator(`img[src*="${merchant.coverFileId}"]`).last();
  await image.scrollIntoViewIfNeeded();
  await expect(image).toBeVisible();
  await expect
    .poll(() =>
      image.evaluate((node) => {
        const wrapper = node.closest('[data-expoimage]');
        const rect = wrapper?.getBoundingClientRect();
        return rect ? { width: rect.width, height: rect.height } : null;
      }),
    )
    .toEqual({ width: 330, height: 397 });
  expect(errors).toEqual([]);
});
