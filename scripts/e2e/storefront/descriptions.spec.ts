import { expect, test, type APIRequestContext } from '@playwright/test';

async function productId(request: APIRequestContext): Promise<string> {
  const feed = await (await request.get('http://localhost:4160/feed')).json();
  const product = feed.data.sections
    .flatMap((section: { products?: { id: string; title: string }[] }) => section.products ?? [])
    .find((item: { title: string }) => item.title === 'Brilliant Eye Brightener');
  expect(product, 'Requires the documented local storefront seed').toBeTruthy();
  return product.id;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale: 'en' }, version: 0 }));
    localStorage.setItem(
      'mercaria.bloom.theme',
      JSON.stringify({ mode: 'light', colorPreset: 'mono' }),
    );
  });
});

for (const width of [390, 1440]) {
  test(`imported descriptions preserve paragraphs, lists, tables and links at ${width}px`, async ({
    page,
    request,
  }) => {
    const domWarnings: string[] = [];
    page.on('console', (message) => {
      if (/In HTML|cannot be a child|hydration error/.test(message.text()))
        domWarnings.push(message.text());
    });
    const id = await productId(request);
    const description = `<h4>Material &amp; care</h4><p>${'A carefully made product for everyday use. '.repeat(15)}</p><p>Second paragraph &lt;keeps its text&gt;.</p><ul><li><strong>Material:</strong> cotton</li><li><em>Care:</em> wash gently</li></ul><table>\n  <tr>\n<th>Size</th><th>Width</th><th>Height</th></tr><tr><td>Small</td><td>30 cm</td><td>60 cm</td></tr><tr><td>Large</td><td>45 cm</td><td>90 cm</td></tr>\n</table><ol start="3"><li>Check the dimensions</li><li>Read the <a href="https://example.com/care">care guide</a></li></ol>`;
    await page.route(`**/listings/${id}`, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.data.description = description;
      await route.fulfill({ response, json: body });
    });
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`/products/${id}`);
    const preview = page.getByTestId('product-description');
    await expect(preview).not.toContainText('<p>');
    await expect(preview).not.toContainText('Second paragraph');
    const more = preview.getByRole('button', { name: 'Read more', exact: true });
    const fade = preview.getByTestId('pdp-description-peek-fade');
    await expect(fade).toHaveCSS('height', '40px');
    await expect(fade).toHaveCSS('pointer-events', 'none');
    await expect(fade).toHaveAttribute('aria-hidden', 'true');
    await expect(more).toHaveCSS('min-height', '32px');
    await expect(more).toHaveCSS('font-size', '14px');
    await expect(more).toHaveCSS('line-height', '16px');
    await expect(more).toHaveCSS('background-color', 'rgb(242, 244, 245)');
    await more.hover();
    await expect(more).toHaveCSS('background-color', 'rgb(225, 228, 229)');
    await expect(preview.getByTestId('product-description-peek')).not.toContainText('...');
    await expect
      .poll(async () => {
        const button = await more.boundingBox();
        const text = await preview.getByTestId('product-description-peek').boundingBox();
        return button && text
          ? {
              sameWidth: Math.abs(button.width - text.width) < 1,
              gap: Math.round(button.y - text.y - text.height),
            }
          : null;
      })
      .toEqual({ sameWidth: true, gap: 12 });
    await more.click();
    const sheet = page.getByTestId('product-description-dialog');
    await expect(sheet.getByRole('heading', { name: 'Material & care' })).toHaveCSS(
      'font-size',
      '16px',
    );
    await expect(sheet.getByText('Second paragraph <keeps its text>.')).toHaveCSS(
      'margin-top',
      '16px',
    );
    await expect(sheet.locator('strong')).toHaveCSS('font-weight', '600');
    await expect(sheet.locator('em')).toHaveCSS('font-style', 'italic');
    await expect(sheet.locator('ul')).toHaveCSS('list-style-type', 'disc');
    await expect(sheet.locator('ol')).toHaveAttribute('start', '3');
    await expect(sheet.getByRole('table').getByRole('row')).toHaveCount(3);
    await expect(sheet.getByRole('cell', { name: '90 cm' })).toBeVisible();
    await expect(sheet.getByRole('columnheader', { name: 'Width' })).toHaveCSS('padding', '16px');
    await expect(sheet.getByRole('link', { name: 'care guide' })).toHaveAttribute(
      'href',
      'https://example.com/care',
    );
    const tableScroll = sheet.locator('.shop-rich-table-scroll');
    await expect(tableScroll).toHaveCSS('overflow-x', 'auto');
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    expect(domWarnings).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(more).toBeFocused();
    if (width === 1440) {
      await page.route('https://example.com/care', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<title>Care guide</title>' }),
      );
      await more.click();
      await sheet.getByRole('link', { name: 'care guide' }).click();
      await expect(page).toHaveURL('https://example.com/care');
    }
  });
}

