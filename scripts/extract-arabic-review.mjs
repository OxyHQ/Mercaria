#!/usr/bin/env bun

/**
 * Prepares the Arabic review (#486) that a human has to do, and states what it
 * could not see.
 *
 * #434 shipped `ar.json` for `packages/dashboard` and `packages/pos`. The parity
 * gate proves every key exists with the right placeholders; it cannot tell a
 * good translation from a plausible-looking one, and no native speaker has read
 * the copy. This file turns that bundle into something a reviewer can actually
 * work through in sittings, and — more importantly — into three groups that ask
 * three DIFFERENT questions.
 *
 * ## Why the grouping is the deliverable and the list is not
 *
 * A reviewer handed 1,252 undifferentiated strings reviews the forms that EXIST.
 * Arabic selects six plural categories; these bundles carry `one` and `other`;
 * so 112 forms Arabic actually selects are absent and nothing on the page says
 * so. A `one`/`other` pair reads as reviewable and comes back approved — a false
 * clean on the plural half, and the expensive kind, because the review is the
 * artefact everybody then trusts.
 *
 * So the plural group is NOT "supply the missing forms". #486 forecloses that in
 * its own words: a bundle spelling the 3–10 form is wrong for 11–99 and no
 * single form is right for both, which is why every count-bearing plural here
 * deliberately writes the SINGULAR in both slots (the `ui.offer.days` precedent,
 * and the `дн.` trick `ru` uses). Supplying forms now would produce copy that
 * cannot be landed: #436 needs the runtime pluralizer and the parity guard to
 * move together, and either alone converts a visible wrong plural into an
 * invisible missing string. The group exists to stop those strings being
 * APPROVED.
 *
 * ## What this cannot see, stated rather than implied
 *
 * Screens are resolved in two tiers (see `resolveCallKey`), and the tier is
 * REPORTED per string rather than flattened: a `t("literal")` site is the render
 * position, while a bare key literal is the file DECLARING a key map whose use
 * site the AST cannot follow. Anything neither tier reaches is counted, never
 * rendered as zero — "found no site" and "there is no site" are otherwise the
 * same output. The i18n guard's part C independently refuses an unreferenced
 * key, so a key this file cannot place is its own blind spot rather than dead
 * copy; the gap between the bundle's key count and the placed count IS the
 * measurement, and it is currently zero for both packages.
 *
 * It deliberately does NOT import the i18n guard. That module executes on
 * import — it would run the whole gate, and a failing gate would `process.exit`
 * out of this script — so the one function worth sharing is not worth taking a
 * side-effecting import for.
 *
 * Usage:  bun scripts/extract-arabic-review.mjs [--json]
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, "..");

/** The two packages #434 shipped `ar` for, which is exactly #486's subject. */
const PACKAGES = [
  { name: "dashboard", root: "packages/dashboard", locales: "packages/dashboard/lib/i18n/locales" },
  { name: "pos", root: "packages/pos", locales: "packages/pos/lib/i18n/locales" },
];

/** The six CLDR categories Arabic selects. The bundles carry two of them. */
const ARABIC_PLURAL_CATEGORIES = ["zero", "one", "two", "few", "many", "other"];
const CLDR_CATEGORIES = new Set(ARABIC_PLURAL_CATEGORIES);

/** i18n-js interpolation. `%{…}`, never `{{…}}`. */
const PLACEHOLDER = /%\{(\w+)\}/gu;

/**
 * The twelve terms #486 names as most likely wrong, with the alternative its
 * author considered. These are the highest-value hour in the whole review: a
 * specific question with a candidate answer already written down.
 *
 * Matched against the ARABIC text, because the question is whether the chosen
 * Arabic word is right — not whether the English one appears.
 */
