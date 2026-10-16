import { expect, test, type Page } from '@playwright/test';
import en from '../../../packages/frontend/lib/i18n/locales/en.json';
import ar from '../../../packages/frontend/lib/i18n/locales/ar.json';

// Observe actual rendered movement; do not replace animation APIs or image delivery.
async function navigateAndMeasure(page: Page, label: string) {
  return page.evaluate(async (label) => {
    const previous = document.querySelector('[data-testid="store-menu-page"]');
    const dialog = previous!.closest('[role="dialog"]')!;
    const button = Array.from(dialog.querySelectorAll<HTMLElement>('[role="button"],button')).find(
      (node) => node.getAttribute('aria-label') === label || node.textContent?.trim() === label,
    )!;
    const samples: { x: number; opacity: number; width: number; panelY: number }[] = [];
    const before = dialog.getBoundingClientRect();
    button.click();
    const start = performance.now();
    while (performance.now() - start < 500) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const next = document.querySelector('[data-testid="store-menu-page"]');
      if (next && next !== previous) {
        const style = getComputedStyle(next);
        samples.push({
          x: new DOMMatrixReadOnly(style.transform).m41,
          opacity: Number(style.opacity),
          width: next.getBoundingClientRect().width,
          panelY: dialog.getBoundingClientRect().y,
        });
      }
    }
    const after = dialog.getBoundingClientRect();
    return {
      samples,
      initialY: before.y,
      finalY: after.y,
      retainedDialog: dialog.isConnected,
      headerShift: after.y - before.y,
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  }, label);
}

for (const [width, locale] of [
  [1440, 'en'],
  [390, 'ar'],
] as const) {
  for (const reduced of [false, true]) {
    test(`store menu moves only its page at ${width}px ${locale}, reduced=${reduced}`, async ({
      page,
      request,
    }) => {
      const copy = locale === 'ar' ? ar : en;
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
      await page.addInitScript(
        (locale) =>
          localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale }, version: 0 })),
        locale,
      );
      const feed = await (await request.get('http://localhost:4160/feed')).json();
      const product = feed.data.sections
        .flatMap(
          (section: { products?: { id: string; title: string }[] }) => section.products ?? [],
        )
        .find((item: { title: string }) => item.title === 'Brilliant Eye Brightener');
      expect(product, 'Requires the documented local storefront seed').toBeTruthy();
      const { store } = (
        await (await request.get(`http://localhost:4160/listings/${product.id}`)).json()
      ).data;
      const policy = 'Policy text supplied for this navigation test.';
      await page.route(
        new RegExp(`^http://localhost:4160/stores/${store.handle}(?:\\?.*)?$`),
        async (route) => {
          const response = await route.fetch();
          const body = await response.json();
          body.data.store.privacyPolicy = policy;
          await route.fulfill({ response, json: body });
        },
      );
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`/stores/${store.handle}`);
      const open = page.getByRole('button', {
        name: copy.store.menu.openLabel.replace('%{store}', store.name),
        exact: true,
      });
      await open.click();
      const panel = page.getByTestId('store-menu-page');
      await expect(panel).toHaveCSS('opacity', '1');
      await expect(
        page.getByRole('button', { name: copy.store.policies.privacy, exact: true }),
      ).toBeVisible();
      const forward = await navigateAndMeasure(page, copy.store.policies.privacy);
      await expect(page.getByText(policy, { exact: true })).toBeVisible();
      const backward = await navigateAndMeasure(page, copy.common.back);
      for (const [measurement, sign] of [
        [forward, locale === 'ar' ? -1 : 1],
        [backward, locale === 'ar' ? 1 : -1],
      ] as const) {
        expect(measurement.retainedDialog).toBe(true);
        if (width >= 768) expect(measurement.headerShift).toBe(0);
        else if (!reduced) {
          const low = Math.min(measurement.initialY, measurement.finalY);
          const high = Math.max(measurement.initialY, measurement.finalY);
          expect(
            measurement.samples.some(
              (sample) => sample.panelY > low + 1 && sample.panelY < high - 1,
            ),
            JSON.stringify(measurement),
          ).toBe(true);
        }
        expect(measurement.overflow).toBe(false);
        expect(measurement.samples.length).toBeGreaterThan(0);
        const last = measurement.samples.at(-1)!;
        expect(last.x).toBe(0);
        expect(last.opacity).toBe(1);
        if (reduced) {
          expect(
            measurement.samples.every((sample) => sample.x === 0 && sample.opacity === 1),
          ).toBe(true);
        } else {
          expect(
            measurement.samples.some((sample) => sample.x * sign > 1 && sample.opacity < 1),
          ).toBe(true);
          expect(
            measurement.samples.every((sample) => Math.abs(sample.x) <= sample.width * 0.4 + 1),
            JSON.stringify(measurement.samples),
          ).toBe(true);
        }
      }
      await page.keyboard.press('Escape');
      await expect(panel).toHaveCount(0);
      await expect(open).toBeFocused();
      expect(errors).toEqual([]);
    });
  }
}

