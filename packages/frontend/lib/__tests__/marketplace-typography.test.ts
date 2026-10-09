import { describe, expect, it } from "vitest";
import { cn } from "../../../ui/src/lib/cn";

describe("marketplace typography class merging", () => {
  it("keeps foreground independent of the marketplace size in either order", () => {
    expect(cn("text-base text-foreground", "text-shop-subtitle text-text"))
      .toBe("text-shop-subtitle text-text");
    expect(cn("text-base text-foreground", "text-shop-heroBold text-text"))
      .toBe("text-shop-heroBold text-text");
    expect(cn("text-base text-foreground", "text-text text-shop-subtitle"))
      .toBe("text-text text-shop-subtitle");
  });

  it("resolves size conflicts at each breakpoint without losing mobile text", () => {
    expect(cn("text-base md:text-lg", "text-shop-subtitle md:text-shop-sectionTitle"))
      .toBe("text-shop-subtitle md:text-shop-sectionTitle");
    expect(cn("text-shop-header", "text-shop-posterXS"))
      .toBe("text-shop-posterXS");
  });

  it("keeps the font family when applying a marketplace weight", () => {
    expect(cn("font-sans font-normal", "font-shop-captionBold"))
      .toBe("font-sans font-shop-captionBold");
  });
});