const DOMAIN_TERMS = [
  { term: "product feed", chosen: "خلاصة المنتجات", alternative: "موجز / تغذية" },
  { term: "variant", chosen: "متغيّر", alternative: "التكوين (the storefront's word for configuration)" },
  { term: "register (the till)", chosen: "الصندوق", alternative: "نقطة البيع (used for the channel name)" },
  { term: "tender", chosen: "طريقة الدفع", alternative: "—" },
  { term: "payouts", chosen: "التحويلات المالية", alternative: "المدفوعات (collides with payments)" },
  { term: "webhooks", chosen: "Webhooks", alternative: "خطافات الويب" },
  { term: "charge (verb)", chosen: "تحصيل", alternative: "—" },
  { term: "combination (wizard)", chosen: "تركيبة", alternative: "تكوين for a canonical configuration" },
  { term: "collection", chosen: "مجموعة", alternative: "—" },
  { term: "fulfilment", chosen: "التنفيذ", alternative: "—" },
  { term: "pickup / collection", chosen: "الاستلام", alternative: "—" },
  { term: "override (handover)", chosen: "تجاوز", alternative: "—" },
];

/** The three RTL authoring decisions #486 asks to be confirmed. */
const RTL_CHOICES = [
  {
    what: "Arrow direction is FLIPPED",
    detail: "`channels.direction.pull` reads `منصّتك ← Mercaria`. The bidi algorithm does not "
      + "mirror arrow glyphs, so in an RTL run \"forward\" is leftward. Same for the "
      + "`WooCommerce ← الإعدادات ← …` breadcrumb.",
    question: "Does the flipped arrow read as \"from Mercaria to your platform\" to a native reader?",
  },
  {
    what: "`channels.andJoin` is `\" و \"` — spaced both sides, which is NOT idiomatic",
    detail: "The waw normally attaches to the following word. It is spaced because the joined "
      + "values are raw Latin identifiers (#485).",
    question: "Is the spaced waw the right compromise beside Latin text, or worse than attaching it?",
  },
  {
    what: "Example values stay Latin, following `ru`/`ja`",
    detail: "Coupon codes, `Acme Supply Co.`, URLs and CSV column names stay Latin; names, phones "
      + "and titles are localized. The phone example `+971 50 123 4567` is an arbitrary Gulf pick.",
    question: "Is `+971` the right market to exemplify, and should the company name be localized?",
  },
];

// ------------------------------------------------------------- the bundle ---

/**
 * Every leaf of a bundle, with a plural OBJECT kept whole as ONE key.
 *
 * Keeping it whole is what lets the plural group ask its own question: split
 * into `key.one` / `key.other` the two halves look like two ordinary strings,
 * which is precisely the reading that gets them approved.
 */
function bundleLeaves(value, prefix = "", out = new Map()) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value);
    const isPlural = entries.length > 0
      && entries.every(([k, v]) => typeof v === "string" && CLDR_CATEGORIES.has(k));
    if (isPlural) {
      out.set(prefix, value);
      return out;
    }
    for (const [k, v] of entries) bundleLeaves(v, prefix ? `${prefix}.${k}` : k, out);
    return out;
  }
  out.set(prefix, value);
  return out;
}

const placeholdersOf = (value) => {
  const text = typeof value === "string" ? value : Object.values(value).join(" ");
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]))].sort();
};

// -------------------------------------------------------------- the source ---

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);
const SKIP_DIRECTORIES = new Set(["node_modules", ".expo", "dist", "build", ".git", "__tests__"]);

function sourceFiles(root) {
  const found = [];
  const walk = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".") continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) walk(full);
      } else if (SOURCE_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf(".")))) {
        found.push(full);
      }
    }
  };
  walk(root);
  return found.sort();
}

/**
 * TWO tiers, because they answer with different confidence and collapsing them
 * would overstate the weaker one.
 *
 * **`call`** — a `t("literal")` argument. This is the RENDER position, so the
 * file is where a reviewer actually sees the string.
 *
 * **`literal`** — the key appears as a bare string literal, which in this
 * codebase means a key MAP (`{ paid: "orders.status.paid" }`) rendered through
 * `t(MAP[x])` at a use site the AST cannot follow. The declaring file is
 * reported instead. That is the same evidence the i18n guard's part C accepts
 * when it refuses an unreferenced key, so a key resolving at this tier is
 * genuinely referenced and only its exact render position is unknown.
 *
 * Anything left is this file's blind spot and is COUNTED, never rendered as
 * zero — "found no site" and "there is no site" are the same output otherwise.
 */
function resolveCallKey(argument) {
  if (argument && ts.isStringLiteralLike(argument)) return argument.text;
  return null;
}

