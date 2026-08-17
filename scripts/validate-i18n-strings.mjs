#!/usr/bin/env bun

/**
 * The dashboard, the POS and the storefront must stay translated (#398, #435).
 *
 * ## Why a guard rather than a memory
 *
 * Extracting a surface's strings is a one-time act; keeping it extracted is a
 * standing requirement, and the way it gets undone is one `<Text>Save</Text>` at
 * a time in unrelated PRs. Every one of those is invisible to everything else in
 * CI: the JSX is valid, `tsc` is happy, lint is happy and every build job passes.
 * The merchant whose device is in German just sees one English word, and nobody
 * finds out until somebody reads that screen in German.
 *
 * The second failure it exists for is quieter still. `i18n-js` runs with
 * `enableFallback` on, so a key missing from `de.json` silently renders the
 * ENGLISH string, and a key missing from EVERY bundle renders `missingBehavior:
 * 'guess'` — a humanised spelling of the key, which in review looks like a
 * translation somebody wrote. Both look correct. Neither is.
 *
 * ## What it checks
 *
 *   A. NO HARDCODED USER-FACING STRING in the migrated surface — JSX text, a
 *      string in a JSX child expression, a user-facing JSX attribute, a
 *      user-facing object property, or an argument to one of a short NAMED list
 *      of calls that carry copy through a plain function (`Alert.alert`,
 *      `toast.*`, `useRailTooltip`).
 *
 *   B. BUNDLE PARITY — every non-`en` bundle has exactly `en`'s key set (missing
 *      AND extra), and every value carries exactly `en`'s `%{placeholders}`. A
 *      missing key falls back to English and looks fine; a renamed placeholder
 *      renders the literal `%{count}` to a merchant. PLURAL keys are exempt from
 *      the key-set half and handed to K — see there.
 *
 *   K. PLURAL SHAPE (#436) — a plural key's categories are a fact about the
 *      LOCALE, not about English, so parity is the wrong invariant for them the
 *      moment the pluralizer stops being English-shaped. See "What K replaced"
 *      below.
 *
 *   C. REFERENTIAL INTEGRITY — every `t('literal')` names a key that exists in
 *      that app's `en.json`, and every key in `en.json` is named by some string
 *      literal in that app's source.
 *
 *   D. THE RESERVED NAMESPACE (#437) — `@mercaria/ui` ships its OWN copy, which
 *      `mergeSharedUiCopy` merges into every app's i18n instance under the
 *      top-level key `ui`. So every shared bundle's only top-level key is `ui`,
 *      and no APP bundle may have one. Both lists are derived from the tracked
 *      file listing rather than written out here, so a fourth app is covered on
 *      the day it appears.
 *
 *   E. THE PROVIDER IS MOUNTED (#437) — every app's root layout mounts
 *      `<SharedUiTranslationProvider>`. Without it a shared component silently
 *      resolves against `@mercaria/ui`'s own English, which is what shipped
 *      before #437 and is therefore invisible in review.
 *
 *   F. AN ACTION LABEL IS NOT A SENTENCE FRAGMENT (#442) — a key rendered as the
 *      text of an action CONTROL must not also be interpolated into a translated
 *      sentence. See "What F is for" below.
 *
 * ## What K replaced, and why relaxing B was not enough
 *
 * B used to require every sibling bundle to carry EXACTLY `en`'s key set. That
 * was correct while `i18n-js`'s English-shaped default pluralizer was the only
 * one registered, and #436 made it wrong in both directions at once:
 *
 *   * a Russian bundle carrying `few`/`many` — which Russian genuinely has and
 *     English does not — would fail B as an "extra" key;
 *   * a Russian bundle carrying only `one`/`other` AFTER the pluralizer landed
 *     would pass B and render NOTHING at count 5. `i18n-js`'s
 *     `helpers/pluralize.ts` walks the category list and, on a miss, returns
 *     `missingTranslation` — it does NOT fall back to English the way an
 *     ordinary missing key does.
 *
 * So dropping the extra-key half is not the fix: it would convert a visible
 * wrong plural into an invisible missing string, which is the trap #436 names.
 * What replaces it is an invariant stated against the LOCALE:
 *
 *   1. the sibling still has the key, and it is still a plural object;
 *   2. every category it carries is one the runtime can actually SELECT for
 *      that locale — so a `few` in a German bundle is dead copy, and a typo'd
 *      `oher` is caught by the same clause;
 *   3. it carries `other`, the terminal rung of the chain;
 *   4. it carries every category English uses that is ALSO selectable there —
 *      which is what stops a Russian bundle quietly losing `one`, and what
 *      "non-empty" alone would have permitted;
 *   5. every form's placeholders match English's, compared against `en`'s
 *      `other` because a `many` form has no English twin to compare with.
 *
 * The permitted set in 2 and the runtime's chain come from ONE module,
 * `packages/ui/src/i18n/plurals.ts`, imported here rather than restated. Two
 * spellings of "which categories does Russian have" is exactly the drift that
 * would let this guard pass a bundle the app cannot render, and the control
 * below runs the REAL chain over a count sweep to prove the two still agree.
 *
 * ## What K does NOT do
 *
 * It does not require a locale to carry every category CLDR gives it. Arabic is
 * missing four and Russian two, and writing those forms is grammar in six
 * languages that nobody here can review — #436 leaves it to native speakers.
 * They are counted instead, and pinned EXACTLY per owner, so the residual can
 * be paid down but cannot silently grow. `pluralCategoryResidual` is that pin;
 * `pluralUnreachableForms` is its mirror for copy that exists and can never be
 * selected.
 *
 * ## What C buys that A cannot
 *
 * A decides only the positions it can decide from the syntax. It cannot see a
 * plain map of status labels — `{ paid: 'Paid', shipped: 'Shipped' }` — because
 * the property names there are statuses, not user-facing prop names, and a
 * detector loose enough to catch it would fire on every Tailwind class and
 * permission string in the tree.
 *
 * The migrated code stores KEYS in those maps (`{ paid: 'orders.status.paid' }`)
 * and calls `t()` at the use site. So writing English back into one leaves
 * `orders.status.paid` referenced by nothing, and C fails naming it. That is the
 * mutation this guard was tested on, and it is why C refuses UNUSED keys rather
 * than only missing ones.
 *
 * ## Scope
 *
 * Check A runs over all three apps — `packages/frontend`, `packages/dashboard`
 * and `packages/pos`. The storefront joined them in #435, which finished the
 * extraction #396 had started and converged it onto the shared registry. Until
 * then it was deliberately excluded, because a gate over a half-migrated tree
 * is one whoever hits it first disables.
 *
 * `packages/ui` is scanned by B and C and deliberately NOT by A, for exactly
 * that reason one package over: #437 converted the condition and offer-label
 * copy and the rest of the package's component prose is still English. What B
 * and C buy there is the whole point of #437 — a shared sentence exists in
 * twelve languages and stays referenced — and neither of them needs the package
 * to be finished first. Widening A to `packages/ui` is the residual on #437.
 *
 * D and E cover every app the tracked listing turns up, extracted or not: they
 * are about the PLUMBING (a reserved namespace, a mounted provider) rather than
 * about copy, so an unmigrated tree has nothing to be excused from — which is
 * what makes a fourth app covered on the day it appears.
 *
 * ## What F is for
 *
 * #442: `channels.disconnect.intro` read "Choose what happens to the %{policy}
 * this channel imported", and `%{policy}` was filled with the lowercased text of
 * the toggle the merchant had just pressed. The three toggles say "Keep
 * products", "Unpublish" and "Archive", so the three renderings were "…happens
 * to the keep products this channel imported", "…to the unpublish…", "…to the
 * archive…".
 *
 * Nothing else in CI can see that. The string is extracted, the key resolves,
 * part B's parity passes, part C finds both keys referenced, `tsc` and lint are
 * happy — and the sentence is ungrammatical in all eleven languages, because an
 * action label is an IMPERATIVE ("Produkte behalten", "商品を残す", "Оставить
 * товары") and a sentence slot needs a TERM. It survived a full eleven-locale
 * translation pass: five translators worked around it with an appositive rather
 * than reporting it, so the bug outlived the one review that looked hardest at
 * the copy.
 *
 * So F states the rule structurally: a key whose text is rendered as an action
 * control's own label may not also be interpolated into a translated sentence.
 * The remedy when it fires is to give the sentence its OWN key — the same remedy
 * the no-exception-list note below describes, and the reason F needs no
 * exception list either.
 *
 * What F deliberately does NOT cover, and why: a key rendered in a BADGE or a
 * row (`orders.status.paid` -> "Paid") is a term, not an imperative, and reads
 * correctly in the appositive frames this surface actually uses
 * (`'%{when} · %{status}'`). Flagging those would push somebody to split a key
 * for no gain, and a guard whose cheapest green is busywork is one that gets
 * switched off. `Pressable` is likewise NOT an action control here: 86 of them
 * wrap whole tappable list rows, so every sentence inside one would read as a
 * label. The proxy is "an element whose entire content IS its label".
 *
 * Its blind spots are real and are COUNTED rather than assumed away — a key
 * reached through a local alias (`s.labelKey`) or returned by a function is
 * unresolvable to a syntactic guard, and F reports how many it could not read
 * instead of letting them look like zero.
 *
 * Usage:  bun scripts/validate-i18n-strings.mjs
 */

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The REAL runtime module, imported and RUN rather than described — the
// `validate-logical-side.mjs` idiom, and the only thing that makes check K's
// permitted set the same fact as the pluralizer's chain. `plurals.ts` is
// importable from a bare script precisely because it imports nothing a bundler
// has to resolve; its sibling `create-app-i18n.ts` needs `expo-localization`
// and could not be pulled in here, which is why the registration seam and the
// chain live in separate files.
import {
  cldrCardinalCategories,
  pluralCategoryChain,
  selectablePluralCategories,
} from "../packages/ui/src/i18n/plurals.ts";
import { SUPPORTED_LOCALES } from "../packages/ui/src/i18n/locales.ts";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The tree to scan. Overridable so the self-test can point the REAL guard at a
 * scratch checkout instead of asserting against a copy of its own logic.
 */
const repositoryRoot = process.env.I18N_VALIDATOR_ROOT
  ? resolve(process.env.I18N_VALIDATOR_ROOT)
  : resolve(here, "..");

/**
 * Fixture trees are a handful of files and a handful of keys, so the real floors
 * would fail every self-test case for the wrong reason. This lowers them to 1 —
 * it never removes them, so a fixture run still catches a traversal that found
 * nothing.
 */
const fixtureFloors = process.env.I18N_VALIDATOR_FIXTURE_FLOORS === "1";

// Resolved from THIS repository rather than from the tree being scanned, so a
// fixture root with no node_modules of its own still parses.
const ts = createRequire(resolve(here, "../package.json"))("typescript");

/**
 * Everything that OWNS a bundle set.
 *
 * `hardcodedStrings` is what separates a migrated app from a package that is
 * only PART way through, and it takes two forms:
 *
 *   `true`  — every check-A finding is a FAILURE, reported with its file, line
 *             and the string itself. What a finished app is held to.
 *   `<n>`   — the owner is mid-extraction. Findings are not failures, but their
 *             COUNT is pinned at exactly `<n>` and BOTH directions fail. What a
 *             package on its way to `true` is held to.
 *
 * `packages/ui` is the second: it is scanned for literals (part C needs them)
 * and its findings are not raised, because most of that package's component
 * prose is still English and a gate over it would be switched off by whoever hit
 * it. It is a real distinction, not a special case — the next package to start
 * extracting joins the list with a pinned count, ratchets it down, and turns it
 * to `true` in the change that finishes.
 *
 * It was a bare `false` until #528, which is the state the pin replaces: the
 * findings were discarded with nothing recording how many there were, so
 * "the conversion is progressing", "it has stalled" and "somebody added two
 * hundred new hardcoded strings" produced the identical silence. A count that
 * fails only when it RISES would still permit the second; H's
 * `deviceLocaleFormatSites` is the model, and it fails in both directions for
 * the same reason.
 */
