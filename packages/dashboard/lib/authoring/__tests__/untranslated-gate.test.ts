/**
 * No authoring surface may terminate a localization fallback in an identifier (#740).
 *
 * ## Why a gate and not thirteen fixed lines
 *
 * `?? field.key` is what the wizard did at THIRTEEN sites, and the issue that
 * reported it named six. That gap is the whole argument for this file: a fix
 * that covers the sites somebody listed, in a package where the pattern is one
 * keystroke and reads as diligence, re-lands the moment a fourteenth surface is
 * written. Nothing else in CI can see it — the JSX is valid, `tsc` is happy,
 * every build job passes, and the defect is a German-speaking merchant reading
 * `electronics.phones.smartphones` where a name goes.
 * `validate:i18n-strings` cannot cover it either: that guards the apps' own
 * `t()` bundles, and this is server-composed CATALOGUE text.
 *
 * ## The population is DERIVED
 *
 * Not a hand-written list of directories, which would omit exactly the new file
 * this exists for. The tree is walked, and a file is in scope when it names one
 * of the DTOs that can carry an `AuthoringLocalizedText` — so a surface added
 * next month is covered on the day it holds one.
 *
 * ## What "measured nothing" would look like
 *
 * A walk that found no files, a scope that matched none of them, or a detector
 * that fires on nothing all produce a green test. The floors below turn each of
 * those into a failure, and `the detector fires on the code this replaced` is
 * the mutation self-test: it runs the real detector over the real pre-fix line
 * and fails the build if it comes back clean.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.resolve(__dirname, "../../..");

/** Directories with no source of ours in them. */
const SKIP = new Set(["node_modules", ".expo", "dist", "build", ".git", "android", "ios"]);

/**
 * Tests are OUT of the population, and deliberately.
 *
 * The gate measures what a merchant can be shown, and a fixture is not a render
 * — including this file's own, which quote the pre-fix lines verbatim so the
 * mutation self-test has something real to fire on. Left in, the gate's first
 * red would be itself, and the obvious remedy is to weaken the detector. The
 * floors below are what stop the exclusion emptying the population.
 */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP.has(entry.name) || entry.name === "__tests__") continue;
      out.push(...walk(path.join(dir, entry.name)));
      continue;
    }
    if (!/\.tsx?$/u.test(entry.name)) continue;
    if (/\.test\.tsx?$/u.test(entry.name)) continue;
    out.push(path.join(dir, entry.name));
  }
  return out;
}

/** Comments are stripped: a module documenting the pattern it refuses is not a violation. */
function stripComments(source: string): string {
  let out = "";
  let index = 0;
  let state: "code" | "line" | "block" = "code";
  while (index < source.length) {
    const two = source.slice(index, index + 2);
    if (state === "code") {
      if (two === "//") {
        state = "line";
        index += 2;
        continue;
      }
      if (two === "/*") {
        state = "block";
        index += 2;
        continue;
      }
      out += source[index];
      index += 1;
      continue;
    }
    if (state === "line") {
      if (source[index] === "\n") {
        state = "code";
        out += "\n";
      }
      index += 1;
      continue;
    }
    if (two === "*/") {
      state = "code";
      index += 2;
      continue;
    }
    out += source[index] === "\n" ? "\n" : " ";
    index += 1;
  }
  return out;
}

/** A file that can HOLD localized catalogue text. Derived, never enumerated. */
const CARRIER_TYPES =
  /\b(AuthoringSchema|AuthoringLocalizedText|AuthoringSchemaText|AuthoringFieldText|AuthoringCategoryOption|AuthoringProductTypeOption)\b/u;

/**
 * A localized `.value` read whose fallback is something else.
 *
 * ABSENCE is a legitimate fallback and is allowed by name: `null` renders no
 * help line, `""` renders no placeholder, and neither claims to be a name.
 * Anything else — a key, a token, a UUID, a hand-written string — is the defect.
 */
const VALUE_FALLBACK = /\?\.value\s*\?\?\s*(?<fallback>[^;,)\]}\n]+)/gu;
const PERMITTED_FALLBACK = /^(?:null|undefined|""|''|``)\s*$/u;

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly fallback: string;
}

function scan(relativePath: string, source: string): Violation[] {
  if (!CARRIER_TYPES.test(source)) return [];
  const found: Violation[] = [];
  stripComments(source)
    .split("\n")
    .forEach((line, index) => {
      for (const match of line.matchAll(VALUE_FALLBACK)) {
        const fallback = (match.groups?.fallback ?? "").trim();
        if (PERMITTED_FALLBACK.test(fallback)) continue;
        found.push({ file: relativePath, line: index + 1, fallback });
      }
    });
  return found;
}

const sources = walk(PACKAGE_ROOT).map((absolute) => ({
  relative: path.relative(PACKAGE_ROOT, absolute),
  text: readFileSync(absolute, "utf8"),
}));
const inScope = sources.filter((entry) => CARRIER_TYPES.test(entry.text));

describe("the localization fallback gate", () => {
  it("walked a real tree", () => {
    // A rename or a moved test file could point PACKAGE_ROOT at nothing; then
    // every assertion below passes over an empty set.
    expect(sources.length).toBeGreaterThan(50);
  });

  it("found the surfaces that hold localized catalogue text", () => {
    expect(inScope.length).toBeGreaterThanOrEqual(6);
    // Named explicitly: if the scope rule stops matching these, it is matching
    // nothing that matters and the floor above would not notice.
    for (const expected of [
      path.join("components", "catalog-authoring", "SchemaField.tsx"),
      path.join("components", "catalog-authoring", "ReviewPanel.tsx"),
      path.join("components", "catalog-authoring", "VariantAxes.tsx"),
    ]) {
      expect(inScope.map((entry) => entry.relative)).toContain(expected);
    }
  });

  it("fires on the code it replaced", () => {
    // The mutation self-test. These are the two lines #740 cited, verbatim.
    const before = [
      "interface X { s: AuthoringSchema }",
      "const subtitle = schema.text.productTypeName?.value ?? schema.productType.key;",
      "const categoryName = schema.text.categoryName?.value ?? draft.categoryId;",
    ].join("\n");
    const fired = scan("before.tsx", before);
    expect(fired.map((violation) => violation.fallback)).toEqual([
      "schema.productType.key",
      "draft.categoryId",
    ]);
  });

  it("does not fire on absence, which is an honest fallback", () => {
    const source = [
      "interface X { s: AuthoringSchema }",
      "const help = text?.help?.value ?? null;",
      'const placeholder = text?.placeholder?.value ?? "";',
    ].join("\n");
    expect(scan("ok.tsx", source)).toEqual([]);
  });

  it("does not fire on a module that holds no localized text", () => {
    expect(scan("unrelated.ts", "const a = row?.value ?? 0;")).toEqual([]);
  });

  it("finds no surface rendering an identifier where a name goes", () => {
    const violations = inScope.flatMap((entry) => scan(entry.relative, entry.text));
    expect(
      violations.map((violation) => `${violation.file}:${violation.line} ?? ${violation.fallback}`),
    ).toEqual([]);
  });
});
