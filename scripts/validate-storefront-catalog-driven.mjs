#!/usr/bin/env bun

/**
 * The storefront must stay catalog-driven (#367 workstream 9).
 *
 * The epic's non-negotiable for this workstream is one sentence:
 *
 * > No category-specific or product-type-specific field list, filter list, spec
 * > list or controlled value anywhere in `packages/frontend`.
 *
 * `scripts/validate-authoring-schema-driven.mjs` is the precedent and the four
 * walls below are its four, re-aimed at the READ surfaces. The fifth is this
 * workstream's own, and it is the one that had four live findings when it was
 * written.
 *
 * ## The population is what the app COMPILES, not the package it is filed under (#478)
 *
 * This guard scanned `packages/frontend/` alone until #478, and the sentence
 * above is why: the non-negotiable names that package. But the storefront is not
 * that package — it is that package PLUS `packages/ui/src`, which every app
 * consumes FROM SOURCE. All three `tsconfig.json` files alias `@mercaria/ui` to
 * `../ui/src` and Metro watches the monorepo root, so a `ui` file is compiled
 * into the storefront's program exactly as one of its own is. Measured at the
 * widening: 94 storefront files import from it, 55 dashboard, 23 POS.
 *
 * So a prefix-scoped gate had a documented workaround — move the hardcoding one
 * package sideways and the gate that forbids it cannot see it, while the screen
 * that renders it is unchanged. That is a property of the TOPOLOGY rather than
 * of anyone's intent, which is why it is fixed here rather than in the one file
 * that hit it. #478's own subject was exactly that: `VariantSwatches` picked a
 * colour widget from three English option names, refused in `packages/frontend`
 * and permitted in `packages/ui`, and the storefront imported it.
 *
 * `packages/pos` joins for the plainer reason that it had NO catalog gate at
 * all and renders catalogue data to a cashier. It is under the READ walls only:
 * it has no authoring surface — its routes are cart, charge, customer, sales,
 * receipt and store-setup, and a scan for `createProduct`, `productTypeKey`,
 * `attributeDefinition` and `wizard` across the package returns nothing — so
 * putting it under `validate-authoring-schema-driven.mjs` would assert a
 * property over a surface that does not exist.
 *
 * `packages/ui/src` is scanned by BOTH gates, and that is not two authorities
 * over one property. It is two DIFFERENT properties — a read surface must stay
 * catalog-driven, an authoring surface must stay schema-driven — whose
 * populations happen to overlap on the tree both programs compile. Neither
 * analyser is a superset of the other, which is the measured reason both are
 * needed: this one has `bucketKey`, `facetKey`, `brandId` and wall 5, the
 * authoring one has `canonicalRefId` and the `controlled` key receiver.
 *
 * ## Why a guard rather than a review note
 *
 * Every shape it catches type-checks, lints, builds and renders. A storefront
 * that knows one category's filters by name looks exactly like one that reads
 * them from the server, right up until an operator publishes a new attribute and
 * nobody's screen changes — which is a defect with no error, no log line and no
 * failing job anywhere in this repository.
 *
 * ## The five walls
 *
 * **1. NO BRANCH ON A CATALOG CONCEPT'S IDENTITY.** A comparison or a `switch`
 * whose subject is one of ADR 0007 D1's identity names (`categoryId`,
 * `attributeKey`, `facetKey`, `productTypeKey`, `enumValueId`, …) and whose
 * other side is a string LITERAL — or an in-file constant BOUND to one, which
 * is the two-step version of the same thing. Plus a membership test against a
 * hardcoded LIST of values.
 *
 * Membership is narrowed to a list this tree AUTHORED — an array literal, a
 * `new Set([...])`, or an in-file constant bound to either — because the correct
 * implementation does exactly the same call against a set built from the server's
 * answer at runtime (`selected.includes(bucket.key)`), and a rule that fired on
 * those would flag the code it exists to protect.
 *
 * The catalog's closed VOCABULARIES — `origin`, `shape`, `kind`, `state`,
 * `level`, `valueType`, `availability`, `scope` — are deliberately absent from
 * the identity list. A renderer MUST switch on them: that is what makes it
 * schema-driven rather than what makes it hardcoded, and the difference is
 * whether the subject is one concept's NAME or the finite set of forms a concept
 * can take.
 *
 * **2. NO NAMESPACED CONCEPT KEY IN THE CATALOG SUBTREE.** A dotted lowercase
 * key (`electronics.phones.smartphones`, `screen_size.diagonal`) stored in a
 * constant is how wall 1 is walked around. Two subtractions make the shape rule
 * usable: the app's own `en.json` keys, and this workstream's own two path
 * literals. Scoped to the catalog subtree rather than the whole storefront, and
 * that is a real limit rather than a preference: a dotted lowercase string is
 * also what an AsyncStorage key and a package specifier look like, so repo-wide
 * this rule cannot tell a concept key from plumbing.
 *
 * **3. NO HARDCODED CONCEPT IDENTITY IN A PAYLOAD.** `{ categoryId: 'abc' }` or
 * `{ facetKey: 'condition' }` — a request whose subject was decided here rather
 * than read off a server answer. Every catalog request in this package is
 * composed from a response.
 *
 * **4. NO TRANSLATED LABEL AS IDENTITY.** A `t(...)` call in the value position
 * of an identity property. A label is presentation and is never identity
 * (ADR 0007 D1); the storefront sends the id or the stable key beside it, and
 * `lib/catalog/facet-selection.ts` is the URL grammar that has nowhere to put a
 * label.
 *
 * **5. NO RE-LISTED SERVER VOCABULARY.** An array or `new Set([...])` of two or
 * more string literals, whose declaration's type annotation mentions a type
 * IMPORTED from `@mercaria/shared-types` in that file. That is a client copy of
 * a server-owned closed set, and the reason it is a defect rather than a style
 * is enforceability: a `Record<Union, string>` cannot omit a member, so adding
 * one to the union fails `tsc` at the copy — while an ARRAY is a SUBSET that
 * goes on compiling while the control silently stops offering the new value.
 *
 * Measured: this wall had FOUR findings when it was written —
 * `compare.tsx`'s condition groups (which had silently omitted `for_parts`
 * since #90 added it), its channel and objective choice lists, and
 * `p/[handle].tsx`'s two copies of the offer-intent list. Each is now the
 * tuple plus a `Record` over the union. Copy MAPS are therefore untouched by
 * this rule, deliberately, and `analyseSource`'s controls assert both
 * directions.
 *
 * ## What this CANNOT see, stated rather than implied
 *
 * Nothing here does type resolution. A vocabulary re-listed with NO type
 * annotation is invisible to wall 5, and a cross-file constant is invisible to
 * wall 1's binding resolution. Both are residuals this guard states rather than
 * cases it silently half-covers; the shapes it does cover are the shapes the
 * findings in this repository actually took.
 *
 * The first residual has a second reader rather than being merely stated:
 * `client-catalog-list-census.test.ts` (#367 workstream 13) keys on the
 * CONSTANT'S NAME instead of its type, so a bare
 * `const CATEGORY_NAMES = ['electronics', 'books']` in the shared or POS trees
 * is caught there. That census and this guard now cover the same two trees on
 * purpose, and the header of that file records which probe belongs to which.
 *
 * Usage:  bun scripts/validate-storefront-catalog-driven.mjs
 */

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Overridable so the self-test points the REAL guard at a scratch checkout. */
const repositoryRoot = process.env.STOREFRONT_CATALOG_VALIDATOR_ROOT
  ? resolve(process.env.STOREFRONT_CATALOG_VALIDATOR_ROOT)
  : resolve(here, "..");