const OWNERS = [
  {
    name: "frontend",
    prefix: "packages/frontend/",
    locales: "packages/frontend/lib/i18n/locales",
    hardcodedStrings: true,
    actionLabelCopy: true,
    // Measured on the tree that joined this list (#435b): 194 source files,
    // 1,330 translated positions, 1,019 keys. Floored well below each, because
    // what a floor has to catch is a traversal that found NOTHING — a prefix
    // that matches no file reports a clean tree — and a floor set just under
    // the measurement fails the next PR that deletes a screen.
    minimumSourceFiles: 120,
    minimumTranslatedPositions: 900,
    minimumKeys: 700,
    // Check F's two INPUT populations. Measured: 55 and 36, with 3 key maps
    // F could not read. Every module-scope key map in the storefront is declared
    // and THEN frozen for that reason — `Object.freeze({ … })` is a call
    // expression, which `collectKeyMaps` cannot read, so an inline-frozen map is
    // one F silently does not check for the #442 property it exists to enforce.
    minimumControlLabelKeys: 25,
    minimumInterpolatedKeys: 8,
    // TWELVE, not eleven: this is the app that ships `ar` (#396) and mirrors its
    // layout for it (#397). The dashboard and the POS wait on #434.
    minimumLocales: 12,
    // H (#488): every date on the storefront now names the app's locale. ZERO is
    // an exact count, so a reintroduced bare `toLocaleDateString()` fails here
    // rather than waiting for somebody to notice an English date in a Japanese
    // sentence.
    deviceLocaleFormatSites: 0,
    // J (#530): four, pinned rather than fixed — `{order.status}` twice on the
    // guest-order screens, `{entry.status}` and `{code.status}` beside the
    // `{code.code}` that is correct four lines above it.
    wireIdentifierRenderSites: 4,
    // I (#542): no pin. Check I RAISES, because a key map read in a render
    // position is a message id on screen with no legitimate spelling.
    minimumRenderableKeyMaps: 40,
    // K (#436). Both EXACT, both fail in both directions.
    // Missing category forms: ar 68 (zero/two/few/many x17), ru 34, ca/es/fr/pt-BR 17 each.
    pluralCategoryResidual: 170,
    // The ja and zh-Hans `one` forms — those locales select only `other`.
    pluralUnreachableForms: 34,
    minimumPluralKeys: 10,
  },
  {
    name: "dashboard",
    prefix: "packages/dashboard/",
    locales: "packages/dashboard/lib/i18n/locales",
    hardcodedStrings: true,
    actionLabelCopy: true,
    // Per-owner rather than one total: a traversal that broke for one of them
    // would otherwise hide behind another's count.
    minimumSourceFiles: 60,
    minimumTranslatedPositions: 300,
    minimumKeys: 300,
    // Check F's two INPUT populations. Its output is an intersection, and an
    // empty intersection is the passing answer — so the only way to tell "no
    // key is used in both roles" from "the walk read nothing" is to floor each
    // input. Measured on this tree: 96 and 28.
    minimumControlLabelKeys: 40,
    minimumInterpolatedKeys: 10,
    // Part B compares every sibling bundle against `en`, so with the siblings
    // gone it compares nothing and reports clean. Eleven of the registry's
    // twelve locales; `ar` waits on the layout mirroring (#434).
    minimumLocales: 11,
    // H (#488): ZERO, as of #529. Every date on this app now names the app's
    // locale, so a reintroduced bare `toLocaleDateString()` fails here rather
    // than waiting for a merchant to notice an English date in a German
    // sentence.
    deviceLocaleFormatSites: 0,
    // J (#530): eight, pinned rather than fixed — the channel and feed screens
    // render `{run.kind}`, `{run.status}`, `{version.status}` and `{report.mode}`
    // straight out of the wire, and `{a.country}` on the order address card is
    // the SAME shape #513 fixed on the storefront with `formatRegionName`.
    wireIdentifierRenderSites: 8,
    minimumRenderableKeyMaps: 40,
    // K (#436). Both EXACT, both fail in both directions.
    // Missing category forms: ar 92, ru 46, ca/es/fr/pt-BR 23 each.
    pluralCategoryResidual: 230,
    // The ja and zh-Hans `one` forms — those locales select only `other`.
    pluralUnreachableForms: 46,
    minimumPluralKeys: 15,
  },
  {
    name: "pos",
    prefix: "packages/pos/",
    locales: "packages/pos/lib/i18n/locales",
    hardcodedStrings: true,
    actionLabelCopy: true,
    minimumSourceFiles: 30,
    minimumTranslatedPositions: 60,
    minimumKeys: 60,
    minimumLocales: 11,
    // Measured: 8 and 11.
    minimumControlLabelKeys: 4,
    minimumInterpolatedKeys: 4,
    // H (#488): ZERO, as of #529 — see the dashboard owner's note above.
    deviceLocaleFormatSites: 0,
    // J (#530): ZERO. The POS renders no wire enum raw, so this owner is a pure
    // regression gate — which is also what makes it the one that would go
    // quietly wrong if the detector broke, hence the controls.
    wireIdentifierRenderSites: 0,
    minimumRenderableKeyMaps: 30,
    // K (#436). Both EXACT, both fail in both directions.
    // Missing category forms: ar 20, ru 10, ca/es/fr/pt-BR 5 each.
    pluralCategoryResidual: 50,
    // The ja and zh-Hans `one` forms — those locales select only `other`.
    pluralUnreachableForms: 10,
    minimumPluralKeys: 3,
  },
  {
    name: "ui",
    prefix: "packages/ui/",
    locales: "packages/ui/src/i18n/locales",
    // Measured at 2cf4889d, which is #534's merge — that PR took six sentences
    // out of `commercial-copy.ts` and the pin came down from 156 with it. #437's
    // last three maps then took it 150 -> 149: only ONE, because check A counts
    // strings RENDERED in JSX and those maps are module scope — the single
    // inline template in `NearbyLocationCard` was the one in this population. It
    // is MEANT to move: every conversion lowers it, the guard says so by name,
    // and a PR that converts copy without lowering it is told exactly what to
    // do. That is the pin working, not a maintenance burden.
    hardcodedStrings: 149,
    // Check F is off here for a DIFFERENT reason than check A. This package
    // does not merely use the action controls, it DEFINES them — a `<Button>`
    // in `packages/ui` is the component, not a call site — so the population F
    // reads is not the one it reasons about. The apps are where a label and a
    // sentence meet. It turns on here in the same change that widens A.
    actionLabelCopy: false,
    minimumControlLabelKeys: null,
    minimumInterpolatedKeys: null,
    minimumSourceFiles: 50,
    // No translated-position floor, deliberately. `inspectUserFacing` credits
    // any value it cannot follow to a literal as "translated", and in a package
    // that is mostly UNextracted that count would be large, stable and
    // meaningless — a floor whose passing says nothing is worse than none,
    // because it reads as coverage. The floors that bite here are the source
    // file count above and the key count below, and the check that actually
    // catches a map put back on English is C.
    minimumTranslatedPositions: null,
    // Measured 432 leaves on `main` at fe72ef26; floored well below at 300, the
    // ratio the frontend owner's note above justifies (700 against 1,019) and
    // for its reason: a floor has to catch a traversal that found NOTHING, and
    // one set just under the measurement fails the next PR that consolidates two
    // keys into one.
    //
    // It read 51 until #528 — the count of leaves #437 originally landed, i.e.
    // 100% of the population on the day it was written and 11.8% by the time
    // three conversion PRs had taken the bundle to 432. That is the failure this
    // number now demonstrates rather than merely describes: **a floor is a
    // measurement that rots in the GREEN direction**, silently, because the tree
    // grows underneath it. Unlike the `hardcodedStrings` pin four lines up, which
    // fails LOUDLY in both directions and so re-derives itself, nothing about a
    // stale floor announces itself — which is why this one sat at 19.7% and then
    // 11.8% with every build green. Re-derive it whenever this bundle grows
    // substantially; the extraction still owed (149 strings) will move it again.
    //
    // All twelve registry locales: this package IS the registry's home, so it can
    // never be behind an app — and that it has one bundle per `SupportedLocale`
    // is enforced where it belongs, by `SHARED_UI_COPY` being a `Record` rather
    // than a `Partial<Record>`, which `bun run --filter @mercaria/ui typecheck`
    // decides.
    minimumKeys: 300,
    minimumLocales: 12,
    // H (#488): ZERO, as of #529. `formatDate` lives in THIS package, so the
    // four shared-component sites #488 left were an import away; they now take
    // the locale from `useSharedUiLocale()`, which is the same value the apps
    // feed the provider. All four owners are at zero, so H is now a pure
    // regression gate rather than a residual ledger.
    deviceLocaleFormatSites: 0,
    // J (#530): one — `ComparisonExplanationBlock` names the provenance provider
    // inside a hardcoded English sentence, which is a check-A finding too and is
    // already inside the 149 above.
    wireIdentifierRenderSites: 1,
    // I (#542): this package DECLARES the maps every app reads, and #542 was
    // found converting three of them, so the floor here is the one that matters.
    minimumRenderableKeyMaps: 40,
    // K (#436). Both EXACT, both fail in both directions.
    // Missing category forms: ar 28, ru 14, ca/es/fr/pt-BR 7 each.
    pluralCategoryResidual: 70,
    // The ja and zh-Hans `one` forms — those locales select only `other`.
    pluralUnreachableForms: 14,
    minimumPluralKeys: 4,
  },
];

/** The reserved top-level key `mergeSharedUiCopy` merges shared copy under. */
const SHARED_UI_NAMESPACE = "ui";

/** The owner whose bundles ARE the shared copy — the only one that may use it. */
const SHARED_UI_OWNER = "ui";

/** The component every app's root layout must mount (#437 check E). */
const SHARED_UI_PROVIDER = "SharedUiTranslationProvider";

/**
 * Every app root, DERIVED from the tracked listing rather than written out.
 *
 * A hand list would silently skip a fourth app — and "the guard found fewer
 * roots" looks exactly like "there are fewer roots". The floor below is what
 * tells them apart.
 */
const ROOT_LAYOUT = /^packages\/[^/]+\/app\/_layout\.tsx$/;
const MINIMUM_ROOT_LAYOUTS = fixtureFloors ? 1 : 3;

/** Every app's locale directory, derived the same way, for check D. */
const APP_LOCALE_BUNDLE = /^packages\/[^/]+\/lib\/i18n\/locales\/[^/]+\.json$/;
const MINIMUM_APP_BUNDLES = fixtureFloors ? 1 : 30;

// Bundles are DATA and are never analysed for hardcoded strings — every value in
// one IS a user-facing string. They are read as JSON by parts B and C instead.
const SOURCE_FILE = /\.tsx?$/;

/**
 * JSX attributes whose string value a person reads.
 *
 * Derived from a census of what actually carries prose in these two packages,
 * plus the near neighbours a new component would reach for. Everything the
 * census showed carrying an IDENTIFIER rather than prose — `className`,
 * `variant`, `size`, `permission`, `href`, `name`, `content`, `type`,
 * `keyboardType`, `accessibilityRole` — is deliberately absent: a guard that
 * flagged `className="px-4"` would be switched off the day it landed.
 */
const USER_FACING_JSX_ATTRIBUTES = new Set([
  "accessibilityHint",
  "accessibilityLabel",
  "actionLabel",
  "alt",
  "body",
  "cancelText",
  "confirmText",
  "description",
  "emptyText",
  "heading",
  "headline",
  "hint",
  "label",
  "message",
  "placeholder",
  "submitText",
  "subtitle",
  "title",
]);

/**
 * Object-literal properties whose string value a person reads — the nav model's
 * `label`, an empty state's `heading`, a channel warning's `body`.
 *
 * `action` is here and NOT in the attribute set above: the census found it only
 * as a property (`action: "Set up payouts"`), while as a JSX attribute it is far
 * more likely to be a handler or a form target.
 */
const USER_FACING_OBJECT_PROPERTIES = new Set([
  "action",
  "actionLabel",
  "body",
  "description",
  "heading",
  "headline",
  "hint",
  "label",
  "message",
  "placeholder",
  "subtitle",
  "title",
]);

/**
 * Calls whose string arguments are shown to a person.
 *
 * The three shapes in this surface that carry copy through a plain function
 * rather than through a prop: a native alert, a toast, and the sidebar rail's
 * hover tooltip. Deliberately a short, named list — "any call taking a string"
 * would flag every `fetch`, every query key and every `router.push`.
 */
const USER_FACING_CALLEES = new Set([
  "Alert.alert",
  "Alert.prompt",
  "toast.error",
  "toast.info",
  "toast.success",
  "toast.warning",
  "useRailTooltip",
]);

/**
 * Elements whose ENTIRE content is their own action label (check F).
 *
 * The test each one passes: everything a person reads inside it is the name of
 * the action they are about to take. `Pressable` and `TouchableOpacity` fail it
 * — this surface has 86 of them and most wrap a whole tappable list row, so
 * treating one as a label would make every sentence inside it a "label" and F
 * would fire on prose that is perfectly fine.
 *
 * A `t()` sitting in a PROP of one of these (`onPress={() => toast.success(t(…))}`)
 * is not the label either, and the walk below stops at a JSX attribute for that
 * reason. Measured: without that stop, the toast keys inside this screen's own
 * disconnect button read as control labels and F reported two false positives.
 */
const ACTION_CONTROL_ELEMENTS = new Set([
  "AlertDialogAction",
  "AlertDialogCancel",
  "Button",
  "DropdownMenuItem",
  "MenuItem",
  "SelectItem",
  "TabsTrigger",
  "ToggleGroupItem",
]);

/**
 * Field names whose value is a WIRE ENUM a reader should never see raw (check J,
 * #530/#489).
 *
 * This list IS the whole instrument, and it has to be, because the shape it
 * catches is syntactically identical to a correct one: `{seller.name}` is fine
 * and `{seller.status}` is not, and without type information only the field name
 * separates them. So the test each entry passes is narrow — **does this field's
 * value have a localized human-readable form?** A `status`, a `kind`, a `state`,
 * a `country` all do (`formatRegionName` is #513's answer for the last), and
 * rendering the wire token instead ships English, or worse a snake_case token,
 * into every one of the twelve locales.
 *
 * `code` and `currency` were in the probe's list and are deliberately NOT here.
 * Measured: they contributed FOUR candidates and all four were correct —
 * `{code.code}` for a referral code and a pickup collection code, `{price.currency}`
 * beside a number. Neither has a localized form: an ISO 4217 code and a claim
 * code are language-independent identifiers shown verbatim by design. Dropping
 * them is what takes this check from 17 candidates with 4 false positives to 13
 * with none — which is the difference between a gate and a gate somebody turns
 * off. `referral-partner.tsx` renders `{code.code}` and `{code.status}` four
 * lines apart, so the two really are separated by nothing but the field name.
 *
 * What this cannot see, stated rather than implied: it reads a SYNTACTIC shape,
 * so it cannot tell a wire enum from a display string that happens to be stored
 * under one of these names, and it cannot see a raw identifier that reaches the
 * screen through a variable or a helper. It catches the shape #489 found three
 * times and #530 found thirteen more of.
 */
const WIRE_ENUM_FIELDS = new Set([
  "channel",
  "condition",
  "country",
  "kind",
  "level",
  "market",
  "mode",
  "provider",
  "reason",
  "role",
  "source",
  "state",
  "status",
  "type",
]);

/** Below this, the file listing is broken — and a broken listing reports a clean tree. */
const MINIMUM_SOURCE_FILES = fixtureFloors ? 1 : 60;

/** Fixture trees are tiny, so the per-app floors above drop to 1 — never to 0. */
const floorFor = (value) => (fixtureFloors ? 1 : value);

/**
 * The guard cannot be its own subject: this file and its self-test both spell
 * out the shapes they exist to catch. Neither lives under a scanned prefix, so
 * this is belt-and-braces against someone moving them.
 */
const GUARD_OWN_FILES = new Set([
  "scripts/validate-i18n-strings.mjs",
  "scripts/test-validate-i18n-strings.mjs",
]);

/**
 * There is deliberately NO exception list.
 *
 * Every other guard in `scripts/` carries one, because each excuses a real
 * constraint somebody hit (a `borderInline*` React Native never registered, a
 * dependency that cannot be removed yet). This one has no such case: a string in
 * these two apps is either COPY, in which case the remedy is one key and costs
 * nothing, or an IDENTIFIER, in which case no detector here looks at it.
 *
 * That matters because the cheapest way to go green decides what people
 * actually do. With an exception list, the cheapest green for an awkward string
 * is an entry nobody revisits. Without one it is `t('some.key')`, which is the
 * correct action — and for a string that genuinely must read the same in every
 * language (a brand name, a currency symbol) a key holding it is right anyway:
 * some languages transliterate, and the decision then lives in the bundle where
 * a translator can see it.
 *
 * The escape hatch that DOES exist is renaming a prop out of the detector sets
 * above, and it is a visible, reviewable edit to this file rather than a silent
 * one to a screen.
 */

// --------------------------------------------------------------- utilities ---

const failures = [];
const findings = [];

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

const hasLetter = (value) => /\p{L}/u.test(value);

/** The literal chunks of a template, so `` `${n} items` `` is seen as "items". */
function templateChunks(node) {
  if (ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)];
}

/** A string-ish literal's readable text, or `null` if the node is not one. */
function literalText(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
    const chunks = templateChunks(node).filter(hasLetter);
    return chunks.length > 0 ? chunks.join(" ") : null;
  }
  return null;
}

/**
 * A translation call: the bare `t(...)` every screen uses, or a `.t(...)` on
 * something (`i18n.t(...)`). Matched by the callee's NAME rather than by
 * resolving it — this is a syntactic guard, and the cost of the loose match is
 * that a variable called `t` holding something else would read as translated.
 * Nothing in either app has one, and part C is what keeps the far end honest.
 */
const isTranslateCall = (node) =>
  ts.isCallExpression(node)
  && ((ts.isIdentifier(node.expression) && node.expression.text === "t")
    || (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "t"));

/** The dotted name of a call's callee, for the `Alert.alert` check. */
function calleeName(node) {
  const target = node.expression;
  if (ts.isIdentifier(target)) return target.text;
  if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression)) {
    return `${target.expression.text}.${target.name.text}`;
  }
  return null;
}

// -------------------------------------------------- check F's key reading ---

/**
 * Read one module-scope `const X = { … }` into the key sets check F can match on.
 *
 * `flat` is the plain map every label record uses
 * (`{ keep_listings: "channels.disconnect.policy.keepListings" }`); `byProp`
 * covers the pluralised shape (`{ product: { one: "…", many: "…" } }`), which
 * the call site reaches as `t(MAP[x].one)`.
 */
function readKeyMap(objectLiteral) {
  const flat = [];
  const byProp = new Map();
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const value = property.initializer;
    if (ts.isStringLiteralLike(value)) {
      flat.push(value.text);
      continue;
    }
    if (!ts.isObjectLiteralExpression(value)) continue;
    for (const leaf of value.properties) {
      if (!ts.isPropertyAssignment(leaf)) continue;
      if (!ts.isIdentifier(leaf.name) && !ts.isStringLiteral(leaf.name)) continue;
      if (!ts.isStringLiteralLike(leaf.initializer)) continue;
      const bucket = byProp.get(leaf.name.text) ?? [];
      bucket.push(leaf.initializer.text);
      byProp.set(leaf.name.text, bucket);
    }
  }
  return { flat, byProp };
}

