import { expect, test, type APIRequestContext } from "@playwright/test";
import type { Listing, PublicAttributeValue } from "../../../packages/shared-types/src";

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
    .getByRole("button", { name: `Shade: ${soldOut.title}`, exact: true })
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

test("reviews read all server ratings and open a paginated list with full text", async ({
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
  await expect(dialog).toContainText("Page 1 of");
  const firstTitle = response.data[0].title;
  await expect(dialog.getByText(firstTitle, { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Next", exact: true }).click();
  await expect(dialog).toContainText("Page 2 of");
  await expect(dialog.getByTestId(`review-${response.data[0].id}`)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
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
  const values = Array.from({ length: 30 }, (_, index) => `Option ${index + 1}`);
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
  await page.goto(`/products/${product.id}?variantId=${variants[29].id}`);
  await expect(page.getByRole("button", { name: "Size: Option 30", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: /^Size: Option / })).toHaveCount(24);
  await page.getByRole("button", { name: "More Size options (6)", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Size: Option / })).toHaveCount(30);
  await page.getByRole("button", { name: "Size: Option 26", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`variantId=${variants[25].id}$`));
  await expect(page.getByRole("button", { name: "Size: Option 26", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
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
