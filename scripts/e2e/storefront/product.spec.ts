import { expect, test, type APIRequestContext } from "@playwright/test";
import type { Listing, PublicAttributeValue, Review } from "../../../packages/shared-types/src";

async function seededProduct(request: APIRequestContext): Promise<Listing> {
  const feed = await (await request.get("http://localhost:4160/feed")).json();
  const summary = feed.data.sections
    .filter((section: { kind: string }) => section.kind === "products")
    .flatMap(
      (section: { products: { id: string; title: string }[] }) =>
        section.products,
    )
    .find(
      (item: { title: string }) => item.title === "Brilliant Eye Brightener",
    );
  expect(summary, "Requires the documented local storefront seed").toBeTruthy();
  return (
    await (
      await request.get(`http://localhost:4160/listings/${summary.id}`)
    ).json()
  ).data;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "i18n-storage",
      JSON.stringify({ state: { locale: "en" }, version: 0 }),
    );
    localStorage.setItem(
      "mercaria.bloom.theme",
      JSON.stringify({ mode: "light", colorPreset: "mono" }),
    );
  });
});

test("variant deep links survive reload and sold-out choices cannot be bought", async ({
  page,
  request,
}) => {
  const product = await seededProduct(request);
  const stella = product.variants.find(
    (variant) => variant.title === "Stella",
  )!;
  const soldOut = product.variants.find((variant) => !variant.inStock)!;
  await page.goto(`/products/${product.id}?variantId=${stella.id}`);
  await expect(
    page.getByRole("button", { name: "Shade: Stella", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Shade: Stella", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page
    .getByRole("button", { name: `Shade: ${soldOut.title}, Sold out`, exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`variantId=${soldOut.id}$`));
  await expect(
    page.getByRole("button", { name: "Sold out", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Buy now", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Shade: Stella", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Add to cart", exact: true }),
  ).toBeEnabled();
  await expect(page.getByText("Subscribe", { exact: true })).toHaveCount(0);
});

test("option availability follows the selected color and size instead of stock in another combination", async ({ page, request }) => {
  const product = await seededProduct(request);
  const configurations = [
    { color: "Red", size: "S", inStock: true },
    { color: "Red", size: "M", inStock: false },
    { color: "Blue", size: "S", inStock: true },
    { color: "Blue", size: "M", inStock: true },
  ];
  const variants = product.variants.slice(0, 4).map((variant, index) => ({
    ...variant,
    optionValues: [
      { name: "Color", value: configurations[index].color },
      { name: "Size", value: configurations[index].size },
    ],
    inStock: configurations[index].inStock,
    available: configurations[index].inStock ? 10 : 0,
    images: { source: "variant", images: [product.images[index]] },
  }));
  await page.route(`**/listings/${product.id}`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.data.options = [
      { name: "Color", values: ["Red", "Blue"] },
      { name: "Size", values: ["S", "M"] },
    ];
    body.data.variants = variants;
    await route.fulfill({ response, json: body });
  });
  await page.goto(`/products/${product.id}?variantId=${variants[0].id}`);
  const medium = page.getByRole("button", { name: /^Size: M(?:, Sold out)?$/ });
  await expect(medium).toHaveCSS("opacity", "1");
  await expect(medium).toHaveAccessibleName("Size: M, Sold out");
  await expect(medium.getByText("M", { exact: true })).toHaveCSS("text-decoration-line", "line-through");
  await expect(medium).toHaveCSS("background-color", "rgb(242, 244, 245)");
  await expect(medium.getByText("M", { exact: true })).toHaveCSS("font-size", "12px");
  await expect(medium.getByText("M", { exact: true })).toHaveCSS("color", "rgba(0, 0, 0, 0.4)");
  await expect(medium.locator("img").last()).toHaveAttribute("src", product.images[1].fileId);
  await medium.click();
  await expect(page).toHaveURL(new RegExp(`variantId=${variants[1].id}$`));
  await expect(page.getByRole("button", { name: "Sold out", exact: true })).toBeDisabled();

  await page.getByRole("button", { name: "Color: Blue", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`variantId=${variants[3].id}$`));
  await expect(medium).toHaveAttribute("aria-pressed", "true");
  await expect(medium).toHaveAccessibleName("Size: M");
  await expect(medium.getByText("M", { exact: true })).toHaveCSS("text-decoration-line", "none");
  await expect(medium.getByText("M", { exact: true })).toHaveCSS("color", "rgb(0, 0, 0)");
  await expect(medium).toHaveCSS("opacity", "1");
  await expect(medium.locator("img").last()).toHaveAttribute("src", product.images[3].fileId);
  await expect(page.getByRole("button", { name: "Add to cart", exact: true })).toBeEnabled();
  // Returning to red preserves M, including its sold-out state.
  await page.getByRole("button", { name: "Color: Red, Sold out", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`variantId=${variants[1].id}$`));
  await expect(medium).toHaveCSS("opacity", "1");
  await expect(medium).toHaveAccessibleName("Size: M, Sold out");
  await expect(medium.getByText("M", { exact: true })).toHaveCSS("text-decoration-line", "line-through");
  await expect(medium).toHaveCSS("background-color", "rgb(242, 244, 245)");
  await expect(medium.getByText("M", { exact: true })).toHaveCSS("font-size", "12px");
  await expect(medium.getByText("M", { exact: true })).toHaveCSS("color", "rgba(0, 0, 0, 0.4)");
  await expect(page.getByRole("button", { name: "Sold out", exact: true })).toBeDisabled();
});

test("variant-owned photos and price replace listing fallbacks without inheriting a discount", async ({
  page,
  request,
}) => {
  const product = await seededProduct(request);
  const selected = product.variants[1];
  await page.route(`**/listings/${product.id}`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.data.compareAtPrice = { amount: 99999 * 100000000, currency: "FAIR" };
    const variant = body.data.variants.find(
      (item: { id: string }) => item.id === selected.id,
    );
    variant.price = { amount: 12345000000, currency: "FAIR" };
    delete variant.compareAtPrice;
    variant.images = {
      source: "variant",
      images: [{ ...product.images[1], alt: "Variant-owned product photo" }],
    };
    await route.fulfill({ response, json: body });
  });
  await page.goto(`/products/${product.id}?variantId=${selected.id}`);
  const gallery = page.getByTestId("product-gallery-carousel");
  await expect(
    gallery.getByRole("img", { name: "Variant-owned product photo" }).last(),
  ).toBeVisible();
  await expect(page.getByTestId("product-thumbnails")).toHaveCount(0);
  await expect(page.getByTestId("product-buy-column")).toContainText("123.45");
  await expect(page.getByText(/\d+% off/)).toHaveCount(0);
  await page.getByRole("button", { name: "Shade: Muna", exact: true }).click();
  await expect(
    page.getByTestId("product-thumbnails").getByRole("button"),
  ).toHaveCount(product.images.length);
});

test("option hover previews its label without selecting a different variant", async ({ page, request }) => {
  const product = await seededProduct(request);
  const selected = product.variants[0];
  const option = selected.optionValues[0];
  const other = product.options.find((item: { name: string }) => item.name === option.name)
    .values.find((value: string) => value !== option.value);
  await page.goto(`/products/${product.id}?variantId=${selected.id}`);
  const label = page.getByTestId(`variant-option-value-${option.name}`);
  const preview = page.getByRole("button", { name: new RegExp(`^${option.name}: ${other}(?:, Sold out)?$`) });
  await preview.hover();
  await expect(label).toHaveText(other);
  await expect(preview).toHaveAttribute("aria-pressed", "false");
  await expect(page).toHaveURL(new RegExp(`variantId=${selected.id}$`));
  await page.mouse.move(0, 0);
  await expect(label).toHaveText(option.value);
  await preview.click();
  await expect(preview).toHaveAttribute("aria-pressed", "true");
  await page.mouse.move(0, 0);
  await expect(label).toHaveText(other);
});

test("thumbnail focus selects a photo and Enter opens that photo in the viewer", async ({ page, request }) => {
  const product = await seededProduct(request);
  await page.goto(`/products/${product.id}`);
  const rail = page.getByTestId("product-thumbnails");
  const third = rail.getByRole("button", { name: "View image 3", exact: true });
  await third.focus();
  await expect(third).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Close media viewer", exact: true })).toHaveCount(0);
  await third.press("Enter");
  await expect(page.getByRole("button", { name: "Close media viewer", exact: true })).toBeVisible();
  // Paging becomes available after the opening flight has seated the photo.
  await expect(page.getByRole("button", { name: "Next image", exact: true })).toBeVisible();
  await page.keyboard.press("ArrowRight");
  const fourth = rail.getByRole("button", { name: "View image 4", exact: true, includeHidden: true });
  await expect(fourth).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Close media viewer", exact: true })).toHaveCount(0);
  await expect(fourth).toHaveAttribute("aria-pressed", "true");
  await fourth.focus();
  await fourth.press("Control+Alt+Space");
  await expect(page.getByRole("button", { name: "Close media viewer", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Close media viewer", exact: true })).toHaveCount(0);
});

test("gallery thumbnails control the carousel and Bloom opens and dismisses the viewer", async ({
  page,
  request,
}) => {
  const product = await seededProduct(request);
  await page.goto(`/products/${product.id}`);
  const thumbnails = page.getByTestId("product-thumbnails");
  await thumbnails
    .getByRole("button", { name: "View image 3", exact: true })
    .click();
  await expect(
    thumbnails.getByRole("button", { name: "View image 3", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  const carousel = page.getByTestId("product-gallery-carousel");
  await expect
    .poll(async () => {
      const track = await carousel.boundingBox();
      const slide = await carousel
        .getByRole("button", {
          name: `Open images of ${product.title}`,
          exact: true,
        })
        .nth(2)
        .boundingBox();
      return !!track && !!slide && Math.abs(track.x - slide.x) < 3;
    })
    .toBe(true);
  await carousel
    .getByRole("button", {
      name: `Open images of ${product.title}`,
      exact: true,
    })
    .nth(2)
    .click();
  await expect(
    page.getByRole("button", { name: "Close media viewer", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(thumbnails.getByRole("button", { name: "View image 4", exact: true, includeHidden: true }))
    .toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Close media viewer", exact: true }),
  ).toHaveCount(0);
  await expect(thumbnails.getByRole("button", { name: "View image 4", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
});

test("gallery keeps 48px thumbnails visible when the viewer moves beyond the rail viewport", async ({ page, request }) => {
  const product = await seededProduct(request);
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/products/${product.id}`);
  const rail = page.getByTestId("product-thumbnails");
  const thumbnails = rail.getByRole("button", { includeHidden: true });
  const first = await thumbnails.first().boundingBox();
  const second = await thumbnails.nth(1).boundingBox();
  expect(first?.width).toBe(48);
  expect(first?.height).toBe(48);
  expect(second!.y - first!.y).toBe(54);
  const count = await thumbnails.count();
  expect(count).toBeGreaterThan(10);

  const open = page.getByTestId("product-gallery-carousel")
    .getByRole("button", { name: `Open images of ${product.title}`, exact: true });
  await open.first().click();
  await expect(page.getByRole("button", { name: "Close media viewer", exact: true })).toBeVisible();
  for (let index = 1; index < count; index++) {
    await page.keyboard.press("ArrowRight");
    await expect(thumbnails.nth(index)).toHaveAttribute("aria-pressed", "true");
  }
  await page.keyboard.press("Escape");
  await expect.poll(async () => {
    const viewport = await rail.boundingBox();
    const selected = await thumbnails.last().boundingBox();
    return !!viewport && !!selected && selected.y >= viewport.y - 1
      && selected.y + selected.height <= viewport.y + viewport.height + 1;
  }).toBe(true);

  // The desktop rail remounts after switching through the mobile layout.
  await page.setViewportSize({ width: 390, height: 600 });
  await expect(rail).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 600 });
  await expect.poll(async () => {
    const viewport = await rail.boundingBox();
    const selected = await thumbnails.last().boundingBox();
    return !!viewport && !!selected && selected.y >= viewport.y - 1
      && selected.y + selected.height <= viewport.y + viewport.height + 1;
  }).toBe(true);

  await open.last().click();
  await expect(page.getByRole("button", { name: "Close media viewer", exact: true })).toBeVisible();
  for (let index = count - 2; index >= 0; index--) {
    await page.keyboard.press("ArrowLeft");
    await expect(thumbnails.nth(index)).toHaveAttribute("aria-pressed", "true");
  }
  await page.keyboard.press("Escape");
  await expect.poll(async () => {
    const viewport = await rail.boundingBox();
    const selected = await thumbnails.first().boundingBox();
    return !!viewport && !!selected && Math.abs(selected.y - viewport.y) < 1;
  }).toBe(true);
});

test("mobile product keeps the merchant before gallery and has no horizontal overflow", async ({
  page,
  request,
}) => {
  const product = await seededProduct(request);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/products/${product.id}`);
  const gallery = page.getByTestId("product-gallery");
  await expect(gallery).toBeVisible();
  const galleryBounds = await gallery.boundingBox();
  const merchant = await page
    .getByRole("link", { name: `Visit ${product.store!.name}`, exact: true })
    .first()
    .boundingBox();
  expect(merchant!.y + merchant!.height).toBeLessThan(galleryBounds!.y);
  expect(Math.abs(galleryBounds!.height - 844 * 0.45)).toBeLessThan(1);
  await expect(gallery.locator('[data-bloom-carousel-dot]')).toHaveCount(0);
  await expect(page.getByTestId("product-thumbnails")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
});

test("mobile gallery swipes between photos without adding a pagination row", async ({ browser, request }) => {
  const product = await seededProduct(request);
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US",
  });
  try {
    const page = await context.newPage();
    await page.goto(`/products/${product.id}`);
    const gallery = page.getByTestId("product-gallery");
    await expect(gallery).toBeVisible();
    const track = gallery.locator("[data-bloom-carousel-track]");
    const bounds = (await track.boundingBox())!;
    const touch = await context.newCDPSession(page);
    const y = bounds.y + bounds.height / 2;
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 340, y }] });
    for (let x = 310; x >= 70; x -= 30) {
      await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
      // A real gesture has elapsed time; this controls velocity, not app readiness.
      await page.waitForTimeout(35);
    }
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(() => track.evaluate(node => node.scrollLeft)).toBeGreaterThan(300);
    await expect.poll(() => track.evaluate(node => Math.abs(node.scrollLeft / node.clientWidth - Math.round(node.scrollLeft / node.clientWidth)))).toBeLessThan(0.01);
    const index = await track.evaluate(node => Math.round(node.scrollLeft / node.clientWidth));
    expect(index).toBeGreaterThan(0);
    await expect(gallery.locator("[data-bloom-carousel-dot]")).toHaveCount(0);
    expect(Math.abs((await gallery.boundingBox())!.height - 844 * 0.45)).toBeLessThan(1);
    await gallery.getByRole("button", { name: `Open images of ${product.title}`, exact: true }).nth(index).tap();
    await expect(page.getByRole("button", { name: "Close media viewer", exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});

for (const [width, locale] of [[1440, "en"], [390, "en"], [1440, "ar"], [390, "ar"]] as const) {
  test(`successful purchase flies its image into the visible cart at ${width}px in ${locale}`, async ({ page, request }) => {
    const product = await seededProduct(request);
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.addInitScript(locale => localStorage.setItem("i18n-storage", JSON.stringify({ state: { locale }, version: 0 })), locale);
    await page.goto(`/products/${product.id}`);
    // A different gallery photo must fly, not the listing's first image.
    let selectedImage: string | null = null;
    if (width >= 976) {
      const thumbnail = page.getByTestId("product-thumbnails").getByRole("button").nth(2);
      await thumbnail.click();
      await expect(thumbnail).toHaveAttribute("aria-pressed", "true");
      selectedImage = await thumbnail.locator("img").getAttribute("src");
      expect(selectedImage).toBeTruthy();
    }
    const add = page.getByTestId("product-purchase-actions").getByRole("button").first();
    await add.scrollIntoViewIfNeeded();
    await page.evaluate(() => {
      const frames: { width: number; x: number; y: number; cartScale: number }[] = [];
      (window as unknown as { cartFlightFrames: typeof frames }).cartFlightFrames = frames;
      const scales: number[] = [];
      (window as unknown as { cartFlightScales: number[] }).cartFlightScales = scales;
      let seen = false;
      let pulsed = false;
      const sample = () => {
        const flight = document.querySelector('[data-testid="cart-flight"]');
        const target = [...document.querySelectorAll('[data-testid="cart-flight-target"]')].find(node => {
          const bounds = node.getBoundingClientRect();
          return bounds.width > 0 && bounds.height > 0 && bounds.x >= 0 && bounds.y >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight;
        });
        const cartScale = target ? new DOMMatrixReadOnly(getComputedStyle(target).transform).a : 1;
        scales.push(cartScale);
        if (cartScale > 1.2) pulsed = true;
        if (flight) {
          seen = true;
          const rect = flight.getBoundingClientRect();
          frames.push({ width: rect.width, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2,
            cartScale });
        }
        // The glyph's arrival animation outlives the fading product sprite.
        // Observe its entire rise and return rather than stopping at sprite removal.
        if (!seen || flight || !pulsed || Math.abs(cartScale - 1) > 0.00001) requestAnimationFrame(sample);
        else (window as unknown as { cartFlightComplete: boolean }).cartFlightComplete = true;
      };
      requestAnimationFrame(sample);
    });
    const added = page.waitForResponse(response => response.url().endsWith("/cart/items") && response.request().method() === "POST");
    await add.click();
    expect((await added).ok()).toBe(true);
    const flight = page.getByTestId("cart-flight");
    await expect(flight).toHaveCount(1);
    if (selectedImage) await expect(flight.locator("img")).toHaveAttribute("src", selectedImage);
    await expect(flight).toHaveCSS("box-shadow", /0px 4px 24px/);
    await expect(flight).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (window as unknown as { cartFlightComplete?: boolean }).cartFlightComplete)).toBe(true);
    const cartIcon = page.locator('[data-testid="cart-flight-target"]:visible').first();
    await expect.poll(() => cartIcon.evaluate(node => new DOMMatrixReadOnly(getComputedStyle(node).transform).a)).toBe(1);
    const result = await page.evaluate(() => {
      const targets = [...document.querySelectorAll('[data-testid="cart-flight-target"]')]
        .map(node => node.getBoundingClientRect()).filter(rect => rect.width > 0 && rect.height > 0 && rect.x >= 0 && rect.y >= 0 && rect.bottom <= innerHeight);
      return { targets: targets.map(rect => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 })), frames: (window as unknown as { cartFlightFrames: { width: number; x: number; y: number; cartScale: number }[] }).cartFlightFrames };
    });
    expect(result.frames.some(frame => frame.width > 140)).toBe(true);
    expect(await page.evaluate(() => (window as unknown as { cartFlightScales: number[] }).cartFlightScales.some(scale => scale > 1.2))).toBe(true);
    expect(result.frames.some(frame => frame.width > 25 && frame.width < 100)).toBe(true);
    expect(result.frames.some(frame => frame.width < 16 && result.targets.some(target => Math.abs(frame.x - target.x) < 2 && Math.abs(frame.y - target.y) < 2))).toBe(true);
    if (width === 390) expect(result.frames.some(frame => frame.width > 140 && Math.abs(frame.x - width / 2) < 2 && Math.abs(frame.y - 200) < 2)).toBe(true);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  });
}

test("cart flight respects reduced motion and never celebrates a failed purchase", async ({ page, request }) => {
  const product = await seededProduct(request);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/products/${product.id}`);
  let flights = 0;
  await page.exposeFunction("recordCartFlight", () => flights++);
  await page.evaluate(() => {
    new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node instanceof Element && (node.matches('[data-testid="cart-flight"]') || node.querySelector('[data-testid="cart-flight"]'))) {
          void (window as unknown as { recordCartFlight: () => Promise<void> }).recordCartFlight();
        }
      }
    }).observe(document.body, { subtree: true, childList: true });
  });
  await page.getByRole("button", { name: "Add to cart", exact: true }).click();
  await expect(page.getByRole("button", { name: "Added to cart", exact: true })).toBeVisible();
  expect(flights).toBe(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.reload();
  await page.route("**/cart/items", route => route.request().method() === "POST"
    ? route.fulfill({ status: 409, json: { success: false, message: "Stock changed before purchase" } })
    : route.continue());
  await page.getByRole("button", { name: "Add to cart", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Stock changed before purchase" })).toBeVisible();
  await expect(page.getByTestId("cart-flight")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Added to cart", exact: true })).toHaveCount(0);
});

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`purchase confirmation slides inside the button and resets with ${reducedMotion} motion`, async ({ page, request }) => {
    const product = await seededProduct(request);
    await page.emulateMedia({ reducedMotion });
    await page.goto(`/products/${product.id}`);
    const actions = page.getByTestId("product-purchase-actions");
    const add = actions.getByRole("button", { name: "Add to cart", exact: true });
    await expect(add).toBeEnabled();
    const label = add.getByText("Add to cart", { exact: true });
    await expect(label).toHaveCSS("font-size", "16px");
    await expect(label).toHaveCSS("font-weight", "600");
    await expect(label).toHaveCSS("line-height", "20px");
    const height = (await actions.boundingBox())!.height;
    await page.evaluate(() => {
      const node = document.querySelector('[data-testid="add-to-cart-label-motion"]')!;
      const frames: number[] = [];
      (window as unknown as { purchaseMotionFrames: number[] }).purchaseMotionFrames = frames;
      new MutationObserver(() => frames.push(new DOMMatrixReadOnly(getComputedStyle(node).transform).m42))
        .observe(node, { attributes: true, attributeFilter: ["style"] });
    });
    const response = page.waitForResponse(response => response.url().endsWith("/cart/items") && response.request().method() === "POST");
    await add.click();
    expect((await response).ok()).toBe(true);
    await expect(actions.getByRole("button", { name: "Added to cart", exact: true })).toBeVisible();
    const motion = actions.getByTestId("add-to-cart-label-motion");
    await expect.poll(() => motion.evaluate(node => new DOMMatrixReadOnly(getComputedStyle(node).transform).m42)).toBe(-52);
    const animated = await page.evaluate(() => (window as unknown as { purchaseMotionFrames: number[] })
      .purchaseMotionFrames.some(position => position < 0 && position > -52));
    expect(animated).toBe(reducedMotion === "no-preference");
    expect((await actions.boundingBox())!.height).toBe(height);
    await expect(add).toBeVisible();
    await expect.poll(() => motion.evaluate(node => new DOMMatrixReadOnly(getComputedStyle(node).transform).m42)).toBe(0);
    expect((await actions.boundingBox())!.height).toBe(height);
  });
}

test("review preview arrows reveal on hover and keyboard focus and stay absent on mobile", async ({ page, request }) => {
  const product = await seededProduct(request);
  await page.goto(`/products/${product.id}`);
  const carousel = page.getByTestId("review-preview-carousel");
  const next = carousel.getByRole("button", { name: "Go to the next item", exact: true });
  const track = carousel.locator("[data-bloom-carousel-track]");
  const arrows = page.getByTestId("review-preview-carousel-overlay-arrows");
  const nextArrow = arrows.locator("[data-bloom-carousel-arrow]").last();
  await carousel.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  await expect(nextArrow).toHaveCSS("opacity", "0");
  await carousel.hover();
  await expect(nextArrow).toHaveCSS("opacity", "1");
  await next.click();
  await expect.poll(() => track.evaluate(element => element.scrollLeft)).toBeGreaterThan(250);
  await page.mouse.move(0, 0);
  await next.focus();
  await expect(nextArrow).toHaveCSS("opacity", "1");
  await page.setViewportSize({ width: 390, height: 1000 });
  await expect(arrows).toHaveCount(0);
  await expect(carousel.getByRole("button", { name: /^Read review by/ })).toHaveCount(3);
  const readMore = page.getByRole("button", { name: "Read more reviews", exact: true });
  await page.mouse.move(0, 0);
  await expect(readMore).toHaveCSS("background-color", "rgb(242, 244, 245)");
});

for (const width of [1440, 390]) {
  test(`review previews open the selected review and restore the trigger at ${width}px`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 1000 });
    const product = await seededProduct(request);
    const response = await (await request.get(
      `http://localhost:4160/listings/${product.id}/reviews?limit=12`,
    )).json();
    const selectedReview = response.data[2];
    expect(selectedReview).toBeTruthy();
    await page.goto(`/products/${product.id}`);
    const sections = page.getByTestId("product-sections");
    const preview = sections.getByTestId(`review-${selectedReview.id}`);
    await expect(sections.getByTestId("review-preview-carousel").getByRole("button", { name: /^Read review by/ })).toHaveCount(3);
    await expect(preview).toHaveRole("button");
    await expect(preview).toHaveAccessibleName(new RegExp(selectedReview.title));
    await expect(preview.getByText(selectedReview.title, { exact: true })).toBeVisible();
    if (width === 1440) {
      await preview.focus();
      await page.keyboard.press("Enter");
    } else await preview.click();
    const dialog = page.getByTestId("product-reviews-dialog");
    const scroll = dialog.getByTestId("product-reviews-scroll");
    const selected = dialog.getByTestId(`review-${selectedReview.id}`);
    await expect(dialog).toBeVisible();
    await expect.poll(() => scroll.evaluate(element => element.clientHeight)).toBeLessThan(1000);
    await expect.poll(() => scroll.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    await expect.poll(async () => {
      const card = (await selected.boundingBox())!;
      const viewport = (await scroll.boundingBox())!;
      // Match Shop's centred reveal; clamp naturally at the start of the list.
      const offset = await scroll.evaluate(element => element.scrollTop);
      const centreDelta = card.y + card.height / 2 - viewport.y - viewport.height / 2;
      return offset === 0 ? Math.max(0, centreDelta) : Math.abs(centreDelta);
    }).toBeLessThan(2);
    await expect(selected.getByText(selectedReview.body, { exact: true })).toBeVisible();
    // Escape inside Search is deliberately consumed; exercise dismissal from
    // the dialog's own header, outside the content testID on bottom sheets.
    await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).focus();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    if (width === 1440) await expect(preview).toBeFocused();
    await sections.getByRole("button", { name: "Read more reviews", exact: true }).click();
    await expect(dialog.getByTestId(`review-${response.data[0].id}`)).toBeVisible();
    await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBe(0);
  });
}

for (const mode of ["light", "dark"] as const) {
  test(`review summary preserves server fractions and Shop geometry in ${mode} mode`, async ({ page, request }) => {
    await page.addInitScript(mode => {
      localStorage.setItem("mercaria.bloom.theme", JSON.stringify({ mode, colorPreset: "mono" }));
    }, mode);
    const product = await seededProduct(request);
    const response = await (await request.get(`http://localhost:4160/listings/${product.id}/reviews?limit=12`)).json();
    await page.goto(`/products/${product.id}`);
    const sections = page.getByTestId("product-sections");
    const average = sections.getByTestId("review-rating-average");
    await expect(average).toHaveCSS("font-size", "28px");
    await expect(average).toHaveCSS("line-height", "30px");
    await expect(average).toHaveCSS("font-weight", "700");
    const stars = sections.getByTestId("review-summary-stars");
    await expect(stars.getByTestId("review-summary-stars-stars").locator(":scope > div")).toHaveCount(5);
    await expect(stars.locator("svg").first()).toHaveAttribute("width", "20");
    await expect(stars).toHaveText("");
    const total = Object.values(response.ratingSummary.distribution).reduce<number>((sum, count) => sum + Number(count), 0);
    for (const bucket of [5, 4, 3, 2, 1]) {
      const row = sections.getByTestId(`rating-distribution-${bucket}`);
      const bar = row.getByRole("progressbar");
      await expect(bar).toHaveCSS("height", "8px");
      await expect(bar).toHaveCSS("border-radius", "8px");
      await expect(bar).toHaveCSS("background-color", mode === "dark" ? "rgba(255, 255, 255, 0.06)" : "rgba(24, 59, 78, 0.06)");
      await expect(row.getByText(String(bucket), { exact: true })).toHaveCSS("font-size", "10px");
      const fraction = response.ratingSummary.distribution[bucket] / total;
      await expect(bar).toHaveAttribute("aria-valuenow", String(fraction));
      const fill = row.getByTestId(`rating-distribution-${bucket}-fill`);
      await expect(fill).toHaveCSS("background-color", mode === "dark" ? "rgb(255, 255, 255)" : "rgb(18, 18, 18)");
      await expect.poll(async () => {
        const fillWidth = (await fill.boundingBox())!.width;
        const barWidth = (await bar.boundingBox())!.width;
        return Math.abs(fillWidth / barWidth - fraction);
      }).toBeLessThan(0.002);
    }
    const trigger = sections.getByRole("button", { name: "Reviews", exact: true });
    await expect(trigger).toHaveCSS("padding-top", "16px");
    await expect(trigger).toHaveCSS("padding-bottom", "16px");
    await expect(trigger).toHaveCSS("padding-inline-start", "0px");
    const contentId = await trigger.getAttribute("aria-controls");
    expect(contentId).toBeTruthy();
    const content = page.locator(`[id="${contentId}"]`);
    await expect(content.locator(":scope > div")).toHaveCSS("padding-bottom", "16px");
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(content).toHaveAttribute("aria-hidden", "true");
    await expect(sections.getByRole("button", { name: "Read more reviews", exact: true })).toHaveCount(0);
    await trigger.click();
    await expect(sections.getByRole("button", { name: "Read more reviews", exact: true })).toBeVisible();
  });
}

test("reviews preserve the server rating and append full text as the sheet scrolls", async ({
  page,
  request,
}) => {
  const product = await seededProduct(request);
  const response = await (
    await request.get(
      `http://localhost:4160/listings/${product.id}/reviews?limit=12`,
    )
  ).json();
  expect(response.ratingSummary.reviewCount).toBeGreaterThan(12);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/products/${product.id}`);
  const sections = page.getByTestId("product-sections");
  await expect(sections).toContainText(
    new RegExp(`${response.ratingSummary.reviewCount}\\u2069? ratings`),
  );
  await sections
    .getByRole("button", { name: "Read more reviews", exact: true })
    .click();
  const dialog = page.getByTestId("product-reviews-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Next", exact: true })).toHaveCount(0);
  const firstTitle = response.data[0].title;
  await expect(dialog.getByText(firstTitle, { exact: true })).toBeVisible();
  const scroller = dialog.getByTestId("product-reviews-scroll");
  await expect.poll(() => scroller.evaluate(node => node.clientHeight)).toBeLessThan(844);
  await expect.poll(async () => {
    // RNW adds its imperative scrollTo({ y }) to the DOM node. Assigning the
    // browser offset exercises actual scrolling without calling that RN API
    // with incompatible browser { top } options.
    await scroller.evaluate(node => { node.scrollTop = node.scrollHeight; });
    return dialog.getByTestId(/^review-[0-9a-f]{8}-/).count();
  }).toBe(response.pagination.total);
  await expect.poll(() => scroller.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
  await expect(dialog.getByTestId(`review-${response.data[0].id}`)).toHaveCount(1);
  await expect(dialog.getByTestId(/^review-[0-9a-f]{8}-/)).toHaveCount(response.pagination.total);
  await expect(dialog.getByTestId("review-rating-average")).toHaveText(`\u2068${response.ratingSummary.rating}\u2069`);
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test("review continuation failures preserve loaded cards and retry the missing page", async ({ page, request }) => {
  const product = await seededProduct(request);
  let unavailable = true;
  await page.route(`**/listings/${product.id}/reviews?*`, async route => {
    if (new URL(route.request().url()).searchParams.get("page") === "2" && unavailable) {
      await route.fulfill({ status: 503, json: { success: false, message: "Temporary test outage" } });
    } else await route.continue();
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/products/${product.id}`);
  await page.getByRole("button", { name: "Read more reviews", exact: true }).click();
  const dialog = page.getByTestId("product-reviews-dialog");
  const cards = dialog.getByTestId(/^review-[0-9a-f]{8}-/);
  await expect(cards).toHaveCount(12);
  await dialog.getByTestId("product-reviews-scroll").evaluate(node => { node.scrollTop = node.scrollHeight; });
  const retry = dialog.getByRole("button", { name: "Try Again", exact: true });
  await expect(retry).toBeVisible();
  await expect(cards).toHaveCount(12);
  unavailable = false;
  await retry.click();
  await expect(cards).toHaveCount(24);
  await expect(retry).toHaveCount(0);
});

test("review search submits to the server, preserves the aggregate and restores the unfiltered list", async ({ page, request }) => {
  const product = await seededProduct(request);
  const endpoint = `http://localhost:4160/listings/${product.id}/reviews`;
  const original = await (await request.get(`${endpoint}?limit=12`)).json();
  const matches = await (await request.get(`${endpoint}?limit=12&query=glow`)).json();
  expect(matches.pagination.total).toBeGreaterThan(0);
  expect(matches.pagination.total).toBeLessThan(original.pagination.total);
  await page.goto(`/products/${product.id}`);
  await page.getByTestId("product-sections").getByRole("button", { name: "Read more reviews", exact: true }).click();
  const dialog = page.getByTestId("product-reviews-dialog");
  const input = dialog.getByPlaceholder("Search reviews", { exact: true });
  await input.fill("  glow  ");
  // Draft text is submitted explicitly; it must not filter the current page.
  await expect(dialog.getByTestId(`review-${original.data[0].id}`)).toHaveCount(1);
  await expect(dialog.getByText(/^Search results:/)).toHaveCount(0);
  const searched = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === `/listings/${product.id}/reviews` && url.searchParams.get("query") === "glow";
  });
  await input.press("Enter");
  expect((await searched).ok()).toBe(true);
  await expect(dialog.getByText(`Search results: \u2068${matches.pagination.total}\u2069`, { exact: true })).toBeVisible();
  await expect(input).not.toBeFocused();
  for (const review of matches.data) {
    await expect(dialog.getByTestId(`review-${review.id}`)).toHaveCount(1);
  }
  await expect(dialog.getByTestId("review-rating-average")).toHaveText(`\u2068${original.ratingSummary.rating}\u2069`);
  await input.fill("no-review-matches-this-phrase-82691");
  await input.press("Enter");
  await expect(dialog.getByText("No reviews match your search.", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Search results: \u20680\u2069", { exact: true })).toBeVisible();
  await dialog.getByTestId("searchTextInputClearBtn").click();
  await expect(input).toHaveValue("");
  await expect(input).toBeFocused();
  await expect(dialog.getByText(/^Search results:/)).toHaveCount(0);
  await expect(dialog.getByTestId(`review-${original.data[0].id}`)).toHaveCount(1);
  await input.press("Escape");
  await expect(dialog).toBeVisible();
});

test("merchant-authored return policy expands and share copies the selected variant URL", async ({
  page,
  context,
  request,
}) => {
  const product = await seededProduct(request);
  const variant = product.variants[1];
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.route(`**/listings/${product.id}`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.data.store.refundPolicy =
      "Local browser fixture: returns within 14 days.";
    await route.fulfill({ response, json: body });
  });
  await page.goto(`/products/${product.id}?variantId=${variant.id}`);
  await page
    .getByRole("button", { name: "Return policy", exact: true })
    .click();
  await expect(
    page.getByText("Local browser fixture: returns within 14 days."),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Share this product", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Link copied", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    `http://localhost:8160/products/${product.id}?variantId=${variant.id}`,
  );
});

test('Buy now uses the selected variant and the server-provided checkout seller', async ({ page, request }) => {
  const product = await seededProduct(request);
  const variant = product.variants.find(item => item.title === 'Stella')!;
  await page.goto(`/products/${product.id}?variantId=${variant.id}`);
  const added = page.waitForResponse(response => response.url().endsWith('/cart/items') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Buy now', exact: true }).click();
  const response = await added;
  expect(response.ok()).toBe(true);
  expect(response.request().postDataJSON()).toMatchObject({ variantId: variant.id, quantity: 1 });
  const cart = (await response.json()).data;
  const group = cart.groups.find((item: { items: { variantId: string }[] }) => item.items.some(line => line.variantId === variant.id));
  await expect(page).toHaveURL(/\/checkout\?/);
  expect(new URL(page.url()).searchParams.get('seller')).toBe(group.sellerKey);
});

test('a product without photographs keeps an accessible empty gallery and working purchase controls', async ({ page, request }) => {
  const product = await seededProduct(request);
  await page.route(`**/listings/${product.id}`, async route => {
    const response = await route.fetch(); const body = await response.json();
    body.data.images = [];
    for (const variant of body.data.variants) variant.images = { source: 'listing_fallback', images: [] };
    await route.fulfill({ response, json: body });
  });
  await page.goto(`/products/${product.id}`);
  await expect(page.getByTestId('product-gallery').getByText('No image', { exact: true })).toBeVisible();
  await expect(page.getByTestId('product-gallery-carousel')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add to cart', exact: true })).toBeEnabled();
});

test("canonical products use the complete gallery and keep purchase availability explicit", async ({ page, request }) => {
  const listing = await seededProduct(request);
  const id = "00000000-0000-4000-8000-000000000001";
  const now = new Date().toISOString();
  const existingReviews = await (await request.get(`http://localhost:4160/listings/${listing.id}/reviews?limit=1`)).json();
  const unverified: Review = {
    ...existingReviews.data[0],
    scope: "product", targetType: "canonical_product", listingId: undefined,
    canonicalProductId: id, verification: "unverified",
  };
  await page.route(`**/reviews/product/${id}*`, route => route.fulfill({ json: {
    success: true, data: [unverified],
    pagination: { page: 1, limit: 12, total: 1, pages: 1, hasNextPage: false, hasPreviousPage: false },
    aggregate: {
      scope: "product", targetType: "canonical_product", targetId: id, dimensions: [],
      rating: 0, reviewCount: 0, unverified: { rating: unverified.rating, count: 1 },
    },
    ratingSummary: { rating: 0, reviewCount: 0, verifiedOnly: true, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } },
  }}));
  await page.route("**/product-page/gallery-preview*", route => route.fulfill({ json: {
    success: true,
    data: {
      product: {
        id, slug: "gallery-preview", status: "active", name: "Gallery preview",
        description: "A catalogue product with a complete photo gallery.",
        aliases: [], searchTokens: [], variantDefiningAttributeKeys: [],
        images: listing.images.map((image, position) => ({
          id: String(position), sourceUrl: image.fileId, alt: `Catalogue photo ${position + 1}`,
          position, status: "active",
        })),
        attributes: [], identifiers: [], fieldProvenance: [],
        rating: 0, ratingCount: 0, variantCount: 0,
        firstSeenAt: now, createdAt: now, updatedAt: now,
      },
      variants: [], offers: { available: false, reason: "comparison_withheld" },
      officialChannels: [], authorizedResellers: [],
    },
  }}));
  await page.goto("/p/gallery-preview");
  await expect(page.getByTestId("product-thumbnails").getByRole("button")).toHaveCount(listing.images.length);
  const gallery = page.getByTestId("product-gallery-carousel");
  await expect(gallery.getByRole("img", { name: "Catalogue photo 1", exact: true }).last()).toBeVisible();
  await expect(page.getByRole("button", { name: "Add to cart", exact: true })).toHaveCount(0);
  // Having no verified purchases does not erase the independent unverified
  // reviews, nor turn their average into a verified product rating.
  await expect(page.getByText(/^Unverified: /)).toBeVisible();
  await expect(page.getByTestId("review-rating-average")).toHaveCount(0);
  await expect(page.getByText("No Product reviews yet.", { exact: true })).toHaveCount(0);
  const preview = page.getByTestId("review-preview-carousel").getByTestId(`review-${unverified.id}`);
  await expect(preview).toHaveRole("button");
  await preview.click();
  const reviewsDialog = page.getByTestId("product-reviews-dialog");
  await expect(reviewsDialog.getByTestId(`review-${unverified.id}`)).toBeVisible();
  await expect(reviewsDialog.getByTestId("review-rating-average")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(reviewsDialog).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("product-thumbnails")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  let saveWrites = 0;
  page.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/product-saves") saveWrites++;
  });
  const save = page.getByRole("button", { name: "Save this product", exact: true, includeHidden: true });
  await expect(save).toHaveAttribute("aria-pressed", "false");
  await save.click();
  await expect(page.getByText("Continue with Oxy", { exact: true })).toBeVisible();
  await expect(save).toHaveAttribute("aria-pressed", "false");
  expect(saveWrites).toBe(0);
});

for (const [layout, value] of [
  ["grid", "Cotton"],
  ["responsive", "Organic cotton and linen"],
  ["list", "Organic cotton and linen with a recycled polyester lining"],
] as const) {
  test(`catalog specifications preserve facts in ${layout} layout across screen sizes`, async ({ page }) => {
    const id = "00000000-0000-4000-8000-000000000002";
    const now = new Date().toISOString();
    await page.route("**/product-page/specification-preview*", route => route.fulfill({ json: {
      success: true, data: {
        product: {
          id, slug: "specification-preview", status: "active", name: "Specification preview",
          aliases: [], searchTokens: [], variantDefiningAttributeKeys: [], images: [],
          attributes: [{
            key: "material", definitionVersion: 1, position: 0,
            displayValue: "Superseded source material", normalizationState: "normalized",
            selectionState: "superseded",
          }], identifiers: [], fieldProvenance: [],
          rating: 0, ratingCount: 0, variantCount: 0,
          firstSeenAt: now, createdAt: now, updatedAt: now,
        },
        variants: [], offers: { available: false, reason: "comparison_withheld" },
        officialChannels: [], authorizedResellers: [],
      },
    }}));
    await page.route(`**/catalog-attributes/values/product/${id}*`, route => route.fulfill({ json: {
      success: true, data: { entityKind: "product", entityId: id, values: [
        { key: "material", label: "Material", displayValue: value },
        { key: "color", label: "Color", displayValue: "Blue" },
        { key: "care", label: "Care", displayValue: "Hand wash" },
      ].map((entry, position) => ({ ...entry, position, valueType: "string", sourceBacked: true, verificationState: "unverified" } satisfies PublicAttributeValue)) },
    }}));
    await page.goto("/p/specification-preview");
    const grid = page.getByTestId("pdp-specifications-grid");
    await expect(grid).toBeVisible();
    await expect(page.getByRole("heading", { name: "Specifications", exact: true })).toHaveCount(1);
    await expect(page.getByText("Superseded source material", { exact: true })).toHaveCount(0);
    const cells = grid.getByTestId("pdp-specification-cell");
    await expect(cells).toHaveCount(3);
    await expect(cells.first()).toContainText(value);
    await expect(cells.first().getByText(value, { exact: true })).toHaveCSS("font-size", "14px");
    await expect(cells.first().getByText(value, { exact: true })).toHaveCSS("line-height", "18px");
    for (const width of [1280, 390, 768]) {
      await page.setViewportSize({ width, height: 900 });
      const columns = layout === "grid" || (layout === "responsive" && width >= 768) ? 2 : 1;
      await expect.poll(() => cells.evaluateAll(nodes => {
        const first = nodes[0].getBoundingClientRect();
        const second = nodes[1].getBoundingClientRect();
        return Math.abs(first.y - second.y) < 1;
      })).toBe(columns === 2);
      await expect.poll(() => grid.evaluate(node => {
        const last = node.lastElementChild!.getBoundingClientRect();
        return Math.abs(last.width - node.getBoundingClientRect().width);
      })).toBeLessThan(1);
      const labelAboveValue = await cells.first().evaluate(cell => {
        const label = cell.children[0].getBoundingClientRect();
        const content = cell.children[1].getBoundingClientRect();
        return content.y >= label.bottom;
      });
      expect(labelAboveValue).toBe(true);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    }
    await grid.screenshot({ path: `/tmp/mercaria-specifications-${layout}.png` });
  });
}

test("store reviews expose the next page and preserve real verification labels", async ({ page, request }) => {
  const product = await seededProduct(request);
  await page.goto(`/stores/${product.store!.handle}`);
  await page.getByRole("button", { name: `Open ${product.store!.name} menu`, exact: true }).click();
  await page.getByRole("button", { name: "View this store's service reviews" }).click();
  await expect(page.getByText(/Page .*1.* of .*2/)).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByText(/Page .*2.* of .*2/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
  await expect(page.getByText("Verified buyer", { exact: true })).toHaveCount(0);
});

test("product gallery keeps selection and viewport bounds in dark Arabic and reduced motion", async ({ page, request }) => {
  const product = await seededProduct(request);
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  await page.addInitScript(() => {
    localStorage.setItem("i18n-storage", JSON.stringify({ state: { locale: "ar" }, version: 0 }));
    localStorage.setItem("mercaria.bloom.theme", JSON.stringify({ mode: "dark", colorPreset: "mono" }));
  });
  await page.goto(`/products/${product.id}`);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("html")).toHaveClass(/dark/);
  const thumbnail = page.getByTestId("product-thumbnails").getByRole("button").nth(2);
  await thumbnail.click();
  await expect(thumbnail).toHaveAttribute("aria-pressed", "true");
  const gallery = page.getByTestId("product-gallery-carousel");
  const slide = gallery.getByRole("button").nth(2);
  await expect.poll(async () => {
    const trackBox = await gallery.boundingBox();
    const slideBox = await slide.boundingBox();
    return !!trackBox && !!slideBox && Math.abs(trackBox.x - slideBox.x) < 3;
  }).toBe(true);
  await slide.click();
  await expect(page.getByRole("button", { name: "إغلاق عارض الوسائط", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "إغلاق عارض الوسائط", exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test("product detail retains the floating shopping composer above mobile navigation", async ({ page, request }) => {
  const product = await seededProduct(request);
  await page.goto(`/products/${product.id}`);
  const composer = page.locator('[data-testid="shopping-composer"]:visible');
  await expect(composer).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => {
    const box = await composer.boundingBox();
    return !!box && box.x >= 0 && box.x + box.width <= 390 && box.y + box.height < 790;
  }).toBe(true);
  await composer.getByRole("textbox").fill("Find similar makeup");
  await composer.getByRole("textbox").press("Enter");
  await expect(page).toHaveURL(/\/thread\?q=Find%20similar%20makeup$/);
});

test("store menu reads authored policies, returns to its menu and opens the report sign-in flow", async ({ page, request }) => {
  const product = await seededProduct(request);
  const privacy = "This store uses order details only to fulfil purchases.";
  const returns = "Contact this store within fourteen days for return instructions.";
  await page.route(new RegExp(`^http://localhost:4160/stores/${product.store!.handle}(?:\\?.*)?$`), async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.data.store.privacyPolicy = privacy;
    body.data.store.refundPolicy = returns;
    await route.fulfill({ response, json: body });
  });
  let reports = 0;
  page.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/reports") reports++;
  });
  await page.goto(`/stores/${product.store!.handle}`);
  await page.getByRole("button", { name: `Open ${product.store!.name} menu`, exact: true }).click();
  await page.getByRole("button", { name: "Privacy policy", exact: true }).click();
  await expect(page.getByText(privacy, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Return policy", exact: true }).click();
  await expect(page.getByText(returns, { exact: true }).last()).toBeVisible();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("button", { name: "Report store", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign in to report", exact: true })).toBeVisible();
  expect(reports).toBe(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Report store", exact: true })).toBeVisible();
});

test("store menu omits unpublished policies", async ({ page, request }) => {
  const product = await seededProduct(request);
  await page.route(new RegExp(`^http://localhost:4160/stores/${product.store!.handle}(?:\\?.*)?$`), async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.data.store.privacyPolicy = "  ";
    delete body.data.store.refundPolicy;
    await route.fulfill({ response, json: body });
  });
  await page.goto(`/stores/${product.store!.handle}`);
  await page.getByRole("button", { name: `Open ${product.store!.name} menu`, exact: true }).click();
  await expect(page.getByRole("button", { name: "Report store", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Privacy policy", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Return policy", exact: true })).toHaveCount(0);
});

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`long product descriptions open in a complete readable sheet at ${viewport.width}px`, async ({ page, request }) => {
    const product = await seededProduct(request);
    const ending = "Final care instructions: wash gently and dry flat. 🧵";
    const description = "A carefully made item for everyday use.\n\n".repeat(18) + ending;
    await page.route(`**/listings/${product.id}`, async route => {
      const response = await route.fetch();
      const body = await response.json();
      body.data.description = description;
      await route.fulfill({ response, json: body });
    });
    await page.setViewportSize(viewport);
    await page.goto(`/products/${product.id}`);
    const preview = page.getByTestId("product-description");
    await expect(preview.getByText(ending, { exact: false })).toHaveCount(0);
    await preview.getByRole("button", { name: "View more", exact: true }).click();
    const sheet = page.getByTestId("product-description-dialog");
    await expect(sheet.getByText(description, { exact: true })).toBeVisible();
    await expect.poll(async () => {
      const bounds = await sheet.boundingBox();
      return !!bounds && bounds.x >= 0 && bounds.x + bounds.width <= viewport.width + 1;
    }).toBe(true);
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(preview.getByRole("button", { name: "View more", exact: true })).toBeVisible();
  });
}

test("short product descriptions are complete without a redundant read-more control", async ({ page, request }) => {
  const product = await seededProduct(request);
  const description = "Made with cotton.\n\nWash at 30°C.";
  await page.route(`**/listings/${product.id}`, async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.data.description = description;
    await route.fulfill({ response, json: body });
  });
  await page.goto(`/products/${product.id}`);
  const preview = page.getByTestId("product-description");
  await expect(preview.getByText(description, { exact: true })).toBeVisible();
  await expect(preview.getByRole("button", { name: "View more", exact: true })).toHaveCount(0);
});

test("a deep-linked option beyond the preview stays selected and visible before expanding", async ({ page, request }) => {
  const product = await seededProduct(request);
  const values = Array.from({ length: 120 }, (_, index) => `Option ${index + 1}`);
  values[119] = "Limited edition with a much longer merchant-authored option name";
  const variants = values.map((value, index) => ({
    ...product.variants[0],
    id: `${product.variants[0].id}-${index}`,
    title: value,
    optionValues: [{ name: "Size", value }],
  }));
  await page.route(`**/listings/${product.id}`, async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.data.options = [{ name: "Size", values }];
    body.data.variants = variants;
    await route.fulfill({ response, json: body });
  });
  await page.goto(`/products/${product.id}?variantId=${variants[119].id}`);
  const selected = page.getByRole("button", { name: `Size: ${values[119]}`, exact: true });
  await expect(selected)
    .toHaveAttribute("aria-pressed", "true");
  const grid = page.getByTestId("variant-option-values-Size");
  const options = grid.getByRole("button", { name: /^Size: / });
  const rowCount = () => grid.getByRole("button").evaluateAll(elements =>
    new Set(elements.map(element => Math.round(element.getBoundingClientRect().top))).size);
  await expect.poll(rowCount).toBe(4);
  const desktopCount = await options.count();
  expect(desktopCount).toBeLessThan(values.length);
  await page.setViewportSize({ width: 390, height: 1000 });
  await expect.poll(() => options.count()).toBeLessThan(desktopCount);
  await expect.poll(rowCount).toBe(4);
  await expect(selected).toBeVisible();
  await expect(selected).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(new RegExp(`variantId=${variants[119].id}$`));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(options).toHaveCount(desktopCount);
  const hidden = values.length - desktopCount;
  await grid.getByRole("button", { name: `More Size options (${hidden})`, exact: true }).click();
  await expect(options).toHaveCount(values.length);
  await page.getByRole("button", { name: "Size: Option 26", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`variantId=${variants[25].id}$`));
  await expect(page.getByRole("button", { name: "Size: Option 26", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
});

test("pictured Arabic options fit four rows and expand without horizontal overflow", async ({ page, request }) => {
  const product = await seededProduct(request);
  const values = Array.from({ length: 32 }, (_, index) => `مقاس ${index + 1}`);
  values[31] = "إصدار خاص باسم طويل للمنتج من المتجر";
  const variants = values.map((value, index) => ({
    ...product.variants[0],
    id: `${product.variants[0].id}-pictured-${index}`,
    title: value,
    optionValues: [{ name: "مقاس", value }],
    images: { source: "variant", images: [product.images[index % product.images.length]] },
  }));
  await page.addInitScript(() => {
    localStorage.setItem("i18n-storage", JSON.stringify({ state: { locale: "ar" }, version: 0 }));
    localStorage.setItem("mercaria.bloom.theme", JSON.stringify({ mode: "dark", colorPreset: "mono" }));
  });
  await page.route(`**/listings/${product.id}`, async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.data.options = [{ name: "مقاس", values }];
    body.data.variants = variants;
    await route.fulfill({ response, json: body });
  });
  await page.goto(`/products/${product.id}?variantId=${variants[31].id}`);
  const grid = page.getByTestId("variant-option-values-مقاس");
  const selected = grid.getByRole("button", { name: `مقاس: ${values[31]}`, exact: true });
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect.poll(() => grid.getByRole("button").evaluateAll(elements =>
      new Set(elements.map(element => Math.round(element.getBoundingClientRect().top))).size)).toBe(4);
    await expect(selected).toHaveAttribute("aria-pressed", "true");
    await expect(selected.locator("img").last()).toHaveAttribute("src", product.images[31 % product.images.length].fileId);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }
  await grid.getByRole("button").last().click();
  await expect(grid.getByRole("button", { name: /^مقاس: / })).toHaveCount(values.length);
  await expect(selected).toHaveAttribute("aria-pressed", "true");
});

for (const width of [1440, 390]) {
  test(`product actions report the listing instead of its store at ${width}px`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 1000 });
    const product = await seededProduct(request);
    let reports = 0;
    page.on("request", request => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/reports") reports++;
    });
    await page.goto(`/products/${product.id}`);
    const trigger = page.getByRole("button", { name: "More actions", exact: true });
    await expect(page.getByTestId("product-summary")).toHaveCSS("row-gap", "16px");
    await expect(page.getByRole("heading", { name: product.title, exact: true })).toHaveCSS("line-height", "28px");
    if (width < 1024) {
      const title = await page.getByRole("heading", { name: product.title, exact: true }).boundingBox();
      const action = await trigger.boundingBox();
      expect(Math.abs(action!.y - title!.y)).toBeLessThan(2);
      expect(action!.x).toBeGreaterThan(title!.x + title!.width);
    }
    await trigger.click();
    const menu = page.getByRole("menu", { name: "More actions", exact: true });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Report product", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Report store", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await trigger.click();
    await menu.getByRole("menuitem", { name: "Report product", exact: true }).click();
    await expect(page.getByRole("dialog", { name: `Report ${product.title}`, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in to report", exact: true })).toBeVisible();
    expect(reports).toBe(0);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
}

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`saving a listing as a guest opens Oxy without sending a save at ${viewport.width}px`, async ({ page, request }) => {
    const product = await seededProduct(request);
    await page.setViewportSize(viewport);
    const writes: string[] = [];
    page.on("request", request => {
      if (["POST", "DELETE"].includes(request.method()) && /^\/(favorites|product-saves)(\/|$)/.test(new URL(request.url()).pathname)) {
        writes.push(request.url());
      }
    });
    await page.goto(`/products/${product.id}`);
    const save = page.getByRole("button", { name: "Save this listing", exact: true, includeHidden: true });
    await expect(save).toHaveAttribute("aria-pressed", "false");
    await save.click();
    await expect(page.getByText("Use your Oxy account", { exact: true })).toBeVisible();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toHaveCount(1);
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await expect(dialog.getByText("Use your Oxy account", { exact: true })).toBeVisible();
    expect(await dialog.evaluate(node => node.closest("[inert]") === null)).toBe(true);
    await expect(page.getByTestId("app-content-boundary")).toHaveAttribute("inert", "");
    await expect(save).toHaveAttribute("aria-pressed", "false");
    expect(writes).toEqual([]);
  });
}

test("product columns and Bloom navigation switch at their independent tablet widths", async ({ page, request }) => {
  const product = await seededProduct(request);
  for (const width of [767, 768, 900, 975, 976, 1024]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`/products/${product.id}`);
    const gallery = page.getByTestId("product-gallery");
    const buy = page.getByTestId("product-buy-column");
    await expect(buy).toBeVisible();
    await expect(page.getByRole(width < 976 ? "tab" : "button", { name: "Profile", exact: true })).toBeVisible();
    await expect.poll(async () => {
      const media = await gallery.boundingBox();
      const details = await buy.boundingBox();
      return width >= 768 ? details!.x >= media!.x + media!.width + 39 : details!.y >= media!.y + media!.height;
    }).toBe(true);
    if (width >= 768) {
      await expect.poll(async () => (await buy.boundingBox())!.width).toBe(464);
      await expect(page.getByTestId("product-thumbnails")).toBeVisible();
    } else {
      await expect(page.getByTestId("product-thumbnails")).toHaveCount(0);
    }
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  }
});

test("Bloom gallery arrows reveal on hover or keyboard focus and remain visible for touch", async ({ page, request, browser }) => {
  const product = await seededProduct(request);
  await page.goto(`/products/${product.id}`);
  const gallery = page.getByTestId("product-gallery-carousel");
  const arrows = gallery.locator("[data-bloom-carousel-arrow]");
  await expect(arrows).toHaveCount(2);
  await expect(arrows.first()).toHaveCSS("opacity", "0");
  await gallery.hover();
  await expect(arrows.first()).toHaveCSS("opacity", "1");
  await page.mouse.move(0, 0);
  await expect(arrows.first()).toHaveCSS("opacity", "0");
  const next = arrows.last().getByRole("button");
  await next.focus();
  await expect(arrows.first()).toHaveCSS("opacity", "1");
  await next.press("Enter");
  await expect(page.getByTestId("product-thumbnails").getByRole("button", { name: "View image 2", exact: true })).toHaveAttribute("aria-pressed", "true");

  const context = await browser.newContext({ viewport: { width: 1024, height: 1000 }, hasTouch: true, reducedMotion: "reduce", locale: "en-US" });
  try {
    const touch = await context.newPage();
    await touch.goto(`/products/${product.id}`);
    expect(await touch.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    const touchArrows = touch.getByTestId("product-gallery-carousel").locator("[data-bloom-carousel-arrow]");
    await expect(touchArrows.first()).toHaveCSS("opacity", "1");
    await expect(touchArrows.first()).toHaveCSS("transition-duration", "0s");
    await touchArrows.last().getByRole("button").tap();
    await expect(touch.getByTestId("product-thumbnails").getByRole("button", { name: "View image 2", exact: true })).toHaveAttribute("aria-pressed", "true");
  } finally {
    await context.close();
  }
});

for (const mode of ["light", "dark"] as const) {
  test(`marketplace purchase and share recipes survive Bloom defaults in ${mode} mode`, async ({ page, request }) => {
    const product = await seededProduct(request);
    const soldOut = product.variants.find(variant => !variant.inStock)!;
    await page.addInitScript(mode => {
      localStorage.setItem("mercaria.bloom.theme", JSON.stringify({ mode, colorPreset: "mono" }));
    }, mode);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`/products/${product.id}`);
    const add = page.getByRole("button", { name: "Add to cart", exact: true });
    const buy = page.getByRole("button", { name: "Buy now", exact: true });
    const share = page.getByRole("button", { name: "Share this product", exact: true });
    await expect(add).toHaveCSS("height", "52px");
    await expect(add).toHaveCSS("background-color", "rgb(84, 51, 235)");
    await expect(add).toHaveCSS("font-size", "16px");
    await expect(add).toHaveCSS("line-height", "20px");
    await expect(add).toHaveCSS("font-weight", "600");
    await expect(add).not.toHaveCSS("box-shadow", "none");
    // Shop uses min-height 52 plus 16px padding; at DPR 1 its rounded
    // half-pixel border makes the 20px text row 54px tall.
    await expect(buy).toHaveCSS("height", "54px");
    await expect(buy.locator("span").first()).toHaveCSS("font-size", "16px");
    await expect(buy.locator("span").first()).toHaveCSS("font-weight", "600");
    await expect(buy).toHaveCSS("background-color", mode === "light" ? "rgb(18, 18, 18)" : "rgb(255, 255, 255)");
    await expect(share).toHaveCSS("height", "44px");
    await expect(share).toHaveCSS("background-color", mode === "light" ? "rgb(255, 255, 255)" : "rgb(18, 18, 18)");
    await expect(share.locator("svg")).toHaveCSS("color", mode === "light" ? "rgb(0, 0, 0)" : "rgb(255, 255, 255)");
    await add.hover();
    await expect(add).toHaveCSS("background-color", "rgb(69, 36, 219)");
    await page.mouse.down();
    await expect.poll(() => add.evaluate(element => {
      const transform = getComputedStyle(element).transform;
      return transform === "none" || new DOMMatrixReadOnly(transform).isIdentity;
    })).toBe(true);
    // Release away from the CTA: this visual check must not create a cart item.
    await page.mouse.move(0, 0);
    await page.mouse.up();
    await page.getByRole("button", { name: `Shade: ${soldOut.title}, Sold out`, exact: true }).click();
    const unavailable = page.getByRole("button", { name: "Sold out", exact: true });
    await expect(unavailable).toBeDisabled();
    await expect(unavailable).toHaveCSS("background-color", mode === "light" ? "rgb(238, 240, 241)" : "rgb(64, 64, 64)");
    await expect(unavailable).toHaveCSS("box-shadow", "none");
    await unavailable.hover({ force: true });
    await expect(unavailable).toHaveCSS("background-color", mode === "light" ? "rgb(238, 240, 241)" : "rgb(64, 64, 64)");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(unavailable).toHaveCSS("height", "52px");
    await expect(share).toHaveCSS("height", "44px");
  });
}

test("option pills keep Shop states and truncate long values in dark desktop and mobile layouts", async ({ page, request }) => {
  const product = await seededProduct(request);
  const longValue = "An extra long merchant-authored option value that must remain on a single line";
  const values = ["Small", longValue, "Large"];
  await page.addInitScript(() => {
    localStorage.setItem("mercaria.bloom.theme", JSON.stringify({ mode: "dark", colorPreset: "mono" }));
  });
  await page.route(`**/listings/${product.id}`, async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.data.options = [{ name: "Size", values }];
    body.data.variants = product.variants.slice(0, 3).map((variant, index) => ({
      ...variant,
      title: values[index],
      optionValues: [{ name: "Size", value: values[index] }],
      inStock: index !== 2,
      available: index === 2 ? 0 : 10,
    }));
    await route.fulfill({ response, json: body });
  });
  await page.goto(`/products/${product.id}`);
  const selected = page.getByRole("button", { name: "Size: Small", exact: true });
  const longOption = page.getByRole("button", { name: `Size: ${longValue}`, exact: true });
  const unavailable = page.getByRole("button", { name: "Size: Large, Sold out", exact: true });
  await expect(selected).toHaveCSS("border-color", "rgb(255, 255, 255)");
  await expect(selected).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(unavailable).toHaveCSS("background-color", "rgb(42, 42, 42)");
  await expect(unavailable).toHaveCSS("opacity", "1");
  await expect(unavailable.getByText("Large", { exact: true })).toHaveCSS("color", "rgba(255, 255, 255, 0.4)");
  await expect(unavailable.getByText("Large", { exact: true })).toHaveCSS("text-decoration-line", "line-through");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(longOption).toHaveCSS("height", "40px");
    await expect(longOption).toHaveCSS("width", "344px");
    await expect(longOption.getByText(longValue, { exact: true })).toHaveCSS("text-overflow", "ellipsis");
    await expect(longOption.getByText(longValue, { exact: true })).toHaveCSS("font-size", "12px");
    await expect(longOption.getByText(longValue, { exact: true })).toHaveCSS("line-height", "16px");
    await longOption.hover();
    await expect(longOption).toHaveCSS("border-color", "rgb(255, 255, 255)");
  }
  for (const reducedMotion of ["no-preference", "reduce"] as const) {
    await page.emulateMedia({ reducedMotion });
    await longOption.hover();
    await page.mouse.down();
    await expect(longOption).toHaveCSS("opacity", "0.5");
    await expect.poll(() => longOption.evaluate(element => {
      const transform = getComputedStyle(element).transform;
      return transform === "none" ? 1 : new DOMMatrixReadOnly(transform).a;
    })).toBe(reducedMotion === "reduce" ? 1 : 0.95);
    await page.mouse.move(0, 0);
    await page.mouse.up();
  }
  await unavailable.click();
  await expect(unavailable).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Sold out", exact: true })).toBeDisabled();
});


for (const width of [1440, 390]) {
  test(`review filters select multiple ratings and order server pages at ${width}px`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 1000 });
    const product = await seededProduct(request);
    await page.goto(`/products/${product.id}`);
    await page.getByRole("button", { name: "Read more reviews", exact: true }).click();
    const filterRequests: string[] = [];
    page.on("request", request => {
      const url = new URL(request.url());
      if (url.pathname.endsWith("/reviews") && url.searchParams.has("ratings")) filterRequests.push(request.url());
    });
    const dialog = page.getByTestId("product-reviews-dialog");
    await dialog.getByRole("button", { name: "Rating", exact: true }).click();
    const menu = page.getByRole("menu");
    await menu.getByRole("checkbox", { name: /Stars:.*1/ }).click();
    await expect(menu.getByRole("checkbox", { name: /Stars:.*1/ })).toBeChecked();
    await menu.getByRole("checkbox", { name: /Stars:.*2/ }).click();
    expect(filterRequests).toHaveLength(0);
    await menu.getByRole("menuitem", { name: "Apply", exact: true }).click();
    const expected = await (await request.get(`http://localhost:4160/listings/${product.id}/reviews?ratings=1,2&sortBy=newest`)).json();
    expect(expected.pagination.total).toBeGreaterThan(0);
    await expect.poll(() => dialog.locator('[data-testid^="review-"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-testid')).filter(id => /^review-[0-9a-f]{8}-/.test(id!)))).toEqual(expected.data.map((review: Review) => `review-${review.id}`));
    await dialog.getByRole("button", { name: "Rating", exact: true }).click();
    await menu.getByRole("menuitem", { name: "Reset", exact: true }).click();
    await menu.getByRole("menuitem", { name: "Apply", exact: true }).click();
    await dialog.getByRole("button", { name: "Sort by", exact: true }).click();
    const oldestOption = menu.getByRole("radio", { name: "Oldest", exact: true });
    await oldestOption.focus();
    await page.keyboard.press("Space");
    await page.keyboard.press("End");
    await expect(menu.getByRole("menuitem", { name: "Apply", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    const oldest = await (await request.get(`http://localhost:4160/listings/${product.id}/reviews?sortBy=oldest&limit=12`)).json();
    await expect.poll(() => dialog.locator('[data-testid^="review-"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-testid')).filter(id => /^review-[0-9a-f]{8}-/.test(id!)).slice(0, 12))).toEqual(oldest.data.map((review: Review) => `review-${review.id}`));
    await expect(dialog.getByRole("button", { name: "Sort by", exact: true })).toHaveCSS("background-color", "rgb(18, 18, 18)");
  });
}