/** Fixture trees are a handful of files; this lowers the floors to 1, never 0. */
const fixtureFloors = process.env.STOREFRONT_CATALOG_VALIDATOR_FIXTURE_FLOORS === "1";

const ts = createRequire(resolve(here, "../package.json"))("typescript");

/**
 * The trees that must stay catalog-driven, each with the vocabulary wall 2
 * subtracts inside it and the floor below which its traversal is broken.
 *
 * A tree carries its OWN bundle rather than the union of all three. A union
 * would let a storefront translation key excuse a literal authored in `ui`,
 * which is wall 2 subtracting a vocabulary that file cannot reach. Measured at
 * the widening: per-tree subtraction produces ZERO wall-2 findings in the new
 * catalog subtree, so the stricter reading costs nothing today.
 *
 * The floors are per TREE and not one total, for the reason
 * `client-catalog-list-census.test.ts` already gives about its two roots: one
 * tree silently emptying leaves a single total satisfied by the others, and a
 * traversal that reads nothing reports a clean tree. Each is roughly 60% of what
 * the tree holds today (197 / 101 / 60 files), the ratio the storefront's
 * original 120 was set at.
 */
const SCANNED_TREES = [
  {
    prefix: "packages/frontend/",
    bundle: "packages/frontend/lib/i18n/locales/en.json",
    floor: fixtureFloors ? 1 : 120,
  },
  {
    prefix: "packages/ui/src/",
    bundle: "packages/ui/src/i18n/locales/en.json",
    floor: fixtureFloors ? 1 : 60,
  },
  {
    prefix: "packages/pos/",
    bundle: "packages/pos/lib/i18n/locales/en.json",
    floor: fixtureFloors ? 1 : 35,
  },
];

/**
 * Where the catalog surfaces live — wall 2's scope, and a second floor each.
 *
 * Wall 2 is deliberately the narrowest wall: outside a catalog subtree a dotted
 * lowercase string is an ordinary machine name, and turning it on tree-wide was
 * measured at 17 findings that were all SF Symbol names (`star.fill`,
 * `pencil.tip`), storage keys (`mercaria.ui.sidebar`) and plural-suffixed
 * translation keys. So `packages/ui/src/components/marketplace/` joins — 41
 * files, the shared catalogue RENDER surface, ZERO findings with wall 2 on — and
 * `packages/ui/src/lib/` deliberately does not, because it is mixed utility and
 * carries three of that noise. `facet-labels.ts` lives there and is covered by
 * wall 1 regardless, which is not gated on this scope.
 */
const CATALOG_PREFIXES = [
  { prefix: "packages/frontend/lib/catalog/", floor: fixtureFloors ? 1 : 8 },
  { prefix: "packages/frontend/components/catalog/", floor: fixtureFloors ? 1 : 4 },
  // One file today, so its floor is 1 for real. It stays because dropping a
  // prefix REMOVES wall-2 coverage, and a widening that also quietly narrows is
  // the shape nobody reads a diff closely enough to catch.
  { prefix: "packages/frontend/app/(app)/categories/", floor: 1 },
  { prefix: "packages/ui/src/components/marketplace/", floor: fixtureFloors ? 1 : 20 },
];

/**
 * ADR 0007 D1's identity names, as this package spells them.
 *
 * A catalog concept has an opaque `id` and a stable machine `key` and NOTHING
 * ELSE. Branching on one against a literal is per-concept truth, whatever the
 * branch is for.
 *
 * `id` on its own is deliberately absent: it is far too general — a listing id,
 * a React key, an order id — and a guard that fired on `if (a.id === b.id)`
 * would be switched off the day it landed. The narrow spellings below are the
 * ones that name a CATALOGUE concept.
 */
const IDENTITY_NAMES = new Set([
  "attributeDefinitionId",
  "attributeKey",
  "attributeName",
  "brandId",
  "bucketKey",
  "canonicalProductId",
  "canonicalVariantId",
  "categoryId",
  "categoryKey",
  "categorySlug",
  "controlledValueId",
  "enumValueId",
  "facetKey",
  "optionName",
  "productFamilyId",
  "productTypeKey",
  "rowKey",
  "valueKey",
]);

/**
 * `key` is in wall 1 too, but only when the object it is read from is a catalog
 * concept — `facet.key`, `axis.key`, `row.key`.
 *
 * A bare `key` is a React prop and a map entry, so it is matched only as a
 * property ACCESS with one of these receivers, which are the shapes that carry a
 * catalog identity under that name. `row` is here because a comparison row's
 * `key` IS the registry attribute key, and `node`/`entry` because a navigation
 * node's and a facet bucket's are identities the server minted.
 */
const KEY_RECEIVERS = new Set([
  "attribute",
  "axis",
  "bucket",
  "category",
  "definition",
  "entry",
  "facet",
  "field",
  "node",
  "option",
  "productType",
  "row",
  "tree",
  "value",
]);

