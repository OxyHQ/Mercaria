import { describe, expect, it } from "vitest";
import { resolvePurchasePreview } from "../purchase-preview";

describe("purchase preview boundary", () => {
  it("does not let a URL opt production into unsupported recurring commerce", () => {
    for (const scenario of ["subscription", "required", "prepaid", "introductory", "unavailable"]) {
      expect(resolvePurchasePreview(scenario, false)).toBeUndefined();
      expect(resolvePurchasePreview(scenario, true)).toBe(scenario);
    }
  });
  it("ignores malformed and unrecognized parameters", () => {
    for (const value of [undefined, null, "", "true", "Subscription", ["subscription"], { scenario: "subscription" }]) {
      expect(resolvePurchasePreview(value, true)).toBeUndefined();
    }
  });
});
