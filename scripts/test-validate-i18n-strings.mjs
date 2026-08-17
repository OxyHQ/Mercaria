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

/**
 * What each app ships beside `en`.
 *
 * The storefront ships TWELVE locales and the other two eleven: it is the app
 * that ships `ar` (#396) and mirrors its layout for it (#397), while the
 * dashboard and the POS wait on #434. That asymmetry is real, and the fixture
 * carries it rather than giving all three the same list — check B's per-app
 * locale floor is the thing that notices an app's siblings going missing, and a
 * fixture where every app ships the same set could never see it get one wrong.
 */
const APP_LOCALES = {
  frontend: [...LOCALES, "ar"],
  dashboard: LOCALES,
  pos: LOCALES,
};

/** The English copy all three fixture apps ship. */
const ENGLISH = {
  common: { save: "Save", cancel: "Cancel" },
  nav: { register: "Register" },
  cart: { lineCount: { one: "%{count} item", other: "%{count} items" } },
  // `channel.pos` exists so check F's interpolated population has a key of its
  // own. Reusing `status.paid` gave it a second reference and silently disarmed
  // the unreferenced-key case below, which is the regression part C exists for.
  orders: { status: { paid: "Paid" }, channel: { pos: "Point of sale" } },
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
 * A fully migrated set of all three apps.
 *
 * They carry the same bundle so a case can mutate any one side without having
 * to describe three vocabularies. `packages/frontend` is one of them now: #435
 * finished the extraction #396 started and converged the storefront onto the
 * shared registry, so check A scans it exactly as it scans the other two and a
 * hardcoded string there fails the build. It used to sit in this tree as the
 * deliberate worst offender, asserting the guard ignored it.
 *
 * Every app screen here names every key the bundle defines, because part C
 * refuses an UNREFERENCED key — an app whose fixture screen named only some of
 * them would fail every case for a reason no case is about.
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
      // A t()-into-t() interpolation whose key is NOT a control label. Check F
      // intersects two populations, so a fixture with an empty one would trip
      // F's own vacuity floor in every case that uses this tree.
      + '    <Text>{t("products.greeting", { name: t("orders.channel.pos") })}</Text>\n'
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
      // A t()-into-t() interpolation whose key is NOT a control label. Check F
      // intersects two populations, so a fixture with an empty one would trip
      // F's own vacuity floor in every case that uses this tree.
      + '    <Text>{t("products.greeting", { name: t("orders.channel.pos") })}</Text>\n'
      + '    <Input placeholder={t("products.searchPlaceholder")} keyboardType="url" />\n'
      + '    <Button title={t("common.save")} />\n'
      + '    <Button title={t("common.cancel")} />\n'
      + "  </View>;\n"
      + "}\n",
    "packages/pos/lib/queryKeys.ts":
      'export const keys = { orders: (id) => ["stores", id, "orders"] as const };\n',
    // In scope since #435, and migrated like the two above it.
    "packages/frontend/app/index.tsx":
      'import { useTranslation } from "@/lib/i18n";\n'
      + "export default function Storefront() {\n"
      + "  const { t } = useTranslation();\n"
      + '  return <View className="flex-1 gap-3 px-4">\n'
      + '    <Text>{t("nav.register")}</Text>\n'
      + '    <Text>{t("orders.status.paid")}</Text>\n'
      + '    <Text>{t("cart.lineCount", { count })}</Text>\n'
      + '    <Text>{t("products.greeting", { name })}</Text>\n'
      // A t()-into-t() interpolation whose key is NOT a control label. Check F
      // intersects two populations, so a fixture with an empty one would trip
      // F's own vacuity floor in every case that uses this tree.
      + '    <Text>{t("products.greeting", { name: t("orders.channel.pos") })}</Text>\n'
      + '    <Input placeholder={t("products.searchPlaceholder")} />\n'
      + '    <Button title={t("common.save")} />\n'
      + '    <Button title={t("common.cancel")} />\n'
      + "  </View>;\n"
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
  for (const [app, locales] of Object.entries(APP_LOCALES)) {
    files[`packages/${app}/lib/i18n/locales/en.json`] = bundle();
    for (const locale of locales) files[`packages/${app}/lib/i18n/locales/${locale}.json`] = bundle();
  }
  // The shared package IS the registry's home, so it ships the UNION and can
  // never be behind an app — including the storefront's `ar`. Before #435 no
  // app in this fixture shipped one, so eleven here was merely incomplete;
  // beside a twelve-locale storefront it would be a tree no deployment can have.
  files["packages/ui/src/i18n/locales/en.json"] = sharedBundle();
  for (const locale of APP_LOCALES.frontend) {
    files[`packages/ui/src/i18n/locales/${locale}.json`] = sharedBundle();
  }
  return { ...files, ...extra };
}