/**
 * Property names whose VALUE is a concept's identity — walls 3 and 4.
 *
 * Every one has to be read off a server answer or off a route parameter, never
 * authored here.
 */
const IDENTITY_PROPERTIES = new Set([
  "attributeDefinitionId",
  "attributeKey",
  "canonicalProductId",
  "canonicalVariantId",
  "categoryId",
  "categoryKey",
  "enumValueId",
  "facetKey",
  "productTypeKey",
]);

/**
 * Receivers whose `.name` is a catalog concept's FREE TEXT — wall 1, #478.
 *
 * This set is why the widening was not the whole fix. `IDENTITY_NAMES` carries
 * `optionName` and `attributeName`, so `o.optionName === "color"` was refused
 * and `option.name === "color"` was SILENT — and `option.name` is the spelling
 * every DTO in this repository actually uses. Measured on the real #478 source
 * before the fix: the guard produced ZERO findings on it, with wall 2 both on
 * and off. So a gate widened to `packages/ui` alone would have scanned the file
 * the issue is about and reported it clean, which is worse than not scanning it
 * — it reads as coverage.
 *
 * Deliberately NARROWER than {@link KEY_RECEIVERS}, and the asymmetry is the
 * point: a `.key` is a machine identity whoever the receiver is, while `.name`
 * is an ordinary English word. `store.name` is a shop's own name, `user.name` a
 * person's, `file.name` a filename — none is a catalog concept, and a guard that
 * fired on them would be switched off the week it landed. So `entry`, `node`,
 * `row`, `field`, `tree` and `value` are all in `KEY_RECEIVERS` and none is
 * here.
 *
 * Comparing a concept's display name against a literal is per-concept truth
 * whatever the branch is for, and it is worse than the `.key` version rather
 * than better: a name is free text a seller typed, so the branch is wrong in
 * every language nobody enumerated. That is #478's own subject — `Colour` got
 * swatches, `Tono` and `Tamaño` got pills.
 */
const NAME_RECEIVERS = new Set([
  "attribute",
  "axis",
  "bucket",
  "category",
  "definition",
  "facet",
  "option",
  "productType",
]);

/**
 * String methods wall 1 reads THROUGH when looking for a concept identity.
 *
 * `COLOR_OPTION_NAMES.has(option.name.trim().toLowerCase())` is the real #478
 * line, and without this the identity is hidden behind two calls — the same
 * two-step evasion `resolvedLiteral` already handles on the LITERAL side, in the
 * other direction. Every member is case- or whitespace-normalising and none
 * changes which concept is being named, which is what makes reading through them
 * safe; a `.slice(0, 3)` or a `.replace(...)` is a different value and is
 * deliberately absent.
 */
const IDENTITY_NORMALIZERS = new Set([
  "trim",
  "trimStart",
  "trimEnd",
  "toLowerCase",
  "toUpperCase",
  "toLocaleLowerCase",
  "toLocaleUpperCase",
  "normalize",
]);

/** Calls whose subject is a membership test — wall 1's third shape. */
const MEMBERSHIP_METHODS = new Set(["includes", "has", "startsWith", "endsWith"]);

/** A dotted lowercase machine key, one dot minimum. */
const NAMESPACED_KEY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/u;

/**
 * Dotted lowercase strings in the catalog subtree that are NOT concept keys —
 * each scoped to a FILE, carrying an EXACT count, reconciled in BOTH directions.
 *
 * Wall 2's shape rule cannot tell these from a category key, because they are
 * the same shape, so they are subtracted by NAME rather than by a pattern.
 *
 * **It is EMPTY, and that is a measured state rather than an oversight.** Every
 * dotted lowercase literal in the catalog subtree today is a translation key,
 * and those are subtracted from the bundle. The first draft of this guard
 * carried one entry — `category_tree`, `useCategoryTree`'s cache-key
 * discriminant — which was INERT: `NAMESPACED_KEY` requires at least one dot
 * and that string has none, so the exemption excused a finding that could never
 * occur. An exemption that cannot fire is indistinguishable from one doing real
 * work, which is the hole this repository's exemption discipline exists to
 * close.
 *
 * It was ALSO, until #494, a bare `Set` of strings compared inside the detector
 * with no file scope and no count, so its reconciliation ran in one direction
 * only: an entry that subtracted nothing failed, and an entry that subtracted
 * fifty occurrences across fifty files passed. Dormant purely because the list
 * is empty — which is exactly why it was worth shaping now, while an entry
 * costs nothing, rather than after somebody adds one.
 *
 * So an entry names its FILE and how many findings it covers, and both
 * directions fail, the rule {@link KNOWN_VOCABULARY_EXCEPTIONS} is under.
 * Adding one is a decision with a reason attached; adding a dead one, or one
 * that quietly grows, is a failure.
 */
const CATALOG_PATH_LITERALS = [];

export const CATALOG_PATH_LITERAL_COUNT = CATALOG_PATH_LITERALS.length;

/**
 * Wall 1 findings that are reasoned — file, exact literal, exact count, reason.
 *
 * New with #478's widening, because the shared tree brought the first wall-1
 * findings anybody had a defensible answer for. Same discipline as the two lists
 * around it: reconciled in BOTH directions, so an entry that stops matching
 * fails the build and an entry that starts covering MORE fails it too.
 *
 * All four entries are one file. `facet-labels.ts` is the shared copy table for
 * the facets whose keys the SERVER declares stable, and three things make it a
 * different object from the hardcoding wall 1 exists to refuse:
 *
 * - **It cannot withhold a dimension.** Every resolver returns `null` when it
 *   holds no copy, and the caller falls back to the server's own `text`. So an
 *   operator publishing a new facet gets that facet, rendered with server text —
 *   which is precisely the failure wall 1 is aimed at, and it does not occur.
 * - **A dedicated gate already owns the property.**
 *   `scripts/validate-facet-label-copy.mjs` imports these exact resolvers, runs
 *   them against the REAL `en.json` for every stable key and bucket, and fails
 *   if one resolves to nothing. Wall 1 would be a second, weaker opinion.
 * - **The obvious "fix" is detector evasion.** Rewriting the four branches as a
 *   `Record` keyed by facet key hardcodes the identical vocabulary in a shape
 *   this wall cannot see. A gate whose cheapest green is the same hazard under
 *   another spelling is worse than no gate, so the branches stay and the reason
 *   is written down.
 *
 * The fifth entry is the `market` sentinel bucket rather than a facet key: an
 * in-file constant bound to `"*"`, which wall 1 resolves through.
 */