/**
 * Does this module-scope record hold translation KEYS? (check I, #542)
 *
 * `collectKeyMaps` reads every module-scope object literal, most of which are
 * not key maps at all — chip class names, icon sizes, colour tuples. What makes
 * one a key map is that every leaf it holds is a key the owning app can actually
 * resolve, which is why this takes the REAL vocabulary rather than matching a
 * key-SHAPED string. The difference is the one check A already records for
 * `label: "nav.register"`: a shape rule would accept a typo'd `"nav.regsiter"`
 * and go on believing the map is fine, and it would accept a record of CSS
 * classes as a key map and start firing on `{CHIP_CLASSES[x]}`.
 *
 * An EMPTY record answers `false`. Nothing is a key map by having no keys, and a
 * vacuous `true` here would put every `{}` in the tree into check I's population.
 */
export function isKeyMap({ flat, byProp }, knownKeys) {
  const values = [...flat, ...[...byProp.values()].flat()];
  if (values.length === 0) return false;
  return values.every((value) => knownKeys.has(value));
}

/** Every module-scope `const X = { … }` in one file, by name. */
export function collectKeyMaps(relativePath, text) {
  const sourceFile = ts.createSourceFile(
    relativePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX,
  );
  const maps = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      if (!declaration.initializer || !ts.isObjectLiteralExpression(declaration.initializer)) continue;
      maps.set(declaration.name.text, readKeyMap(declaration.initializer));
    }
  }
  return maps;
}

/**
 * Which keys can a `t(…)` argument resolve to?
 *
 * `null` means "this guard cannot read it" — a key held in a local alias
 * (`s.labelKey`) or returned by a function. Those are COUNTED by the caller
 * rather than treated as zero, because "F found no violation" and "F could not
 * see the argument" are the same output otherwise.
 */
function resolveTranslateKeys(argument, maps) {
  if (!argument) return null;
  if (ts.isStringLiteralLike(argument)) return [argument.text];
  // t(MAP[expr])
  if (ts.isElementAccessExpression(argument) && ts.isIdentifier(argument.expression)) {
    const found = maps.get(argument.expression.text);
    return found && found.flat.length > 0 ? found.flat : null;
  }
  if (ts.isPropertyAccessExpression(argument)) {
    const base = argument.expression;
    // t(MAP[expr].one)
    if (ts.isElementAccessExpression(base) && ts.isIdentifier(base.expression)) {
      const found = maps.get(base.expression.text);
      const bucket = found?.byProp.get(argument.name.text);
      return bucket && bucket.length > 0 ? bucket : null;
    }
    // t(MAP.one)
    if (ts.isIdentifier(base)) {
      const found = maps.get(base.text);
      const bucket = found?.byProp.get(argument.name.text);
      return bucket && bucket.length > 0 ? bucket : null;
    }
  }
  return null;
}

/** The tag name of a JSX opening/self-closing element. */
function jsxTagName(element) {
  const opening = ts.isJsxElement(element) ? element.openingElement : element;
  const tag = opening.tagName;
  return ts.isIdentifier(tag) ? tag.text : tag.getText();
}

/**
 * Is this `t(…)` call rendering an action control's OWN label?
 *
 * Two ways a control carries its label, and the difference between them is the
 * whole subtlety here:
 *
 *   <Button><Text>{t(k)}</Text></Button>   — a CHILD, the spelling this tree uses
 *   <Button title={t(k)} />                — a label-bearing ATTRIBUTE
 *
 * and one way it does NOT:
 *
 *   <Button onPress={() => toast.success(t(k))}>  — a handler
 *
 * So the walk stops at an attribute only when that attribute is not one a
 * person reads. Measured: without the stop, the toast keys inside this screen's
 * own disconnect button read as control labels and F reported two false
 * positives; with the stop written as "any attribute", a button whose label
 * comes through `title=` stops being seen at all.
 */
function actionControlAncestor(node) {
  for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
    if (ts.isJsxAttribute(ancestor)) {
      const readable = ts.isIdentifier(ancestor.name)
        && USER_FACING_JSX_ATTRIBUTES.has(ancestor.name.text);
      if (!readable) return null;
      const owner = ancestor.parent?.parent;
      if (!owner) return null;
      const element = ts.isJsxOpeningElement(owner) ? owner.parent : owner;
      const name = jsxTagName(ts.isJsxElement(element) ? element : owner);
      return ACTION_CONTROL_ELEMENTS.has(name) ? name : null;
    }
    if (ts.isJsxElement(ancestor) || ts.isJsxSelfClosingElement(ancestor)) {
      const name = jsxTagName(ancestor);
      if (ACTION_CONTROL_ELEMENTS.has(name)) return name;
    }
    if (ts.isSourceFile(ancestor)) return null;
  }
  return null;
}

// ----------------------------------------------------------- the analyser ---

/**
 * Analyse ONE source file.
 *
 * Returns the hardcoded-string findings, the number of TRANSLATED positions it
 * saw, and every string literal in the file (part C reads the last of these to
 * decide which keys are referenced).
 *
 * `knownKeys` is the app's own vocabulary — every key its `en.json` can resolve,
 * including the parent of a pluralised pair. It is what lets rule 3's remedy
 * through: module-scope data holds KEYS (`{ label: "nav.register" }`), and a
 * guard that flagged those would be flagging the fix. Passing the REAL key set
 * rather than matching a key-SHAPED string is the difference that matters — a
 * typo'd `"nav.regsiter"` still fails, where a shape rule would wave it past and
 * the screen would render a humanised guess of the misspelling.
 *
 * Exported shape rather than inline code so the positive and negative controls
 * below run production's own code path over control SOURCE, rather than
 * asserting against a second copy of the rules.
 */