for (const width of [1440, 390]) {
  for (const reducedMotion of ["no-preference", "reduce"] as const) {
    test(`collapsed review caption keeps its space at ${width}px with ${reducedMotion} motion`, async ({ page, request }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ reducedMotion });
      const product = await seededProduct(request);
      await page.goto(`/products/${product.id}`);
      const sections = page.getByTestId("product-sections");
      const trigger = sections.getByRole("button", { name: "Reviews", exact: true });
      const caption = sections.getByTestId("reviews-collapsed-summary");
      const mask = caption.getByTestId("reviews-collapsed-summary-mask");
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      await expect(caption).toHaveAttribute("aria-hidden", "true");
      await expect(mask).toHaveCSS("opacity", "0");
      await trigger.scrollIntoViewIfNeeded();
      const triggerBox = (await trigger.boundingBox())!;
      const captionWidth = (await caption.boundingBox())!.width;
      expect(captionWidth).toBeGreaterThan(50);
      await page.evaluate(() => {
        const frames: number[] = [];
        (window as unknown as { reviewCaptionFrames: number[] }).reviewCaptionFrames = frames;
        const node = document.querySelector('[data-testid="reviews-collapsed-summary-mask"]')!;
        let remaining = 40;
        const sample = () => {
          frames.push(node.getBoundingClientRect().width);
          if (--remaining > 0) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      await trigger.click();
      await expect(caption).not.toHaveAttribute("aria-hidden", "true");
      await expect(mask).toHaveCSS("opacity", "1");
      await expect.poll(async () => Math.round((await mask.boundingBox())!.width)).toBe(Math.round(captionWidth));
      await expect(caption).toHaveAccessibleName(/Item condition and description.*4\.7/);
      const frames = await page.evaluate(() => (window as unknown as { reviewCaptionFrames: number[] }).reviewCaptionFrames);
      expect(frames.some(value => value > 0 && value < captionWidth - 1)).toBe(reducedMotion === "no-preference");
      await page.screenshot({ path: `/tmp/mercaria-review-caption-${width}-${reducedMotion}.png` });
      const collapsed = sections.getByRole("button", { name: /^Reviews/ });
      expect((await collapsed.boundingBox())!.height).toBe(triggerBox.height);
      await collapsed.click();
      await expect(mask).toHaveCSS("opacity", "0");
      await expect.poll(async () => (await mask.boundingBox())!.width).toBe(0);
      await expect(caption).toHaveAttribute("aria-hidden", "true");
      expect((await caption.boundingBox())!.width).toBe(captionWidth);
    });
  }
}

test("collapsed review caption mirrors in Arabic and keeps dark contrast", async ({ page, request }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.addInitScript(() => {
    localStorage.setItem("i18n-storage", JSON.stringify({ state: { locale: "ar" }, version: 0 }));
    localStorage.setItem("mercaria.bloom.theme", JSON.stringify({ mode: "dark", colorPreset: "mono" }));
  });
  const product = await seededProduct(request);
  await page.goto(`/products/${product.id}`);
  const sections = page.getByTestId("product-sections");
  const title = sections.getByRole("heading", { name: "المراجعات", exact: true });
  await sections.getByRole("button", { name: "المراجعات", exact: true }).click();
  const caption = sections.getByTestId("reviews-collapsed-summary");
  await expect(caption.getByTestId("reviews-collapsed-summary-mask")).toHaveCSS("opacity", "1");
  await expect(caption).toHaveAccessibleName(/حالة السلعة ووصفها/);
  const captionBox = (await caption.boundingBox())!;
  const titleBox = (await title.boundingBox())!;
  expect(captionBox.x + captionBox.width).toBeLessThan(titleBox.x + titleBox.width);
  await expect.poll(() => caption.getByText(/4\.7/).evaluate((node) => {
    const context = document.createElement("canvas").getContext("2d")!;
    context.fillStyle = getComputedStyle(node).color;
    context.fillRect(0, 0, 1, 1);
    return [...context.getImageData(0, 0, 1, 1).data];
  })).toEqual([255, 255, 255, 191]);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: "/tmp/mercaria-review-caption-ar-dark.png" });
});