const KNOWN_CONCEPT_BRANCHES = [
  {
    file: "packages/ui/src/lib/facet-labels.ts",
    literal: "availability",
    count: 1,
    reason:
      "stable-key facet copy; falls back to server text and is gated by validate:facet-label-copy",
  },
  {
    file: "packages/ui/src/lib/facet-labels.ts",
    literal: "offer_channel",
    count: 1,
    reason:
      "stable-key facet copy; falls back to server text and is gated by validate:facet-label-copy",
  },
  {
    file: "packages/ui/src/lib/facet-labels.ts",
    literal: "condition",
    count: 1,
    reason:
      "stable-key facet copy; falls back to server text and is gated by validate:facet-label-copy",
  },
  {
    file: "packages/ui/src/lib/facet-labels.ts",
    literal: "market",
    count: 1,
    reason:
      "stable-key facet copy; falls back to server text and is gated by validate:facet-label-copy",
  },
  {
    file: "packages/ui/src/lib/facet-labels.ts",
    literal: "*",
    count: 1,
    reason:
      "FACET_MARKET_ANY_BUCKET, the NULL-region sentinel — the one market bucket that is not a CLDR region code",
  },
];

export const KNOWN_CONCEPT_BRANCH_COUNT = KNOWN_CONCEPT_BRANCHES.length;

/** The package a re-listed vocabulary is copied FROM — wall 5. */
const VOCABULARY_PACKAGE = "@mercaria/shared-types";

/**
 * How many string literals make an array a re-listing rather than a pair.
 *
 * TWO. One string literal in an annotated array is a single-member default and
 * is not a copy of a set; two is a client deciding which members exist.
 */
const VOCABULARY_RELIST_MINIMUM = 2;

/**
 * Wall 5 findings that are reasoned and are NOT catalog vocabulary.
 *
 * Each entry names the exact declaration and why it stands. The set is
 * reconciled in BOTH directions after the scan — an entry that no longer fires
 * fails the build too — so it cannot rot into a list of things somebody once
 * silenced. Widening it is a diff with a reason attached, which is the point.
 *
 * NONE of the four is a catalog vocabulary, which is the property this wall
 * guards. Each is a POLICY subset of a server-owned union, legitimately a subset
 * of the set rather than a copy of it — the shape is identical to a vocabulary
 * copy and the drift risk is real in every case, so each is recorded with what
 * would close it rather than pattern-exempted.
 *
 * The last three arrived with #478's widening, which is the first time any gate
 * read `packages/ui/src` or `packages/pos`.
 */
const KNOWN_VOCABULARY_EXCEPTIONS = [
  {
    file: "packages/frontend/app/(app)/orders/[id].tsx",
    declaration: "BUYER_CANCELLABLE",
    // EXACTLY how many findings this entry excuses, reconciled both ways below.
    // Without it the entry is a PREDICATE with no bound: matching was
    // `detail.startsWith(declaration + " ")` into a Set, so any number of
    // findings sharing this declaration's name in this file collapsed to one
    // membership and the reconciliation could only ever ask "did it fire at
    // least once". A second, differently-valued re-listing of the same name
    // rode in free and the guard printed "1 reasoned exception, all still
    // firing" (#448, #494 finding 2).
    count: 1,
    reason:
      "a policy subset of OrderStatus, not a catalog vocabulary; closed by reading #110's CancellationEligibility",
  },
  {
    file: "packages/ui/src/lib/pickup-labels.ts",
    declaration: "GUEST_ONLY_BLOCK_REASONS",
    count: 1,
    reason:
      "a policy subset of PickupBlockReason — the refusals a signed-out shopper could fix by signing in (#93 client rule 10) — not a catalog vocabulary; closed by the server publishing that subset",
  },
  // Both POS entries are one mirror of the backend role → permission matrix.
  // They CANNOT be closed by importing the vocabulary: `packages/shared-types`
  // exports `StorePermission` as a TYPE UNION and no runtime tuple, so a client
  // cannot enumerate it. `packages/pos/lib/__tests__/permissions.test.ts` is
  // what keeps the mirror in lockstep; closing these entries means shared-types
  // gaining a `STORE_PERMISSIONS` value the backend matrix is also built from.
  {
    file: "packages/pos/lib/permissions.ts",
    declaration: "ALL_PERMISSIONS",
    count: 1,
    reason:
      "a client mirror of the backend role matrix, not a catalog vocabulary; shared-types exports StorePermission as a type only, so it cannot be enumerated at runtime",
  },
  {
    file: "packages/pos/lib/permissions.ts",
    declaration: "STAFF_PERMISSIONS",
    count: 1,
    reason:
      "the staff row of the same mirror; same reason, and the same shared-types tuple would close both",
  },
];

export const KNOWN_VOCABULARY_EXCEPTION_COUNT = KNOWN_VOCABULARY_EXCEPTIONS.length;

/** Below these, the traversal is broken — and a broken traversal reports clean. */
// The floors now live on SCANNED_TREES and CATALOG_PREFIXES, one per tree and
// one per catalog subtree, because a single total is satisfied by whichever tree
// did not empty.

/** The guard cannot be its own subject; neither file lives under the prefix anyway. */
const GUARD_OWN_FILES = new Set([
  "scripts/validate-storefront-catalog-driven.mjs",
  "scripts/test-validate-storefront-catalog-driven.mjs",
]);

const SOURCE_FILE = /\.tsx?$/;

/**
 * A test file, which every wall deliberately skips.
 *
 * A test's job is to name specific values: a fixture facet keyed `color`, a
 * variant axis called `storage`, a subject with a known variant id. Every one of
 * those is what the walls exist to refuse in PRODUCTION code and what a test
 * cannot do without. Measured: `lib/catalog/__tests__/composition.test.ts`
 * produced eleven findings, all of them fixtures, none of them a defect.
 *
 * This is a CATEGORY rather than a hand-maintained list of paths, which is what
 * keeps it from being the kind of exemption that rots — there is nothing to
 * update when a test is added. What keeps it honest is the control in the
 * self-test: the SAME source, at a non-test path, must still be refused by every
 * wall. An exclusion that could swallow production code would fail that case.
 *
 * The count of skipped files is REPORTED on success, so a tree where production
 * modules had been renamed into `__tests__` to quieten this guard shows up as a
 * number nobody expected rather than as silence.
 */