/** Is this call `t(…)`, `i18n.t(…)`, or `translate(…)`? */
function isTranslateCall(node) {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text === "t" || callee.text === "translate";
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text === "t";
  return false;
}

// ------------------------------------------------------------- the screens ---

/**
 * A file's reader-facing name.
 *
 * Under `app/` this is an expo-router ROUTE, which is what a reviewer needs to
 * find the string. Everywhere else it is a component, and the component's own
 * importers are resolved one level up so the reviewer is told which screens
 * render it — a key namespace is a filing decision, but where a string appears
 * is what decides whether the tone and the length are right.
 */
function screenNameFor(relativePath) {
  const marker = "/app/";
  const at = relativePath.indexOf(marker);
  if (at === -1) return null;
  let route = relativePath.slice(at + marker.length).replace(/\.[tj]sx?$/u, "");
  route = route
    .split("/")
    .filter((segment) => !(segment.startsWith("(") && segment.endsWith(")")))
    .join("/");
  route = route.replace(/\/?index$/u, "");
  route = route.replace(/_layout$/u, "_layout");
  return `/${route}`.replace(/\/\/+/gu, "/");
}

/** Import specifiers a file names, resolved to repo-relative paths where possible. */
function importedPaths(relativePath, text, packageRoot) {
  const sourceFile = ts.createSourceFile(
    relativePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX,
  );
  const out = [];
  for (const statement of sourceFile.statements) {
    const specifier = ts.isImportDeclaration(statement) ? statement.moduleSpecifier : null;
    if (!specifier || !ts.isStringLiteralLike(specifier)) continue;
    const raw = specifier.text;
    if (raw.startsWith("@/")) out.push(join(packageRoot, raw.slice(2)));
    else if (raw.startsWith(".")) out.push(join(dirname(relativePath), raw));
    // A bare specifier is a dependency, not a file in this package.
  }
  return out;
}

// ------------------------------------------------------------------ report ---

/**
 * The commit and the day, stated in the document.
 *
 * A reviewer meeting a different total needs to know which tree produced this
 * one — the bundles have already drifted once since #486 was written, and a pack
 * with no provenance is one nobody can tell is stale.
 */
function generatedFor() {
  const sha = Bun.spawnSync({ cmd: ["git", "rev-parse", "--short", "HEAD"], cwd: repositoryRoot })
    .stdout.toString().trim();
  const day = new Date().toISOString().slice(0, 10);
  return `${sha || "unknown commit"} on ${day}`;
}

const report = { generatedFor: generatedFor(), packages: [] };

