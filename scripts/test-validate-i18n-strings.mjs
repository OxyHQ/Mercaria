#!/usr/bin/env bun

/**
 * Mutation-tests `validate-i18n-strings.mjs`.
 *
 * A guard that has only ever been seen to pass is indistinguishable from one
 * that cannot fail, and this one fails QUIET in every direction: a TypeScript
 * AST walk that stopped descending reports a clean tree, a `git ls-files` that
 * returns nothing reports a clean tree, a prefix filter matching no path reports
 * a clean tree, and a key-parity check over a bundle it failed to parse reports
 * a clean tree. Every case below breaks exactly one thing and requires the guard
 * to fail with words that identify the right check.
 *
 * The cases that must PASS matter as much as the ones that must fail. This
 * surface is full of strings that are NOT copy — Tailwind classes, permission
 * names, route literals, query keys, provider ids — and a guard that fired on
 * any of them would be switched off by whoever hit it first.
 *
 * Fixtures are real trees with a real `git init`, so the guard's actual file
 * listing runs rather than a stand-in for it.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const validator = resolve(repositoryRoot, "scripts/validate-i18n-strings.mjs");

/**
 * Run the REAL guard against a scratch checkout.
 *
 * `realFloors` runs it with the production vacuity floors, which is the only way
 * to see those floors fire; every other case relaxes them, since a fixture tree
 * of four files would otherwise fail for a reason that has nothing to do with
 * i18n.
 */
