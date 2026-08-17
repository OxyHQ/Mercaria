#!/usr/bin/env bun

/**
 * A `Money`'s `.amount` is INTEGER MINOR UNITS. This refuses to let one reach
 * rendered output without passing the display chokepoint.
 *
 * ## Why a guard rather than a memory
 *
 * `Money { amount, currency }` looks like a number and a label, and rendering it
 * as one is a single keystroke shorter than doing it properly:
 *
 *     <Text>{price.amount} {price.currency}</Text>
 *
 * That prints `12345 EUR` for a price of €123.45 — and because FAIR carries
 * EIGHT decimals, `100000000 FAIR` for a price of 1 FAIR, on the currency
 * Mercaria uses as its preferred default. Nothing in this repository could see
 * it: it is valid TSX, `tsc` types it as `number`, lint is happy, the app
 * renders, and the number that appears is a plausible one. Issue #441 found
 * three of these in shipped marketplace cards; a fourth was hand-rolling the
 * conversion inline and a fifth was hiding in a local `formatPrice` helper.
 *
 * `AGENTS.md` names `formatMoney`/`PriceDisplay`/`FxContext` in `@mercaria/ui`
 * the single source of truth for money display and forbids an app keeping a
 * local copy. That is the rule; this is the thing that enforces it. Routing
 * through the chokepoint is also what supplies precision (`CURRENCY_PRECISION`),
 * the symbol (`CURRENCY_SYMBOLS`) and bidi isolation (#429/#433) — so a bypass
 * loses three properties at once, and `validate-bidi-isolation.mjs` cannot see
 * it, because that guard asserts what the formatters RETURN and a bypass never
 * calls one.
 *
 * ## Scope
 *
 * All four client packages — `frontend`, `ui`, `dashboard` and `pos`. Unlike
 * `validate-rtl-logical-classes.mjs`, which excludes the dashboard and the POS
 * because their RTL migration has not happened (#398) and a gate over an
 * unmigrated tree is one whoever hits it first disables, this gate was MEASURED
 * against all four before being scoped: the dashboard and the POS produce zero
 * findings today, so including them costs nothing and narrowing to the packages
 * that happened to be broken would be a gate that reads as coverage.
 *
 * The backend is deliberately out of scope. It has a test runner, it renders no
 * JSX, and its money handling is gated by CHECK constraints and the `DualMoney`
 * contracts instead.
 *
 * ## What is matched, and what deliberately is not
 *
 * Comments are BLANKED before scanning (content replaced space-for-space, so
 * line numbers survive), because the files this gate covers describe the bug it
 * catches in prose — the three cards fixed by #441 each carry a comment naming
 * `price.amount`. A census over source that does not exclude comments reports
 * findings in the safest files in the tree.
 *
 * Three rules, each a shape a real bug took:
 *
 *   1. `raw-amount-jsx-child` — `{expr.amount}` in a JSX child position. The
 *      `=` lookbehind is what keeps `price={x.amount}` out: passing a number as
 *      a prop is ordinary, and the receiving component is where the decision
 *      lives.
 *   2. `raw-amount-template` — `${expr.amount}` inside a template literal.
 *   3. `hand-rolled-minor-units` — an `.amount` divided or multiplied by a
 *      decimal scale factor. This is the chokepoint's own arithmetic, and a
 *      second copy of it is a second answer to what a currency's precision is.
 *   4. `amount-beside-currency` — anything interpolated immediately before a
 *      `currency`-ish interpolation. This is the one that generalises: it does
 *      not read `.amount` at all, so it catches the shape after the value has
 *      been through a local, a parameter or a `.toFixed()` — which is exactly
 *      how the `families/[handle].tsx` instance escaped the first three rules.
 *
 * ## What this CANNOT see, stated rather than implied
 *
 * A `.amount` assigned to a local and rendered as a bare `{total}` several lines
 * later is invisible to rules 1–3, and rule 4 only catches it when a currency is
 * rendered beside it. Nothing here does type resolution: a field named `amount`
 * that is not money would be flagged (and belongs in `KNOWN_EXCEPTIONS` with the
 * type that proves it), and a money field named something else would not be.
 * The rules cover the shapes money-rendering bugs have actually taken in this
 * repository, not every shape one could take.
 *
 * Usage:  bun scripts/validate-money-formatting.mjs
 */

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The tree to scan. Overridable so the self-test can point the REAL guard at a
 * scratch checkout instead of asserting against a copy of its own logic.
 */
