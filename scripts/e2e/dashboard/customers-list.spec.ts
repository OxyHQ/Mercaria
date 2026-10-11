import { expect, test } from '@playwright/test';
import en from '../../../packages/dashboard/lib/i18n/locales/en.json';
import ar from '../../../packages/dashboard/lib/i18n/locales/ar.json';
import { fixture } from './fixture';

for (const [width, locale, mode] of [
  [1440, 'en', 'light'],
  [390, 'ar', 'dark'],
] as const) {
  test(`customer search isolates results and recovers at ${width}px ${locale} ${mode}`, async ({
    page,
  }) => {
    const copy = locale === 'ar' ? ar : en;
    await fixture(page, locale, mode);
    await page.setViewportSize({ width, height: 1000 });
    const jordan = {
      id: 'jordan',
      storeId: 'store-preview',
      displayName: 'Jordan Smith',
      email: 'jordan@example.test',
      isWalkIn: false,
      tags: [],
      groupTags: [],
      stats: { orderCount: 3, totalSpent: { amount: 14900, currency: 'EUR' } },
      createdAt: '2026-10-08T12:00:00Z',
      updatedAt: '2026-10-08T12:00:00Z',
    };
    const taylor = {
      ...jordan,
      id: 'taylor',
      displayName: 'Taylor Parker',
      email: 'taylor@example.test',
    };
    let fail = true;
    let release: (() => void) | undefined;
    let lateRelease: (() => void) | undefined;
    let lateFinished = false;
    const searches: string[] = [];
    await page.route('**/admin/stores/*/customers?**', async (route) => {
      const query = new URL(route.request().url()).searchParams.get('search') ?? '';
      searches.push(query);
      if (fail)
        return route.fulfill({ status: 503, json: { success: false, message: 'Unavailable' } });
      if (query === 'Taylor')
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      if (query === 'late')
        await new Promise<void>((resolve) => {
          lateRelease = resolve;
        });
      const rows = query === 'missing' ? [] : query === 'Taylor' ? [taylor] : [jordan];
      await route.fulfill({
        json: {
          success: true,
          data: rows,
          pagination: { page: 1, pages: rows.length ? 1 : 0, limit: 20, total: rows.length },
        },
      });
      if (query === 'late') lateFinished = true;
    });
    await page.goto('/customers');
    const surface = page.getByTestId('merchant-customers-list');
    const input = page.getByRole('textbox', { name: copy.customers.searchPlaceholder });
    await expect(surface.getByText(copy.customers.loadError, { exact: true })).toBeVisible();
    fail = false;
    await surface.getByRole('button', { name: copy.common.retry, exact: true }).click();
    const jordanLink = page.getByRole('link', { name: jordan.displayName, exact: true });
    await expect(jordanLink).toHaveAttribute('href', '/customers/jordan');
    await expect(page.getByText(jordan.email, { exact: true })).toBeVisible();
    await expect(page.getByRole('table', { name: copy.nav.customers })).toHaveCount(
      width >= 768 ? 1 : 0,
    );
    const original = await surface.elementHandle();
    const inputElement = await input.elementHandle();
    const before = await surface.boundingBox();
    await input.fill('Taylor');
    await expect.poll(() => Boolean(release)).toBe(true);
    await expect(jordanLink).toHaveCount(0);
    await expect(page.getByText(jordan.displayName, { exact: true })).toHaveCount(0);
    expect(await original!.evaluate((node) => node.isConnected)).toBe(true);
    expect(await inputElement!.evaluate((node) => node.isConnected)).toBe(true);
    expect((await surface.boundingBox())!.height).toBeGreaterThanOrEqual(before!.height);
    await expect(input).toBeFocused();
    release!();
    await expect(page.getByRole('link', { name: taylor.displayName, exact: true })).toBeVisible();
    await input.fill('late');
    await expect.poll(() => Boolean(lateRelease)).toBe(true);
    await input.fill('missing');
    await expect(surface.getByText(copy.resourceList.noResults, { exact: true })).toBeVisible();
    await expect(surface.getByText(copy.customers.empty.title, { exact: true })).toHaveCount(0);
    lateRelease!();
    await expect.poll(() => lateFinished).toBe(true);
    await expect(surface.getByText(copy.resourceList.noResults, { exact: true })).toBeVisible();
    await expect(jordanLink).toHaveCount(0);
    await surface
      .getByRole('button', { name: copy.resourceList.clearFilters, exact: true })
      .click();
    await expect(input).toHaveValue('');
    await expect(jordanLink).toBeVisible();
    expect(searches).toEqual(expect.arrayContaining(['', 'Taylor', 'late', 'missing']));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `/tmp/wholesale-customers-${width}-${locale}-${mode}.png`,
      fullPage: true,
    });
  });
}