const TEST_FILE = /(?:^|\/)__tests__\/|\.test\.tsx?$/;

// --------------------------------------------------------------- utilities ---

/** Every file git tracks, repo-relative — so ignored files cannot count. */
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

/** Every leaf key of a nested bundle, dotted. */
function bundleKeys(value, prefix = "", out = new Set()) {
  for (const [key, entry] of Object.entries(value)) {
    const path = `${prefix}${key}`;
    if (entry !== null && typeof entry === "object") bundleKeys(entry, `${path}.`, out);
    else out.add(path);
  }
  return out;
}

/** The dotted name of a property access chain's LAST segment, or `null`. */
function accessedName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isIdentifier(node)) return node.text;
  return null;
}

/** The receiver of `x.key` — `x` — or `null`. */
function accessReceiver(node) {
  if (!ts.isPropertyAccessExpression(node)) return null;
  const target = node.expression;
  if (ts.isIdentifier(target)) return target.text;
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  return null;
}

/** Whether an expression names a catalogue concept's identity. */
function namesIdentity(node) {
  const subject = throughNormalizers(node);
  const name = accessedName(subject);
  if (name === null) return false;
  if (IDENTITY_NAMES.has(name)) return true;
  if (name !== "key" && name !== "name") return false;
  const receiver = accessReceiver(subject);
  if (receiver === null) return false;
  const bare = receiver.replace(/^_+/u, "");
  return name === "key" ? KEY_RECEIVERS.has(bare) : NAME_RECEIVERS.has(bare);
}

/**
 * A node with any case- or whitespace-normalising calls peeled off.
 *
 * `option.name.trim().toLowerCase()` names the same concept `option.name` does,
 * and #478's own line hid the identity behind exactly those two calls. Loops,
 * so a third wrapper does not walk out from under it.
 */
function throughNormalizers(node) {
  let current = node;
  while (
    ts.isCallExpression(current) &&
    // `normalize("NFC")` and `toLocaleLowerCase(locale)` legitimately take one.
    // Bounded rather than free because the method set is closed and every member
    // of it is nullary or unary.
    current.arguments.length <= 1 &&
    ts.isPropertyAccessExpression(current.expression) &&
    IDENTITY_NORMALIZERS.has(current.expression.name.text)
  ) {
    current = current.expression.expression;
  }
  return current;
}

/** A string literal's text, or `null`. */
function literalText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

/** Whether a node is a translate call — `t(...)` or `something.t(...)`. */
const isTranslateCall = (node) =>
  ts.isCallExpression(node) &&
  ((ts.isIdentifier(node.expression) && node.expression.text === "t") ||
    (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "t"));

/** The elements of an array literal or a `new Set([...])`, or `null`. */
function listElements(node) {
  if (ts.isArrayLiteralExpression(node)) return node.elements;
  if (
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "Set" &&
    node.arguments !== undefined &&
    node.arguments[0] !== undefined &&
    ts.isArrayLiteralExpression(node.arguments[0])
  ) {
    return node.arguments[0].elements;
  }
  return null;
}

/** Whether a node is an array literal or a `new Set([...])` of string literals. */
function literalValueList(node) {
  const elements = listElements(node);
  if (elements === null) return null;
  const values = [];
  for (const element of elements) {
    const value = literalText(element);
    if (value === null) return null;
    values.push(value);
  }
  return values.length > 0 ? values : null;
}

/**
 * Every in-file `const NAME = <string literal | literal list>`.
 *
 * This is what makes the two-step evasion visible: binding a category's key to a
 * constant and comparing against THAT is the same branch with one more line.
 * Resolution is per FILE and deliberately shallow — see the header's residuals.
 */
function collectLiteralBindings(sourceFile) {
  const strings = new Map();
  const lists = new Map();
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      const value = literalText(node.initializer);
      if (value !== null) strings.set(node.name.text, value);
      const list = literalValueList(node.initializer);
      if (list !== null) lists.set(node.name.text, list);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { strings, lists };
}

/** A node's literal text, resolving an in-file constant binding. */
function resolvedLiteral(node, bindings) {
  const direct = literalText(node);
  if (direct !== null) return direct;
  if (ts.isIdentifier(node)) return bindings.strings.get(node.text) ?? null;
  return null;
}

/** Whether the receiver of a membership call is a list THIS TREE authored. */
function authoredValueList(node, bindings) {
  if (literalValueList(node) !== null) return true;
  if (ts.isIdentifier(node)) return bindings.lists.has(node.text);
  return false;
}

/** Whether a literal sits in a module-specifier position, which wall 2 ignores. */
function isModuleSpecifier(node) {
  const parent = node.parent;
  if (parent === undefined) return false;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return true;
  if (ts.isCallExpression(parent) && parent.arguments[0] === node) {
    const callee = parent.expression;
    if (ts.isIdentifier(callee) && callee.text === "require") return true;
    if (callee.kind === ts.SyntaxKind.ImportKeyword) return true;
  }
  return ts.isImportTypeNode(parent) || ts.isExternalModuleReference(parent);
}

/**
 * Every type name this file imports from `@mercaria/shared-types` — wall 5.
 *
 * The import LIST is the signal, not a type checker: a name bound here to that
 * package is a server-owned vocabulary, and an array annotated with it is a
 * client copy of a closed set. Both `import type {…}` and a value import count,
 * because `import { CONDITION_GROUPS, type ConditionGroup }` is one statement.
 */
function vocabularyTypeNames(sourceFile) {
  const names = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (literalText(statement.moduleSpecifier) !== VOCABULARY_PACKAGE) continue;
    const clause = statement.importClause;
    if (clause?.namedBindings === undefined) continue;
    if (!ts.isNamedImports(clause.namedBindings)) continue;
    for (const element of clause.namedBindings.elements) names.add(element.name.text);
  }
  return names;
}