for (const pkg of PACKAGES) {
  const localeDirectory = join(repositoryRoot, pkg.locales);
  const en = bundleLeaves(JSON.parse(readFileSync(join(localeDirectory, "en.json"), "utf8")));
  const ar = bundleLeaves(JSON.parse(readFileSync(join(localeDirectory, "ar.json"), "utf8")));

  const packageRoot = join(repositoryRoot, pkg.root);
  const files = sourceFiles(packageRoot);
  const textByPath = new Map();
  for (const absolute of files) {
    const rel = relative(repositoryRoot, absolute);
    try {
      textByPath.set(rel, readFileSync(absolute, "utf8"));
    } catch {
      /* unreadable file: counted by the floor below, never silently dropped */
    }
  }

  const callSites = new Map();
  const literalSites = new Map();
  let unreadableCalls = 0;
  const add = (bag, key, rel) => {
    if (!bag.has(key)) bag.set(key, new Set());
    bag.get(key).add(rel);
  };

  for (const [rel, text] of textByPath) {
    const sourceFile = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node) => {
      if (isTranslateCall(node)) {
        const key = resolveCallKey(node.arguments[0]);
        if (key === null) unreadableCalls += 1;
        else add(callSites, key, rel);
      }
      // Tier 2: any string literal that IS a key of this bundle. Scoped to the
      // bundle's own vocabulary rather than to a key-SHAPED pattern, so a route
      // literal or a permission name can never be mistaken for copy.
      if (ts.isStringLiteralLike(node) && ar.has(node.text)) add(literalSites, node.text, rel);
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sourceFile, visit);
  }

  // Component → the screens that import it, one level. Enough to answer "where
  // does a reviewer see this", and stated as a component when it cannot be
  // resolved rather than guessed at.
  const importersOf = new Map();
  for (const [rel, text] of textByPath) {
    for (const target of importedPaths(rel, text, pkg.root)) {
      for (const candidate of [`${target}.tsx`, `${target}.ts`, `${target}/index.tsx`, `${target}/index.ts`]) {
        if (!textByPath.has(candidate)) continue;
        if (!importersOf.has(candidate)) importersOf.set(candidate, new Set());
        importersOf.get(candidate).add(rel);
      }
    }
  }

  const screensFor = (paths) => {
    const screens = new Set();
    for (const path of paths) {
      const own = screenNameFor(path);
      if (own) { screens.add(own); continue; }
      const viaImporters = [...(importersOf.get(path) ?? [])]
        .map(screenNameFor)
        .filter(Boolean);
      if (viaImporters.length > 0) for (const s of viaImporters) screens.add(s);
      else screens.add(`(component) ${path.slice(pkg.root.length + 1)}`);
    }
    return [...screens].sort();
  };

  const groups = {
    domain: [], complete: [], plural: [], interpolated: [],
    latinByDesign: [], compositionOnly: [],
  };
  const findings = [];

  for (const [key, arValue] of ar) {
    const enValue = en.get(key);
    const viaCall = [...(callSites.get(key) ?? [])];
    const viaLiteral = [...(literalSites.get(key) ?? [])];
    const paths = viaCall.length > 0 ? viaCall : viaLiteral;
    const entry = {
      key,
      en: enValue,
      ar: arValue,
      screens: screensFor(paths),
      files: paths.map((f) => f.slice(pkg.root.length + 1)).sort(),
      siteCount: paths.length,
      // Which tier answered, so a reviewer knows whether the screen is the
      // render position or the file that declares the key map.
      resolvedBy: viaCall.length > 0 ? "call" : viaLiteral.length > 0 ? "literal" : "none",
      placeholders: placeholdersOf(arValue),
    };

    if (enValue === undefined) {
      findings.push({ kind: "key_absent_from_en", key });
      continue;
    }

    const isPlural = typeof arValue === "object";
    if (isPlural) {
      const rendersCount = placeholdersOf(arValue).includes("count");
      const missing = ARABIC_PLURAL_CATEGORIES.filter((c) => !(c in arValue));
      if (rendersCount) {
        groups.plural.push({ ...entry, missingCategories: missing });
        continue;
      }
      // A plural with NO count rendered: the singular-in-both trick cannot
      // apply, so the two forms are a genuine noun distinction and ARE
      // reviewable. #486's prose says "every plural writes the singular in
      // both", which is true of every count-bearing one and not of this.
      groups.complete.push({ ...entry, note: "plural, renders no %{count} — genuinely reviewable" });
      continue;
    }

    // A string identical in both languages is USUALLY deliberate here, not a
    // miss: #486 keeps brand names, URLs, coupon codes and `Acme Supply Co.`
    // Latin, following `ru`/`ja`. Reporting those as defects is how a list gets
    // ignored — so they are a group with their own question ("is this policy
    // right?"), and the ones with no letters at all are dropped entirely,
    // because `%{a} · %{b}` has nothing anybody could translate.
    const bare = typeof arValue === "string"
      ? arValue.replace(PLACEHOLDER, "").trim()
      : "";
    if (typeof arValue === "string" && arValue === enValue) {
      if (!/\p{L}/u.test(bare)) {
        groups.compositionOnly.push(entry);
        continue;
      }
      groups.latinByDesign.push(entry);
      continue;
    }

    if (entry.placeholders.length > 0) groups.interpolated.push(entry);
    else groups.complete.push(entry);
  }

  for (const entry of [...groups.complete, ...groups.interpolated]) {
    const text = typeof entry.ar === "string" ? entry.ar : "";
    for (const term of DOMAIN_TERMS) {
      if (term.chosen.length > 3 && text.includes(term.chosen)) {
        groups.domain.push({ term: term.term, key: entry.key, screens: entry.screens });
      }
    }
  }

  // Vacuity. Every one of these has been the failure at least once this month in
  // some other census: a walk that found nothing, a partition that silently
  // dropped a member, a filter that matched none.
  const partitioned = groups.complete.length + groups.plural.length + groups.interpolated.length
    + groups.latinByDesign.length + groups.compositionOnly.length;
  const expected = ar.size - findings.filter((f) => f.kind === "key_absent_from_en").length;
  if (partitioned !== expected) {
    throw new Error(
      `${pkg.name}: the three groups hold ${partitioned} keys but the bundle has ${expected} to `
      + "place. A key in none of them is one the reviewer is never shown, and a key in two is one "
      + "they are asked two different questions about.",
    );
  }
  if (textByPath.size < 20) {
    throw new Error(`${pkg.name}: only ${textByPath.size} source files walked — the walk is broken, `
      + "and a walk that finds nothing resolves every key to no screen");
  }
  if (ar.size === 0 || groups.plural.length === 0) {
    throw new Error(`${pkg.name}: empty bundle or no plural keys found — the leaf reader is broken, `
      + "and it would report a clean bundle with nothing in it");
  }

  report.packages.push({
    name: pkg.name,
    bundleKeys: ar.size,
    enKeys: en.size,
    filesScanned: textByPath.size,
    resolvedByCall: [...ar.keys()].filter((k) => callSites.has(k)).length,
    resolvedByLiteralOnly: [...ar.keys()].filter((k) => !callSites.has(k) && literalSites.has(k)).length,
    keysWithNoResolvedSite: [...ar.keys()].filter((k) => !callSites.has(k) && !literalSites.has(k)).length,
    unreadableCalls,
    groups,
    findings,
  });
}

