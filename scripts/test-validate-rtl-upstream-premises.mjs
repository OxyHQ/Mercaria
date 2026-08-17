#!/usr/bin/env bun

/**
 * Mutation-tests `validate-rtl-upstream-premises.mjs`.
 *
 * That guard is built almost entirely out of ABSENCE claims — "React Native
 * does not mention `borderInlineStartWidth`", "the allow-list does not contain
 * `start`" — and absence is what a broken search reports. A wrong path, a
 * renamed dist layout, an extension filter that excludes the file the symbol
 * lives in, and a genuinely-absent symbol all produce the identical passing
 * answer. So the guard has to be shown FAILING, on a fixture where each thing
 * it looks for is really there.
 *
 * The two EXPIRY cases are the ones that matter most, because they are the only
 * reason the guard exists: it is a tripwire for an upstream fix that has not
 * happened yet, so nothing in the real tree will ever exercise them. If they
 * stop firing, the guard becomes a permanent green that reports nothing, and
 * fifteen physical directional utilities keep an expired justification.
 *
 * Fixtures are real directory trees pointed at by `RTL_PREMISES_MODULES_ROOT`,
 * so the guard's real walk, real extension filter and real parser all run
 * against them — no fixture-only branch inside the guard.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const validator = resolve(repositoryRoot, "scripts/validate-rtl-upstream-premises.mjs");

/** The real shape of what upstream ships today — every case starts from this. */
function healthyModules() {
  return {
    // React Native: the RN-native spellings present, the CSS logical ones not.
    "react-native/Libraries/StyleSheet/StyleSheetTypes.js":
      "export type BorderProps = { borderStartWidth?: number, borderStartColor?: string };\n",
    "react-native/Libraries/Components/View/ViewStylePropTypes.js":
      "const styles = { borderStartWidth: true, borderEndWidth: true };\n",
    // react-native-css: the allow-list, verbatim in shape.
    "react-native-css/dist/commonjs/compiler/declarations.js":
      "function parseTextAlign({\n"
      + "  value\n"
      + "}, builder) {\n"
      + '  const allowed = new Set(["auto", "left", "right", "center", "justify"]);\n'
      + "  if (allowed.has(value)) {\n"
      + "    return value;\n"
      + "  }\n"
      + '  builder.addWarning("value", value);\n'
      + "  return undefined;\n"
      + "}\n",
  };
}