export function analyseSource(
  relativePath, text, knownKeys, sharedKeyMaps = new Map(), keyMapNames = new Set(),
) {
  const sourceFile = ts.createSourceFile(
    relativePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const fileFindings = [];
  const literals = [];
  /** `{ key, line }` for every `t('literal')`, so part C can resolve each one. */
  const translateKeys = [];
  let translatedPositions = 0;
  /** F: `{ key, line, tag }` for every key rendered as an action control's label. */
  const controlLabelSites = [];
  /** F: `{ key, line, frame }` for every key interpolated into another sentence. */
  const interpolatedSites = [];
  /** F: `{ line, role, source }` for each argument F could not read. Counted, not ignored. */
  const unreadableKeySources = [];
  /** H: `{ line, method }` for every date formatted in the DEVICE's locale. */
  const deviceLocaleFormatSites = [];
  /** I: `{ line, map, kind, text }` for every key map rendered without `t()`. */
  const rawKeyRenderSites = [];
  /** J: `{ line, field, text }` for every wire identifier rendered raw. */
  const wireIdentifierRenderSites = [];

  // A file's OWN maps win over the app-wide bag, so a control fixture with no
  // siblings resolves exactly as production does.
  const keyMaps = new Map(sharedKeyMaps);
  for (const [name, value] of collectKeyMaps(relativePath, text)) keyMaps.set(name, value);

  // I: which of those maps hold KEYS rather than anything else a module-scope
  // record might hold. The caller supplies the app-wide answer (a map is
  // routinely declared in one file and read in another, and `@mercaria/ui`'s are
  // read from all three apps); this unions in the ones THIS file declares, so a
  // self-contained control fixture is measured exactly as production is.
  const renderableKeyMaps = new Set(keyMapNames);
  for (const [name, value] of collectKeyMaps(relativePath, text)) {
    if (isKeyMap(value, knownKeys)) renderableKeyMaps.add(name);
  }

  const lineOf = (node) =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  const report = (node, kind, value) => {
    fileFindings.push({
      file: relativePath,
      line: lineOf(node),
      kind,
      text: value.trim().replace(/\s+/g, " ").slice(0, 120),
    });
  };

  /**
   * Walk an expression that sits in a user-facing POSITION and report any
   * readable literal in it.
   *
   * Descends through the shapes a screen legitimately uses — a ternary, `??`,
   * a `&&`, a parenthesis — and stops at the two boundaries that have their own
   * handling: a `t()` argument (that is the remedy, not the defect) and nested
   * JSX (whose children and attributes are visited by the main walk).
   */
  const inspectUserFacing = (node, kind) => {
    if (!node) return;
    if (isTranslateCall(node)) {
      translatedPositions += 1;
      return;
    }
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) return;

    const value = literalText(node);
    if (value !== null) {
      if (knownKeys.has(value)) {
        translatedPositions += 1;
        return;
      }
      if (hasLetter(value)) report(node, kind, value);
      return;
    }
    if (ts.isParenthesizedExpression(node)) return inspectUserFacing(node.expression, kind);
    if (ts.isConditionalExpression(node)) {
      inspectUserFacing(node.whenTrue, kind);
      inspectUserFacing(node.whenFalse, kind);
      return;
    }
    if (ts.isBinaryExpression(node)) {
      inspectUserFacing(node.left, kind);
      inspectUserFacing(node.right, kind);
      return;
    }
    if (ts.isCallExpression(node) || ts.isPropertyAccessExpression(node)
      || ts.isElementAccessExpression(node) || ts.isIdentifier(node)) {
      // A value composed elsewhere. Following it is a type-checker's job, not a
      // syntactic guard's; part C is what keeps the far end honest.
      translatedPositions += 1;
    }
  };

  /**
   * I: a key map read in a position a READER sees, without `t()` around it.
   *
   * The population is the RENDER POSITION, not "a key-map read outside `t(`",
   * and that distinction is the whole check. A key legitimately FLOWS —
   * `basketResultTextKey` returns `RESULT_KIND_KEYS[kind]`, `NEXT_STATUSES`
   * holds `ORDER_STATUS_LABEL_KEYS.shipped` in a `labelKey` field, and
   * `payments.tsx` binds `STATE_COPY[state]` to a const it resolves two lines
   * later. Measured: the read-outside-`t(` rule reports 33 candidates on this
   * tree and every one of them is a legitimate flow; the render-position rule
   * reports ZERO. So the loose version is not a noisier gate, it is a gate that
   * would be deleted in its first week.
   *
   * Descends through the shapes a render position legitimately uses, exactly as
   * `inspectUserFacing` does, and — unlike it — through a template's spans:
   * `` {`${MAP[x]} · ${n}`} `` renders the key just as plainly.
   *
   * Deliberately does NOT descend into a conditional's CONDITION, which is what
   * lets the presence test through: `{X[k] ? t(X[k]) : fallback}` reads the map
   * once as a guard and once, correctly, as a translation.
   */
  const inspectKeyRender = (node, kind) => {
    if (!node) return;
    if (isTranslateCall(node)) return;
    if (ts.isParenthesizedExpression(node)) return inspectKeyRender(node.expression, kind);
    if (ts.isConditionalExpression(node)) {
      inspectKeyRender(node.whenTrue, kind);
      inspectKeyRender(node.whenFalse, kind);
      return;
    }
    if (ts.isBinaryExpression(node)) {
      inspectKeyRender(node.left, kind);
      inspectKeyRender(node.right, kind);
      return;
    }
    if (ts.isTemplateExpression(node)) {
      for (const span of node.templateSpans) inspectKeyRender(span.expression, kind);
      return;
    }
    const isRead = (ts.isElementAccessExpression(node) || ts.isPropertyAccessExpression(node))
      && ts.isIdentifier(node.expression)
      && renderableKeyMaps.has(node.expression.text);
    if (isRead) {
      rawKeyRenderSites.push({
        line: lineOf(node),
        map: node.expression.text,
        kind,
        text: node.getText(sourceFile).slice(0, 80),
      });
    }
  };

  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      literals.push(node.text);
    }

    // H. a date formatted in the DEVICE's locale rather than the APP's (#488).
    //
    // Read off the AST rather than by grepping the text, and that is what makes
    // it comment-immune: `StoreMenuSheet.tsx` documents the defect it fixed in
    // prose containing the literal `toLocaleDateString`, and a text scan would
    // report the file it just cleaned. There is no node for a comment here, so
    // the population is the CALLS.
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && DEVICE_LOCALE_METHODS.has(node.expression.name.text)) {
      const first = node.arguments[0];
      // An explicit `undefined` is the device locale exactly as an omitted
      // argument is — the same defect wearing a more deliberate face — so both
      // count. Anything else has NAMED a locale and is what the remedy looks
      // like.
      const namesNoLocale = first === undefined
        || (ts.isIdentifier(first) && first.text === "undefined");
      if (namesNoLocale) {
        deviceLocaleFormatSites.push({
          line: lineOf(node),
          method: node.expression.name.text,
        });
      }
    }

    // C. every `t('literal')` names a key the bundle must hold.
    if (isTranslateCall(node)) {
      const first = node.arguments[0];
      if (first && ts.isStringLiteral(first)) {
        translateKeys.push({ key: first.text, line: lineOf(first) });
      }
    }

    // F. the two populations: a key rendered as an action control's own label,
    // and a key interpolated into another translated sentence.
    if (isTranslateCall(node)) {
      const tag = actionControlAncestor(node);
      if (tag !== null) {
        const keys = resolveTranslateKeys(node.arguments[0], keyMaps);
        if (keys === null) {
          unreadableKeySources.push({
            line: lineOf(node), role: "control-label",
            source: node.arguments[0] ? node.arguments[0].getText(sourceFile) : "<none>",
          });
        } else {
          for (const key of keys) controlLabelSites.push({ key, line: lineOf(node), tag });
        }
      }

      const values = node.arguments[1];
      if (values && ts.isObjectLiteralExpression(values)) {
        const frame = ts.isStringLiteralLike(node.arguments[0])
          ? node.arguments[0].text
          : "<computed>";
        for (const property of values.properties) {
          if (!ts.isPropertyAssignment(property)) continue;
          // Unwrap the `.toLowerCase()` / `.trim()` chain #442 itself used —
          // matching the bare call only would miss the exact shape F exists for.
          let value = property.initializer;
          while (
            ts.isCallExpression(value)
            && ts.isPropertyAccessExpression(value.expression)
            && !isTranslateCall(value)
          ) value = value.expression.expression;
          if (!isTranslateCall(value)) continue;
          const keys = resolveTranslateKeys(value.arguments[0], keyMaps);
          if (keys === null) {
            unreadableKeySources.push({
              line: lineOf(node), role: "interpolated",
              source: value.arguments[0] ? value.arguments[0].getText(sourceFile) : "<none>",
            });
          } else {
            for (const key of keys) interpolatedSites.push({ key, line: lineOf(node), frame });
          }
        }
      }
    }

    // A. JSX text: `<Text>Save</Text>`
    if (ts.isJsxText(node) && hasLetter(node.text)) {
      report(node, "jsx-text", node.text);
    }

    // A. A JSX CHILD expression: `<Text>{"Save"}</Text>`, `{n} item{n === 1 ? "" : "s"}`
    if (
      ts.isJsxExpression(node)
      && node.expression
      && node.parent
      && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
    ) {
      inspectUserFacing(node.expression, "jsx-child");
      // I. the same position, asking a different question: is this a KEY?
      inspectKeyRender(node.expression, "jsx-child");

      // J. a wire enum rendered raw (#530, the class #489 named).
      //
      // Only a JSX CHILD, deliberately. The attribute and object-property
      // positions check A also walks are where an `accessibilityLabel` or a
      // `testID` legitimately carries an identifier, and widening to them turned
      // a clean 13 into noise nobody would keep.
      if (ts.isPropertyAccessExpression(node.expression)
        && WIRE_ENUM_FIELDS.has(node.expression.name.text)) {
        wireIdentifierRenderSites.push({
          line: lineOf(node),
          field: node.expression.name.text,
          text: node.expression.getText(sourceFile).slice(0, 80),
        });
      }
    }

    // A. A user-facing ATTRIBUTE: `placeholder="Search"`
    if (
      ts.isJsxAttribute(node)
      && ts.isIdentifier(node.name)
      && USER_FACING_JSX_ATTRIBUTES.has(node.name.text)
      && node.initializer
    ) {
      const value = ts.isJsxExpression(node.initializer)
        ? node.initializer.expression
        : node.initializer;
      inspectUserFacing(value, `attribute:${node.name.text}`);
      inspectKeyRender(value, `attribute:${node.name.text}`);
    }

    // A. A user-facing object PROPERTY: `{ label: "Register" }`
    if (
      ts.isPropertyAssignment(node)
      && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
      && USER_FACING_OBJECT_PROPERTIES.has(node.name.text)
    ) {
      inspectUserFacing(node.initializer, `property:${node.name.text}`);
      inspectKeyRender(node.initializer, `property:${node.name.text}`);
    }

    // A. `Alert.alert("Deleted", "The product is gone.")`, `toast.error("…")`,
    // `useRailTooltip("Expand sidebar")`
    {
      const callee = ts.isCallExpression(node) ? calleeName(node) : null;
      if (callee !== null && USER_FACING_CALLEES.has(callee)) {
        for (const argument of node.arguments) {
          inspectUserFacing(argument, `call:${callee}`);
          inspectKeyRender(argument, `call:${callee}`);
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return {
    findings: fileFindings,
    translatedPositions,
    literals,
    translateKeys,
    controlLabelSites,
    interpolatedSites,
    unreadableKeySources,
    deviceLocaleFormatSites,
    rawKeyRenderSites,
    // How many key maps THIS CALL could have fired on. Reported rather than left
    // to the caller's own copy of the derivation, because the two are not the
    // same fact: a caller that stops PASSING the app-wide set still derives it
    // perfectly, so a floor read off the deriver passes while the analyser sees
    // only the maps each file declares itself — and `@mercaria/ui` declares the
    // ones all three apps read. Measured: with the argument replaced by an empty
    // set the whole guard stayed green and the summary went on printing the full
    // population. Two derived representations agreeing is not a check.
    renderableKeyMapCount: renderableKeyMaps.size,
    wireIdentifierRenderSites,
  };
}

/**
 * Does this source MOUNT `<SharedUiTranslationProvider>`? (check E)
 *
 * Written from the IDIOM — a JSX element whose tag is that name — rather than
 * from a substring or a regex. The difference is what the three negative
 * controls below cover: an import of the symbol, a comment naming it and a
 * string mentioning it are all things a repository legitimately contains, and a
 * substring check would accept every one of them as proof the provider is
 * mounted. It cannot tell WHERE in the tree the element sits, which is stated
 * in `ui-translation.tsx` rather than implied here.
 *
 * Exported for the same reason `analyseSource` is: the controls run production's
 * own code path over control SOURCE rather than asserting against a second copy
 * of the rule.
 */
export function mountsSharedUiProvider(relativePath, text) {
  const sourceFile = ts.createSourceFile(
    relativePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let mounted = false;
  const visit = (node) => {
    if (mounted) return;
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
      && ts.isIdentifier(node.tagName)
      && node.tagName.text === SHARED_UI_PROVIDER
    ) {
      mounted = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return mounted;
}

/** Flatten a bundle to `a.b.c` -> string, refusing a non-string leaf. */
function flatten(value, prefix, into, file) {
  for (const [name, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${name}` : name;
    if (typeof child === "string") {
      into.set(path, child);
    } else if (child && typeof child === "object" && !Array.isArray(child)) {
      flatten(child, path, into, file);
    } else {
      failures.push(
        `${file}: "${path}" is ${Array.isArray(child) ? "an array" : typeof child}. A bundle holds `
        + "strings and nested objects only — i18n-js renders anything else as [object Object].",
      );
    }
  }
}

/**
 * CLDR plural categories. A pluralised key is a nested object, so `en.json`
 * flattens to `cart.lineCount.one` / `.other` while the call site names only
 * `cart.lineCount` — part C would otherwise report both leaves as unused.
 *
 * Deliberately narrow: the parent is credited only when the LAST segment is one
 * of these six words. A general "any prefix counts" rule would let the stray
 * literal `"orders"` in a query key mark every `orders.*` key used, which is
 * most of a bundle.
 */
const PLURAL_CATEGORIES = new Set(["zero", "one", "two", "few", "many", "other"]);

function pluralParentOf(key) {
  const cut = key.lastIndexOf(".");
  if (cut < 0) return null;
  return PLURAL_CATEGORIES.has(key.slice(cut + 1)) ? key.slice(0, cut) : null;
}

/**
 * Every PLURAL object in a parsed bundle: `a.b.c` -> {category -> string}.
 *
 * STRICTER than `pluralParentOf`, and it has to be. That function asks whether a
 * key's last segment is a category word, which is right for part C — crediting a
 * parent so its leaves are not reported unused — and wrong here, because it also
 * matches a key that merely HAS a child called `other`. The storefront has
 * exactly one: `feedback.other` is the "Other" option in a list of thirty
 * feedback reasons, and reading `feedback` as a plural would demand `other` from
 * a locale for a key that is not pluralised at all, then report the other
 * twenty-nine children as categories that can never be selected.
 *
 * So a plural object is one whose children are ALL category words and are all
 * strings. Derived from the PARSED bundle rather than the flattened map, because
 * "what are this node's own children" is the question, and a flat map answers it
 * only by prefix arithmetic.
 */
function collectPlurals(value, prefix, into) {
  const entries = Object.entries(value);
  if (
    entries.length > 0
    && entries.every(([name, child]) => PLURAL_CATEGORIES.has(name) && typeof child === "string")
  ) {
    into.set(prefix, new Map(entries));
    return;
  }
  for (const [name, child] of entries) {
    if (child && typeof child === "object" && !Array.isArray(child)) {
      collectPlurals(child, prefix ? `${prefix}.${name}` : name, into);
    }
  }
}

/** `packages/pos/lib/i18n/locales/pt-BR.json` -> `pt-BR`, or null if unknown. */
function localeOfBundlePath(path) {
  const stem = path.slice(path.lastIndexOf("/") + 1).replace(/\.json$/u, "");
  return SUPPORTED_LOCALES.includes(stem) ? stem : null;
}

/**
 * Check K's whole decision for ONE sibling bundle (#436).
 *
 * A function rather than an inline loop so the controls below can run the REAL
 * detector over synthetic bundles. K's healthy answer on this repository is "no
 * failures and two residual counts", and a detector that had quietly stopped
 * detecting would produce the same thing.
 *
 * Returns the failures plus the two residuals as LISTS of `key.category`, so
 * the caller can both count them and name a few — a bare number tells whoever
 * hits the pin nothing about which forms moved.
 */
function pluralShapeOf({ path, locale, englishPlurals, plurals }) {
  const failures = [];
  const missing = [];
  const unreachable = [];

  // What the runtime can SELECT, and — separately — what CLDR says the language
  // NEEDS. They differ by `zero`, which i18n-js offers in every locale as an
  // affordance ("You have no messages") and which CLDR lists only for Arabic
  // among the twelve. So a missing `zero` in French is not residual (nobody owes
  // it) while a PRESENT one would not be unreachable either (the chain uses it).
  const selectable = selectablePluralCategories(locale);
  const required = cldrCardinalCategories(locale);

  for (const [key, englishForms] of englishPlurals) {
    const forms = plurals.get(key);
    if (!forms || forms.size === 0) {
      failures.push(
        `${path}: "${key}" is a plural key in en.json and is missing or not a plural object here. `
        + "i18n-js resolves the whole object from ONE locale, so there is no per-category fallback "
        + "to English — every count on this screen would render missingTranslation.",
      );
      continue;
    }

    if (!forms.has("other")) {
      failures.push(
        `${path}: "${key}" carries {${[...forms.keys()].join(", ")}} and no "other". That is the `
        + "terminal rung of the category chain, so every count whose own category is absent renders "
        + "NOTHING rather than an approximate form.",
      );
    }

    // Required: what English uses AND this locale can select. `one` is demanded
    // of Russian and NOT of Japanese, whose only category is `other`.
    for (const category of englishForms.keys()) {
      if (!selectable.includes(category) || forms.has(category)) continue;
      failures.push(
        `${path}: "${key}" is missing "${category}", which en.json uses and ${locale} can select. `
        + "Dropping it renders the `other` form at a count the language distinguishes — the exact "
        + "defect #436 exists to remove, arrived at from the other direction.",
      );
    }

    // Against en's `other`, because a `many` form has no English twin to compare
    // with. Every English plural key carries identical placeholders across its
    // own forms, so `other` is a canonical rather than an arbitrary pick.
    //
    // `zero` is the ONE category held to a weaker rule, and a control is what
    // established it: its entire purpose is to replace the number with a word
    // ("You have no messages", "aucun produit"), which is i18n-js's own worked
    // example for the category. Demanding equality there refuses the correct
    // translation. It is still held to a SUBSET, so an invented or renamed
    // placeholder is caught in `zero` exactly as anywhere else — what is
    // permitted is dropping one, not inventing one.
    const englishPlaceholders = placeholdersOf(englishForms.get("other") ?? "");
    const englishNames = new Set(englishPlaceholders ? englishPlaceholders.split(",") : []);
    for (const [category, value] of forms) {
      if (!selectable.includes(category)) unreachable.push(`${key}.${category}`);
      const own = placeholdersOf(value);
      const foreign = (own ? own.split(",") : []).filter((name) => !englishNames.has(name));
      const wrong = category === "zero" ? foreign.length > 0 : own !== englishPlaceholders;
      if (wrong) {
        failures.push(
          `${path}: "${key}.${category}" carries placeholders {${own || "none"}} but en.json's `
          + `"${key}.other" carries {${englishPlaceholders || "none"}}. A renamed placeholder `
          + "renders the literal %{count} to a shopper."
          + (category === "zero" ? "" : " Only a `zero` form may drop one."),
        );
      }
    }

    for (const category of required) {
      if (!forms.has(category)) missing.push(`${key}.${category}`);
    }
  }

  return { failures, missing, unreachable };
}

/**
 * The three `Date` methods that resolve against the RUNTIME's default locale —
 * the device — when handed no locale (#488, check H).
 *
 * `Intl.DateTimeFormat` is deliberately NOT in this set. Constructing one takes
 * the locale as its FIRST argument, so the shape that omits it
 * (`new Intl.DateTimeFormat()`) is vanishingly rare and the shape that supplies
 * it is the remedy `formatDate` is built from — a detector covering both would
 * fire on `packages/ui/src/lib/format.ts` itself.
 */
const DEVICE_LOCALE_METHODS = new Set([
  "toLocaleDateString",
  "toLocaleString",
  "toLocaleTimeString",
]);

/**
 * A placeholder in a syntax `i18n-js` DOES NOT INTERPOLATE (#487, check G).
 *
 * The interpolator reads `%{name}`. A `{{name}}` — the Mustache/Handlebars
 * spelling, and what `i18next` uses — is passed through as literal text, so the
 * braces reach the shopper. Twelve bundles carried `"{{count}}/1000 characters"`
 * for exactly that reason.
 *
 * Check B could never have caught it: B asserts every bundle carries the SAME
 * placeholders as `en`, and all twelve carried `{{count}}` identically. Parity
 * is a consistency check, and twelve wrong things can be perfectly consistent —
 * which is the general lesson worth keeping, not just this key.
 */
const FOREIGN_PLACEHOLDER = /\{\{[^{}]*\}\}/g;

/** Every `{{…}}` in a bundle value — the input to check G and to its controls. */
const foreignPlaceholdersOf = (value) => [...String(value).matchAll(FOREIGN_PLACEHOLDER)]
  .map((match) => match[0]);

const PLACEHOLDER = /%\{([^}]+)\}/g;
const placeholdersOf = (value) =>
  [...value.matchAll(PLACEHOLDER)].map((match) => match[1]).sort().join(",");

/** Every key `t()` can resolve: the leaves, plus the parent of a plural pair. */
function resolvableKeys(flat) {
  const keys = new Set(flat.keys());
  for (const key of flat.keys()) {
    const parent = pluralParentOf(key);
    if (parent !== null) keys.add(parent);
  }
  return keys;
}

/**
 * Read a tracked file, or record WHY it could not be read and carry on.
 *
 * `git ls-files` reports the INDEX, which can name a file the working tree does
 * not have. Reading that as a FAILURE keeps the run loud rather than ending it
 * with a stack trace and no verdict.
 */
async function readTracked(path) {
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

// --------------------------------------------------------- the vocabularies ---

// Read BEFORE the sources, because the analyser needs each app's key set: rule
// 3's remedy puts KEYS into module-scope data, and only the real vocabulary can
// tell `label: "nav.register"` (correct) from `label: "nav.regsiter"` (a typo
// that renders a humanised guess at a merchant).

const tracked = trackedFiles();

/** owner name -> locale path -> flattened `a.b.c` -> value. */
const bundlesByApp = new Map();
/** owner name -> locale path -> plural key -> (category -> value), for check K. */
const pluralsByApp = new Map();
/** owner name -> how many plural keys en.json holds, for K's summary line. */
const pluralKeysByApp = new Map();
/** Every bundle path anywhere -> its TOP-LEVEL keys, for check D. */
const topLevelKeysByPath = new Map();
for (const app of OWNERS) {
  const bundlePaths = tracked.filter(
    (path) => path.startsWith(`${app.locales}/`) && path.endsWith(".json"),
  );
  if (bundlePaths.length === 0) {
    failures.push(
      `${app.name}: no locale bundles under ${app.locales} — the scan found nothing to check`,
    );
  }
  const flatByLocale = new Map();
  const pluralsByLocale = new Map();
  for (const path of bundlePaths) {
    const text = await readTracked(path);
    if (text === null) continue;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      failures.push(`${path}: not valid JSON (${error.message})`);
      continue;
    }
    topLevelKeysByPath.set(path, Object.keys(parsed));
    const flat = new Map();
    flatten(parsed, "", flat, path);
    flatByLocale.set(path, flat);
    const plurals = new Map();
    collectPlurals(parsed, "", plurals);
    pluralsByLocale.set(path, plurals);
  }
  bundlesByApp.set(app.name, flatByLocale);
  pluralsByApp.set(app.name, pluralsByLocale);
}

const knownKeysByApp = new Map(
  OWNERS.map((app) => [
    app.name,
    resolvableKeys(bundlesByApp.get(app.name)?.get(`${app.locales}/en.json`) ?? new Map()),
  ]),
);

// -------------------------------------------------------------- controls ----

/**
 * POSITIVE AND NEGATIVE CONTROLS.
 *
 * Both run the REAL `analyseSource` over control SOURCE, on every invocation
 * including in CI — a control that only runs in the self-test says nothing about
 * the run that actually gated the merge. A detector that silently stopped
 * detecting (a renamed `ts` predicate, a lost `parent` link, an editor mangling
 * the file) would otherwise report a clean tree, which is what a clean tree
 * reports.
 */
const CONTROL_MUST_FIND = [
  { id: "jsx-text", source: "const A = () => <Text>Save changes</Text>;" },
  { id: "jsx-child-string", source: 'const A = () => <Text>{"Save changes"}</Text>;' },
  { id: "jsx-child-template", source: "const A = () => <Text>{`${n} items in cart`}</Text>;" },
  { id: "jsx-child-ternary", source: 'const A = () => <Text>{n === 1 ? "item" : "items"}</Text>;' },
  { id: "attribute", source: 'const A = () => <Input placeholder="Search products" />;' },
  { id: "attribute-expression", source: 'const A = () => <Input placeholder={"Search products"} />;' },
  { id: "object-property", source: 'export const NAV = [{ key: "a", label: "Register" }];' },
  { id: "alert-argument", source: 'Alert.alert("Deleted", "The product is gone.");' },
  { id: "toast-argument", source: 'toast.error("Could not save the product.");' },
  { id: "tooltip-argument", source: 'const tip = useRailTooltip("Expand sidebar");' },
];

/**
 * Spellings that must NEVER fire. The Tailwind class, the route, the permission
 * and the query key are all real in this tree, and a guard that flagged them
 * would be turned off within a day. The last four are the remedy itself.
 */
const CONTROL_MUST_NOT_FIND = [
  'const A = () => <View className="flex-row items-center gap-2 px-4" />;',
  'export const NAV = [{ key: "orders", href: "/orders", permission: "orders:read" }];',
  'const key = ["stores", storeId, "products"] as const;',
  'const A = () => <Input keyboardType="url" autoCapitalize="none" />;',
  'const A = () => <Text>{t("register.title")}</Text>;',
  'const A = () => <Input placeholder={t("products.searchPlaceholder")} />;',
  'export const NAV = [{ key: "a", label: "nav.register" }];',
  'Alert.alert(t("products.deleted"), t("products.deletedBody"));',
  'toast.error(error.message);',
  'const tip = useRailTooltip(t("nav.register"));',
  'const response = await fetch("/api/products", { method: "POST" });',
];

/**
 * The vocabulary the controls are measured against. Written out rather than
 * borrowed from an app, so a control keeps meaning the same thing after somebody
 * renames a real key — and so the "a key-shaped string that is NOT a key still
 * fails" case below has something to be absent from.
 */
const CONTROL_KEYS = new Set([
  "a.b",
  "c.d",
  "nav.register",
  "products.deleted",
  "products.deletedBody",
  "products.searchPlaceholder",
  "register.title",
]);

for (const control of CONTROL_MUST_FIND) {
  const { findings: found } = analyseSource(
    `control/${control.id}.tsx`,
    control.source,
    CONTROL_KEYS,
  );
  if (found.length === 0) {
    failures.push(
      `positive control failed: ${control.id} produced no finding for ${JSON.stringify(control.source)} — `
      + "the analyser is broken, and a broken analyser reports a clean tree",
    );
  }
}
for (const source of CONTROL_MUST_NOT_FIND) {
  const { findings: found } = analyseSource("control/negative.tsx", source, CONTROL_KEYS);
  if (found.length > 0) {
    failures.push(
      `negative control failed: ${JSON.stringify(source)} produced ${found.length} finding(s) `
      + `(${found.map((f) => f.kind).join(", ")}) — the analyser is too broad and would be `
      + "disabled by whoever hit it",
    );
  }
}
// The remedy must also register as translated, or the vacuity floor below is
// measuring something other than what it claims to.
{
  const remedy = analyseSource(
    "control/translated.tsx",
    'const A = () => <><Text>{t("a.b")}</Text><Input placeholder={t("c.d")} /></>;',
    CONTROL_KEYS,
  );
  if (remedy.translatedPositions < 2) {
    failures.push(
      `positive control failed: a file with two t() positions counted ${remedy.translatedPositions} — `
      + "the translated-position floor cannot detect a broken traversal",
    );
  }
}

/**
 * Controls for check G (#487), run on every invocation.
 *
 * G's real-tree answer is ZERO findings, which is exactly what a broken regex
 * also returns — so without these the check would go on reporting a clean tree
 * after somebody edited the pattern into one that matches nothing.
 *
 * The negatives matter as much: `%{count}` is the CORRECT spelling and appears
 * in roughly 150 real values, and a `${…}` is a JavaScript template that has
 * already been substituted before the value reaches a bundle. A G that fired on
 * either would be switched off the same day.
 */
for (const seeded of ['{{count}}/1000 characters', 'Hello {{ name }}', '{{a}} and {{b}}']) {
  if (foreignPlaceholdersOf(seeded).length === 0) {
    failures.push(
      `positive control failed: check G found no foreign placeholder in ${JSON.stringify(seeded)} — `
      + "the detector is broken, and a broken detector reports a clean bundle set",
    );
  }
}
for (const safe of ['%{count}/1000 characters', 'Order %{number}', 'no placeholder at all', '{}', '{ }']) {
  if (foreignPlaceholdersOf(safe).length > 0) {
    failures.push(
      `negative control failed: check G fired on ${JSON.stringify(safe)}, which is the CORRECT `
      + "i18n-js spelling — a guard that flags the remedy gets disabled",
    );
  }
}

/**
 * Controls for check H (#488), run on every invocation.
 *
 * H's answer for the storefront is ZERO, and zero is also what a detector that
 * stopped matching returns. The negatives pin the two shapes that must not
 * fire: a call that NAMES a locale, and the `formatDate` remedy itself.
 */
const deviceLocaleFindings = (source) =>
  analyseSource("control/device-locale.tsx", source, CONTROL_KEYS).deviceLocaleFormatSites;

const DEVICE_LOCALE_MUST_FIND = [
  "const d = new Date(x).toLocaleDateString();",
  "const d = new Date(x).toLocaleString();",
  "const d = new Date(x).toLocaleTimeString();",
  // The explicit `undefined` — the same defect wearing a more deliberate face.
  'const d = new Date(x).toLocaleDateString(undefined, { year: "numeric" });',
];
const DEVICE_LOCALE_MUST_NOT_FIND = [
  "const d = new Date(x).toLocaleDateString(locale);",
  'const d = new Date(x).toLocaleString(locale, { dateStyle: "medium" });',
  "const d = formatDate(x, locale);",
  "const d = formatDateTime(x, locale);",
  // The remedy's own implementation, which names the locale positionally.
  'const f = new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(parsed);',
  // A same-named method on something that is not a Date still takes a locale.
  "const n = (1234.5).toLocaleString(locale);",
];

for (const source of DEVICE_LOCALE_MUST_FIND) {
  if (deviceLocaleFindings(source).length === 0) {
    failures.push(
      `positive control failed: check H produced no finding for ${JSON.stringify(source)} — `
      + "the detector is broken, and a broken detector reports a clean app",
    );
  }
}
for (const source of DEVICE_LOCALE_MUST_NOT_FIND) {
  if (deviceLocaleFindings(source).length > 0) {
    failures.push(
      `negative control failed: check H fired on ${JSON.stringify(source)}, which NAMES a locale — `
      + "a guard that flags the remedy gets disabled",
    );
  }
}
// Comment-immunity, asserted rather than assumed: `StoreMenuSheet.tsx` records
// the defect it fixed in prose that contains the literal method name, and a
// text-based scan would report the file it had just cleaned.
{
  const commented = deviceLocaleFindings(
    "// Was `toLocaleDateString(undefined, …)`, which used the device locale.\n"
    + "const d = formatDate(x, locale);",
  );
  if (commented.length > 0) {
    failures.push(
      "negative control failed: check H fired on a COMMENT naming the method. It reads the AST, so "
      + "this must be impossible — if it fires, the detector has been rewritten as a text scan",
    );
  }
}

/**
 * Controls for check I (#542), run on every invocation.
 *
 * These carry the check. Its real-tree answer is ZERO for all four owners —
 * `@mercaria/ui`'s nineteen were fixed in #541 — and zero is exactly what a
 * detector that stopped matching returns, so there is no live site to keep it
 * honest. The positives are the REAL bug, reconstructed: a `*_LABEL_KEYS` map
 * read straight into a render position with the `t(` dropped.
 *
 * The negatives are the more interesting half, because they are what separate
 * this from the rule that does not work. A key legitimately FLOWS — returned
 * from a function, held in another record, bound to a const, tested for
 * presence — and a rule keyed on "a key-map read outside `t(`" fires on all four
 * shapes. Measured on this tree: 33 candidates, every one of them correct code.
 */
const CONTROL_KEY_MAP = 'const M = { a: "a.b", c: "c.d" };\n';
const rawKeyFindings = (source) =>
  analyseSource("control/raw-key.tsx", CONTROL_KEY_MAP + source, CONTROL_KEYS).rawKeyRenderSites;

const RAW_KEY_MUST_FIND = [
  "const A = () => <Text>{M[x]}</Text>;",
  "const A = () => <Text>{M.a}</Text>;",
  // Inside a template — the id renders just as plainly with a middot after it.
  "const A = () => <Text>{`${M[x]} · ${n}`}</Text>;",
  // One half translated and one half not is the exact shape #542 measured.
  "const A = () => <Text>{t(M.a)} · {M[x]}</Text>;",
  "const A = () => <Text>{ready ? M[x] : M.c}</Text>;",
  'const A = () => <Input placeholder={M[x]} />;',
  "const A = () => <Text>{M[x] ?? M.c}</Text>;",
];
const RAW_KEY_MUST_NOT_FIND = [
  // The remedy.
  "const A = () => <Text>{t(M[x])}</Text>;",
  "const A = () => <Text>{t(M.a)}</Text>;",
  'const A = () => <Input placeholder={t(M[x])} />;',
  // A key RETURNED for a caller to resolve — `basketResultTextKey`'s shape.
  "export function labelKey(k) { return M[k]; }",
  // A key held in another record — `NEXT_STATUSES`' shape.
  "const NEXT = [{ key: 'shipped', labelKey: M.a }];",
  // A key bound to a const and resolved later — `STATE_COPY`'s shape.
  "const A = () => { const copy = M[x]; return <Text>{t(copy)}</Text>; };",
  // The presence test: the guard reads the map, the render beside it is correct.
  "const A = () => <Text>{M[x] ? t(M[x]) : fallback}</Text>;",
  // An import of the name is not a render of it.
  'import { M } from "./labels";\nconst A = () => <Text>{t("a.b")}</Text>;',
];

for (const source of RAW_KEY_MUST_FIND) {
  if (rawKeyFindings(source).length === 0) {
    failures.push(
      `positive control failed: check I produced no finding for ${JSON.stringify(source)} — `
      + "the detector is broken, and its answer for a broken detector and for a clean tree is the "
      + "same zero",
    );
  }
}
for (const source of RAW_KEY_MUST_NOT_FIND) {
  if (rawKeyFindings(source).length > 0) {
    failures.push(
      `negative control failed: check I fired on ${JSON.stringify(source)}, which is either the `
      + "remedy or a key legitimately in FLIGHT to one — a guard that flags those reports 33 "
      + "findings on a correct tree and gets deleted",
    );
  }
}
// A record that is NOT a key map must be invisible to I, or the check starts
// firing on every `{CHIP_CLASSES[x]}` in the tree. This is what `isKeyMap`
// buys, and it is why the population is matched against the REAL vocabulary
// rather than against a key-SHAPED string.
{
  const classes = analyseSource(
    "control/not-a-key-map.tsx",
    'const CHIP = { ok: "bg-green-100", bad: "bg-red-100" };\nconst A = () => <Text>{CHIP[x]}</Text>;',
    CONTROL_KEYS,
  ).rawKeyRenderSites;
  if (classes.length > 0) {
    failures.push(
      "negative control failed: check I fired on a record of CSS classes. Its population must be "
      + "maps whose every value is a key the app can resolve — if this fires, `isKeyMap` has been "
      + "loosened into a shape match",
    );
  }
  // …and the same map with one value that is NOT a real key is not a key map
  // either, which is what stops a typo'd key from arming the check on a record
  // that is half something else.
  const partial = analyseSource(
    "control/half-a-key-map.tsx",
    'const M = { a: "a.b", c: "not.a.real.key" };\nconst A = () => <Text>{M[x]}</Text>;',
    CONTROL_KEYS,
  ).rawKeyRenderSites;
  if (partial.length > 0) {
    failures.push(
      "negative control failed: check I fired on a record holding a string that is NOT a key. "
      + "`isKeyMap` requires EVERY value to resolve, so this must not fire",
    );
  }
}
// An empty record is not a key map. Without this, `every` over no values is
// vacuously true and every `{}` in the tree joins I's population.
if (isKeyMap({ flat: [], byProp: new Map() }, CONTROL_KEYS)) {
  failures.push(
    "negative control failed: an EMPTY record read as a key map — `every` over nothing is "
    + "vacuously true, so check I's population would swallow every `{}` in the tree",
  );
}

/**
 * Controls for check J (#530), run on every invocation.
 *
 * J's per-owner answers are pinned, and three of the four are non-zero, so a
 * broken detector fails those pins loudly. The POS's is ZERO, though, and these
 * are what keep that one meaningful.
 *
 * The negatives are the reason this check is shippable at all. `{seller.name}`
 * and `{code.code}` are syntactically identical to the defect and differ only in
 * the FIELD NAME, so the field list is the entire instrument — and `code` and
 * `currency` are out of it because measuring said so, not because it seemed
 * tidy.
 */
const wireIdentifierFindings = (source) =>
  analyseSource("control/wire-identifier.tsx", source, CONTROL_KEYS).wireIdentifierRenderSites;

const WIRE_IDENTIFIER_MUST_FIND = [
  "const A = () => <Text>{order.status}</Text>;",
  "const A = () => <Text>{run.kind}</Text>;",
  "const A = () => <Text>{a.country}</Text>;",
  "const A = () => <Text>{report.mode}</Text>;",
  // A deeper path still ends in the field that decides it.
  "const A = () => <Text>{status.data.source.status}</Text>;",
];
const WIRE_IDENTIFIER_MUST_NOT_FIND = [
  // The remedy, both spellings.
  "const A = () => <Text>{t(ORDER_STATUS_LABEL_KEYS[order.status])}</Text>;",
  "const A = () => <Text>{formatRegionName(a.country, locale)}</Text>;",
  // Ordinary display fields, which the naive "any bare identifier" rule the
  // issue first proposed would have fired on — that version is why this one is
  // keyed on the field name at all.
  "const A = () => <Text>{seller.name}</Text>;",
  "const A = () => <Text>{order.orderNumber}</Text>;",
  "const A = () => <Text>{count}</Text>;",
  "const A = () => <Text>{product.title}</Text>;",
  // The two fields measured OUT of the list: both are identifiers shown
  // verbatim on purpose and neither has a localized form.
  "const A = () => <Text>{code.code}</Text>;",
  "const A = () => <Text>{price.currency}</Text>;",
  // A wire field read somewhere that is not a render position.
  "const A = () => <View testID={run.status} />;",
  "const cls = CHIP[run.status];",
];

for (const source of WIRE_IDENTIFIER_MUST_FIND) {
  if (wireIdentifierFindings(source).length === 0) {
    failures.push(
      `positive control failed: check J produced no finding for ${JSON.stringify(source)} — `
      + "the detector is broken, and the POS owner's pin of ZERO would go on passing",
    );
  }
}
for (const source of WIRE_IDENTIFIER_MUST_NOT_FIND) {
  if (wireIdentifierFindings(source).length > 0) {
    failures.push(
      `negative control failed: check J fired on ${JSON.stringify(source)}, which is either the `
      + "remedy or an ordinary display value — this is the direction that gets a gate switched "
      + "off, and it is the direction the issue's first phrasing failed in",
    );
  }
}

/**
 * Controls for check F's detector, run on every invocation.
 *
 * F's real-tree answer is an EMPTY intersection, which is what a completely
 * broken detector also returns. These are what tell the two apart, so they run
 * beside the tree scan rather than only in the self-test.
 */
const actionLabelViolations = (source) => {
  const result = analyseSource("control/action-label.tsx", source, CONTROL_KEYS);
  const labels = new Set(result.controlLabelSites.map((site) => site.key));
  return result.interpolatedSites.filter((site) => labels.has(site.key));
};

const ACTION_LABEL_MUST_FIND = [
  {
    id: "literal-key-reused",
    source: 'const A = () => <><Text>{t("frame.x", { v: t("a.b") })}</Text>'
      + '<Button><Text>{t("a.b")}</Text></Button></>;',
  },
  {
    // The other way a control carries its label. Nothing in this tree spells it
    // this way today, which is exactly why it needs a control: F would look
    // just as green if it could not see an attribute label at all.
    id: "attribute-label-reused",
    source: 'const A = () => <><Text>{t("frame.x", { v: t("a.b") })}</Text>'
      + '<Button title={t("a.b")} /></>;',
  },
  {
    // #442's exact shape: a record of label keys, indexed, lowercased, and
    // dropped into a frame — while the same record fills a toggle group.
    id: "indexed-map-lowercased",
    source: 'const M = { one: "a.b", two: "c.d" };\n'
      + 'const A = () => <><Text>{t("frame.x", { v: t(M[k]).toLowerCase() })}</Text>'
      + "{items.map((o) => <ToggleGroupItem key={o}><Text>{t(M[o])}</Text></ToggleGroupItem>)}</>;",
  },
];

const ACTION_LABEL_MUST_NOT_FIND = [
  {
    id: "different-keys",
    source: 'const A = () => <><Text>{t("frame.x", { v: t("c.d") })}</Text>'
      + '<Button><Text>{t("a.b")}</Text></Button></>;',
  },
  {
    // The false positive measured on the real tree: a t() in a PROP of a button
    // is a toast, not the button's label.
    id: "key-only-in-a-handler",
    source: 'const A = () => <><Text>{t("frame.x", { v: t("a.b") })}</Text>'
      + '<Button onPress={() => toast.success(t("a.b"))}><Text>{t("c.d")}</Text></Button></>;',
  },
  {
    // A badge is not an action control: "Paid" is a term and reads correctly in
    // the appositive frames this surface uses.
    id: "badge-label-interpolated",
    source: 'const A = () => <><Text>{t("frame.x", { v: t("a.b") })}</Text>'
      + '<View><Text>{t("a.b")}</Text></View></>;',
  },
  {
    // A whole tappable row is not a label — this is why Pressable is excluded.
    id: "pressable-row",
    source: 'const A = () => <><Text>{t("frame.x", { v: t("a.b") })}</Text>'
      + '<Pressable><Text>{t("a.b")}</Text></Pressable></>;',
  },
];

for (const control of ACTION_LABEL_MUST_FIND) {
  if (actionLabelViolations(control.source).length === 0) {
    failures.push(
      `positive control failed: check F saw no violation in ${control.id} — F's answer on the real `
      + "tree is an empty intersection, so a detector that finds nothing anywhere passes silently",
    );
  }
}
for (const control of ACTION_LABEL_MUST_NOT_FIND) {
  const found = actionLabelViolations(control.source);
  if (found.length > 0) {
    failures.push(
      `negative control failed: check F fired on ${control.id} (${found.map((s) => s.key).join(", ")}) `
      + "— F would be flagging copy that is correct, and a guard whose cheapest green is busywork "
      + "gets switched off",
    );
  }
}

// ------------------------------------------------- check K's controls (#436) ---

/**
 * The counts the sweep below runs the REAL chain over.
 *
 * Chosen to reach every category the twelve locales have, not to look thorough:
 * Russian needs 21 for `one` and 5 for `many`, Arabic needs 2 for `two`, 3 for
 * `few`, 11 for `many` and 100 for `other`, and Spanish/French/Catalan/
 * Portuguese need a seven-figure number for `many` — which is the one a
 * hand-written list quietly omits, because nothing smaller reaches it.
 */
const PLURAL_SWEEP_COUNTS = [0, 1, 2, 3, 5, 10, 11, 21, 100, 101, 1000, 1000000, 2000000];

/**
 * The control that makes K's permitted set the SAME FACT as the runtime's chain
 * rather than a description of it.
 *
 * K passes a bundle whose categories all sit inside `selectablePluralCategories`.
 * If the chain ever asked for a category outside that set, K would be approving
 * bundles the app cannot render — and nothing else in CI would notice, because
 * the app compiles, exports and renders the `other` form. So the chain is RUN,
 * over every registry locale, and its output is checked against the set K uses.
 *
 * The second half is the vacuity control, and it is the one that matters: a
 * chain that had degenerated to `["other"]` everywhere — which is precisely what
 * a broken `CARDINAL` lookup would produce — satisfies the first half
 * perfectly. So every category the sweep reaches is collected per locale, and
 * the locales with more than two categories must actually REACH more than two.
 */
const pluralChainReach = new Map();
for (const locale of SUPPORTED_LOCALES) {
  const selectable = selectablePluralCategories(locale);
  const reached = new Set();
  for (const count of PLURAL_SWEEP_COUNTS) {
    const chain = pluralCategoryChain(locale, count);
    if (chain.length === 0) {
      failures.push(
        `control failed: the plural chain for ${locale} at count ${count} is EMPTY — i18n-js walks `
        + "the list and would fall straight to missingTranslation",
      );
      continue;
    }
    if (chain[chain.length - 1] !== "other") {
      failures.push(
        `control failed: the plural chain for ${locale} at count ${count} is `
        + `[${chain.join(", ")}] and does not END in "other". The terminal rung is what makes a `
        + "missing `few` form render the approximate string instead of nothing at all.",
      );
    }
    if (new Set(chain).size !== chain.length) {
      failures.push(
        `control failed: the plural chain for ${locale} at count ${count} repeats a category `
        + `([${chain.join(", ")}]) — a duplicate rung is a second lookup of a key that just missed`,
      );
    }
    for (const category of chain) {
      reached.add(category);
      if (selectable.includes(category)) continue;
      failures.push(
        `control failed: the plural chain for ${locale} at count ${count} asks for "${category}", `
        + `which is not in selectablePluralCategories("${locale}") `
        + `([${selectable.join(", ")}]). Check K would be REFUSING a form the runtime needs, or `
        + "passing a bundle that cannot answer that count — the two halves of #436 have drifted.",
      );
    }
  }
  pluralChainReach.set(locale, reached);

  // The vacuity half. `cldrCardinalCategories` is the language's own tuple, so
  // this asserts the sweep actually exercised Russian's `few`/`many` and
  // Arabic's `two`/`zero` rather than landing on `other` every time.
  for (const category of cldrCardinalCategories(locale)) {
    if (reached.has(category)) continue;
    failures.push(
      `control failed: no count in the sweep produced "${category}" for ${locale}, which CLDR says `
      + "it has. Either the sweep no longer reaches that category — in which case K's residual "
      + "count is measuring a category nothing can select — or the rule for this locale has "
      + "collapsed onto a subset of its categories.",
    );
  }
}

/**
 * Controls for check K's DETECTOR, run against `pluralShapeOf` itself.
 *
 * Every clause gets one, because K's answer on this repository is silence, and
 * each of these is a real bundle somebody could write. The `en` side is held
 * fixed at one key with `one`/`other` and a `%{count}`, which is the shape all
 * 52 real ones have.
 */
const K_ENGLISH = new Map([["items", new Map([["one", "%{count} item"], ["other", "%{count} items"]])]]);
const asForms = (entries) => new Map([["items", new Map(Object.entries(entries))]]);

const PLURAL_SHAPE_CONTROLS = [
  {
    id: "ru missing `other`",
    locale: "ru",
    forms: asForms({ one: "%{count} товар" }),
    mustFail: /no "other"/u,
  },
  {
    id: "ru missing `one`, which Russian selects at 21",
    locale: "ru",
    forms: asForms({ other: "%{count} товаров" }),
    mustFail: /is missing "one"/u,
  },
  {
    id: "renamed placeholder in a form English has no twin for",
    locale: "ru",
    forms: asForms({
      one: "%{count} товар", few: "%{n} товара", many: "%{count} товаров", other: "%{count} товаров",
    }),
    mustFail: /carries placeholders \{n\}/u,
  },
  {
    id: "the key is absent entirely",
    locale: "de",
    forms: new Map(),
    mustFail: /missing or not a plural object/u,
  },
  {
    id: "ru carrying `few`/`many`, which en.json does not have",
    locale: "ru",
    forms: asForms({
      one: "%{count} товар", few: "%{count} товара", many: "%{count} товаров",
      other: "%{count} товаров",
    }),
    mustPass: true,
  },
  {
    id: "ja carrying only `other`, its one category",
    locale: "ja",
    forms: asForms({ other: "商品 %{count} 件" }),
    mustPass: true,
  },
  {
    id: "fr carrying an optional `zero`, which the chain does select",
    locale: "fr",
    forms: asForms({ zero: "aucun produit", one: "%{count} produit", other: "%{count} produits" }),
    mustPass: true,
    // `zero` is not in French's CLDR tuple, so it must not be counted as
    // unreachable either — the whole reason `selectable` and `required` differ.
    mustNotBeUnreachable: true,
  },
  {
    // The other side of the exemption above. `zero` may DROP `%{count}`; it may
    // not INVENT one, and without this control the exemption would be a hole
    // rather than a narrowing — which is how removing an exception removes a
    // check.
    id: "a `zero` form inventing a placeholder English does not have",
    locale: "fr",
    forms: asForms({
      zero: "aucun %{produit}", one: "%{count} produit", other: "%{count} produits",
    }),
    mustFail: /"items\.zero" carries placeholders \{produit\}/u,
  },
];

for (const control of PLURAL_SHAPE_CONTROLS) {
  const result = pluralShapeOf({
    path: `control/${control.locale}.json`,
    locale: control.locale,
    englishPlurals: K_ENGLISH,
    plurals: control.forms,
  });
  if (control.mustFail) {
    if (!result.failures.some((failure) => control.mustFail.test(failure))) {
      failures.push(
        `positive control failed: check K did not report ${control.mustFail} for "${control.id}" — `
        + `it said ${JSON.stringify(result.failures)}. K's answer on the real tree is silence, so a `
        + "clause that stopped firing is invisible.",
      );
    }
  }
  if (control.mustPass && result.failures.length > 0) {
    failures.push(
      `negative control failed: check K rejected "${control.id}" (${result.failures.join("; ")}). `
      + "That is a bundle #436 exists to make legal, and a guard that refuses the correct answer is "
      + "one whoever hits it will loosen.",
    );
  }
  if (control.mustNotBeUnreachable && result.unreachable.length > 0) {
    failures.push(
      `negative control failed: check K counted ${result.unreachable.join(", ")} as unreachable in `
      + `"${control.id}". The chain selects \`zero\` at count 0 in every locale, so counting it `
      + "against the pin would push somebody to delete copy that renders.",
    );
  }
}

/**
 * Controls for check E's detector, run on every invocation for the same reason.
 *
 * The three that must NOT fire are the whole point: an import, a comment and a
 * string all name the provider without mounting it, and a substring check —
 * which is the obvious way to write this — accepts all three. So does a root
 * layout that imports the provider and then forgets the element, which is
 * exactly the regression E exists for.
 */
const PROVIDER_CONTROL_MOUNTED = [
  `const A = () => <${SHARED_UI_PROVIDER} t={t}><Stack /></${SHARED_UI_PROVIDER}>;`,
  `const A = () => <Boundary><${SHARED_UI_PROVIDER} t={t}><Stack /></${SHARED_UI_PROVIDER}></Boundary>;`,
  `const A = () => <${SHARED_UI_PROVIDER} t={t} />;`,
];
const PROVIDER_CONTROL_NOT_MOUNTED = [
  `import { ${SHARED_UI_PROVIDER} } from "@mercaria/ui";\nconst A = () => <Stack />;`,
  `// mount the ${SHARED_UI_PROVIDER} here\nconst A = () => <Stack />;`,
  `const name = "${SHARED_UI_PROVIDER}";`,
  "const A = () => <BloomThemeProvider><Stack /></BloomThemeProvider>;",
];
for (const source of PROVIDER_CONTROL_MOUNTED) {
  if (!mountsSharedUiProvider("control/provider.tsx", source)) {
    failures.push(
      `positive control failed: ${JSON.stringify(source)} did not read as mounting `
      + `${SHARED_UI_PROVIDER} — the detector is broken, and a broken detector reports every app `
      + "as un-mounted, which is loud; this direction is the quiet one",
    );
  }
}
for (const source of PROVIDER_CONTROL_NOT_MOUNTED) {
  if (mountsSharedUiProvider("control/provider.tsx", source)) {
    failures.push(
      `negative control failed: ${JSON.stringify(source)} read as mounting ${SHARED_UI_PROVIDER} — `
      + "the detector is a substring match, so an app that imports the provider and never renders "
      + "it would pass while every shared sentence fell back to English",
    );
  }
}

// -------------------------------------------------------------- the scan ----

const sources = tracked.filter(
  (path) =>
    SOURCE_FILE.test(path)
    && OWNERS.some((owner) => path.startsWith(owner.prefix))
    && !GUARD_OWN_FILES.has(path),
);

let translatedPositions = 0;
/** Per owner, so one owner's count cannot cover for another's broken traversal. */
const translatedByApp = new Map(OWNERS.map((owner) => [owner.name, 0]));
/** Every string literal seen per owner — part C's evidence that a key is used. */
const literalsByApp = new Map(OWNERS.map((owner) => [owner.name, new Set()]));
/** Every `t('literal')` site per owner, so part C can name the file and line. */
const translateSitesByApp = new Map(OWNERS.map((owner) => [owner.name, []]));
/** Files scanned per owner — the per-owner half of the vacuity floor below. */
const filesByApp = new Map(OWNERS.map((owner) => [owner.name, 0]));

/** F: `{ key -> site }` per owner for each of its two populations. */
const controlLabelKeysByApp = new Map(OWNERS.map((owner) => [owner.name, new Map()]));
const interpolatedKeysByApp = new Map(OWNERS.map((owner) => [owner.name, new Map()]));
/** H: `{ file, line, method }` for every date formatted in the device's locale. */
const deviceLocaleFormatsByApp = new Map(OWNERS.map((owner) => [owner.name, []]));
/** I: `{ file, line, map, kind }` for every key map rendered without `t()`. */
const rawKeyRendersByApp = new Map(OWNERS.map((owner) => [owner.name, []]));
/**
 * I: the FEWEST key maps any one of an owner's files could have fired on.
 *
 * The minimum rather than the total, and it is the minimum that makes this a
 * witness: every file receives the app-wide set and adds whatever it declares
 * itself, so the smallest value across an owner's files IS the size of the set
 * the caller actually handed the analyser. A sum, or the deriver's own count,
 * both stay right while the argument is empty.
 */
const renderableSeenByApp = new Map(OWNERS.map((owner) => [owner.name, null]));
/** J: `{ file, line, field, text }` for every wire identifier rendered raw. */
const wireIdentifierRendersByApp = new Map(OWNERS.map((owner) => [owner.name, []]));

/**
 * How many check-A findings an owner whose `hardcodedStrings` is a pinned COUNT
 * produced.
 *
 * A count rather than the findings, because a count is the whole of what this
 * pin can honestly assert: it cannot tell a newly-added string from one that was
 * always there, so keeping the list would only invite a report that looks like
 * it answers "which ones are new" and does not.
 */
const pinnedHardcodedByApp = new Map(OWNERS.map((owner) => [owner.name, 0]));
/** F: how many `t()` arguments it could not read, per owner. Reported, never assumed zero. */
const unreadableKeySourcesByApp = new Map(OWNERS.map((owner) => [owner.name, []]));

// Check F needs every owner's module-scope key maps BEFORE any file is
// analysed: a label record is routinely declared in one file and used in
// another (`CHANNEL_TYPE_NAME_KEYS` lives in `channel-presentation.tsx` and is
// read from two other screens), so a per-file bag would leave those unreadable
// and F would silently see a smaller tree than it reports.
const textByPath = new Map();
for (const path of sources) {
  const text = await readTracked(path);
  if (text !== null) textByPath.set(path, text);
}

const keyMapsByApp = new Map(OWNERS.map((owner) => [owner.name, new Map()]));
const collidingKeyMapNames = new Map(OWNERS.map((owner) => [owner.name, new Set()]));
for (const [path, text] of textByPath) {
  const app = OWNERS.find((candidate) => path.startsWith(candidate.prefix));
  const bag = keyMapsByApp.get(app.name);
  for (const [name, value] of collectKeyMaps(path, text)) {
    if (bag.has(name)) collidingKeyMapNames.get(app.name).add(name);
    bag.set(name, value);
  }
}
// Two files in one app declaring the same name is ambiguous, and resolving it
// to whichever happened to be read last is a WRONG answer rather than a missing
// one — it would attribute one screen's keys to another's control. Drop the
// name from the shared bag; the file that declares it still resolves its own,
// and everywhere else F reports the site as unreadable, which is honest.
for (const owner of OWNERS) {
  const bag = keyMapsByApp.get(owner.name);
  for (const name of collidingKeyMapNames.get(owner.name)) bag.delete(name);
}

/**
 * I: the key-map NAMES each owner's files may not render without `t()`.
 *
 * Derived, never hand-listed — which is what makes it self-maintaining as more
 * copy converts, and #542's whole point is that EVERY future conversion
 * reintroduces this risk. A map earns its place by holding keys the owner can
 * actually resolve (`isKeyMap`), so a record of chip classes or icon sizes is
 * not in the population and check I can never fire on one.
 *
 * A `packages/ui` map is in EVERY owner's set, because `mergeSharedUiCopy` puts
 * that package's copy under the reserved `ui` namespace in all three apps at
 * runtime — so a dashboard screen rendering `{CONDITION_LABEL_KEYS[x]}` ships a
 * `ui.` message id to a merchant exactly as a `packages/ui` component would. It
 * is matched against `ui`'s OWN vocabulary for the same reason: check D forbids
 * an app bundle from claiming that namespace, so the app's `knownKeys` cannot
 * contain a single one of those keys and filtering against it would empty the
 * set silently.
 *
 * A name two files in one owner both declare is NOT dropped the way the check-F
 * bag drops it. F resolves a name to a key SET and an ambiguous one gives a
 * wrong answer; I only asks "is this name a key map", and two key maps sharing a
 * name are still both key maps, so the ambiguity does not reach the question.
 */
const renderableKeyMapsByApp = new Map(OWNERS.map((owner) => [owner.name, new Set()]));
{
  const sharedOwner = OWNERS.find((owner) => owner.name === SHARED_UI_OWNER);
  const sharedKeys = knownKeysByApp.get(SHARED_UI_OWNER);
  for (const [path, text] of textByPath) {
    const app = OWNERS.find((candidate) => path.startsWith(candidate.prefix));
    const isShared = path.startsWith(sharedOwner.prefix);
    const vocabulary = isShared ? sharedKeys : knownKeysByApp.get(app.name);
    for (const [name, value] of collectKeyMaps(path, text)) {
      if (!isKeyMap(value, vocabulary)) continue;
      if (isShared) for (const owner of OWNERS) renderableKeyMapsByApp.get(owner.name).add(name);
      else renderableKeyMapsByApp.get(app.name).add(name);
    }
  }
}

for (const [path, text] of textByPath) {
  const app = OWNERS.find((candidate) => path.startsWith(candidate.prefix));
  const result = analyseSource(
    path, text, knownKeysByApp.get(app.name), keyMapsByApp.get(app.name),
    renderableKeyMapsByApp.get(app.name),
  );
  filesByApp.set(app.name, filesByApp.get(app.name) + 1);
  // H, I and J run for EVERY owner, including the two whose `hardcodedStrings`
  // and `actionLabelCopy` are off: a date in the wrong language, a rendered
  // message id and a raw wire enum are none of them a hardcoded string and none
  // of them an action label, so neither switch describes any of the three.
  for (const site of result.deviceLocaleFormatSites) {
    deviceLocaleFormatsByApp.get(app.name).push({ ...site, file: path });
  }
  for (const site of result.rawKeyRenderSites) {
    rawKeyRendersByApp.get(app.name).push({ ...site, file: path });
  }
  const seenSoFar = renderableSeenByApp.get(app.name);
  renderableSeenByApp.set(
    app.name,
    seenSoFar === null ? result.renderableKeyMapCount
      : Math.min(seenSoFar, result.renderableKeyMapCount),
  );
  for (const site of result.wireIdentifierRenderSites) {
    wireIdentifierRendersByApp.get(app.name).push({ ...site, file: path });
  }
  if (app.actionLabelCopy) {
    const controls = controlLabelKeysByApp.get(app.name);
    for (const site of result.controlLabelSites) {
      if (!controls.has(site.key)) controls.set(site.key, { ...site, file: path });
    }
    const interpolated = interpolatedKeysByApp.get(app.name);
    for (const site of result.interpolatedSites) {
      if (!interpolated.has(site.key)) interpolated.set(site.key, { ...site, file: path });
    }
    const unreadable = unreadableKeySourcesByApp.get(app.name);
    for (const site of result.unreadableKeySources) unreadable.push({ ...site, file: path });
  }
  // An owner that is only PART way through extraction contributes its literals
  // (part C needs them) and none of its check-A findings — but the findings are
  // COUNTED, and that count is pinned below. Discarding them outright is what
  // made a stalled conversion and a regressing one look the same (#528).
  if (app.hardcodedStrings === true) findings.push(...result.findings);
  else pinnedHardcodedByApp.set(app.name, pinnedHardcodedByApp.get(app.name) + result.findings.length);
  translatedPositions += result.translatedPositions;
  translatedByApp.set(app.name, translatedByApp.get(app.name) + result.translatedPositions);
  const seen = literalsByApp.get(app.name);
  for (const literal of result.literals) seen.add(literal);
  const sites = translateSitesByApp.get(app.name);
  for (const site of result.translateKeys) sites.push({ ...site, file: path });
}

// ------------------------------------------------- B and C: the bundles -----

for (const app of OWNERS) {
  const flatByLocale = bundlesByApp.get(app.name) ?? new Map();
  const pluralsByLocale = pluralsByApp.get(app.name) ?? new Map();
  const englishPath = `${app.locales}/en.json`;
  const english = flatByLocale.get(englishPath);
  if (!english) {
    failures.push(`${app.name}: ${englishPath} is missing — every other locale falls back to it`);
    continue;
  }

  if (flatByLocale.size < floorFor(app.minimumLocales)) {
    failures.push(
      `${app.name} has ${flatByLocale.size} locale bundles, below the `
      + `${floorFor(app.minimumLocales)} floor — the parity check below compares every sibling `
      + "against en.json, so with the siblings missing it compares nothing and reports clean",
    );
  }

  if (english.size < floorFor(app.minimumKeys)) {
    failures.push(
      `${englishPath} holds ${english.size} keys, below the ${floorFor(app.minimumKeys)} floor — `
      + "a bundle that small means the extraction regressed or the file listing is broken",
    );
  }

  const scanned = filesByApp.get(app.name) ?? 0;
  if (scanned < floorFor(app.minimumSourceFiles)) {
    failures.push(
      `${scanned} source files scanned under ${app.prefix}, below the `
      + `${floorFor(app.minimumSourceFiles)} floor — a prefix that matches nothing reports a clean `
      + "tree, and the repository-wide floor below cannot see one owner drop out",
    );
  }

  const seen = translatedByApp.get(app.name) ?? 0;
  if (app.minimumTranslatedPositions !== null
    && seen < floorFor(app.minimumTranslatedPositions)) {
    failures.push(
      `${seen} translated positions seen in packages/${app.name}, below the `
      + `${floorFor(app.minimumTranslatedPositions)} floor — the analyser reached almost no `
      + "user-facing position there, which is exactly what a fully extracted app would also look "
      + "like if the traversal were broken",
    );
  }

  // I's vacuity floor, and it is the one that carries this check (#542).
  //
  // Check I's real-tree answer is ZERO, so nothing in its own output can tell a
  // clean tree from a POPULATION that came out empty — and the population is
  // derived, which means a change to `collectKeyMaps`, to `isKeyMap`, or to how
  // a map is spelled (an inline `Object.freeze({…})` is already one this cannot
  // read) shrinks it silently and in the green direction. The controls prove the
  // DETECTOR works; this proves it was pointed at something.
  const renderable = renderableSeenByApp.get(app.name) ?? 0;
  if (renderable < floorFor(app.minimumRenderableKeyMaps)) {
    failures.push(
      `packages/${app.name}: the analyser saw ${renderable} renderable key map(s), below the `
      + `${floorFor(app.minimumRenderableKeyMaps)} floor — check I has almost nothing to fire on, `
      + "which is indistinguishable from a tree where every key map is correctly wrapped in `t()`. "
      + "Either the derivation broke, this app's copy moved somewhere `collectKeyMaps` cannot read "
      + "it, or the population stopped being PASSED to `analyseSource`.",
    );
  }

  // B. parity
  //
  // Every leaf UNDER an English plural key is handed to K instead, in all three
  // loops. Leaving them here would fail a Russian `many` as an extra key and
  // demand `one` from a Japanese bundle that can never select it — and the
  // placeholder loop below `continue`s on a form with no English twin, which is
  // precisely where a renamed `%{count}` in a `few` form would have slipped
  // through. K re-checks all three properties against the locale's own
  // categories; it is a narrowing of B's SUBJECT, not of what is asserted.
  const englishPlurals = pluralsByLocale.get(englishPath) ?? new Map();
  pluralKeysByApp.set(app.name, englishPlurals.size);
  const underEnglishPlural = (key) => {
    const parent = pluralParentOf(key);
    return parent !== null && englishPlurals.has(parent);
  };

  for (const [path, flat] of flatByLocale) {
    if (path === englishPath) continue;
    for (const key of english.keys()) {
      if (underEnglishPlural(key)) continue;
      if (!flat.has(key)) {
        failures.push(
          `${path}: missing key "${key}". enableFallback renders the ENGLISH string for it, so this `
          + "screen looks translated in review and is not.",
        );
      }
    }
    for (const key of flat.keys()) {
      if (underEnglishPlural(key)) continue;
      if (!english.has(key)) {
        failures.push(`${path}: key "${key}" does not exist in en.json — it can never be rendered.`);
      }
    }
    for (const [key, value] of flat) {
      if (underEnglishPlural(key)) continue;
      const source = english.get(key);
      if (source === undefined) continue;
      if (placeholdersOf(value) !== placeholdersOf(source)) {
        failures.push(
          `${path}: "${key}" carries placeholders {${placeholdersOf(value) || "none"}} but en.json `
          + `carries {${placeholdersOf(source) || "none"}}. A renamed placeholder renders the literal `
          + "%{name} to a merchant.",
        );
      }
    }
  }

  // K. plural shape, per LOCALE rather than per English (#436).
  //
  // The module note above says what this replaced and why. Two residuals are
  // counted here and pinned below; everything else is a failure.
  let categoryResidual = 0;
  let unreachableForms = 0;
  const residualExamples = [];
  const unreachableExamples = [];

  for (const [path, plurals] of pluralsByLocale) {
    if (path === englishPath) continue;
    const locale = localeOfBundlePath(path);
    if (locale === null) {
      failures.push(
        `${path}: not a bundle for any locale in SUPPORTED_LOCALES. Check K validates plural `
        + "categories against the locale's own CLDR set, and it has no set for a file it cannot "
        + "name — so an unrecognised bundle is refused rather than skipped.",
      );
      continue;
    }
    const result = pluralShapeOf({ path, locale, englishPlurals, plurals });
    failures.push(...result.failures);
    categoryResidual += result.missing.length;
    unreachableForms += result.unreachable.length;
    for (const at of result.missing) {
      if (residualExamples.length < 4) residualExamples.push(`${path} "${at}"`);
    }
    for (const at of result.unreachable) {
      if (unreachableExamples.length < 4) unreachableExamples.push(`${path} "${at}"`);
    }
  }

  // Both residuals are EXACT counts and fail in both directions, for the reason
  // `deviceLocaleFormatSites` is: a ceiling would let the gap grow back after
  // somebody paid part of it down, and a floor would fail the PR that pays any
  // of it down. Filling a form in, or deleting a dead one, moves the pin in the
  // same change — which is the point, because that is when a human decided.
  if (!fixtureFloors && app.pluralCategoryResidual !== null
    && categoryResidual !== app.pluralCategoryResidual) {
    failures.push(
      `packages/${app.name}: ${categoryResidual} plural form(s) missing for a category the locale `
      + `CAN select, expected exactly ${app.pluralCategoryResidual}.\n`
      + `      e.g. ${residualExamples.join("\n           ") || "(none)"}\n`
      + "      These render the `other` form today — no worse than before #436 and no better. "
      + "Writing them is grammar in languages nobody here can review, so they are counted rather "
      + "than invented. If you ADDED forms, lower this owner's `pluralCategoryResidual`; if this "
      + "rose, a bundle lost a form or a locale gained a category.",
    );
  }
  if (!fixtureFloors && app.pluralUnreachableForms !== null
    && unreachableForms !== app.pluralUnreachableForms) {
    failures.push(
      `packages/${app.name}: ${unreachableForms} plural form(s) the runtime can NEVER select, `
      + `expected exactly ${app.pluralUnreachableForms}.\n`
      + `      e.g. ${unreachableExamples.join("\n           ") || "(none)"}\n`
      + "      Copy no count can reach. Today's are the `one` forms in ja and zh-Hans, whose only "
      + "CLDR category is `other`; deleting them changes what count=1 renders wherever the two "
      + "strings differ, which is a copy decision rather than a cleanup. A RISE here is a category "
      + "written into a locale that has no such form — dead the day it landed.",
    );
  }

  // K's vacuity floor. Its healthy answer is "no failures", so an English plural
  // population that came out EMPTY reports exactly what a correct tree reports —
  // and that population is derived from `collectPlurals`, which a change to how
  // a plural is spelled would shrink silently and in the green direction.
  if (englishPlurals.size < floorFor(app.minimumPluralKeys)) {
    failures.push(
      `packages/${app.name}: check K found ${englishPlurals.size} plural key(s) in ${englishPath}, `
      + `below the ${floorFor(app.minimumPluralKeys)} floor — with that population empty K validates `
      + "nothing and passes, which is indistinguishable from a bundle set whose plurals are all "
      + "correct.",
    );
  }

  // G. the placeholder syntax is the one i18n-js actually reads (#487).
  //
  // Runs over EVERY bundle including `en` — the original defect was in the
  // English source string too, and a check that skipped it would have reported
  // eleven of the twelve. Needs no vacuity floor of its own: `minimumKeys` and
  // `minimumLocales` above already floor this exact population, so a bundle set
  // that read as empty fails there first.
  for (const [path, flat] of flatByLocale) {
    for (const [key, value] of flat) {
      const foreign = foreignPlaceholdersOf(value);
      if (foreign.length === 0) continue;
      failures.push(
        `${path}: "${key}" carries ${foreign.join(", ")}, which i18n-js does NOT interpolate — it `
        + "reads %{name}. The braces render literally to a shopper. Check B cannot see this: it "
        + "compares bundles against each other, and all twelve can be wrong together.",
      );
    }
  }

  // H. dates are formatted in the APP's locale, not the DEVICE's (#488).
  //
  // An EXACT count rather than a ceiling, and it is skipped on a fixture tree
  // for the reason `fixtureFloors` exists: a scratch checkout of six files has
  // none of the real call sites, so every pinned residual would fail for a
  // reason that says nothing about the guard. H's own detector is still
  // exercised on a fixture run — its positive and negative controls run on
  // EVERY invocation, which is what keeps this from being untested there.
  const deviceLocaleSites = deviceLocaleFormatsByApp.get(app.name) ?? [];
  if (!fixtureFloors && app.deviceLocaleFormatSites !== null
    && deviceLocaleSites.length !== app.deviceLocaleFormatSites) {
    const listing = deviceLocaleSites
      .map((site) => `${site.file}:${site.line} ${site.method}()`)
      .join("\n      ");
    failures.push(
      `packages/${app.name}: ${deviceLocaleSites.length} date(s) formatted in the DEVICE locale, `
      + `expected exactly ${app.deviceLocaleFormatSites}.\n`
      + `      ${listing || "(none)"}\n`
      + "      A `toLocale*String()` with no locale argument — or an explicit `undefined`, which is "
      + "the same thing — renders in the DEVICE's language, so a shopper reading Mercaria in "
      + "Japanese on an English phone gets an English date inside a Japanese sentence.\n"
      + "      The remedy is `formatDate`/`formatDateTime` from @mercaria/ui with the locale "
      + "`useTranslation()` already returns. If you FIXED some of these, lower the owner's "
      + "`deviceLocaleFormatSites` in this file to the new count — it is an exact count, not a "
      + "ceiling, so the number cannot quietly drift in either direction.",
    );
  }

  // I. a key map rendered WITHOUT `t()` (#542).
  //
  // RAISED rather than pinned, unlike H and J, and the difference is confidence
  // rather than taste: the population is derived from maps whose every value is
  // a real key, so a read of one in a render position resolves to a message id
  // by construction. There is no legitimate spelling of it and therefore no
  // residual to hold a number against. The real-tree answer is ZERO for all
  // four owners — the nineteen #541 found are fixed — so the controls below,
  // not this loop, are what prove the detector still works.
  for (const site of rawKeyRendersByApp.get(app.name) ?? []) {
    failures.push(
      `${site.file}:${site.line}: \`${site.text}\` renders a TRANSLATION KEY, not a sentence — `
      + `\`${site.map}\` holds keys and this ${site.kind} is missing its \`t(…)\`.\n`
      + "      The screen shows the raw message id in EVERY locale, English included, so this is "
      + "not a \"shows English to a Spanish reader\" bug somebody eventually reports — it is "
      + "visible to everyone and to no other check here.\n"
      + "      `tsc` cannot see it: a key and a sentence are both `string`. Wrap the read: "
      + `\`t(${site.map}[…])\`.`,
    );
  }

  // J. a wire enum rendered raw to a reader (#530, the class #489 named).
  //
  // PINNED per owner like H, and for H's reason: the thirteen live sites are a
  // known, enumerated set, and fixing them is a key map or a localized lookup
  // apiece across three packages — work with its own review, handed over with
  // the measurement attached rather than folded into the change that measures
  // it. Exact in both directions, so a NEW one fails immediately and fixing
  // some fails until the number comes down with them.
  const wireSites = wireIdentifierRendersByApp.get(app.name) ?? [];
  if (!fixtureFloors && app.wireIdentifierRenderSites !== null
    && wireSites.length !== app.wireIdentifierRenderSites) {
    const listing = wireSites
      .map((site) => `${site.file}:${site.line} {${site.text}}`)
      .join("\n      ");
    failures.push(
      `packages/${app.name}: ${wireSites.length} wire identifier(s) rendered raw to a reader, `
      + `expected exactly ${app.wireIdentifierRenderSites}.\n`
      + `      ${listing || "(none)"}\n`
      + "      The English here is GENERATED AT RUNTIME from an identifier, so no literal-based "
      + "instrument can find it: there is no key for parity or referential integrity to check, "
      + "check A has no string to read, and `tsc` types it a perfectly good `string`.\n"
      + "      The remedy is a key map (`SEARCH_RESULT_KIND_KEYS` in the storefront's `search.tsx`) "
      + "or a localized lookup (`formatRegionName` for a country). If you FIXED some of these, "
      + "lower the owner's `wireIdentifierRenderSites` in this file to the new count — an exact "
      + "count, not a ceiling.",
    );
  }

  // A'. a mid-extraction owner's hardcoded-string count is PINNED (#528).
  //
  // Skipped on a fixture tree for H's reason: a scratch checkout has none of the
  // real call sites, so a pinned residual would fail for a reason that says
  // nothing about the guard. Check A's own detector is exercised on a fixture
  // run either way — its controls run on every invocation.
  //
  // Both directions fail. UP is the one this exists for: it is the direction a
  // ceiling would permit, and the direction in which a package mid-conversion
  // silently acquires two hundred new English strings. DOWN fails because a pin
  // that only ratchets on regression stops describing the package the moment
  // somebody makes progress, and a number nobody maintains is one nobody reads.
  const pinnedHardcoded = pinnedHardcodedByApp.get(app.name) ?? 0;
  if (!fixtureFloors && typeof app.hardcodedStrings === "number"
    && pinnedHardcoded !== app.hardcodedStrings) {
    const delta = pinnedHardcoded - app.hardcodedStrings;
    // Deliberately NOT a listing of the findings. This check COUNTS; it cannot
    // tell a new string from one that was always there, and printing forty of a
    // hundred and fifty-six would look like an answer to "which ones are new"
    // while not being one. The reader's own diff is where that lives, and
    // saying so is more use than the dump.
    failures.push(
      `packages/${app.name}: ${pinnedHardcoded} hardcoded user-facing string(s), expected `
      + `exactly ${app.hardcodedStrings} (${delta > 0 ? `+${delta}` : delta}).\n`
      + "      This owner is mid-extraction, so check A does not RAISE its findings — it pins their\n"
      + "      COUNT, in both directions, the way H pins `deviceLocaleFormatSites`.\n"
      + `      ${delta > 0
        ? "The count went UP: your change introduced English copy into a package that is being "
          + "extracted OUT of it.\n"
          + "      This check counts and cannot say which strings are new — your own diff can. The "
          + "remedy is to put\n      the copy in this package's own bundles under the reserved `ui` "
          + "namespace, or to raise the pin\n      with a reason covering it."
        : "The count went DOWN, which is progress: lower the owner's `hardcodedStrings` in this "
          + "file to the\n      new count. It is an exact count rather than a ceiling, so it cannot "
          + "quietly drift in either\n      direction, and a pin nobody maintains is one nobody "
          + "reads."}\n`
      + "      When it reaches 0, change `hardcodedStrings` to `true` and this owner is finished.",
    );
  }

  // C. referential integrity
  const literals = literalsByApp.get(app.name) ?? new Set();
  for (const key of english.keys()) {
    if (!literals.has(key) && !literals.has(pluralParentOf(key))) {
      failures.push(
        `${englishPath}: "${key}" is named by no string literal in packages/${app.name}. Either it is `
        + "dead copy, or the call site that used it was replaced with a hardcoded English string.",
      );
    }
  }
  // C. every `t('literal')` names a real key.
  const resolvable = knownKeysByApp.get(app.name) ?? new Set();
  for (const site of translateSitesByApp.get(app.name) ?? []) {
    if (resolvable.has(site.key)) continue;
    failures.push(
      `${site.file}:${site.line}: t(${JSON.stringify(site.key)}) names no key in ${englishPath}. `
      + "i18n-js renders a humanised guess of the key, which reads like real copy.",
    );
  }
}

// ------------------------------------------- D: the reserved `ui` namespace --

// `mergeSharedUiCopy` spreads `@mercaria/ui`'s bundle over the app's, so a
// top-level `ui` key on either side is one silently replacing the other. The
// runtime merge throws on it; this is what stops it reaching a runtime. Both
// populations are DERIVED from the tracked listing — a hand list would skip a
// fourth app, and "the guard found fewer" reads identically to "there are
// fewer", which is what the two floors are for.

const sharedOwner = OWNERS.find((owner) => owner.name === SHARED_UI_OWNER);
for (const [path, topLevel] of topLevelKeysByPath) {
  if (!path.startsWith(`${sharedOwner.locales}/`)) continue;
  if (topLevel.length !== 1 || topLevel[0] !== SHARED_UI_NAMESPACE) {
    failures.push(
      `${path}: a shared bundle's only top-level key must be "${SHARED_UI_NAMESPACE}", found `
      + `[${topLevel.join(", ")}]. Anything else is merged into every app's instance outside the `
      + "reserved namespace, where it silently overwrites app copy or is overwritten by it.",
    );
  }
}

const appBundlePaths = tracked.filter((path) => APP_LOCALE_BUNDLE.test(path));
if (appBundlePaths.length < MINIMUM_APP_BUNDLES) {
  failures.push(
    `${appBundlePaths.length} app locale bundles found, below the ${MINIMUM_APP_BUNDLES} floor — `
    + "the derivation matched almost nothing, and a derivation that matches nothing reports every "
    + "app clean of the reserved-namespace collision",
  );
}
for (const path of appBundlePaths) {
  const text = await readTracked(path);
  if (text === null) continue;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    failures.push(`${path}: not valid JSON (${error.message})`);
    continue;
  }
  if (Object.prototype.hasOwnProperty.call(parsed, SHARED_UI_NAMESPACE)) {
    failures.push(
      `${path}: has a top-level "${SHARED_UI_NAMESPACE}" key, which is reserved for `
      + "@mercaria/ui's own copy (#437). mergeSharedUiCopy refuses this at boot; rename the app key.",
    );
  }
}