/** A tree whose dashboard `en.json` is mutated, with every sibling kept in parity. */
function treeWithBundle(mutate, extra = {}) {
  const files = migratedTree(extra);
  files["packages/dashboard/lib/i18n/locales/en.json"] = bundle(mutate);
  for (const locale of APP_LOCALES.dashboard) {
    files[`packages/dashboard/lib/i18n/locales/${locale}.json`] = bundle(mutate);
  }
  return files;
}

const cases = [
  {
    name: "a fully extracted set of three apps passes",
    files: migratedTree(),
    expectExit: 0,
    expectOutput: "i18n string guard passed",
  },

  // ---------------------------------------------------- the mutation cases ---
  // Each reintroduces exactly ONE hardcoded string and must be caught by name.

  {
    // F, the class #442 belongs to. The fixture reuses `common.cancel`, which
    // `migratedTree` already renders as a <Button> label, as the value of an
    // interpolation — the shape that produced "…happens to the keep products
    // this channel imported".
    name: "an action label interpolated into a sentence fails (F)",
    files: migratedTree({
      "packages/dashboard/app/(app)/regressed.tsx":
        'import { useTranslation } from "@/lib/i18n";\n'
        + "export const A = () => {\n"
        + "  const { t } = useTranslation();\n"
        + '  return <Text>{t("products.greeting", { name: t("common.cancel").toLowerCase() })}</Text>;\n'
        + "};\n",
    }),
    expectExit: 1,
    expectOutput: "is BOTH an action control's label and a value interpolated into a sentence",
  },
  {
    // The negative half, and the one that decides whether F is worth having: a
    // key that is only ever a sentence value must not fire just because some
    // OTHER key is a button label.
    name: "a key interpolated but never used as a control label passes (F)",
    files: migratedTree({
      "packages/dashboard/app/(app)/fine.tsx":
        'import { useTranslation } from "@/lib/i18n";\n'
        + "export const A = () => {\n"
        + "  const { t } = useTranslation();\n"
        + '  return <Text>{t("products.greeting", { name: t("orders.status.paid") })}</Text>;\n'
        + "};\n",
    }),
    expectExit: 0,
    expectOutput: "i18n string guard passed",
  },
  {
    // F's populations are its vacuity floor, and this is the case that proves
    // the floor can fire: real floors against a tree whose apps render no
    // action control at all.
    name: "a tree too small for check F's populations says so, naming F",
    files: migratedTree(),
    realFloors: true,
    expectExit: 1,
    // Named rather than a bare "below the": with the production floors this
    // fixture trips several, and a substring any of them would satisfy would
    // pass whether or not F's own floor exists.
    expectOutput: "check F saw",
  },
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
    // The mutation test for the widening itself, and this case is where it
    // lives: it was the must-NOT-fire proof that check A ignored
    // `packages/frontend`, and it is now the must-fire proof that it does not.
    // Inverted rather than deleted — a deleted case leaves nothing asserting
    // either direction, and "the storefront is scanned" would then rest on the
    // OWNERS entry alone, which is exactly the kind of claim a prefix matching
    // nothing satisfies silently.
    name: "the storefront IS in scope and DOES fire (#435)",
    files: migratedTree({
      "packages/frontend/components/hardcoded.tsx":
        'export const I = () => <View><Text>Add to cart</Text><Input placeholder="Search" /></View>;\n',
    }),
    expectExit: 1,
    // The file and the string in ONE substring, so the case cannot be satisfied
    // by a finding in some other file happening to sit beside the right text.
    expectOutput: 'packages/frontend/components/hardcoded.tsx:1: hardcoded user-facing string '
      + '[jsx-text]\n    "Add to cart"',
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
      for (const locale of APP_LOCALES.dashboard) {
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
    name: "the STOREFRONT's bundle claiming the namespace fails too — D covers every app",
    // Check D is about the MERGE rather than about copy, so it covers every app
    // that owns a bundle, and this case says so from a third app.
    //
    // The fixture keeps the storefront's bundle otherwise INTACT, in all twelve
    // locales, and names the added key from its screen. The earlier version
    // replaced the whole of `en.json` with a two-key object, which was harmless
    // while the storefront was unscanned and now trips parity against eleven
    // siblings AND part C — so the case would go red for a compound reason
    // while claiming exactly one, and would keep passing if check D were
    // deleted outright.
    files: (() => {
      const files = migratedTree();
      const claimNamespace = (value) => {
        value.ui = { somethingElse: "Hello" };
        return value;
      };
      files["packages/frontend/lib/i18n/locales/en.json"] = bundle(claimNamespace);
      for (const locale of APP_LOCALES.frontend) {
        files[`packages/frontend/lib/i18n/locales/${locale}.json`] = bundle(claimNamespace);
      }
      files["packages/frontend/app/index.tsx"] = files["packages/frontend/app/index.tsx"].replace(
        '<Text>{t("nav.register")}</Text>',
        '<Text>{t("nav.register")}</Text>\n    <Text>{t("ui.somethingElse")}</Text>',
      );
      return files;
    })(),
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
    // #528. `hardcodedStrings: false` discarded an owner's check-A findings with
    // nothing recording how many there were, so a stalled conversion, a
    // progressing one and a regressing one produced identical silence. Asserted
    // on the SOURCE, like the exception-list case above and for the same reason:
    // the failure to catch is somebody restoring the boolean, and no fixture
    // tree can see a decision that was made in the config.
    name: "no owner disables check A outright — a mid-extraction owner pins a COUNT",
    guardSourceMustNotContain: ["hardcodedStrings: false"],
    files: migratedTree(),
    expectExit: 0,
    expectOutput: "i18n string guard passed",
  },
  {
    // The pin is skipped on a fixture tree (`fixtureFloors`), so this is the
    // only configuration in which it runs here — and it proves it RUNS and
    // COMPARES rather than being carried inertly. It fires in the DOWN
    // direction because this fixture holds one unextracted `packages/ui` string
    // against a pin measured on the real tree; the real tree is what exercises
    // agreement, on every invocation of the guard proper.
    name: "a mid-extraction owner's pinned hardcoded count is compared, not carried",
    files: migratedTree(),
    realFloors: true,
    expectExit: 1,
    expectOutput: "hardcoded user-facing string(s), expected exactly",
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
  {
    // I (#542). Through the REAL guard on a REAL file listing rather than only
    // through the in-process controls, because the two can come apart: the
    // controls call `analyseSource` directly, and the population it fires on is
    // assembled by the caller.
    name: "a key map rendered without t() fails — the #542 regression",
    files: migratedTree({
      "packages/dashboard/lib/status-labels.ts":
        'export const STATUS_KEYS = { paid: "orders.status.paid" };\n',
      "packages/dashboard/app/(app)/keys.tsx":
        'import { STATUS_KEYS } from "@/lib/status-labels";\n'
        + "export const S = ({ order }) => <Text>{STATUS_KEYS[order.status]}</Text>;\n",
    }),
    expectExit: 1,
    expectOutput: "renders a TRANSLATION KEY, not a sentence",
  },
  {
    // The other half, and the one that decides whether this check survives its
    // first month: a key in FLIGHT to a `t()` is not a rendered key. All four
    // legitimate shapes at once — returned, held in a record, bound to a const,
    // and tested for presence — because the rule keyed on "a read outside `t(`"
    // fires on every one of them and reports 33 findings on the real tree.
    name: "a key legitimately in flight to t() does NOT fire check I",
    files: migratedTree({
      "packages/dashboard/lib/status-labels.ts":
        'export const STATUS_KEYS = { paid: "orders.status.paid" };\n'
        + "export function statusKey(s) { return STATUS_KEYS[s]; }\n"
        + 'export const ROWS = [{ key: "paid", labelKey: STATUS_KEYS.paid }];\n',
      "packages/dashboard/app/(app)/keys.tsx":
        'import { STATUS_KEYS } from "@/lib/status-labels";\n'
        + "export const A = ({ order }) => {\n"
        + "  const copy = STATUS_KEYS[order.status];\n"
        + "  return <Text>{t(copy)}</Text>;\n"
        + "};\n"
        + "export const B = ({ order }) => "
        + "<Text>{STATUS_KEYS[order.status] ? t(STATUS_KEYS[order.status]) : null}</Text>;\n",
    }),
    expectExit: 0,
    expectOutput: "i18n string guard passed",
  },
  {
    // J (#530). The pin is skipped on a fixture tree, so `realFloors` is the
    // only configuration in which it runs here — and this proves it RUNS and
    // COMPARES rather than being carried inertly, the `hardcodedStrings` case
    // above applied to the other pin. It fires in the DOWN direction because
    // this fixture holds none of the real sites the pins were measured on.
    name: "check J's pinned wire-identifier count is compared, not carried",
    files: migratedTree(),
    realFloors: true,
    expectExit: 1,
    expectOutput: "wire identifier(s) rendered raw to a reader, expected exactly",
  },
  {
    // I's vacuity floor, same technique and same reason. A fixture tree carries
    // none of the real key maps, so under production floors it must say so —
    // if this stops firing, the floor has been turned into a comment.
    name: "check I's key-map floor fires when the population is tiny",
    files: migratedTree(),
    realFloors: true,
    expectExit: 1,
    expectOutput: "renderable key map(s), below the",
  },
  {
    // J's negative half, through the real guard: the two field names measured
    // OUT of the list. Both are identifiers shown verbatim on purpose, both sit
    // beside real defects in the live tree, and a version of this check that
    // fired on them would have four false positives out of seventeen.
    //
    // Asserted as a COUNT under `realFloors`, not as a passing run, and the
    // difference is what makes this case exist at all. The first spelling of it
    // expected exit 0 on a fixture tree — where J's pin is SKIPPED, exactly as
    // H's is — so nothing compared J's findings and swapping `{code.code}` for
    // `{code.status}` changed the result not at all. It measured nothing and
    // read as coverage. Pinning the count instead asserts BOTH directions in one
    // case: the real defect below counts, and the two verbatim spellings beside
    // it do not.
    name: "check J counts a wire enum and NOT a verbatim code or currency",
    files: migratedTree({
      "packages/dashboard/app/(app)/codes.tsx":
        "export const A = ({ code, price, order }) => <View>\n"
        + "  <Text>{code.code}</Text>\n"
        + "  <Text>{price.currency}</Text>\n"
        + "  <Text>{code.label}</Text>\n"
        + "  <Text>{order.status}</Text>\n"
        + "</View>;\n",
    }),
    realFloors: true,
    expectExit: 1,
    expectOutput: "packages/dashboard: 1 wire identifier(s) rendered raw to a reader",
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

/**
 * Check F, mutation-tested against the REAL repository rather than a fixture.
 *
 * Every case above builds a tiny tree that exists to be caught. That proves the
 * detector works on source shaped the way the fixture author imagined it; it
 * does not prove F would have caught #442, which lived in a 1,100-line screen
 * where the label record is declared 80 lines below its use and the value went
 * through `.toLowerCase()`. So this puts the real defect back into the real file
 * and requires the real guard to go red naming the real key.
 *
 * The mutation is asserted to have APPLIED (a replace whose pattern no longer
 * matches writes the file back unchanged, and a guard that then passes reads
 * exactly like one that cannot fail), and the restore is asserted against a
 * marker from this edit rather than against a checksum of the copy.
 */
async function assertCheckFCatchesTheRealDefect() {
  const target = resolve(
    repositoryRoot, "packages/dashboard/app/(app)/channels/[connectionId].tsx",
  );
  const FIXED = '{t("channels.disconnect.intro")}';
  const REGRESSED = '{t("channels.disconnect.intro", {\n'
    + "            policy: t(DISCONNECT_POLICY_LABEL_KEYS[policy]).toLowerCase(),\n"
    + "          })}";

  const original = await readFile(target, "utf8");
  // Measure the premise before relying on it: if the screen no longer spells the
  // fixed form, this test would "pass" by mutating nothing.
  if (!original.includes(FIXED)) {
    return `${target} does not contain ${FIXED} — the premise of this mutation is gone, `
      + "so a green run here would mean nothing";
  }

  try {
    await writeFile(target, original.replace(FIXED, REGRESSED));
    const mutated = await readFile(target, "utf8");
    if (mutated === original) return "the mutation did not apply — the file is byte-identical";
    if (!mutated.includes("DISCONNECT_POLICY_LABEL_KEYS[policy]).toLowerCase()")) {
      return "the mutation applied but does not carry #442's shape";
    }

    const proc = Bun.spawnSync({
      cmd: ["bun", validator],
      cwd: repositoryRoot,
      env: { ...process.env, I18N_VALIDATOR_ROOT: repositoryRoot },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = `${proc.stdout.toString()}${proc.stderr.toString()}`;
    if (proc.exitCode === 0) {
      return "check F did not fail on #442's own defect, reintroduced into its own file";
    }
    for (const expected of [
      "channels.disconnect.policy.keepListings",
      "is BOTH an action control's label and a value interpolated into a sentence",
      "ToggleGroupItem",
    ]) {
      if (!output.includes(expected)) {
        return `the guard failed but never mentioned ${JSON.stringify(expected)} — `
          + "it went red for some other reason";
      }
    }
  } finally {
    await writeFile(target, original);
  }

  const restored = await readFile(target, "utf8");
  if (restored !== original) return "the file was NOT restored byte-for-byte";
  if (!restored.includes(FIXED) || restored.includes(REGRESSED)) {
    return "the restore left the mutation behind";
  }
  // The restore is only proven by the guard going green again: a file that was
  // rewritten wrongly would still differ from `original` in ways this test's own
  // string comparison happens to miss.
  const after = Bun.spawnSync({
    cmd: ["bun", validator],
    cwd: repositoryRoot,
    env: { ...process.env, I18N_VALIDATOR_ROOT: repositoryRoot },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (after.exitCode !== 0) {
    return "the guard is still red after the restore — the working tree was left mutated";
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

const realTreeProblem = await assertCheckFCatchesTheRealDefect();
if (realTreeProblem) {
  failed += 1;
  console.error(`FAIL  check F catches #442 in the real tree\n        ${realTreeProblem}`);
} else {
  console.log("ok    check F catches #442 in the real tree");
}

if (failed > 0) {
  console.error(`\n${failed} of ${cases.length + 2} guard cases failed.`);
  process.exit(1);
}

console.log(`\nAll ${cases.length + 2} guard cases passed.`);