test("explicit light theme keeps review text dark when the OS prefers dark", async ({ page, request }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  const product = await seededProduct(request);
  await page.goto(`/products/${product.id}`);
  const sections = page.getByTestId("product-sections");
  await sections.getByRole("button", { name: "Reviews", exact: true }).click();
  const caption = sections.getByTestId("reviews-collapsed-summary");
  await expect(caption.getByTestId("reviews-collapsed-summary-mask")).toHaveCSS("opacity", "1");
  await expect.poll(() => caption.getByText(/4\.7/).evaluate((node) => {
    const context = document.createElement("canvas").getContext("2d")!;
    context.fillStyle = getComputedStyle(node).color;
    context.fillRect(0, 0, 1, 1);
    return [...context.getImageData(0, 0, 1, 1).data];
  })).toEqual([0, 0, 0, 191]);
});

for (const width of [1440, 390]) {
  test(`a review's report action preserves the review sheet and requires sign-in at ${width}px`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 1000 });
    const product = await seededProduct(request);
    const published = await (await request.get(`http://localhost:4160/listings/${product.id}/reviews?limit=12`)).json();
    const review = published.data[0];
    let reports = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/reports") reports++;
    });
    await page.goto(`/products/${product.id}`);
    // Previews retain one action and never contain nested menu buttons.
    await expect(page.getByRole("button", { name: "Review actions", exact: true })).toHaveCount(0);
    await page.getByTestId("product-sections").getByRole("button", { name: "Read more reviews", exact: true }).click();
    const sheet = page.getByTestId("product-reviews-dialog");
    const card = sheet.getByTestId(`review-${review.id}`);
    const trigger = card.getByRole("button", { name: "Review actions", exact: true });
    await trigger.click();
    const menu = page.getByRole("menu", { name: "Review actions", exact: true });
    await menu.getByRole("menuitem", { name: "Report review", exact: true }).click();
    const report = page.getByRole("dialog", { name: /^Report Review by/ });
    await expect(report).toBeVisible();
    await expect(report.getByRole("button", { name: "Sign in to report", exact: true })).toBeVisible();
    await expect(report.getByRole("button", { name: "Send report", exact: true })).toHaveCount(0);
    expect(reports).toBe(0);
    await page.keyboard.press("Escape");
    await expect(report).toBeHidden();
    await expect(sheet).toBeVisible();
    await expect(trigger).toBeVisible();
  });
}