/** Whether a type node mentions any of the given names, anywhere in its subtree. */
function typeMentions(typeNode, names) {
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (ts.isIdentifier(node) && names.has(node.text)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(typeNode);
  return found;
}

/**
 * How many string literals a list-shaped initializer carries.
 *
 * Counts both a bare member (`['new', 'used']`) and a member's `value`, `key`
 * or `id` property (`[{ value: 'new', label: … }]`) — the second is the shape
 * both of `compare.tsx`'s findings took, and a rule reading only the first
 * would have flagged one of the three real cases.
 */
function vocabularyLiteralCount(node) {
  const elements = listElements(node);
  if (elements === null) return 0;
  let count = 0;
  for (const element of elements) {
    if (literalText(element) !== null) {
      count += 1;
      continue;
    }
    if (!ts.isObjectLiteralExpression(element)) continue;
    for (const property of element.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const name =
        ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
          ? property.name.text
          : null;
      if (name !== "value" && name !== "key" && name !== "id") continue;
      if (literalText(property.initializer) !== null) {
        count += 1;
        break;
      }
    }
  }
  return count;
}

// ----------------------------------------------------------- the analyser ---

/**
 * Analyse ONE source file against the five walls.
 *
 * Exported so the controls run production's own code path over control SOURCE,
 * rather than asserting against a second copy of the rules.
 */
export function analyseSource(relativePath, text, translationKeys, options = {}) {
  const namespacedKeys = options.namespacedKeys ?? true;
  const sourceFile = ts.createSourceFile(
    relativePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const bindings = collectLiteralBindings(sourceFile);
  const vocabularyTypes = vocabularyTypeNames(sourceFile);
  const findings = [];

  const report = (node, wall, detail) => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    findings.push({ file: relativePath, line: line + 1, wall, detail });
  };

  const visit = (node) => {
    // WALL 1a — `concept.key === 'literal'`, in either operand order.
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      const isComparison =
        op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        op === ts.SyntaxKind.EqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsToken;
      if (isComparison) {
        const left = resolvedLiteral(node.left, bindings);
        const right = resolvedLiteral(node.right, bindings);
        if (right !== null && namesIdentity(node.left)) {
          report(node, "concept-branch", `compared against "${right}"`);
        } else if (left !== null && namesIdentity(node.right)) {
          report(node, "concept-branch", `compared against "${left}"`);
        }
      }
    }

    // WALL 1b — `switch (concept.key)` with any literal case.
    if (ts.isSwitchStatement(node) && namesIdentity(node.expression)) {
      for (const clause of node.caseBlock.clauses) {
        if (!ts.isCaseClause(clause)) continue;
        const value = literalText(clause.expression);
        if (value !== null) report(clause, "concept-branch", `switch case "${value}"`);
      }
    }

    // WALL 1c — `LIST.includes(concept.key)` and `concept.key.startsWith('x')`.
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (MEMBERSHIP_METHODS.has(method)) {
        const [argument] = node.arguments;
        if (
          argument !== undefined &&
          namesIdentity(argument) &&
          authoredValueList(node.expression.expression, bindings)
        ) {
          report(node, "concept-branch", `${method}() over a hardcoded value list`);
        }
        const value = argument === undefined ? null : resolvedLiteral(argument, bindings);
        if (value !== null && namesIdentity(node.expression.expression)) {
          report(node, "concept-branch", `${method}("${value}") on a concept identity`);
        }
      }
    }

    // WALL 2 — a namespaced concept key. Catalog subtree only.
    const asLiteral = namespacedKeys ? literalText(node) : null;
    if (
      asLiteral !== null &&
      NAMESPACED_KEY.test(asLiteral) &&
      !translationKeys.has(asLiteral) &&
      !isModuleSpecifier(node)
    ) {
      // The path-literal exemptions are NOT subtracted here. They are excused by
      // the caller, against a FILE and a count, because a finding suppressed
      // inside the detector never exists to be counted — which is what left this
      // list reconcilable in one direction only (#494).
      report(node, "namespaced-key", `"${asLiteral}"`);
    }

    // WALLS 3 and 4 — an identity property whose value was decided HERE.
    if (ts.isPropertyAssignment(node)) {
      const name =
        ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : null;
      if (name !== null && IDENTITY_PROPERTIES.has(name)) {
        const value = literalText(node.initializer);
        if (value !== null && value.length > 0) {
          report(node, "hardcoded-identity", `${name}: "${value}"`);
        }
        if (isTranslateCall(node.initializer)) {
          report(node, "label-as-identity", `${name} was assigned a translated string`);
        }
      }
    }

    // WALL 5 — a server-owned vocabulary, re-listed under its own type.
    if (
      ts.isVariableDeclaration(node) &&
      node.type !== undefined &&
      node.initializer !== undefined &&
      vocabularyTypes.size > 0 &&
      typeMentions(node.type, vocabularyTypes)
    ) {
      const count = vocabularyLiteralCount(node.initializer);
      if (count >= VOCABULARY_RELIST_MINIMUM) {
        const declared = ts.isIdentifier(node.name) ? node.name.text : "a declaration";
        report(
          node,
          "vocabulary-relisting",
          `${declared} re-lists ${count} members of a ${VOCABULARY_PACKAGE} vocabulary`,
        );
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return findings;
}

// ------------------------------------------------------------------- main ---

const WALL_TEXT = {
  "concept-branch":
    "branches on a catalogue concept's identity. The server decides which categories, attributes and values exist; a client that knows one by name holds truth a data change cannot reach (ADR 0007 D1).",
  "namespaced-key":
    "carries a namespaced concept key. A category, product type or attribute key in this tree is per-concept truth even when nothing branches on it yet.",
  "hardcoded-identity":
    "hardcodes a concept identity into a payload. Every catalog request here is composed from a server answer or a route parameter.",
  "label-as-identity":
    "sends a TRANSLATED string as identity. A label is presentation and is never identity (ADR 0007 D1); send the id or the stable key beside it.",
  "vocabulary-relisting":
    "re-lists a server-owned closed set as an ARRAY. Import the tuple and, where copy is needed, put it in a Record over the union — a Record cannot omit a member, an array silently can.",
};

async function main() {
  const failures = [];
  /** exception id -> how many findings it actually excused. */
  const matchedExceptions = new Map();
  /** path-literal exemption id -> how many findings it actually excused. */
  const matchedPathLiterals = new Map();
  /** concept-branch exemption id -> how many findings it actually excused. */
  const matchedConceptBranches = new Map();
  const files = trackedFiles();

  // One bundle per tree, read up front. An unreadable one exits rather than
  // falling back to an empty key set: an empty set makes wall 2 fire on every
  // translation key in the tree, and the guard would be reporting the bundle's
  // absence as dozens of catalog findings.
  const translationKeysByTree = new Map();
  for (const tree of SCANNED_TREES) {
    let bundleRaw;
    try {
      bundleRaw = await readFile(resolve(repositoryRoot, tree.bundle), "utf8");
    } catch {
      console.error(
        `\n  ${tree.bundle} could not be read; wall 2 cannot tell a concept key from copy in ${tree.prefix}.\n`,
      );
      process.exit(1);
    }
    translationKeysByTree.set(tree.prefix, bundleKeys(JSON.parse(bundleRaw)));
  }

  const inTree = files.filter(
    (path) =>
      SCANNED_TREES.some((tree) => path.startsWith(tree.prefix)) &&
      SOURCE_FILE.test(path) &&
      !GUARD_OWN_FILES.has(path),
  );
  const scanned = inTree.filter((path) => !TEST_FILE.test(path));
  const skippedTests = inTree.length - scanned.length;
  const catalog = scanned.filter((path) =>
    CATALOG_PREFIXES.some((entry) => path.startsWith(entry.prefix)),
  );

  for (const path of scanned) {
    let text;
    try {
      text = await readFile(resolve(repositoryRoot, path), "utf8");
    } catch (error) {
      // A tracked file the working tree lost. Loud, never a silent skip: a
      // traversal that quietly drops files is one that reports a clean tree.
      failures.push(`${path}: tracked but unreadable (${String(error)})`);
      continue;
    }
    const inCatalogTree = CATALOG_PREFIXES.some((entry) => path.startsWith(entry.prefix));
    const owningTree = SCANNED_TREES.find((tree) => path.startsWith(tree.prefix));
    for (const finding of analyseSource(path, text, translationKeysByTree.get(owningTree.prefix), {
      namespacedKeys: inCatalogTree,
    })) {
      const excused = KNOWN_VOCABULARY_EXCEPTIONS.find(
        (entry) =>
          finding.wall === "vocabulary-relisting" &&
          entry.file === finding.file &&
          finding.detail.startsWith(`${entry.declaration} `),
      );
      if (excused !== undefined) {
        const id = `${excused.file}:${excused.declaration}`;
        matchedExceptions.set(id, (matchedExceptions.get(id) ?? 0) + 1);
        continue;
      }
      const excusedLiteral = CATALOG_PATH_LITERALS.find(
        (entry) =>
          finding.wall === "namespaced-key" &&
          entry.file === finding.file &&
          finding.detail === `"${entry.literal}"`,
      );
      if (excusedLiteral !== undefined) {
        const id = `${excusedLiteral.file}:${excusedLiteral.literal}`;
        matchedPathLiterals.set(id, (matchedPathLiterals.get(id) ?? 0) + 1);
        continue;
      }
      // Matched on the EXACT detail rather than a prefix. Wall 1 emits three
      // shapes (`compared against`, `switch case`, a membership test) and an
      // entry excusing a comparison must not silently start excusing a `switch`
      // on the same literal in the same file.
      const excusedBranch = KNOWN_CONCEPT_BRANCHES.find(
        (entry) =>
          finding.wall === "concept-branch" &&
          entry.file === finding.file &&
          finding.detail === `compared against "${entry.literal}"`,
      );
      if (excusedBranch !== undefined) {
        const id = `${excusedBranch.file}:${excusedBranch.literal}`;
        matchedConceptBranches.set(id, (matchedConceptBranches.get(id) ?? 0) + 1);
        continue;
      }
      // The wall KEY is in the line as well as the sentence: it is what a
      // reader greps for and what this guard's own controls assert on, and a
      // control that could only match the prose would pass on any refusal at
      // all — including one from a different rule.
      failures.push(
        `${finding.file}:${finding.line} [${finding.wall}] ${finding.detail} — ${WALL_TEXT[finding.wall]}`,
      );
    }
  }

  // Every entry in ALL THREE lists must declare an integer `count` of at least 1, or
  // the reconciliations below compare against `undefined` — and `actual <
  // undefined` and `actual > undefined` are BOTH false, so an entry missing the
  // field falls straight through every branch and excuses without limit, in
  // silence. Checked here so the FIRST entry added without one fails naming
  // itself. (`validate-route-targets.mjs` needs no such check: it compares
  // `hits === entry.count` and then pushes unconditionally, so an undefined
  // count fails loudly there. The safety property is the comparison SHAPE, not
  // the presence of this loop — #494.)
  for (const [entry, name] of [
    ...KNOWN_VOCABULARY_EXCEPTIONS.map((entry) => [entry, entry.declaration]),
    ...CATALOG_PATH_LITERALS.map((entry) => [entry, entry.literal]),
    ...KNOWN_CONCEPT_BRANCHES.map((entry) => [entry, entry.literal]),
  ]) {
    if (Number.isInteger(entry.count) && entry.count >= 1) continue;
    failures.push(
      `exemption entry "${name}" in ${entry.file} declares no integer count >= 1 `
      + `(got ${JSON.stringify(entry.count)}). Without one it excuses EVERY occurrence of its shape in `
      + "that file, which is the hole #448 closed — declare exactly how many findings it covers",
    );
  }

  // Both exemption lists, reconciled in BOTH directions. An entry that no
  // longer fires has stopped describing the tree, and a list that can only grow
  // is one nobody removes anything from.
  for (const entry of CATALOG_PATH_LITERALS) {
    const id = `${entry.file}:${entry.literal}`;
    const actual = matchedPathLiterals.get(id) ?? 0;
    if (actual === entry.count) continue;

    if (actual === 0) {
      failures.push(
        `${id} is listed as a non-concept path literal ${entry.count} time(s), which no longer `
        + "matches anything — the count went DOWN to 0. Remove the entry, or it excuses a finding "
        + "that cannot occur. Check first that the literal CAN match NAMESPACED_KEY at all: it needs "
        + "at least one dot and every segment lowercase, and the first draft of this list carried an "
        + "entry with no dot in it",
      );
      continue;
    }
    if (actual < entry.count) {
      failures.push(
        `${id} is listed as a non-concept path literal ${entry.count} time(s), but only ${actual} `
        + "matched — the count went DOWN. Lower the count to what remains, or restore what the entry "
        + "was covering",
      );
      continue;
    }
    failures.push(
      `${id} is listed as a non-concept path literal ${entry.count} time(s), but ${actual} finding(s) `
      + "matched it — the count went UP. An excusing entry is a PREDICATE, not an identity, so a NEW "
      + "use of the same literal in the same file would otherwise ride in behind the reasoned one. "
      + "Read the value off the server's answer, or raise the count with a reason covering it too",
    );
  }
  for (const entry of KNOWN_VOCABULARY_EXCEPTIONS) {
    const id = `${entry.file}:${entry.declaration}`;
    const actual = matchedExceptions.get(id) ?? 0;
    if (actual === 0) {
      failures.push(
        `${id} is listed as a reasoned wall-5 exception ${entry.count} time(s), which no longer matches `
        + "anything — the count went DOWN to 0. Either the re-listing was removed or the file moved: "
        + "delete the entry so the list keeps describing the tree, and so its standing positive control "
        + "keeps standing",
      );
      continue;
    }
    if (actual < entry.count) {
      failures.push(
        `${id} is listed as a reasoned wall-5 exception ${entry.count} time(s), but only ${actual} `
        + "finding(s) matched it — the count went DOWN. Lower the count to what remains, or restore what "
        + "the entry was covering",
      );
      continue;
    }
    if (actual > entry.count) {
      failures.push(
        `${id} is listed as a reasoned wall-5 exception ${entry.count} time(s), but ${actual} finding(s) `
        + "matched it — the count went UP. An excusing entry is a PREDICATE, not an identity, so a NEW "
        + "re-listed vocabulary under the same declaration name in the same file would otherwise ride in "
        + "behind the reasoned one. Fix the new occurrence, or raise the count with a reason covering it too",
      );
    }
  }

  for (const entry of KNOWN_CONCEPT_BRANCHES) {
    const id = `${entry.file}:${entry.literal}`;
    const actual = matchedConceptBranches.get(id) ?? 0;
    if (actual === entry.count) continue;

    if (actual === 0) {
      failures.push(
        `${id} is listed as a reasoned wall-1 branch ${entry.count} time(s), which no longer matches `
        + "anything — the count went DOWN to 0. The branch was removed or the file moved: delete the "
        + "entry so the list keeps describing the tree",
      );
      continue;
    }
    if (actual < entry.count) {
      failures.push(
        `${id} is listed as a reasoned wall-1 branch ${entry.count} time(s), but only ${actual} `
        + "matched — the count went DOWN. Lower the count to what remains, or restore what the entry "
        + "was covering",
      );
      continue;
    }
    failures.push(
      `${id} is listed as a reasoned wall-1 branch ${entry.count} time(s), but ${actual} finding(s) `
      + "matched it — the count went UP. An excusing entry is a PREDICATE, not an identity, so a NEW "
      + "branch on the same literal in the same file would otherwise ride in behind the reasoned one. "
      + "Read the value off the server's answer, or raise the count with a reason covering it too",
    );
  }

  // The vacuity floors, one per TREE and one per CATALOG SUBTREE. Per-tree
  // rather than per-total, because a total is satisfied by whichever tree did
  // NOT empty — `packages/ui/src` moving would leave 197 storefront files
  // clearing a floor of 120 and this guard silently back to scanning one
  // package, which is the exact state #478 exists to end. And a whole tree can
  // be scanned while its catalog subtree is renamed out from under the
  // prefixes, so both kinds are needed: a clean report over zero catalog files
  // is the exact shape of a guard that is on and measuring nothing.
  for (const tree of SCANNED_TREES) {
    const count = scanned.filter((path) => path.startsWith(tree.prefix)).length;
    if (count < tree.floor) {
      failures.push(
        `only ${count} source files under ${tree.prefix} (floor ${tree.floor}) — the file listing is broken, and a broken listing reports a clean tree`,
      );
    }
  }
  for (const entry of CATALOG_PREFIXES) {
    const count = catalog.filter((path) => path.startsWith(entry.prefix)).length;
    if (count < entry.floor) {
      failures.push(
        `only ${count} catalog source files under ${entry.prefix} (floor ${entry.floor}) — that catalog surface was moved or removed, so wall 2 is measuring nothing there`,
      );
    }
  }

  if (failures.length > 0) {
    console.error("\nThe storefront must stay catalog-driven (#367 workstream 9):\n");
    for (const failure of failures) console.error(`  ${failure}`);
    console.error(
      "\n  The taxonomy, the navigation trees, the attribute registry and the facet rail\n" +
        "  decide which categories, filters, specifications and values exist. Adding one is\n" +
        "  a DATA change; anything in these trees that knows a category, product type,\n" +
        "  attribute or value by name breaks that and breaks it silently — tsc, lint and\n" +
        "  every build job stay green.\n" +
        "\n  `packages/ui/src` and `packages/pos` are in scope since #478: every app\n" +
        "  compiles the shared tree from source, so moving a hardcoded list one package\n" +
        "  sideways changes nothing about what a shopper sees.\n",
    );
    process.exit(1);
  }

  const perTree = SCANNED_TREES.map(
    (tree) => `${String(scanned.filter((path) => path.startsWith(tree.prefix)).length)} ${tree.prefix}`,
  ).join(", ");
  const translationKeyTotal = [...translationKeysByTree.values()].reduce(
    (total, keys) => total + keys.size,
    0,
  );
  console.log(
    `storefront catalog-driven guard passed — ${scanned.length} source files (${perTree}) ` +
      `(${catalog.length} of them the catalog surfaces', ${String(skippedTests)} test files ` +
      `skipped); 5 walls; ` +
      `${translationKeyTotal} translation keys across ${String(SCANNED_TREES.length)} bundles and ` +
      `${String(CATALOG_PATH_LITERALS.length)} named literals subtracted by wall 2; ` +
      `${String(KNOWN_CONCEPT_BRANCHES.length)} reasoned wall-1 branch(es); ` +
      `${String(KNOWN_VOCABULARY_EXCEPTIONS.length)} reasoned wall-5 exception(s); ` +
      "every exemption in all three lists matched its exact declared count.",
  );
}

// The self-test imports `analyseSource`; only a direct run scans the repository.
if (import.meta.main) {
  await main();
}
