import { describe, expect, it } from "vitest";
import type { ProductVariantDTO } from "@mercaria/shared-types";
import {
  chooseListingVariant,
  resolveListingVariant,
} from "../variant-selection";

function variant(
  id: string,
  tone: string,
  size: string,
  inStock = true,
): ProductVariantDTO {
  return {
    id,
    title: id,
    optionValues: [
      { name: "Tono", value: tone },
      { name: "サイズ", value: size },
    ],
    price: { amount: 1000, currency: "EUR" },
    available: inStock ? 4 : 0,
    inStock,
  };
}
const redSmall = variant("rs", "Rojo", "S");
const redLarge = variant("rl", "Rojo", "L", false);
const blueLarge = variant("bl", "Azul", "L");
const variants = [redLarge, redSmall, blueLarge];

describe("listing variant selection", () => {
  it("honors a sold-out deep link and falls back only for missing/foreign ids", () => {
    expect(resolveListingVariant(variants, "rl")).toBe(redLarge);
    expect(resolveListingVariant(variants, "foreign")).toBe(redSmall);
    expect(resolveListingVariant(variants)).toBe(redSmall);
    expect(resolveListingVariant([redLarge])).toBe(redLarge);
    expect(resolveListingVariant([])).toBeUndefined();
  });
  it("preserves the exact requested combination even when it is sold out", () => {
    expect(chooseListingVariant(variants, redSmall, "サイズ", "L")).toBe(
      redLarge,
    );
  });
  it("moves to an existing combination when an option matrix has holes", () => {
    expect(chooseListingVariant(variants, redSmall, "Tono", "Azul")).toBe(
      blueLarge,
    );
  });
  it("prefers stock among equally close combinations without mutating the catalog", () => {
    const blueSmall = variant("bs", "Azul", "S", false);
    const choices = [blueSmall, blueLarge];
    expect(chooseListingVariant(choices, undefined, "Tono", "Azul")).toBe(
      blueLarge,
    );
    expect(choices).toEqual([blueSmall, blueLarge]);
    expect(
      chooseListingVariant(choices, redSmall, "Tono", "missing"),
    ).toBeUndefined();
  });
});