/** A markdown cell: pipes and newlines would otherwise break the table. */
const cell = (value) => String(value ?? "")
  .replace(/\|/gu, "\\|")
  .replace(/\r?\n/gu, " ");

/**
 * The reviewer's document.
 *
 * The domain terms and RTL choices go FIRST and deliberately so: they are
 * specific questions with candidate answers already written down, answerable in
 * about an hour, and that is the highest-value hour available here. Twelve
 * hundred undifferentiated strings is a task somebody defers.
 */
function markdown() {
  const totals = (name) => report.packages.reduce((n, p) => n + p.groups[name].length, 0);
  const out = [];
  const push = (...lines) => out.push(...lines);

  push(
    "# Arabic review pack (#486)",
    "",
    `Generated from \`${report.generatedFor}\`. Every number below is derived; none is typed by hand.`,
    "",
    "```bash",
    "bun scripts/extract-arabic-review.mjs            # the counts",
    "bun scripts/extract-arabic-review.mjs --markdown # this document",
    "bun scripts/extract-arabic-review.mjs --json     # the same data, for tooling",
    "```",
    "",
    "**Arabic in a markdown table bidi-scrambles against the Latin key beside it.** This file is",
    "the archival, diffable copy; read the published pack instead if one was shared with you.",
    "",
    "## What you are NOT being asked",
    "",
    "Read this before anything else — three of them would otherwise waste your time or,",
    "worse, produce copy that cannot be landed.",
    "",
    "1. **You are not being asked to supply Arabic plural forms.** These bundles carry",
    "   `one` and `other`; Arabic selects six categories. The missing forms are known,",
    "   deliberate and owned by #436, which needs a runtime pluralizer and a parity-guard",
    "   change to land together. Forms written now could not be shipped. Section 3 exists",
    "   so those strings are not *approved*, not so they are filled in.",
    "2. **You are not being asked whether Arabic is ready to ship.** It is not (#429",
    "   item 2): nothing has rendered on a device or in a foregrounded tab. An approved",
    "   section 2 does not mean Arabic is done.",
    "3. **You are not being asked to review the storefront.** This pack is",
    "   `packages/dashboard` and `packages/pos` only — what #434 shipped. The storefront",
    "   and `@mercaria/ui` got Arabic under #396/#397 and are a separate review.",
    "4. **You are not being asked to edit files.** Answers go back as comments; every",
    "   change is a separate PR with its own reviewer.",
    "",
  );

  push("## The numbers, and how they were derived", "");
  push(
    "| package | keys | 1. native read | 2. plural (do not touch) | 3. interpolated |"
    + " 4. Latin by design | excluded |",
    "|---|---|---|---|---|---|---|",
  );
  for (const p of report.packages) {
    push(`| \`${p.name}\` | ${p.bundleKeys} | ${p.groups.complete.length} | `
      + `${p.groups.plural.length} | ${p.groups.interpolated.length} | `
      + `${p.groups.latinByDesign.length} | ${p.groups.compositionOnly.length} |`);
  }
  const allKeys = report.packages.reduce((n, p) => n + p.bundleKeys, 0);
  push(`| **total** | **${allKeys}** | **${totals("complete")}** | **${totals("plural")}** | `
    + `**${totals("interpolated")}** | **${totals("latinByDesign")}** | `
    + `**${totals("compositionOnly")}** |`, "");
  push(
    "**Keys** are bundle leaves with a plural object counted as ONE key, because splitting",
    "it into `key.one`/`key.other` makes the two halves look like ordinary strings — which is",
    "exactly the reading that gets them approved. The five columns partition the bundle",
    "exactly; the script throws if they do not.",
    "",
    "**#486's own figures were 1,088 and 140, from #434.** The bundles have drifted since",
    "(POS is *down* five). If you meet a different total somewhere, that is why.",
    "",
    "**Screens** come from call sites, in two tiers, reported per string:",
    "",
    "| package | resolved by `t()` call | by key literal only | unplaced |",
    "|---|---|---|---|",
  );
  for (const p of report.packages) {
    push(`| \`${p.name}\` | ${p.resolvedByCall} | ${p.resolvedByLiteralOnly} | `
      + `${p.keysWithNoResolvedSite} |`);
  }
  push(
    "",
    "A `t(\"literal\")` site is the render position. A bare key literal is the file declaring a",
    "key map whose use site the parser cannot follow — the screen shown is then where the key",
    "is *declared*. **Unplaced is zero for both packages**, which is the check that this pack",
    "is not silently short: the i18n guard independently refuses an unreferenced key, so a key",
    "this script could not place would be its own blind spot rather than dead copy.",
    "",
  );

  push(
    "## 1. Start here — twelve terms and three choices",
    "",
    "These are the highest-value hour in the pack. Each is a specific question with the",
    "alternative already considered, and each affects every screen the term appears on.",
    "",
    "### The twelve domain terms",
    "",
    "| term | chosen | alternative considered | appearances | reachable from |",
    "|---|---|---|---|---|",
  );
  for (const term of DOMAIN_TERMS) {
    const hits = report.packages.flatMap((p) => p.groups.domain.filter((d) => d.term === term.term));
    const screens = [...new Set(hits.flatMap((h) => h.screens))].sort();
    push(`| ${cell(term.term)} | ${cell(term.chosen)} | ${cell(term.alternative)} | `
      + `${hits.length} | ${screens.length === 0 ? "—" : cell(screens.slice(0, 6).join(", "))}`
      + `${screens.length > 6 ? ` +${screens.length - 6} more` : ""} |`);
  }
  push(
    "",
    "**Appearances is how many strings contain the chosen Arabic term**, so a term with a",
    "high count and a wrong word is a wide change. A count of zero means the term did not",
    "appear verbatim — it may still be there inflected, which is itself worth a look.",
    "",
    "**\"Reachable from\" is not \"appears on\".** A string rendered by a SHARED component lists",
    "every screen that mounts it — `channels.webhooks.register` lives in one file",
    "(`components/channels/channel-presentation.tsx`) that four channel screens import, so it is",
    "listed under all four. That is the useful reading: changing it changes four screens.",
    "",
    "### The three RTL authoring choices",
    "",
  );
  for (const choice of RTL_CHOICES) {
    push(`**${choice.what}**`, "", choice.detail, "", `> ${choice.question}`, "");
  }

  const sections = [
    ["2. Needs a native read", "complete",
      "The ordinary case: does this say what it means, in Arabic, on this screen. Grouped by "
      + "screen, because tone and length depend on where a string sits."],
    ["3. Plural — do NOT review or supply", "plural",
      "**Knowingly wrong for 3–10 and owned by #436.** Each writes the singular in BOTH slots "
      + "deliberately: correct for 11–99, wrong for 3–10, and no single form is right for both. "
      + "Listed only so they are not approved as correct. `missing` names the categories Arabic "
      + "selects that the bundle does not carry."],
    ["4. Interpolated — check the placeholders", "interpolated",
      "The failure here is a renamed or dropped `%{placeholder}`, not wording. **Every "
      + "placeholder must survive verbatim**; changing one breaks the render. Word ORDER around "
      + "them is free and is often what needs changing in Arabic."],
    ["5. Identical to English by design — confirm the policy", "latinByDesign",
      "Brand names, URLs, coupon codes and example values stay Latin, following `ru`/`ja`. "
      + "These are not misses. The question is whether the policy is right, and it is the same "
      + "question as RTL choice 3 above."],
  ];

  for (const [title, group, blurb] of sections) {
    push(`## ${title}`, "", blurb, "");
    for (const p of report.packages) {
      const entries = p.groups[group];
      if (entries.length === 0) continue;
      push(`### \`${p.name}\` — ${entries.length} strings`, "");
      const byScreen = new Map();
      for (const e of entries) {
        const label = e.screens.length > 0 ? e.screens.join(", ") : "(unplaced)";
        if (!byScreen.has(label)) byScreen.set(label, []);
        byScreen.get(label).push(e);
      }
      for (const [screen, list] of [...byScreen].sort((a, b) => a[0].localeCompare(b[0]))) {
        push(`<details><summary><code>${cell(screen)}</code> — ${list.length}</summary>`, "");
        const extra = group === "plural" ? " | missing |"
          : group === "interpolated" ? " | placeholders |" : "";
        push(`| key | English | Arabic${extra} file |`,
          `|---|---|---|${extra ? "---|" : ""}---|`);
        for (const e of list) {
          const ar = typeof e.ar === "string" ? e.ar
            : Object.entries(e.ar).map(([k, v]) => `**${k}:** ${v}`).join("<br>");
          const en = typeof e.en === "string" ? e.en
            : Object.entries(e.en).map(([k, v]) => `**${k}:** ${v}`).join("<br>");
          const tail = group === "plural" ? ` | ${cell(e.missingCategories.join(", "))} |`
            : group === "interpolated" ? ` | ${cell(e.placeholders.map((x) => `%{${x}}`).join(" "))} |`
            : "";
          push(`| \`${cell(e.key)}\` | ${cell(en)} | ${cell(ar)}${tail} `
            + `\`${cell(e.files[0] ?? "—")}\`${e.files.length > 1 ? ` +${e.files.length - 1}` : ""} |`);
        }
        push("", "</details>", "");
      }
    }
  }

  push(
    "## Excluded, with the reason",
    "",
    `${totals("compositionOnly")} strings are not in any section above: they contain no letters `
    + "outside their placeholders (`%{a} · %{b}`), so there is nothing anybody could translate.",
    "",
  );
  return out.join("\n");
}

if (process.argv.includes("--markdown")) {
  console.log(markdown());
} else if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  for (const pkg of report.packages) {
    const { groups: g } = pkg;
    console.log(
      `${pkg.name}: ${pkg.bundleKeys} keys (en ${pkg.enKeys}) across ${pkg.filesScanned} files\n`
      + `  group 1 needs a native read : ${g.complete.length}\n`
      + `  group 2 plural, DO NOT touch: ${g.plural.length}\n`
      + `  group 3 interpolated        : ${g.interpolated.length}\n`
      + `  group 4 Latin by design     : ${g.latinByDesign.length}\n`
      + `  excluded, no translatable   : ${g.compositionOnly.length}\n`
      + `  domain-term hits            : ${g.domain.length}\n`
      + `  resolved by t() call site   : ${pkg.resolvedByCall}\n`
      + `  resolved by key literal only: ${pkg.resolvedByLiteralOnly}\n`
      + `  keys with NO resolved site  : ${pkg.keysWithNoResolvedSite}  <- this file's blind spot\n`
      + `  t() args it could not read  : ${pkg.unreadableCalls}\n`
      + `  findings (not fixed)        : ${pkg.findings.length}`,
    );
  }
}

export { DOMAIN_TERMS, RTL_CHOICES, report };