for (const [width, locale] of [
  [1440, 'en'],
  [390, 'ar'],
] as const) {
  test(`merchant navigation remains reachable while reading a long policy at ${width}px ${locale}`, async ({
    page,
    request,
  }) => {
    const copy = locale === 'ar' ? ar : en;
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(
      (locale) =>
        localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale }, version: 0 })),
      locale,
    );
    const feed = await (await request.get('http://localhost:4160/feed')).json();
    const product = feed.data.sections
      .flatMap((section: { products?: { id: string; title: string }[] }) => section.products ?? [])
      .find((item: { title: string }) => item.title === 'Brilliant Eye Brightener');
    const { store } = (
      await (await request.get(`http://localhost:4160/listings/${product.id}`)).json()
    ).data;
    const policy = Array.from(
      { length: 80 },
      (_, index) => `Policy paragraph ${index + 1}: information about this store.`,
    ).join('\n');
    await page.route(
      new RegExp(`^http://localhost:4160/stores/${store.handle}(?:\\?.*)?$`),
      async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        body.data.store.privacyPolicy = policy;
        await route.fulfill({ response, json: body });
      },
    );
    await page.goto(`/stores/${store.handle}`);
    await page
      .getByRole('button', {
        name: copy.store.menu.openLabel.replace('%{store}', store.name),
        exact: true,
      })
      .click();
    await page.getByRole('button', { name: copy.store.policies.privacy, exact: true }).click();
    const body = page.getByText(policy, { exact: true });
    await expect(body).toBeVisible();
    const back = page.getByRole('button', { name: copy.common.back, exact: true });
    const share = page.getByRole('button', {
      name: copy.store.menu.share.replace('%{store}', store.name),
      exact: true,
    });
    // Let the incoming page finish before comparing the bar's resting geometry.
    await expect(page.getByTestId('store-menu-page')).toHaveCSS('opacity', '1');
    const before = await back.boundingBox();
    const scroll = await body.evaluateHandle((node) => {
      for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
        if (
          /auto|scroll/.test(getComputedStyle(ancestor).overflowY) &&
          ancestor.scrollHeight > ancestor.clientHeight + 100
        )
          return ancestor;
      }
      return null;
    });
    const bodyBox = await body.boundingBox();
    await page.mouse.move(bodyBox!.x + 20, Math.max(200, bodyBox!.y + 60));
    await page.mouse.wheel(0, 1600);
    await expect.poll(() => scroll.evaluate((node) => node?.scrollTop ?? 0)).toBeGreaterThan(100);
    await expect(back).toBeInViewport();
    await expect(share).toBeInViewport();
    expect(Math.abs((await back.boundingBox())!.y - before!.y)).toBeLessThan(1);
    await back.click();
    await expect(
      page.getByRole('button', { name: copy.store.policies.privacy, exact: true }),
    ).toBeVisible();
  });
}