// ------------------------------------------- E: the provider is mounted ------

const rootLayouts = tracked.filter((path) => ROOT_LAYOUT.test(path));
if (rootLayouts.length < MINIMUM_ROOT_LAYOUTS) {
  failures.push(
    `${rootLayouts.length} app root layouts found, below the ${MINIMUM_ROOT_LAYOUTS} floor — `
    + "the derivation matched almost nothing, so this check verified almost nothing",
  );
}
for (const path of rootLayouts) {
  const text = await readTracked(path);
  if (text === null) continue;
  if (!mountsSharedUiProvider(path, text)) {
    failures.push(
      `${path}: does not mount <${SHARED_UI_PROVIDER}>. Every component in @mercaria/ui that renders `
      + "its own copy resolves through it; without one they fall back to that package's English "
      + "silently, in an app whose own screens are correctly translated (#437).",
    );
  }
}

// ------------------------------- F: an action label is not a noun (#442) -----

let actionLabelOwners = 0;
for (const app of OWNERS) {
  if (!app.actionLabelCopy) continue;
  actionLabelOwners += 1;
  const controls = controlLabelKeysByApp.get(app.name);
  const interpolated = interpolatedKeysByApp.get(app.name);

  // F's ANSWER is an intersection, and the passing answer is the empty one — so
  // an empty intersection means nothing unless both inputs were non-empty. A
  // walk that read no control labels, or no interpolations, reports exactly the
  // same clean run as a correct tree.
  if (controls.size < floorFor(app.minimumControlLabelKeys)) {
    failures.push(
      `${app.name}: check F saw ${controls.size} keys rendered as an action control's label, `
      + `below the ${floorFor(app.minimumControlLabelKeys)} floor — with that population empty F `
      + "intersects nothing and passes, which is indistinguishable from a clean tree",
    );
  }
  if (interpolated.size < floorFor(app.minimumInterpolatedKeys)) {
    failures.push(
      `${app.name}: check F saw ${interpolated.size} keys interpolated into another translated `
      + `sentence, below the ${floorFor(app.minimumInterpolatedKeys)} floor — same reason as above, `
      + "from the other side of the intersection",
    );
  }

  for (const [key, control] of controls) {
    const use = interpolated.get(key);
    if (!use) continue;
    failures.push(
      `${key} is BOTH an action control's label and a value interpolated into a sentence (#442).\n`
      + `    label       ${control.file}:${control.line} inside <${control.tag}>\n`
      + `    interpolated ${use.file}:${use.line} into "${use.frame}"\n`
      + "    An action label is an imperative — \"Keep products\", \"Produkte behalten\", "
      + "\"Оставить товары\" — and a\n"
      + "    sentence slot needs a term, so the frame reads \"…happens to the keep products this "
      + "channel\n    imported\" in every language. Give the sentence its OWN key rather than "
      + "reusing the label's.",
    );
  }
}

