import { expect, test } from '@playwright/test';
import en from '../../../packages/dashboard/lib/i18n/locales/en.json';
import ar from '../../../packages/dashboard/lib/i18n/locales/ar.json';
import { fixture } from './fixture';

for (const [width, locale, mode] of [
  [1440, 'en', 'light'],
  [390, 'en', 'light'],
  [390, 'ar', 'light'],
  [390, 'en', 'dark'],
] as const) {
  test(`merchant product organization preserves untouched fields at ${width}px ${locale} ${mode}`, async ({
    page,
  }) => {
    const copy = locale === 'ar' ? ar : en;
    await fixture(page, locale, mode);
    await page.setViewportSize({ width, height: 1100 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const product = {
      id: 'organization-product',
      title: 'Linen studio shirt',
      description: 'A linen shirt.',
      category: 'clothing',
      status: 'draft',
      vendor: 'Original maker',
      productType: 'Shirts',
      tags: ['linen, cotton', 'summer'],
      images: [],
      variants: [],
      options: [],
      quantity: 8,
      overriddenFields: [],
      price: { amount: 4900, currency: 'EUR' },
    };
    const patches: Record<string, unknown>[] = [];
    let failRead = false;
    let releasePatch: (() => void) | undefined;
    let pendingPatch: Promise<void> | undefined;
    await page.route('**/admin/stores/*/products/organization-product', async (route) => {
      if (route.request().method() === 'PATCH') {
        const patch = route.request().postDataJSON();
        patches.push(patch);
        if (pendingPatch) await pendingPatch;
        Object.assign(product, patch);
      } else if (failRead)
        return route.fulfill({
          status: 502,
          json: { success: false, message: 'Fixture refresh failure' },
        });
      return route.fulfill({ json: { success: true, data: product } });
    });
    await page.goto('/products/organization-product');
    const organization = page.getByTestId('merchant-product-organization');
    const save = page.getByRole('button', { name: copy.products.detail.saveChanges, exact: true });
    const vendor = organization.getByRole('textbox', {
      name: copy.products.new.vendorLabel,
      exact: true,
    });
    const productType = organization.getByRole('textbox', {
      name: copy.products.wizard.review.productType,
      exact: true,
    });
    await expect(vendor).toHaveValue('Original maker');
    await expect(organization.getByText('linen, cotton', { exact: true })).toBeVisible();
    await page
      .getByRole('textbox', { name: copy.common.title, exact: true })
      .fill('Edited linen shirt');
    product.vendor = 'Synced maker'; // A connector changed an untouched field while this editor was open.
    await save.click();
    await expect.poll(() => patches.length).toBe(1);
    await expect(vendor).toHaveValue('Synced maker');
    for (const field of ['vendor', 'productType', 'tags', 'imageFileIds', 'category'])
      expect(patches[0]).not.toHaveProperty(field);
    await vendor.fill('');
    await expect(save).toBeDisabled();
    await expect(
      organization.getByText(copy.products.wizard.fields.required, { exact: true }),
    ).toBeVisible();
    await vendor.fill('New maker');
    await productType.fill('Linen shirts');
    const tag = organization.getByRole('textbox', {
      name: copy.products.detail.organization.addTag,
      exact: true,
    });
    await tag.fill('new, arrival');
    await tag.press('Enter');
    await tag.fill('new, arrival');
    await organization
      .getByRole('button', { name: copy.products.detail.organization.addTag, exact: true })
      .click();
    await expect(organization.getByText('new, arrival', { exact: true })).toHaveCount(1);
    await organization
      .getByRole('button', {
        name: copy.products.detail.organization.removeTag.replace('%{tag}', 'summer'),
        exact: true,
      })
      .click();
    failRead = true;
    const organizationHeight = (await organization.boundingBox())!.height;
    pendingPatch = new Promise((resolve) => {
      releasePatch = resolve;
    });
    await save.click();
    await expect.poll(() => patches.length).toBe(2);
    await expect(vendor).toBeDisabled();
    await expect(productType).toBeDisabled();
    expect((await organization.boundingBox())!.height).toBe(organizationHeight);
    releasePatch!();
    pendingPatch = undefined;
    expect(patches[1]).toMatchObject({
      vendor: 'New maker',
      productType: 'Linen shirts',
      tags: ['linen, cotton', 'new, arrival'],
    });
    expect(patches[1]).not.toHaveProperty('imageFileIds');
    await expect(page.getByText(copy.products.detail.loadFailed, { exact: true })).toBeVisible();
    await expect(vendor).toHaveValue('New maker');
    product.vendor = 'Maker from next sync';
    failRead = false;
    await page.getByRole('button', { name: copy.common.retry, exact: true }).click();
    await expect(page.getByText(copy.products.detail.loadFailed, { exact: true })).toHaveCount(0);
    await expect(vendor).toHaveValue('Maker from next sync');
    await expect(vendor).toBeEnabled();
    const main = await page.getByTestId('merchant-product-main').boundingBox();
    const side = await organization.boundingBox();
    if (width >= 1024) expect(side!.x).toBeGreaterThan(main!.x + main!.width);
    else expect(side!.y).toBeGreaterThanOrEqual(main!.y + main!.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await organization.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `/tmp/mercaria-product-organization-${width}-${locale}-${mode}.png`,
      fullPage: true,
    });
    product.status = 'restricted';
    await page.reload();
    await expect(vendor).toBeDisabled();
    await expect(save).toBeDisabled();
    await expect(
      page.getByRole('button', { name: copy.products.detail.archive, exact: true }),
    ).toBeDisabled();
    expect(errors).toEqual([]);
  });
}
