import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { compile } from '@tailwindcss/node';
import { expect, test } from '@playwright/test';

// Measured Shop geometry, independent of the token declarations. Relative line
// heights must preserve it in the browser as well as follow native font scale.
const geometry = {
  heroNormal: [36, 42],
  heroBold: [36, 42],
  caption: [12, 16],
  captionMedium: [12, 16],
  captionBold: [12, 16],
  badge: [10, 13],
  badgeBold: [10, 13],
  bodySmall: [14, 18],
  bodyLarge: [16, 22],
  bodyTitleSmall: [14, 18],
  bodyTitleLarge: [16, 22],
  subtitle: [18, 20],
  sectionTitle: [20, 22],
  header: [28, 30],
  headerBold: [24, 26],
  buttonSmall: [12, 16],
  buttonMedium: [14, 16],
  buttonLarge: [16, 20],
  posterXS: [36, 38],
  body: [16, 24],
};

for (const app of ['frontend', 'dashboard', 'pos']) {
  test(`${app} typography preserves measured line boxes with standard relative leading`, async ({
    page,
  }) => {
    const base = resolve(__dirname, `../../../packages/${app}`);
    const compiler = await compile(await readFile(`${base}/global.css`, 'utf8'), {
      base,
      onDependency() {},
    });
    await page.setContent(
      Object.keys(geometry)
        .map((name) => `<div id="${name}" class="text-shop-${name}">Mercaria</div>`)
        .join(''),
    );
    await page.addStyleTag({
      content: compiler.build(Object.keys(geometry).map((name) => `text-shop-${name}`)),
    });
    for (const [name, [size, lineHeight]] of Object.entries(geometry)) {
      const actual = await page.locator(`#${name}`).evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          size: parseFloat(style.fontSize),
          lineHeight: parseFloat(style.lineHeight),
          height: element.getBoundingClientRect().height,
        };
      });
      expect(actual.size, name).toBe(size);
      expect(actual.lineHeight, name).toBeCloseTo(lineHeight, 2);
      expect(actual.height, name).toBeCloseTo(lineHeight, 1);
    }
  });
}