if (actionLabelOwners < floorFor(2)) {
  failures.push(
    `check F ran over ${actionLabelOwners} owners, below the ${floorFor(2)} floor — `
    + "an owner list that matched nothing runs F over nothing and reports clean",
  );
}

// ---------------------------------------------------------- vacuity floors --

if (sources.length < MINIMUM_SOURCE_FILES) {
  failures.push(
    `${sources.length} source files scanned is below the ${MINIMUM_SOURCE_FILES} floor — `
    + "the file listing is probably broken, and a broken listing reports a clean tree",
  );
}

// ------------------------------------------------------------------ verdict --

if (findings.length > 0 || failures.length > 0) {
  console.error("i18n string guard failed:\n");
  for (const finding of findings) {
    console.error(`  ${finding.file}:${finding.line}: hardcoded user-facing string [${finding.kind}]`);
    console.error(`    ${JSON.stringify(finding.text)}`);
    console.error(
      "    Move it to that app's lib/i18n/locales/en.json, render it with t('key'), "
      + "and translate it in every sibling bundle.\n",
    );
  }
  for (const failure of failures) console.error(`  ${failure}\n`);
  console.error(
    "  The dashboard and POS were translated in #398. A hardcoded string is invisible to tsc,\n"
    + "  to lint and to every build job — it just renders in English to somebody who does not read it.\n",
  );
  process.exit(1);
}