const repositoryRoot = process.env.MONEY_FORMAT_VALIDATOR_ROOT
  ? resolve(process.env.MONEY_FORMAT_VALIDATOR_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Fixture trees are a handful of files, so the real vacuity floors would fail
 * every self-test case for the wrong reason. This lowers them to 1 — it never
 * removes them, so a fixture run still catches a traversal that finds nothing.
 */
const fixtureFloors = process.env.MONEY_FORMAT_VALIDATOR_FIXTURE_FLOORS === "1";

/** Every package that renders money to a person. */
const SCANNED_PREFIXES = [
  "packages/frontend/",
  "packages/ui/",
  "packages/dashboard/",
  "packages/pos/",
];

const SOURCE_FILE = /\.(?:tsx?|jsx?)$/;

/** A member-access chain: `price`, `a.b.c`, `x?.y`, `rows[0].total`. */
const CHAIN = String.raw`[A-Za-z_$][\w$]*(?:(?:\?\.|\.)[\w$]+|\[[^\]\n]*\])*`;

/**
 * The chain plus its final `.amount`, with the accessor spelled BOTH ways.
 *
 * `?.` has to be allowed on the last hop specifically: `total?.amount` is how an
 * optional money field is read in this tree, and a matcher that only accepted
 * `.` would miss it — which is precisely a bypass reading as clean. The positive
 * control below carries that exact spelling, and caught this while it was wrong.
 */
const AMOUNT_ACCESS = String.raw`${CHAIN}(?:\?\.|\.)amount`;

/**
 * Each rule names what to do instead. `suggestion` is most of this gate's value:
 * whoever trips it should not have to go and work out which formatter applies.
 */
const RULES = [
  {
    id: "raw-amount-jsx-child",
    // Not preceded by `=` (a prop value), a word character or `$` (a template
    // interpolation, which rule 2 owns and would otherwise double-report).
    pattern: new RegExp(String.raw`(?<![=\w$])\{\s*${AMOUNT_ACCESS}\s*\}`, "g"),
    suggestion:
      "`.amount` is integer MINOR units — render it with formatMoney(money) for a native figure, "
      + "or <PriceDisplay price={money} /> to convert into the viewer's display currency",
  },
  {
    id: "raw-amount-template",
    pattern: new RegExp(String.raw`\$\{\s*${AMOUNT_ACCESS}\s*\}`, "g"),
    suggestion:
      "`.amount` is integer MINOR units — interpolate formatMoney(money) instead, "
      + "or formatSourceMoney(offerMoney) when the currency is a source's own string",
  },
  {
    id: "hand-rolled-minor-units",
    pattern: new RegExp(String.raw`(?:\?\.|\.)amount\s*[/*]\s*(?:10\s*\*\*|1e-?\d+|0\.0*1\b|\d{2,})`, "g"),
    suggestion:
      "converting minor units by hand is a second answer to CURRENCY_PRECISION — "
      + "call formatMoney/formatSourceMoney, which already read it",
  },
  {
    id: "raw-decimal-render",
    // A `.toFixed(...)` inside a JSX child or a template interpolation — i.e. a
    // decimal that reaches a reader without passing a formatter. The `[^{}\n]*`
    // spans deliberately refuse to cross a brace, so a nested template is left
    // alone rather than matched by accident.
    pattern: new RegExp(String.raw`(?<![=\w$])(\$?)\{[^{}\n]*\.toFixed\s*\([^{}\n]*\}`, "g"),
    suggestion:
      "`toFixed` always emits an ASCII `.`, which is the wrong decimal separator in eight of the "
      + "twelve shipped locales — render it through useFormatters() (formatRating, formatPercent, "
      + "formatMoney, formatDistance, formatReviewCount), which spell a numeral for the locale in force",
  },
  {
    id: "amount-beside-currency",
    pattern: new RegExp(
      String.raw`(?<![=\w$])(\$?)\{[^{}\n]*\}\s+\1\{[^{}\n]*[Cc]urrency[^{}\n]*\}`,
      "g",
    ),
    suggestion:
      "a figure rendered beside a bare currency code is what a bypass looks like — "
      + "formatMoney supplies the symbol, and formatSourceMoney supplies the `1234.00 RON` form",
  },
];

/**
 * Deliberate, reasoned survivals. Each entry excuses findings in ONE file whose
 * matched text contains `pattern`.
 *
 * The list must only SHRINK: an entry that stops matching anything FAILS the
 * run, so a bypass cannot outlive the reason it was allowed — the discipline
 * `validate-rtl-logical-classes.mjs` and `validate-no-mongo.mjs` both use. That
 * property is also this guard's standing positive control against the real tree:
 * every entry below names text that is really in it, so a rule that silently
 * stopped matching turns the run RED instead of green. It is the answer to "a
 * scan that reports clean because it read nothing looks identical to a clean
 * one" that does not decay as the tree is cleaned up, because both entries
 * describe code that is CORRECT and is meant to stay.
 *
 * ## `count` is not decoration, and it was added because a mutation got through
 *
 * An excusing entry is matched on file + rule + text, which is a PREDICATE and
 * not an identity: a SECOND bypass of the same shape in the same file satisfies
 * the same predicate and rides in behind the first, silently. Mutation M3 did
 * exactly that — re-inlining a minor-unit conversion into `price-alerts.tsx`,
 * the very file whose prefill is excused, left the guard GREEN. So each entry
 * declares how many findings it covers and the count is asserted EXACTLY: a list
 * of exemptions needs its own exact-count assertion, or it is a hole shaped like
 * whatever is already in it.
 */
const KNOWN_EXCEPTIONS = [
  {
    file: "packages/ui/src/lib/format.ts",
    pattern: "kilometres.toFixed(1)",
    rule: "raw-decimal-render",
    count: 1,
    reason:
      "`formatDistance`'s own un-localized fallback. `formatNumber` degrades to the PRE-#500 "
      + "spelling when the runtime refuses `style: \"unit\"` or the OS hands us a malformed tag, and "
      + "the whole point of the fallback is that it is the ASCII form. Excused here rather than "
      + "rewritten, because a localized fallback is a contradiction.",
  },
  {
    file: "packages/ui/src/lib/format.ts",
    pattern: "BASIS_POINTS_PER_PERCENT).toFixed(fractionDigits)",
    rule: "raw-decimal-render",
    count: 1,
    reason: "`formatPercent`'s own un-localized fallback — the entry above, one formatter over.",
  },
  {
    file: "packages/ui/src/lib/format.ts",
    pattern: "${money.currency}",
    rule: "amount-beside-currency",
    count: 1,
    reason:
      "`formatSourceMoney`'s own return. This IS the chokepoint: an OfferMoney's currency is a "
      + "source's bare string, so `1234.00 RON` is the correct rendering once CURRENCY_PRECISION "
      + "has supplied the divisor, and the function refuses with null when it has not.",
  },
  {
    file: "packages/frontend/app/(app)/price-alerts.tsx",
    pattern: ".amount / 10 **",
    rule: "hand-rolled-minor-units",
    count: 1,
    reason:
      "Prefills the target-price TextInput, so the value must stay a bare parseable number: it is "
      + "read straight back by Number(value), and formatMoney returns a symbol-prefixed string "
      + "wrapped in bidi isolates (U+2068/U+2069), which would make that NaN. It also needs the "
      + "currency's FULL precision rather than the formatter's fixed 2dp, or a FAIR target would "
      + "round away six decimals of what the buyer is editing. The DISPLAY figure beside it does "
      + "go through formatMoney (#441).",
  },
];

/** Below these, the scan is broken — and a broken scan reports a clean tree. */
const MINIMUM_SOURCE_FILES = fixtureFloors ? 1 : 250;

/**
 * VACUITY FLOOR ON THE SUBJECT, not just on the traversal.
 *
 * A file count proves files were read; it does not prove the thing being looked
 * for is present to be found. These two census counts do, and — this is the
 * point — neither can be eroded by fixing a bypass. `.amount` stays in the tree
 * in every legitimate position (arithmetic, comparisons, object literals handed
 * to a formatter), and cleaning up bypasses ADDS formatter calls rather than
 * removing them. A floor its own remedy erodes ends at `>= 0`.
 *
 * Measured at the time of writing: 39 `.amount` sightings and 82 formatter
 * sightings across the four packages. The floors sit well under both, so
 * ordinary churn does not trip them and a traversal that silently read nothing
 * — a broken `git ls-files`, a prefix that matches no path, a comment-blanker
 * that ate whole files — does.
 */
const MINIMUM_AMOUNT_SIGHTINGS = fixtureFloors ? 1 : 15;
const MINIMUM_FORMATTER_SIGHTINGS = fixtureFloors ? 1 : 20;

/** Any use of the display chokepoint, in any of its three spellings. */
const FORMATTER_SIGHTING = /\bformatMoney\s*\(|\bformatSourceMoney\s*\(|<PriceDisplay\b/g;

/** A `.amount` member access anywhere at all, in any position. */
const AMOUNT_SIGHTING = /\.amount\b/g;

/**
 * The guard cannot be its own subject: this file and its self-test both spell
 * out every bypass they exist to catch. Neither lives under a scanned prefix
 * today, so this is belt-and-braces against someone moving them.
 */
const GUARD_OWN_FILES = new Set([
  "scripts/validate-money-formatting.mjs",
  "scripts/test-validate-money-formatting.mjs",
]);

/** Every file git tracks, repo-relative — so ignored and generated files cannot count. */
function trackedFiles() {
  const listed = spawnSync("git", ["ls-files", "-z"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (listed.status !== 0) {
    throw new Error(`git ls-files failed in ${repositoryRoot}: ${listed.stderr ?? listed.error}`);
  }
  return listed.stdout.split("\0").filter(Boolean);
}

/**
 * Blank every comment, preserving every newline and every column.
 *
 * Content is replaced space-for-space rather than removed, so a finding's line
 * and the context printed beside it still line up with the file on disk. The
 * scanner is string-aware — `"https://x"` and a backticked template must not
 * open a comment — which is also why the template-literal bodies survive: rule 2
 * looks INSIDE them, so they are kept and only comments are blanked.
 */
function blankComments(text) {
  let out = "";
  let index = 0;
  // null | '"' | "'" | "`" | "//" | "/*"
  let state = null;

  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];

    if (state === null) {
      if (char === "/" && next === "/") {
        state = "//";
        out += "  ";
        index += 2;
        continue;
      }
      if (char === "/" && next === "*") {
        state = "/*";
        out += "  ";
        index += 2;
        continue;
      }
      if (char === '"' || char === "'" || char === "`") {
        state = char;
      }
      out += char;
      index += 1;
      continue;
    }

    if (state === "//") {
      if (char === "\n") {
        state = null;
        out += char;
      } else {
        out += " ";
      }
      index += 1;
      continue;
    }

    if (state === "/*") {
      if (char === "*" && next === "/") {
        state = null;
        out += "  ";
        index += 2;
        continue;
      }
      out += char === "\n" ? "\n" : " ";
      index += 1;
      continue;
    }

    // Inside a string or template literal: kept verbatim, escapes consumed in
    // pairs so a trailing `\"` cannot close it early.
    if (char === "\\") {
      out += text.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (char === state) state = null;
    out += char;
    index += 1;
  }

  return out;
}

const findings = [];
const failures = [];

/**
 * POSITIVE CONTROL.
 *
 * Every rule is run against lines KNOWN to contain what it looks for, and every
 * rule against lines known NOT to. A regex that silently stopped matching — a
 * bad escape, a lost group, an editor mangling the source — would otherwise
 * report a clean tree, which is exactly what a clean tree reports.
 *
 * The must-match samples are the REAL pre-fix source lines from the five sites
 * #441 removed, so the control asserts the rules catch the bug as it was
 * actually written rather than as it was imagined. They run before the scan and
 * on EVERY invocation, including in CI, because a control that only runs in the
 * self-test says nothing about the run that gated the merge.
 */
const CONTROL_MUST_MATCH = {
  "raw-amount-jsx-child": [
    "        {price.amount} {price.currency}",
    "          {result.price.amount} {result.price.currency}",
    "<Text>{offers.summary.lowestPrice.amount}</Text>",
    "<Text>{rows[0].total?.amount}</Text>",
  ],
  "raw-amount-template": [
    "                : `${lowestPrice.amount} ${lowestPrice.currency}`}",
    "const label = `Total ${cart.subtotal.amount}`;",
  ],
  "hand-rolled-minor-units": [
    "    suggested === undefined ? \"\" : (suggested.amount / 10 ** precision).toFixed(precision)",
    "const major = money.amount / 100;",
    "const major = money.amount / 1e8;",
    "const major = money.amount * 0.01;",
  ],
  "amount-beside-currency": [
    "    : `${amount} ${currency}`;",
    "        {price.amount} {price.currency}",
    "  return `${major.toFixed(2)} ${money.currency}`;",
  ],
  // The REAL pre-#500 lines from `ReviewSummaryCard`. The second is the one
  // worth reading: a localized review count and a raw ASCII rating in ONE
  // template literal, which is the mixed sentence #500 exists to remove — and
  // which every gate in this repository was blind to until this rule.
  "raw-decimal-render": [
    '              <Text className="text-headerBold text-text">{average.toFixed(1)}</Text>',
    "                  {`${formatReviewCount(unverified.count)} unverified · ${unverified.rating.toFixed(1)}`}",
    "        <Text>{(basis.rateBps / 100).toFixed(1)}%</Text>",
  ],
};

/**
 * Spellings that must NEVER fire. These are the legitimate shapes the four
 * packages are full of, plus the remedies this gate pushes people towards — a
 * guard that flagged its own remedy would be turned off within a day.
 */
const CONTROL_MUST_NOT_MATCH = [
  "<PriceDisplay price={{ amount: price.amount, currency: presentable }} />",
  "  return formatMoney({ amount: lowestPrice.amount, currency: presentable });",
  "        <Text>{formatMoney(result.price)}</Text>",
  "  if (delivery.cost.amount === 0) return 'Free delivery';",
  "  return a.price.amount - b.price.amount;",
  "  const total = groups.reduce((acc, g) => acc + g.subtotal.amount, 0);",
  "  Math.round((1 - product.price.amount / product.compareAtPrice.amount) * 100)",
  "        <Text>Price published in {price.currency}</Text>",
  "  const percent = Math.abs(deltaBps) / 100;",
  "  <TotalRow label=\"Subtotal\" amount={<PriceDisplay price={totals.subtotal} />} />",
  " * It used to print `price.amount` raw, which is integer MINOR units.",
  // The `raw-decimal-render` remedy, and the shapes it must leave alone. A
  // guard that flagged its own remedy would be turned off within a day; a
  // `toFixed` that is NOT on its way to a reader (a parseable prefill, an
  // intermediate value) is not this rule's business, and the brace is what
  // tells the two apart.
  "              <Text>{formatRating(average)}</Text>",
  "  const rounded = (value / 10).toFixed(2);",
  "                  {`${formatReviewCount(unverified.count)} unverified · ${formatRating(unverified.rating)}`}",
];

for (const rule of RULES) {
  for (const sample of CONTROL_MUST_MATCH[rule.id] ?? []) {
    rule.pattern.lastIndex = 0;
    if (!rule.pattern.test(sample)) {
      failures.push(
        `positive control failed: rule ${rule.id} did not match ${JSON.stringify(sample)} — `
        + "the matcher is broken, and a broken matcher reports a clean tree",
      );
    }
  }
}
for (const sample of CONTROL_MUST_NOT_MATCH) {
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(sample)) {
      failures.push(
        `negative control failed: rule ${rule.id} matched ${JSON.stringify(sample)}, which is a `
        + "legitimate money render — the matcher is too broad and would be disabled by whoever hit it",
      );
    }
  }
}

/**
 * The comment blanker is itself load-bearing and fails QUIET: one that ate a
 * whole file would remove every finding in it and report a clean tree. These
 * assert both directions on every invocation.
 */
const BLANKER_CASES = [
  {
    name: "a line comment is blanked",
    input: "const a = 1; // {price.amount}\nconst b = 2;\n",
    mustNotContain: "{price.amount}",
    mustContain: "const b = 2;",
  },
  {
    name: "a block comment is blanked and keeps its lines",
    input: "/*\n * {price.amount}\n */\nconst c = 3;\n",
    mustNotContain: "{price.amount}",
    mustContain: "const c = 3;",
  },
  {
    name: "a URL inside a string does not open a comment",
    input: 'const u = "https://x.example/a"; const d = `${p.amount}`;\n',
    mustNotContain: null,
    mustContain: "${p.amount}",
  },
  {
    name: "a template literal body survives",
    input: "const t = `${lowestPrice.amount} ${lowestPrice.currency}`;\n",
    mustNotContain: null,
    mustContain: "${lowestPrice.amount}",
  },
];

for (const testCase of BLANKER_CASES) {
  const blanked = blankComments(testCase.input);
  if (blanked.split("\n").length !== testCase.input.split("\n").length) {
    failures.push(
      `comment-blanker control failed: ${testCase.name} changed the line count — `
      + "findings would be reported against the wrong lines",
    );
  }
  if (testCase.mustNotContain !== null && blanked.includes(testCase.mustNotContain)) {
    failures.push(`comment-blanker control failed: ${testCase.name} did not blank the comment`);
  }
  if (!blanked.includes(testCase.mustContain)) {
    failures.push(
      `comment-blanker control failed: ${testCase.name} destroyed real code — `
      + "a blanker that eats code reports a clean tree",
    );
  }
}

/**
 * Read a tracked file, or record WHY it could not be read and carry on.
 *
 * `git ls-files` reports the INDEX, which can name a file the working tree does
 * not have. Reading that as a FAILURE keeps the run loud rather than ending it
 * with a stack trace and no verdict.
 */
async function readTrackedFile(path) {
  try {
    return await readFile(resolve(repositoryRoot, path), "utf8");
  } catch (error) {
    failures.push(
      `${path} is tracked by git but could not be read (${error.code ?? error.message}) — `
      + "the working tree disagrees with the index, so this scan was incomplete",
    );
    return null;
  }
}

const sources = trackedFiles().filter(
  (path) =>
    SOURCE_FILE.test(path)
    && SCANNED_PREFIXES.some((prefix) => path.startsWith(prefix))
    && !GUARD_OWN_FILES.has(path),
);

let amountSightings = 0;
let formatterSightings = 0;

for (const path of sources) {
  const raw = await readTrackedFile(path);
  if (raw === null) continue;
  const text = blankComments(raw);

  amountSightings += (text.match(AMOUNT_SIGHTING) ?? []).length;
  formatterSightings += (text.match(FORMATTER_SIGHTING) ?? []).length;

  for (const [index, line] of text.split("\n").entries()) {
    for (const rule of RULES) {
      rule.pattern.lastIndex = 0;
      for (const match of line.matchAll(rule.pattern)) {
        findings.push({
          file: path,
          line: index + 1,
          match: match[0].trim(),
          context: line.trim().slice(0, 160),
          rule: rule.id,
          suggestion: rule.suggestion,
        });
      }
    }
  }
}

// ------------------------------------------------------------- exceptions ---

/**
 * An entry must declare an integer `count` of at least 1, or the reconciliation
 * below silently compares against `undefined` and the entry reports a mismatch
 * it cannot explain. Refuses the next entry added without one (#448).
 */
for (const entry of KNOWN_EXCEPTIONS) {
  if (Number.isInteger(entry.count) && entry.count >= 1) continue;
  failures.push(
    `KNOWN_EXCEPTIONS entry "${entry.pattern}" (${entry.rule}) in ${entry.file} declares no integer `
    + `count >= 1 (got ${JSON.stringify(entry.count)}). Without one it excuses EVERY occurrence of its `
    + "shape in that file — declare exactly how many findings it covers.",
  );
}

const honoured = new Map(KNOWN_EXCEPTIONS.map((entry) => [entry, 0]));
const unexcused = findings.filter((finding) => {
  const entry = KNOWN_EXCEPTIONS.find(
    (exception) =>
      exception.file === finding.file
      && exception.rule === finding.rule
      && finding.match.includes(exception.pattern),
  );
  if (!entry) return true;
  honoured.set(entry, honoured.get(entry) + 1);
  return false;
});

for (const entry of KNOWN_EXCEPTIONS) {
  const actual = honoured.get(entry);
  if (actual === entry.count) continue;
  if (actual === 0) {
    failures.push(
      `KNOWN_EXCEPTIONS still excuses "${entry.pattern}" (${entry.rule}) in ${entry.file}, which no `
      + "longer matches anything — the count went DOWN to 0. Either the bypass was removed or the file "
      + "moved: delete the entry so the list keeps describing the tree, and so its standing positive "
      + "control keeps standing.",
    );
    continue;
  }
  if (actual < entry.count) {
    // Separate from the over-count branch on purpose (#448): reporting a
    // DECREASE with "a new bypass rode in" sends the next reader to look for
    // something that is not there, which is the failure a named direction fixes.
    failures.push(
      `KNOWN_EXCEPTIONS excuses "${entry.pattern}" (${entry.rule}) in ${entry.file} ${entry.count} `
      + `time(s), but only ${actual} matched — the count went DOWN. Part of what it excused is gone, `
      + `so the entry has stopped describing the tree: lower the count to ${actual}, or restore what `
      + "was removed.",
    );
    continue;
  }
  failures.push(
    `KNOWN_EXCEPTIONS excuses "${entry.pattern}" (${entry.rule}) in ${entry.file} ${entry.count} `
    + `time(s), but ${actual} finding(s) matched it — the count went UP. An excusing entry is a `
    + "PREDICATE, not an identity, so a NEW bypass of the same shape in the same file would otherwise "
    + "ride in behind the reasoned one. Fix the new occurrence, or raise the count with a reason "
    + "covering it too.",
  );
}

// ---------------------------------------------------------- vacuity floors ---

if (sources.length < MINIMUM_SOURCE_FILES) {
  failures.push(
    `${sources.length} source files scanned is below the ${MINIMUM_SOURCE_FILES} floor — `
    + "the file listing is probably broken, and a broken listing reports a clean tree",
  );
}

if (amountSightings < MINIMUM_AMOUNT_SIGHTINGS) {
  failures.push(
    `${amountSightings} \`.amount\` sightings is below the ${MINIMUM_AMOUNT_SIGHTINGS} floor — `
    + "this scan could not SEE the thing it exists to look for, so a clean result means nothing",
  );
}

if (formatterSightings < MINIMUM_FORMATTER_SIGHTINGS) {
  failures.push(
    `${formatterSightings} formatter sightings is below the ${MINIMUM_FORMATTER_SIGHTINGS} floor — `
    + "the scanned corpus does not contain the money-rendering surface this gate is supposed to cover",
  );
}

// ------------------------------------------------------------------ verdict ---

if (unexcused.length > 0 || failures.length > 0) {
  console.error("Money-formatting guard failed:\n");
  for (const finding of unexcused) {
    console.error(`  ${finding.file}:${finding.line}: raw money render "${finding.match}" [${finding.rule}]`);
    console.error(`    ${finding.context}`);
    console.error(`    ${finding.suggestion}\n`);
  }
  for (const failure of failures) console.error(`  ${failure}\n`);
  console.error(
    "  `Money.amount` is INTEGER MINOR UNITS. Rendering it raw prints 12345 for EUR 123.45, and\n"
    + "  100000000 for 1 FAIR — eight orders of magnitude out, on Mercaria's default currency.\n"
    + "  AGENTS.md names formatMoney/PriceDisplay/FxContext the single source of truth for money\n"
    + "  display; going through them also supplies the symbol and bidi isolation (#429).\n",
  );
  process.exit(1);
}

console.log(
  `Money-formatting guard passed — ${sources.length} source files scanned across `
  + `${SCANNED_PREFIXES.length} packages; ${RULES.length} rules positively and negatively `
  + `controlled; ${amountSightings} \`.amount\` and ${formatterSightings} formatter sightings `
  + `seen; ${KNOWN_EXCEPTIONS.length} known exceptions each matched their exact declared count `
  + `(${findings.length - unexcused.length} findings excused in total).`,
);