async function runAgainst(files) {
  const root = await mkdtemp(join(tmpdir(), "rtl-premises-"));
  try {
    for (const [path, contents] of Object.entries(files)) {
      const full = join(root, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, contents);
    }
    const proc = Bun.spawnSync({
      cmd: ["bun", validator],
      cwd: repositoryRoot,
      env: { ...process.env, RTL_PREMISES_MODULES_ROOT: root },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: proc.exitCode,
      output: `${proc.stdout.toString()}${proc.stderr.toString()}`,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const cases = [
  {
    name: "the shape upstream ships today passes",
    files: healthyModules(),
    expectExit: 0,
    expectOutput: "Both premises behind KNOWN_EXCEPTIONS still hold",
  },

  // ── premise (a) ──────────────────────────────────────────────────────────
  {
    // THE tripwire. Nothing in the real tree can exercise this until React
    // Native ships the CSS spellings, so this case is the only thing standing
    // between "the guard would notice" and a claim nobody has tested.
    name: "premise (a) EXPIRING fires — RN registers borderInline*",
    files: {
      ...healthyModules(),
      "react-native/Libraries/StyleSheet/StyleSheetTypes.js":
        "export type BorderProps = { borderStartWidth?: number, borderInlineStartWidth?: number };\n",
    },
    expectExit: 1,
    expectOutput: "PREMISE (a) HAS EXPIRED",
  },
  {
    name: "premise (a) expiry names CONVERSION as the action, never silencing",
    files: {
      ...healthyModules(),
      "react-native/Libraries/StyleSheet/StyleSheetTypes.js":
        "export type BorderProps = { borderStartWidth?: number, borderInlineEndColor?: string };\n",
    },
    expectExit: 1,
    expectOutput: "THE ACTION IS TO CONVERT, not to silence this check",
  },
  {
    // The control has to be able to fail, or every absence below is worthless.
    name: "premise (a)'s positive control fires when the walk reads nothing",
    files: {
      ...healthyModules(),
      "react-native/Libraries/StyleSheet/StyleSheetTypes.js": "export type BorderProps = {};\n",
      "react-native/Libraries/Components/View/ViewStylePropTypes.js": "const styles = {};\n",
    },
    expectExit: 1,
    expectOutput: "Premise (a)'s positive control failed",
  },
  {
    name: "a missing react-native fails CLOSED rather than reporting absence",
    files: {
      "react-native-css/dist/commonjs/compiler/declarations.js":
        healthyModules()["react-native-css/dist/commonjs/compiler/declarations.js"],
    },
    expectExit: 1,
    expectOutput: "Premise (a) could not be measured",
  },
  {
    // The extension filter is a real way to read a comfortable zero: RN ships
    // Flow types beside its JS, and a filter that dropped them would miss a
    // spelling that only appears in a type definition.
    name: "premise (a) reads .flow files too, not only .js",
    files: {
      ...healthyModules(),
      "react-native/Libraries/StyleSheet/StyleSheetTypes.js.flow":
        "declare type S = { borderInlineStartStyle?: string };\n",
    },
    expectExit: 1,
    expectOutput: "PREMISE (a) HAS EXPIRED",
  },

  // ── premise (b) ──────────────────────────────────────────────────────────
  {
    name: "premise (b) EXPIRING fires — parseTextAlign admits start",
    files: {
      ...healthyModules(),
      "react-native-css/dist/commonjs/compiler/declarations.js":
        "function parseTextAlign({ value }, builder) {\n"
        + '  const allowed = new Set(["auto", "left", "right", "center", "justify", "start", "end"]);\n'
        + "  return allowed.has(value) ? value : undefined;\n"
        + "}\n",
      },
    expectExit: 1,
    expectOutput: "PREMISE (b) HAS EXPIRED",
  },
  {
    name: "a RENAMED parseTextAlign fails closed rather than assuming the premise holds",
    files: {
      ...healthyModules(),
      "react-native-css/dist/commonjs/compiler/declarations.js":
        "function parseTextAlignment({ value }, builder) {\n"
        + '  const allowed = new Set(["auto", "left", "right"]);\n'
        + "  return allowed.has(value) ? value : undefined;\n"
        + "}\n",
    },
    expectExit: 1,
    expectOutput: "was not found in",
  },
  {
    name: "an allow-list that parses to NOTHING fails its control, not vacuously passes",
    files: {
      ...healthyModules(),
      "react-native-css/dist/commonjs/compiler/declarations.js":
        "function parseTextAlign({ value }, builder) {\n"
        + "  const allowed = new Set([]);\n"
        + "  return allowed.has(value) ? value : undefined;\n"
        + "}\n",
    },
    expectExit: 1,
    expectOutput: "Premise (b)'s positive control failed",
  },
  {
    // Neither expiry nor the measured set. Reported rather than passed, because
    // the exception's written reason quotes this exact list.
    name: "an allow-list that MOVED without admitting start is reported, not passed",
    files: {
      ...healthyModules(),
      "react-native-css/dist/commonjs/compiler/declarations.js":
        "function parseTextAlign({ value }, builder) {\n"
        + '  const allowed = new Set(["auto", "left", "right", "center"]);\n'
        + "  return allowed.has(value) ? value : undefined;\n"
        + "}\n",
    },
    expectExit: 1,
    expectOutput: "neither the measured set nor an expiry",
  },
  {
    name: "a missing react-native-css fails CLOSED",
    files: {
      "react-native/Libraries/StyleSheet/StyleSheetTypes.js":
        healthyModules()["react-native/Libraries/StyleSheet/StyleSheetTypes.js"],
    },
    expectExit: 1,
    expectOutput: "Premise (b) could not be measured",
  },
  {
    // The bound on the body slice is load-bearing: the real file defines dozens
    // of parsers, and an unbounded search would happily read a NEIGHBOUR's
    // allow-list and report on the wrong function.
    name: "a neighbouring parser's allow-list is not read as parseTextAlign's",
    files: {
      ...healthyModules(),
      "react-native-css/dist/commonjs/compiler/declarations.js":
        "function parseTextAlign({ value }, builder) {\n"
        + '  const allowed = new Set(["auto", "left", "right", "center", "justify"]);\n'
        + "  return allowed.has(value) ? value : undefined;\n"
        + "}\n"
        + "function parseSomethingElse({ value }, builder) {\n"
        + '  const allowed = new Set(["start", "end"]);\n'
        + "  return allowed.has(value) ? value : undefined;\n"
        + "}\n",
    },
    expectExit: 0,
    expectOutput: "premise (b) holds",
  },
];

let failed = 0;
for (const testCase of cases) {
  const { exitCode, output } = await runAgainst(testCase.files);
  const problems = [];
  if (exitCode !== testCase.expectExit) {
    problems.push(`expected exit ${testCase.expectExit}, got ${exitCode}`);
  }
  if (!output.includes(testCase.expectOutput)) {
    problems.push(`expected output to contain ${JSON.stringify(testCase.expectOutput)}`);
  }
  if (problems.length > 0) {
    failed += 1;
    console.error(`FAIL  ${testCase.name}`);
    for (const problem of problems) console.error(`        ${problem}`);
    console.error(`        --- guard output ---\n${output.split("\n").map((l) => `        ${l}`).join("\n")}`);
  } else {
    console.log(`ok    ${testCase.name}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} of ${cases.length} premise-guard cases failed.`);
  process.exit(1);
}
console.log(`\nAll ${cases.length} premise-guard cases passed.`);