const actionLabelSummary = OWNERS
  .filter((owner) => owner.actionLabelCopy)
  .map((owner) => {
    const unreadable = unreadableKeySourcesByApp.get(owner.name).length;
    return `${owner.name} ${controlLabelKeysByApp.get(owner.name).size} label/`
      + `${interpolatedKeysByApp.get(owner.name).size} interpolated`
      + (unreadable > 0 ? ` (${unreadable} unreadable)` : "");
  })
  .join(", ");

console.log(
  `i18n string guard passed — ${sources.length} source files scanned across `
  + `${OWNERS.map((owner) => owner.prefix).join(", ")}; ${translatedPositions} translated positions seen; `
  + `${appBundlePaths.length} app bundles and ${rootLayouts.length} app roots checked for the `
  + `reserved "${SHARED_UI_NAMESPACE}" namespace and <${SHARED_UI_PROVIDER}>; `
  + `check F intersected ${actionLabelSummary}; `
  // Check I's population, reported for check F's reason: its finding count is
  // ZERO on a healthy tree, so the only number that says the check was pointed
  // at anything is the size of what it scanned.
  + `check I watched ${OWNERS.map((owner) => `${owner.name} `
    + `${renderableSeenByApp.get(owner.name) ?? 0}`).join("/")} key maps; `
  // K's populations, reported for the same reason as I's: its healthy answer is
  // silence, so the only numbers saying it was pointed at anything are how many
  // plural keys it validated and how far the chain sweep reached.
  + `check K validated ${OWNERS.map((owner) => `${owner.name} `
    + `${pluralKeysByApp.get(owner.name) ?? 0}`).join("/")} plural keys against `
  + `${SUPPORTED_LOCALES.length} locales, chain sweep reaching `
  + `${[...pluralChainReach.values()].reduce((total, reached) => total + reached.size, 0)} `
  + "locale/category pairs; "
  + `${CONTROL_MUST_FIND.length + PROVIDER_CONTROL_MOUNTED.length + ACTION_LABEL_MUST_FIND.length
    + DEVICE_LOCALE_MUST_FIND.length + RAW_KEY_MUST_FIND.length
    + WIRE_IDENTIFIER_MUST_FIND.length} `
  + "positive and "
  + `${CONTROL_MUST_NOT_FIND.length + PROVIDER_CONTROL_NOT_MOUNTED.length
    + ACTION_LABEL_MUST_NOT_FIND.length + DEVICE_LOCALE_MUST_NOT_FIND.length
    + RAW_KEY_MUST_NOT_FIND.length + WIRE_IDENTIFIER_MUST_NOT_FIND.length} `
  + "negative controls run.",
);

// Printed on every PASS, deliberately, and phrased as an exclusion rather than
// a caveat. Check A decides the positions it can decide FROM THE SYNTAX, and
// #435b found four shapes it cannot — each of which reaches a reader as raw
// English while this line says "passed". A green run that does not say so is
// the failure this guard exists to prevent, one level up: it would read as
// "this app has no hardcoded copy", which is not what was measured.
//
// Three of the four are caught by check C ONCE EXTRACTED, because the migrated
// form stores KEYS in the map and writing English back leaves a key referenced
// by nothing. The fourth cannot be caught by anything here: there is no literal.
console.log(
  "  Not decided by check A, and not a claim this run makes: a module-scope "
  + "initializer holding sentences (array OR record), a function or `switch` "
  + "that RETURNS copy, a parameter default, and text derived at runtime from "
  + "an identifier (`kind.replace(/_/gu, ' ')`), which has no literal to find. "
  + "Nor an English string thrown as an `Error` and rendered from "
  + "`error.message`. See docs/app-i18n.md §\"What the guard cannot see\".",
);
