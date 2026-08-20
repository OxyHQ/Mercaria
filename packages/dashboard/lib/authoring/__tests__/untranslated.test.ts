/**
 * What the wizard renders when catalogue text has no translation (#740).
 *
 * ## Why these cases and not a render test
 *
 * The dashboard's runner has no renderer, so a screen cannot be mounted and the
 * only honest way to pin this is to keep the decision in a pure function and
 * execute it. That is also why the thirteen sites hold no conditionals of their
 * own: anything they decided themselves would be untestable here.
 *
 * The defect this replaces was not a crash. `?? field.key` renders, `tsc` is
 * happy, every build job passes, and a merchant in German reads
 * `electronics.phones.smartphones` where a product type's name goes. The cases
 * that matter are therefore about WHICH string comes back, and the two that
 * would silently re-land the bug are the blank-value case (an empty translation
 * reading as a successful one) and the `unidentifiable` branch (a category UUID
 * being marked up instead of withheld).
 *
 * Nothing here is named `label`: `validate:facet-label-copy` walls off reads of
 * `label.text` on a purely SYNTACTIC shape, and a local of that name in this
 * package fires it. The gate is right to be that blunt — the field name is its
 * whole instrument — so the collision is resolved here rather than by adding
 * this file to its allow-list.
 */

import { describe, expect, it } from "vitest";
import type { AuthoringLocalizedText } from "@mercaria/shared-types";
import { anyUntranslated, authoringLabel, UNTRANSLATED_NOTICE_KEY } from "../untranslated";

/**
 * A fake `t` that renders the KEY and its interpolation values rather than copy.
 *
 * Asserting against English sentences would make every case fail on the day
 * somebody improves the wording, and would not prove the key was interpolated
 * into the right slot. Rendering `key{values}` proves both.
 */
const translate = (key: string, options?: Record<string, unknown>): string => {
  const values = options === undefined ? "" : JSON.stringify(options);
  return `${key}${values}`;
};

const resolved = (value: string): AuthoringLocalizedText => ({
  value,
  effectiveLocale: "de",
  step: "exact",
  status: "approved",
});

const WITH_KEY = "products.wizard.untranslated.withKey";
const UNNAMED = "products.wizard.untranslated.unnamed";

describe("authoringLabel", () => {
  it("returns the translation when there is one", () => {
    const result = authoringLabel(
      resolved("Bildschirmgröße"),
      { kind: "key", key: "screen_size" },
      translate,
    );
    expect(result).toEqual({ outcome: "translated", text: "Bildschirmgröße" });
  });

  it("never renders a bare key when the text is absent", () => {
    const result = authoringLabel(undefined, { kind: "key", key: "screen_size" }, translate);
    expect(result.outcome).toBe("untranslated");
    // The key survives — six untranslated fields must stay tellable apart — but
    // only inside the affordance that says it is an identifier.
    expect(result.text).toBe(`${WITH_KEY}{"key":"\u2068screen_size\u2069"}`);
    expect(result.text).not.toBe("screen_size");
  });

  it("treats a blank translation as untranslated rather than rendering an empty label", () => {
    for (const blank of ["", "   ", "\n\t"]) {
      const result = authoringLabel(resolved(blank), { kind: "key", key: "colour" }, translate);
      expect(result.outcome).toBe("untranslated");
      expect(result.text).toBe(`${WITH_KEY}{"key":"\u2068colour\u2069"}`);
    }
  });

  it("trims a translation rather than rendering its whitespace", () => {
    const result = authoringLabel(resolved("  Farbe  "), { kind: "key", key: "colour" }, translate);
    expect(result).toEqual({ outcome: "translated", text: "Farbe" });
  });

  it("withholds the identifier entirely when only a database id exists", () => {
    const uuid = "0f3a5c1e-7b62-4d0a-9f11-2c8a4e6b0d33";
    const result = authoringLabel(undefined, { kind: "unidentifiable" }, translate);
    expect(result).toEqual({ outcome: "untranslated", text: UNNAMED });
    // The whole point of the branch: there is no property a UUID could travel on.
    expect(result.text).not.toContain(uuid);
  });

  it("falls back to the unnamed copy when the key itself is blank", () => {
    const result = authoringLabel(undefined, { kind: "key", key: "   " }, translate);
    expect(result).toEqual({ outcome: "untranslated", text: UNNAMED });
  });

  it("bidi-isolates the key, by CODE POINT", () => {
    // FSI/PDI are zero-width and default-ignorable, so a missing pair renders
    // identically to a correct one in every screenshot and diff view — the same
    // reason `validate:bidi-isolation` reads code points off the formatters.
    // Without it, `128gb` next to a neutral space and a mirrored parenthesis
    // inside an Arabic sentence has no strong `L` to anchor it.
    const result = authoringLabel(undefined, { kind: "key", key: "128gb" }, translate);
    expect(result.text).toContain("\u2068128gb\u2069");
  });

  it("does not isolate a real translation, which is already in the reader's direction", () => {
    const result = authoringLabel(resolved("Farbe"), { kind: "key", key: "colour" }, translate);
    expect(result.text).toBe("Farbe");
    expect(result.text).not.toContain("\u2068");
  });

  it("marks a controlled-value token, which is a machine token and not a word a shopper reads", () => {
    // `titanium_grey`, not "Gris titanio" — the seed carries both and the wizard
    // used to render the first when the second was missing.
    const result = authoringLabel(undefined, { kind: "key", key: "titanium_grey" }, translate);
    expect(result.text).toBe(`${WITH_KEY}{"key":"\u2068titanium_grey\u2069"}`);
  });
});

describe("anyUntranslated", () => {
  it("is false when every label resolved", () => {
    expect(
      anyUntranslated([
        { outcome: "translated", text: "Farbe" },
        { outcome: "translated", text: "Größe" },
      ]),
    ).toBe(false);
  });

  it("is true when one did not", () => {
    expect(
      anyUntranslated([
        { outcome: "translated", text: "Farbe" },
        { outcome: "untranslated", text: "x" },
      ]),
    ).toBe(true);
  });

  it("is false on an empty list, so a panel with no labels shows no notice", () => {
    expect(anyUntranslated([])).toBe(false);
  });
});

describe("the notice key", () => {
  it("is a literal the i18n validator can resolve", () => {
    expect(UNTRANSLATED_NOTICE_KEY).toBe("products.wizard.untranslated.notice");
  });
});