test('a short rich description renders formatting without an unnecessary sheet link', async ({
  page,
  request,
}) => {
  const id = await productId(request);
  await page.route(`**/listings/${id}`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.data.description = '<p><strong>Soft &amp; comfortable.</strong><br>Wash gently. 🧵</p>';
    await route.fulfill({ response, json: body });
  });
  await page.goto(`/products/${id}`);
  const preview = page.getByTestId('product-description');
  await expect(preview.locator('strong')).toHaveText('Soft & comfortable.');
  await expect(preview).toContainText('Wash gently. 🧵');
  await expect(preview.getByRole('button', { name: 'Read more', exact: true })).toHaveCount(0);
  await expect(preview.getByTestId('pdp-description-peek-fade')).toHaveCount(0);
});

test('merchant HTML cannot execute code or inject page styles', async ({ page, request }) => {
  const id = await productId(request);
  await page.route(`**/listings/${id}`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.data.description = `<p>${'Safe content. '.repeat(35)}<a href="javascript:document.body.dataset.executed='yes'">Blocked link</a></p><style>body{display:none}</style><script>document.body.dataset.executed='yes'</script><img src="https://example.com/broken.png" alt="Diagram" onerror="document.body.dataset.executed='yes'">`;
    await route.fulfill({ response, json: body });
  });
  await page.route('https://example.com/broken.png', (route) => route.abort());
  await page.goto(`/products/${id}`);
  await page
    .getByTestId('product-description')
    .getByRole('button', { name: 'Read more', exact: true })
    .click();
  const sheet = page.getByTestId('product-description-dialog');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText('Blocked link', { exact: true })).toBeVisible();
  await expect(sheet.getByRole('link', { name: 'Blocked link' })).toHaveCount(0);
  await expect(sheet.locator('script, style, [onerror], [onclick]')).toHaveCount(0);
  await expect(page.locator('body')).not.toHaveAttribute('data-executed');
});

test('description peek follows dark theme and reduced motion while retaining keyboard access', async ({
  page,
  request,
}) => {
  const id = await productId(request);
  await page.addInitScript(() =>
    localStorage.setItem(
      'mercaria.bloom.theme',
      JSON.stringify({ mode: 'dark', colorPreset: 'mono' }),
    ),
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route(`**/listings/${id}`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.data.description = 'A carefully made product for everyday use. '.repeat(15);
    await route.fulfill({ response, json: body });
  });
  await page.goto(`/products/${id}`);
  const preview = page.getByTestId('product-description');
  const more = preview.getByRole('button', { name: 'Read more', exact: true });
  const fade = preview.getByTestId('pdp-description-peek-fade');
  await expect
    .poll(() => fade.evaluate((node) => getComputedStyle(node).backgroundImage))
    .toContain('rgb(53, 53, 53)');
  await expect(more).toHaveCSS('transition-duration', '0s');
  await expect(more).toHaveCSS('background-color', 'rgb(42, 42, 42)');
  await more.hover();
  await expect(more).toHaveCSS('background-color', 'rgb(64, 64, 64)');
  await more.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('product-description-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(more).toBeFocused();
});