test("store review actions open the same report form and preserve the store menu", async ({ page, request }) => {
  const product = await seededProduct(request);
  const reviews = await (await request.get(`http://localhost:4160/stores/${product.store!.handle}/reviews`)).json();
  expect(reviews.data.length).toBeGreaterThan(0);
  await page.goto(`/stores/${product.store!.handle}`);
  await page.getByRole("button", { name: `Open ${product.store!.name} menu`, exact: true }).click();
  await page.getByRole("button", { name: "View this store's service reviews", exact: true }).click();
  const trigger = page.getByTestId(`review-actions-${reviews.data[0].id}`);
  await trigger.click();
  await page.getByRole("menuitem", { name: "Report review", exact: true }).click();
  const report = page.getByRole("dialog", { name: /^Report Review by/ });
  await expect(report.getByRole("button", { name: "Sign in to report", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(report).toBeHidden();
  await expect(trigger).toBeVisible();
});

for (const width of [1440, 390]) {
  test(`purchased review variants appear only in full cards and wrap at ${width}px`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 1000 });
    const product = await seededProduct(request);
    const variant = "Midnight blue / Extra long / Limited edition with embroidered details";
    // Visual fixture: the real repository's purchase-evidence rules are tested
    // against PostgreSQL. This leaves the catalog's currently selected shade alone.
    await page.route(`**/listings/${product.id}/reviews?*`, async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      data.data[0] = { ...data.data[0], verification: "verified_purchase", purchasedVariantTitle: variant };
      for (const review of data.data.slice(1)) delete review.purchasedVariantTitle;
      await route.fulfill({ response, json: data });
    });
    await page.goto(`/products/${product.id}`);
    await expect(page.getByTestId("review-preview-carousel")).toBeVisible();
    await expect(page.getByTestId("review-purchased-variant")).toHaveCount(0);
    await page.getByTestId("product-sections").getByRole("button", { name: "Read more reviews", exact: true }).click();
    const sheet = page.getByTestId("product-reviews-dialog");
    const context = sheet.getByTestId("review-purchased-variant");
    await expect(context).toHaveCount(1);
    await expect(context).toHaveText(variant);
    await expect(context).toHaveCSS("font-size", "12px");
    const box = (await context.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    if (width === 390) expect(box.height).toBeGreaterThan(16);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await page.unrouteAll({ behavior: "wait" });
  });
}