async function runAgainst(files, { realFloors = false, removeAfterAdd = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "i18n-string-validator-"));
  try {
    for (const [path, contents] of Object.entries(files)) {
      const full = join(root, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, typeof contents === "string" ? contents : `${JSON.stringify(contents, null, 2)}\n`);
    }

    Bun.spawnSync({ cmd: ["git", "-c", "init.defaultBranch=main", "init", "-q"], cwd: root });
    Bun.spawnSync({ cmd: ["git", "add", "-A", "-f"], cwd: root });

    // Deleted AFTER `git add`, so the path stays in the index while the working
    // tree loses it — a real divergence (a half-applied checkout, an interrupted
    // rebase) and the only way to reach the unreadable-file branch.
    for (const path of removeAfterAdd) await rm(join(root, path), { force: true });

    const environment = { ...process.env, I18N_VALIDATOR_ROOT: root };
    if (!realFloors) environment.I18N_VALIDATOR_FIXTURE_FLOORS = "1";

    const proc = Bun.spawnSync({
      cmd: ["bun", validator],
      cwd: repositoryRoot,
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    });
    return { exitCode: proc.exitCode, output: `${proc.stdout.toString()}${proc.stderr.toString()}` };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const LOCALES = ["bn", "ca", "de", "es", "fr", "hi", "ja", "pt-BR", "ru", "zh-Hans"];

/** The English copy both fixture apps ship. */
const ENGLISH = {
  common: { save: "Save", cancel: "Cancel" },
  nav: { register: "Register" },
  cart: { lineCount: { one: "%{count} item", other: "%{count} items" } },
  orders: { status: { paid: "Paid" } },
  products: { searchPlaceholder: "Search products", greeting: "Hello, %{name}" },
};

/**
 * `@mercaria/ui`'s OWN copy (#437), under the reserved `ui` namespace. Every
 * leaf here is named by a literal in the fixture `packages/ui` source below —
 * that pairing is what part C checks, and it is the whole mechanism #437 added.
 */
const SHARED_UI_ENGLISH = {
  ui: {
    condition: { label: { new: "New" } },
    offer: { days: { one: "%{count} day", other: "%{count} days" } },
  },
};

/** A bundle for `locale`, with `mutate` applied to a deep copy. */
function bundle(mutate = (value) => value) {
  return mutate(structuredClone(ENGLISH));
}

/** A shared-copy bundle, with `mutate` applied to a deep copy. */
function sharedBundle(mutate = (value) => value) {
  return mutate(structuredClone(SHARED_UI_ENGLISH));
}

/**
 * An app root layout that mounts the provider (#437 check E).
 *
 * Deliberately carries the IMPORT as well as the element, because the
 * regression the check exists for is the element going and the import staying —
 * which is what a substring detector would wave straight past.
 */
function rootLayout() {
  return (
    'import { SharedUiTranslationProvider } from "@mercaria/ui";\n'
    + 'import { useTranslation } from "@/lib/i18n";\n'
    + "export default function RootLayout() {\n"
    + "  const { t } = useTranslation();\n"
    + "  return (\n"
    + "    <SharedUiTranslationProvider t={t}>\n"
    + "      <Stack />\n"
    + "    </SharedUiTranslationProvider>\n"
    + "  );\n"
    + "}\n"
  );
}

/**
 * A fully migrated pair of apps.
 *
 * Both apps carry the same bundle so a case can mutate either side without
 * having to describe two vocabularies. `packages/frontend` is present in every
 * tree and is deliberately full of hardcoded copy: it is out of scope (#396,
 * #435) and the guard must keep ignoring it.
 */
function migratedTree(extra = {}) {
  const files = {
    "packages/dashboard/app/(app)/index.tsx":
      'import { useTranslation } from "@/lib/i18n";\n'
      + "export default function Home() {\n"
      + "  const { t } = useTranslation();\n"
      + '  return <View className="flex-row gap-2 px-4">\n'
      + '    <Text>{t("nav.register")}</Text>\n'
      + '    <Text>{t("orders.status.paid")}</Text>\n'
      + '    <Text>{t("cart.lineCount", { count })}</Text>\n'
      + '    <Text>{t("products.greeting", { name })}</Text>\n'
      + '    <Input placeholder={t("products.searchPlaceholder")} />\n'
      + '    <Button title={t("common.save")} />\n'
      + '    <Button title={t("common.cancel")} />\n'
      + "  </View>;\n"
      + "}\n",
    "packages/dashboard/components/shell/nav-items.ts":
      'export const NAV = [{ key: "orders", labelKey: "nav.register", href: "/orders", permission: "orders:read" }];\n',
    "packages/pos/app/(app)/index.tsx":
      'import { useTranslation } from "@/lib/i18n";\n'
      + "export default function Register() {\n"
      + "  const { t } = useTranslation();\n"
      + '  return <View className="flex-1 bg-background">\n'
      + '    <Text>{t("nav.register")}</Text>\n'
      + '    <Text>{t("orders.status.paid")}</Text>\n'
      + '    <Text>{t("cart.lineCount", { count })}</Text>\n'
      + '    <Text>{t("products.greeting", { name })}</Text>\n'
      + '    <Input placeholder={t("products.searchPlaceholder")} keyboardType="url" />\n'
      + '    <Button title={t("common.save")} />\n'
      + '    <Button title={t("common.cancel")} />\n'
      + "  </View>;\n"
      + "}\n",
    "packages/pos/lib/queryKeys.ts":
      'export const keys = { orders: (id) => ["stores", id, "orders"] as const };\n',
    // Out of scope, and deliberately the worst offender in the tree.
    "packages/frontend/app/index.tsx":
      "export default function Storefront() {\n"
      + '  return <View><Text>Buy it now</Text><Input placeholder="Search everything" /></View>;\n'
      + "}\n",

    // #437: the shared package's own copy, its key maps, and a component that
    // resolves one of them. The second file is the must-NOT-fire case for the
    // `hardcodedStrings: false` flag — `packages/ui` is only PART way through
    // extraction, so check A must not touch it while B and C do.
    "packages/ui/src/lib/condition.ts":
      'export const CONDITION_LABEL_KEYS = { new: "ui.condition.label.new" };\n'
      + 'export const DAYS_KEY = "ui.offer.days";\n',
    "packages/ui/src/components/ConditionBadge.tsx":
      'import { CONDITION_LABEL_KEYS, DAYS_KEY } from "../lib/condition";\n'
      + 'import { useSharedUiTranslation } from "../i18n/ui-translation";\n'
      + "export function ConditionBadge({ days }) {\n"
      + "  const t = useSharedUiTranslation();\n"
      + "  return <View>\n"
      + "    <Text>{t(CONDITION_LABEL_KEYS.new)}</Text>\n"
      + "    <Text>{t(DAYS_KEY, { count: days })}</Text>\n"
      + "  </View>;\n"
      + "}\n",
    "packages/ui/src/components/NotYetExtracted.tsx":
      'export const Banner = () => <Text>Free delivery over 50</Text>;\n',

    // #437 check E: every app root mounts the provider, the storefront included.
    "packages/dashboard/app/_layout.tsx": rootLayout(),
    "packages/pos/app/_layout.tsx": rootLayout(),
    "packages/frontend/app/_layout.tsx": rootLayout(),
  };
  for (const app of ["dashboard", "pos"]) {
    files[`packages/${app}/lib/i18n/locales/en.json`] = bundle();
    for (const locale of LOCALES) files[`packages/${app}/lib/i18n/locales/${locale}.json`] = bundle();
  }
  files["packages/ui/src/i18n/locales/en.json"] = sharedBundle();
  for (const locale of LOCALES) {
    files[`packages/ui/src/i18n/locales/${locale}.json`] = sharedBundle();
  }
  return { ...files, ...extra };
}

/** A tree whose dashboard `en.json` is mutated, with every sibling kept in parity. */
function treeWithBundle(mutate, extra = {}) {
  const files = migratedTree(extra);
  files["packages/dashboard/lib/i18n/locales/en.json"] = bundle(mutate);
  for (const locale of LOCALES) {
    files[`packages/dashboard/lib/i18n/locales/${locale}.json`] = bundle(mutate);
  }
  return files;
}

const cases = [
  {
    name: "a fully extracted pair of apps passes",
    files: migratedTree(),
    expectExit: 0,
    expectOutput: "i18n string guard passed",
  },

  // ---------------------------------------------------- the mutation cases ---
  // Each reintroduces exactly ONE hardcoded string and must be caught by name.

  {
    name: "a reintroduced JSX text node fails",
    files: migratedTree({
      "packages/dashboard/app/(app)/regressed.tsx":
        "export const A = () => <Text>Save changes</Text>;\n",
    }),
    expectExit: 1,
    expectOutput: '"Save changes"',
  },
  {
    name: "a reintroduced placeholder attribute fails",
    files: migratedTree({
      "packages/pos/components/regressed.tsx":
        'export const B = () => <Input placeholder="Scan a barcode" />;\n',
    }),
    expectExit: 1,
    expectOutput: '"Scan a barcode"',
  },
  {
    name: "a reintroduced title/body pair on an empty state fails",
    files: migratedTree({
      "packages/dashboard/components/regressed.tsx":
        'export const C = () => <Empty title="No access" body="You cannot see this." />;\n',
    }),
    expectExit: 1,
    expectOutput: '"No access"',
  },
  {
    name: "a reintroduced label in module-scope data fails",
    files: migratedTree({
      "packages/dashboard/components/regressed.ts":
        'export const NAV = [{ key: "a", label: "Register", href: "/" }];\n',
    }),
    expectExit: 1,
    expectOutput: "property:label",
  },
  {
    name: "a reintroduced Alert.alert argument fails",
    files: migratedTree({
      "packages/pos/components/regressed.tsx":
        'export const D = () => Alert.alert("Deleted", "The sale is gone.");\n',
    }),
    expectExit: 1,
    expectOutput: "call:Alert.alert",
  },
  {
    name: "a reintroduced toast message fails",
    files: migratedTree({
      "packages/dashboard/components/regressed.tsx":
        'export const T = () => toast.error("Could not save the product.");\n',
    }),
    expectExit: 1,
    expectOutput: "call:toast.error",
  },
  {
    name: "a reintroduced rail tooltip fails",
    files: migratedTree({
      "packages/pos/components/regressed.tsx":
        'export const U = () => useRailTooltip("Expand sidebar");\n',
    }),
    expectExit: 1,
    expectOutput: "call:useRailTooltip",
  },
  {
    name: "a plural built by concatenating an s fails",
    files: migratedTree({
      "packages/pos/components/regressed.tsx":
        'export const E = () => <Text>{`${n} item${n === 1 ? "" : "s"} in cart`}</Text>;\n',
    }),
    expectExit: 1,
    expectOutput: "jsx-child",
  },
  {
    name: "a ternary between two English literals in a JSX child fails",
    files: migratedTree({
      "packages/dashboard/components/regressed.tsx":
        'export const F = () => <Text>{open ? "Open" : "Closed"}</Text>;\n',
    }),
    expectExit: 1,
    expectOutput: "jsx-child",
  },
  {
    name: "a key-SHAPED literal that is not a real key still fails",
    // The reason the analyser is given the app's real vocabulary rather than a
    // regex for "looks like a key": a typo renders a humanised guess of the
    // misspelling to a merchant, and a shape rule would wave it straight past.
    files: migratedTree({
      "packages/dashboard/components/regressed.ts":
        'export const NAV = [{ key: "a", label: "nav.regsiter" }];\n',
    }),
    expectExit: 1,
    expectOutput: "nav.regsiter",
  },
  {
    name: "the reported finding names the file and the line",
    files: migratedTree({
      "packages/pos/components/regressed.tsx":
        "export const G = () => (\n  <View>\n    <Text>Charge</Text>\n  </View>\n);\n",
    }),
    expectExit: 1,
    expectOutput: "packages/pos/components/regressed.tsx:3:",
  },

  // ------------------------------------------------ the must-NOT-fire cases ---

  {
    name: "Tailwind classes, routes, permissions and query keys do NOT fire",
    files: migratedTree({
      "packages/dashboard/components/identifiers.tsx":
        'export const H = () => <View className="ms-2 flex-row items-center rounded-lg border px-3" />;\n'
        + 'export const routes = { orders: "/orders", settings: "/settings/store" };\n'
        + 'export const perms = ["store:manage", "orders:read"] as const;\n'
        + 'export const q = ["stores", id, "products"] as const;\n'
        + 'export const providers = { shopify: "shopify", woocommerce: "woocommerce" };\n'
        + 'export const load = () => fetch("/api/products", { method: "POST" });\n'
        + "export const V = () => toast.error(error.message);\n",
    }),
    expectExit: 0,
    expectOutput: "i18n string guard passed",
  },
  {
    name: "the storefront is out of scope and does NOT fire (#396/#435)",
    files: migratedTree({
      "packages/frontend/components/hardcoded.tsx":
        'export const I = () => <View><Text>Add to cart</Text><Input placeholder="Search" /></View>;\n',
    }),
    expectExit: 0,
    expectOutput: "i18n string guard passed",
  },
  {
    name: "a non-source file in the scanned tree does NOT fire",
    files: migratedTree({
      "packages/dashboard/README.md": "The Save button says `Save`.\n",
      "packages/pos/global.css": '.a { content: "Charge"; }\n',
    }),
    expectExit: 0,
    expectOutput: "i18n string guard passed",
  },
  {
    name: "a pluralised key is credited to the call site that names its parent",
    // `cart.lineCount.one` / `.other` are named by nothing; `cart.lineCount` is.
    files: migratedTree(),
    expectExit: 0,
    expectOutput: "i18n string guard passed",
  },

  // ------------------------------------------------------- B: bundle parity ---

  {
    name: "a key missing from a sibling bundle fails",
    files: (() => {
      const files = migratedTree();
      files["packages/dashboard/lib/i18n/locales/de.json"] = bundle((value) => {
        delete value.orders.status.paid;
        return value;
      });
      return files;
    })(),
    expectExit: 1,
    expectOutput: 'missing key "orders.status.paid"',
  },
  {
    name: "a key that exists only in a sibling bundle fails",
    files: (() => {
      const files = migratedTree();
      files["packages/pos/lib/i18n/locales/es.json"] = bundle((value) => {
        value.orders.status.refunded = "Reembolsado";
        return value;
      });
      return files;
    })(),
    expectExit: 1,
    expectOutput: 'does not exist in en.json',
  },
  {
    name: "a renamed placeholder fails",
    files: (() => {
      const files = migratedTree();
      files["packages/dashboard/lib/i18n/locales/fr.json"] = bundle((value) => {
        value.products.greeting = "Bonjour, %{nom}";
        return value;
      });
      return files;
    })(),
    expectExit: 1,
    expectOutput: "carries placeholders",
  },
  {
    name: "a bundle leaf that is not a string fails",
    files: treeWithBundle((value) => {
      value.common.save = ["Save"];
      return value;
    }),
    expectExit: 1,
    expectOutput: "is an array",
  },
  {
    name: "a bundle that is not valid JSON fails",
    files: migratedTree({
      "packages/pos/lib/i18n/locales/ru.json": "{ not json\n",
    }),
    expectExit: 1,
    expectOutput: "not valid JSON",
  },

  // ------------------------------------------- C: referential integrity ------

  {
    name: "a t() call naming a key that does not exist fails",
    files: migratedTree({
      "packages/dashboard/components/regressed.tsx":
        'export const J = () => <Text>{t("orders.status.doesNotExist")}</Text>;\n',
    }),
    expectExit: 1,
    expectOutput: "names no key in",
  },
  {
    name: "a key nothing references fails — the label-map regression",
    // The shape a reviewer would not catch: the map goes back to English, the
    // JSX still renders, and the key it used to name is now dead.
    files: (() => {
      const files = migratedTree();
      files["packages/dashboard/app/(app)/index.tsx"] = files[
        "packages/dashboard/app/(app)/index.tsx"
      ].replace('<Text>{t("orders.status.paid")}</Text>', "<Text>{STATUS.paid}</Text>");
      files["packages/pos/app/(app)/index.tsx"] = files["packages/pos/app/(app)/index.tsx"].replace(
        '<Text>{t("orders.status.paid")}</Text>',
        "<Text>{STATUS.paid}</Text>",
      );
      return files;
    })(),
    expectExit: 1,
    expectOutput: '"orders.status.paid" is named by no string literal',
  },

  // ------------------------------------- #437: the shared package's own copy ---

  {
    name: "@mercaria/ui's own copy put back on English fails — the #437 regression",
    // The exact shape #437 exists for: the map goes back to a sentence, every
    // app screen around it is still fully extracted, tsc and lint are happy,
    // and a merchant reading German sees an English paragraph. Part C is what
    // sees it, because the key it used to name is now referenced by nothing.
    files: (() => {
      const files = migratedTree();
      files["packages/ui/src/lib/condition.ts"] = files["packages/ui/src/lib/condition.ts"]
        .replace('new: "ui.condition.label.new"', 'new: "New"');
      return files;
    })(),
    expectExit: 1,
    expectOutput: '"ui.condition.label.new" is named by no string literal in packages/ui',
  },
  {
    name: "a shared sentence missing from one locale fails",
    files: (() => {
      const files = migratedTree();
      files["packages/ui/src/i18n/locales/de.json"] = sharedBundle((value) => {
        delete value.ui.condition.label.new;
        return value;
      });
      return files;
    })(),
    expectExit: 1,
    expectOutput: 'missing key "ui.condition.label.new"',
  },
  {
    name: "packages/ui's UNextracted prose does NOT fire check A",
    // The flag that lets B and C run over a package check A cannot police yet.
    // Without it every existing English string in @mercaria/ui fails the build
    // on the day #437 lands, which is the version of this gate nobody keeps.
    files: migratedTree({
      "packages/ui/src/components/StillEnglish.tsx":
        'export const S = () => <Empty title="Nothing here" body="Try another filter." />;\n',
    }),
    expectExit: 0,
    expectOutput: "i18n string guard passed",
  },
  {
    name: "an app bundle claiming the reserved `ui` namespace fails",
    files: (() => {
      const files = migratedTree();
      files["packages/dashboard/lib/i18n/locales/en.json"] = bundle((value) => {
        value.ui = { somethingElse: "Hello" };
        return value;
      });
      for (const locale of LOCALES) {
        files[`packages/dashboard/lib/i18n/locales/${locale}.json`] = bundle((value) => {
          value.ui = { somethingElse: "Hello" };
          return value;
        });
      }
      return files;
    })(),
    expectExit: 1,
    expectOutput: 'has a top-level "ui" key, which is reserved',
  },
  {
    name: "the STOREFRONT's bundle claiming the namespace fails, though it is out of scope for A",
    // Check D covers every app: it is about the merge, not about copy, so the
    // storefront's un-migrated screens are no reason to skip it.
    files: migratedTree({
      "packages/frontend/lib/i18n/locales/en.json": { common: { save: "Save" }, ui: { x: "y" } },
    }),
    expectExit: 1,
    expectOutput: "packages/frontend/lib/i18n/locales/en.json: has a top-level \"ui\" key",
  },
  {
    name: "a shared bundle with a key outside the reserved namespace fails",
    files: (() => {
      const files = migratedTree();
      files["packages/ui/src/i18n/locales/en.json"] = sharedBundle((value) => {
        value.loose = { key: "Escaped the namespace" };
        return value;
      });
      return files;
    })(),
    expectExit: 1,
    expectOutput: 'only top-level key must be "ui"',
  },
  {
    name: "an app root that stops mounting the provider fails, import intact",
    // The regression a substring check cannot see, and the one that actually
    // happens: somebody refactors the tree and the element goes while the
    // import stays. Every shared sentence then falls back to English silently.
    files: (() => {
      const files = migratedTree();
      files["packages/pos/app/_layout.tsx"] = rootLayout()
        .replace("    <SharedUiTranslationProvider t={t}>\n", "")
        .replace("    </SharedUiTranslationProvider>\n", "");
      return files;
    })(),
    expectExit: 1,
    expectOutput: "packages/pos/app/_layout.tsx: does not mount <SharedUiTranslationProvider>",
  },
  {
    name: "a NEW app is covered by D and E without editing the guard",
    // Both populations are derived from the tracked listing. A hand list would
    // report this tree clean — and "found fewer roots" reads exactly like
    // "there are fewer roots".
    files: migratedTree({
      "packages/kiosk/app/_layout.tsx":
        "export default function RootLayout() { return <Stack />; }\n",
    }),
    expectExit: 1,
    expectOutput: "packages/kiosk/app/_layout.tsx: does not mount <SharedUiTranslationProvider>",
  },

  // ------------------------------------------------------ the meta failures ---

  {
    name: "the guard carries no exception list to go stale",
    // Asserted on the SOURCE rather than by a fixture: the design decision is
    // that there is nothing to excuse, so the failure to catch is somebody
    // adding a list back and quietly excusing a screen.
    guardSourceMustNotContain: ["KNOWN_EXCEPTIONS"],
    files: migratedTree(),
    expectExit: 0,
    expectOutput: "i18n string guard passed",
  },
  {
    name: "a broken file listing cannot pass silently (vacuity floors)",
    files: migratedTree(),
    realFloors: true,
    expectExit: 1,
    expectOutput: "below the 60 floor",
  },
  {
    name: "a missing en.json is a loud failure",
    files: (() => {
      const files = migratedTree();
      delete files["packages/pos/lib/i18n/locales/en.json"];
      return files;
    })(),
    expectExit: 1,
    expectOutput: "is missing",
  },
  {
    name: "a tracked file the working tree lost is a loud failure, not a stack trace",
    files: migratedTree({
      "packages/dashboard/components/vanished.tsx":
        'export const K = () => <Text>{t("common.save")}</Text>;\n',
    }),
    removeAfterAdd: ["packages/dashboard/components/vanished.tsx"],
    expectExit: 1,
    expectOutput: "could not be read",
  },
];

/**
 * The guard's own positive/negative controls run on every invocation, so they
 * are already exercised by every case above. This asserts the SOURCE still
 * carries them — a control that got deleted would otherwise leave every case
 * green, since none of them depends on the controls existing.
 */
async function assertGuardSource() {
  const source = await readFile(validator, "utf8");
  const required = [
    "CONTROL_MUST_FIND",
    "CONTROL_MUST_NOT_FIND",
    // #437's own detector has its own pair, and its negative half is the one
    // that matters: it is what stops `mountsSharedUiProvider` degrading into a
    // substring match that an import alone satisfies.
    "PROVIDER_CONTROL_MOUNTED",
    "PROVIDER_CONTROL_NOT_MOUNTED",
    "positive control failed",
    "negative control failed",
  ];
  const missing = required.filter((token) => !source.includes(token));
  if (missing.length > 0) {
    return `guard source no longer carries ${missing.join(", ")} — its self-controls were removed`;
  }
  return null;
}

let failed = 0;

for (const testCase of cases) {
  const { exitCode, output } = await runAgainst(testCase.files, {
    realFloors: testCase.realFloors,
    removeAfterAdd: testCase.removeAfterAdd,
  });

  const problems = [];
  if (exitCode !== testCase.expectExit) {
    problems.push(`expected exit ${testCase.expectExit}, got ${exitCode}`);
  }
  if (!output.includes(testCase.expectOutput)) {
    problems.push(`expected output to contain ${JSON.stringify(testCase.expectOutput)}`);
  }
  for (const token of testCase.guardSourceMustNotContain ?? []) {
    if ((await readFile(validator, "utf8")).includes(token)) {
      problems.push(`the guard source still carries ${token}`);
    }
  }

  if (problems.length > 0) {
    failed += 1;
    console.error(`FAIL  ${testCase.name}`);
    for (const problem of problems) console.error(`        ${problem}`);
    console.error(`        --- guard output ---\n${output.replace(/^/gm, "        ")}`);
  } else {
    console.log(`ok    ${testCase.name}`);
  }
}

const sourceProblem = await assertGuardSource();
if (sourceProblem) {
  failed += 1;
  console.error(`FAIL  the guard keeps its own controls\n        ${sourceProblem}`);
} else {
  console.log("ok    the guard keeps its own controls");
}

if (failed > 0) {
  console.error(`\n${failed} of ${cases.length + 1} guard cases failed.`);
  process.exit(1);
}

console.log(`\nAll ${cases.length + 1} guard cases passed.`);
