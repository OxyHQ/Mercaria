/**
 * The commercial-disclosure surface's structural boundaries (#129), asserted by
 * SCAN rather than by fixture.
 *
 * Each is a claim about what a customer-facing surface CANNOT do, and a
 * behavioural test can only ever say "it did not this time". The scanner shape,
 * the vacuity floor and the mutation self-test are
 * `retail-checkout-isolation.test.ts`'s, reused deliberately rather than
 * reinvented.
 *
 * Six walls:
 *
 *  1. **No procurement economics reaches a buyer.** #129 retail rule 6, cart
 *     rule 9 and order rule 6, plus #126's privacy half: the wholesale cost,
 *     the supplier's identity and SKU, the agreement, the procurement offer and
 *     the carrier account may not be named by anything that composes what a
 *     buyer reads. The presentation TYPES have no field for one, and this makes
 *     the words unwritable in the modules that build them, so a future author
 *     cannot introduce one under a plausible name.
 *  2. **No referral partner or commission reaches a buyer.** #129 referral
 *     rules 3, 6 and 9, and order rule 11.
 *  3. **No OxyPay or FairCoin payment option, placeholder or teaser.** #129
 *     acceptance 9 and its whole §"Future OxyPay copy boundary" — scanned
 *     against RAW source, copy included, because the prohibition is on the
 *     COPY as much as on the code.
 *  4. **The commercial mode is never re-inferred from a name, a price or a
 *     badge.** It is READ from #57's offer kind, #123's live retail binding and
 *     #123's stored `commercial_role`, and a storefront that started deciding
 *     for itself is exactly the misattribution acceptance 2 forbids.
 *  5. **Ranking is untouched.** #129 ranking rule 1: reuse #74 and create no
 *     separate retail-only score. Nothing in this domain may reach the ranking
 *     service, and no `mercaria_retail` term may enter a score.
 *  6. **The storefront renders the seller from the presentation, never from a
 *     vendor or store name.** The one file that could make this mistake is a
 *     storefront file, and the storefront has NO test runner — the
 *     `seller-identity-isolation.test.ts` precedent, for the same reason.
 *
 * Plus a RUNTIME walk of really-emitted presentations for every forbidden fact,
 * because a scan proves what the source says and a walk proves what the wire
 * carries.
 *
 * ## Where the copy lives, and which walls follow it there (#507)
 *
 * Three of the six walls read STRINGS, so each has to reach wherever the
 * sentences currently sit. There are two such places and they are covered
 * differently, because the forbidden vocabularies behave differently under
 * translation:
 *
 *   * **Wall 3 scans every leaf of BOTH bundle trees** — the storefront's
 *     (#435b, wired by #492/#504) and `@mercaria/ui`'s, which nothing scanned
 *     for this until #507 even though #502 had already moved five copy maps
 *     into it. `OxyPay` and `FairCoin` are PROPER NOUNS: they survive
 *     translation unchanged, so one scan is as true in Portuguese as in
 *     English, which is exactly what makes a whole-tree population honest here.
 *   * **Walls 1 and 2 scan only the leaves under a namespace the buyer-facing
 *     commercial modules actually NAME**, derived rather than listed. Their
 *     vocabularies are identifier-shaped, and over a whole tree they are wrong
 *     in both directions at once: measured, the referral detector hits
 *     `settings.sections.referralPartner` in all twelve storefront bundles —
 *     correct copy for a legitimate settings row — while the words a buyer
 *     would actually read do not survive translation at all. Scoped to the
 *     namespace and scanned over KEY as well as value, they catch the thing
 *     that IS translation-invariant: a key named after a forbidden fact.
 *
 * Wall 4 needs no bundle half and gets none. `MODE_INFERENCE_REFERENCE` matches
 * an assignment and a `.includes(…)` call; neither is expressible in a
 * sentence, so copy moving out of a module costs it nothing. Saying so is the
 * point — a wall extended to a population it cannot measure reads as coverage.
 *
 * The derived half is what stops #490 (converting `commercial-copy.ts` to
 * keys) from disarming walls 1 and 2 the way it would disarm a hand-listed
 * one: the namespace follows the copy with no edit here, and a key that
 * resolves to no leaf fails as STALE rather than scanning nothing.
 */

import { describe, expect, it } from 'vitest';
import { assertDirectoriesAreFlat } from '../../__tests__/domain-population.js';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMMERCIAL_DISCLOSURE_KEYS,
  COMMERCIAL_FORBIDDEN_DISCLOSURE_FACTS,
  COMMERCIAL_MODE_NATIVE_CHECKOUT,
  COMMERCIAL_MODES,
  commercialDisclosureKeys,
  deriveCommercialMode,
} from '@mercaria/shared-types';
import {
  externalReferralPresentation,
  informationalPresentation,
  marketplacePresentation,
  retailPresentationFromSnapshot,
} from '../commercial-presentation/presentation';

import {
  assertNothingOutsideDomainPopulation,
  namedInSharedDirectories,
  readSrcDirectory,
  walkOwnedDirectory,
  type DirectoryReader,
} from '../../__tests__/domain-population.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO_PACKAGES = join(SRC_ROOT, '..', '..');

/**
 * The one route that serves this domain and cannot be derived from a name.
 *
 * `routes/retail-offers.ts` is named after its RESOURCE rather than after this
 * domain, and no rule reaches it without also reaching something else: a
 * `retail` prefix over `routes/` takes `retail-service-requests.ts`, which is
 * #127's, and an `offer` prefix takes #57's and #74's surfaces — the six modules
 * #472 scoped out of the offer wall for exactly this reason. So it stays a hand
 * list, with an EXACT count and a comment claiming only what the list IS, which
 * is #460's other sanctioned resolution ("where a hand list must stay, narrow
 * the comment to what the list actually covers").
 */
const UNDERIVABLE_ROUTES = ['routes/retail-offers.ts'];

/**
 * Every backend module of the domain, WALKED plus the one counted route (#460).
 *
 * The list this replaces named all six and was complete on the day it was
 * written; what it could not do is cover the module somebody adds next.
 */
/** Anything whose PATH names this domain, in either spelling. */
const DOMAIN_NAMED = /commercial-presentation|commercialPresentation/i;

/**
 * The shared flat directories a module of this domain lives in under a domain
 * NAME.
 *
 * They contribute NOTHING today — the domain owns no controller, route,
 * middleware or schema module carrying its name, `routes/retail-offers.ts`
 * being named after its resource instead — and they are listed so that one
 * appearing tomorrow is admitted rather than reported as an outsider.
 */
const PRESENTATION_SHARED_DIRECTORIES = [
  'controllers',
  'routes',
  'middleware',
  'db/schema',
] as const;

/**
 * Every backend module of the domain, DERIVED as a function of its reader
 * (#460), so the positive control below measures THIS derivation.
 */
function presentationPopulation(readDir: DirectoryReader = readSrcDirectory): string[] {
  return [
    ...walkOwnedDirectory('services/commercial-presentation', readDir),
    ...namedInSharedDirectories(PRESENTATION_SHARED_DIRECTORIES, DOMAIN_NAMED, readDir),
    ...UNDERIVABLE_ROUTES,
  ];
}

const PRESENTATION_PATHS = [
  ...presentationPopulation(),
];

/**
 * The STOREFRONT files this gate scans for commercial copy.
 *
 * NOT "every file that renders a disclosure" — `orders/index.tsx` renders none
 * and is scanned so that it cannot acquire one unchecked. Measured 2026-08-18:
 * the four screens plus the component and the copy module are exactly the files
 * naming `CommercialDisclosure` or `commercial-copy`, and the only other file
 * naming one is `ui/src/index.ts`, the barrel, which re-exports and renders
 * nothing.
 *
 * **The list is complete today and nothing keeps it complete** (#460): a NEW
 * storefront screen rendering the disclosure would not appear here, and the
 * exact-count assertion below would still pass, because the count is of this
 * list rather than of the screens. The rejection recorded beside that assertion
 * — that walking `packages/frontend` whole would scan every screen in the app —
 * argues against a BLANKET walk and not against a targeted derivation over the
 * files that reference the disclosure or the copy module, which is what a
 * conversion would actually use. Left as a hand list because that is a decision
 * for whoever owns this wall, with the gap stated rather than implied.
 *
 * Scanned from here because `packages/frontend` has no test runner at all and
 * `packages/ui`'s `test` script is an `echo`. The file that would put
 * `Sold by Mercaria` over a merchant's sale is a screen, so the gate has to
 * reach one — `seller-identity-isolation.test.ts` made the same call for the
 * same reason.
 */
const STOREFRONT_PATHS = [
  'frontend/app/(app)/cart.tsx',
  'frontend/app/(app)/checkout/index.tsx',
  'frontend/app/(app)/orders/[id].tsx',
  'frontend/app/(app)/orders/index.tsx',
  'frontend/app/(app)/products/[id].tsx',
  'ui/src/components/marketplace/CommercialDisclosure.tsx',
  'ui/src/lib/commercial-copy.ts',
];

/**
 * Procurement economics, by any plausible name.
 *
 * `supplier` alone is deliberately NOT the pattern: the retail presentation
 * legitimately talks about a *supplier fulfilment disclosure*, which is the one
 * thing about the partner a buyer IS told (ADR 0004 D2.8). What is forbidden is
 * naming the partner, their price or their reference.
 */
const PROCUREMENT_ECONOMICS_REFERENCE =
  /supplierUnitCost|supplierLineTotal|supplierSku|supplierName|supplierId\b|supplierAccountId|agreementId|procurementOfferId|wholesale|carrierAccount|purchaseOrderId|providerRejection/;

/** The referral domain — #129 referral rules 3, 6 and 9. */
const REFERRAL_REFERENCE =
  /\/referral|referralPartner|partnerCommission|affiliateCommission|referralCode|payoutState/i;

/** ADR 0004 D11 and #129 acceptance 9. */
const OXYPAY_OR_FAIRCOIN_REFERENCE = /oxy_?[Pp]ay|OxyPay|[Ff]air[Cc]oin/;

/**
 * Every locale bundle tree whose copy wall 3 must reach.
 *
 * The OxyPay/FairCoin prohibition is explicitly a scan of COPY, not only of
 * code — a "coming soon", a disabled wallet row and a conversion teaser are all
 * STRINGS. #435b moved exactly those strings out of the four storefront screens
 * this file scans and into `frontend`'s bundles, and #502 moved five of
 * `@mercaria/ui`'s copy maps into ITS bundles, so a gate that reads only `.ts`
 * and `.tsx` would go on passing while the checkout said the forbidden thing.
 *
 * TWO roots, because they are two packages with two release paths and #507
 * measured that only the first was covered: `ui`'s twelve bundles carried 2,412
 * leaves that no OxyPay wall had ever read. Nothing violated — this closed an
 * exposure rather than a defect — which is precisely when it is cheap to close.
 *
 * Each root carries its OWN excused keys: an exception is a fact about one
 * tree's copy, and one list shared across both would excuse a key in a package
 * that does not have it, which then reads as stale in whichever tree lacks it.
 */
const BUNDLE_ROOTS: readonly {
  readonly label: string;
  readonly root: string;
  readonly currencyNameKeys: readonly string[];
}[] = [
  {
    label: 'frontend',
    root: join(REPO_PACKAGES, 'frontend', 'lib', 'i18n', 'locales'),
    currencyNameKeys: ['settings.currency.description'],
  },
  {
    // `@mercaria/ui`'s own copy, merged under the reserved `ui` namespace by
    // `SharedUiTranslationProvider` and shared by all three apps — so a
    // forbidden sentence here reaches the storefront, the dashboard AND the POS
    // at once, a wider blast radius than the tree that happened to be covered
    // first.
    label: 'ui',
    root: join(REPO_PACKAGES, 'ui', 'src', 'i18n', 'locales'),
    // Deliberately empty: this package ships no currency picker, so no key here
    // legitimately names the currency. An entry added without one being needed
    // fails the staleness assertion below rather than sitting unused.
    currencyNameKeys: [],
  },
];

/**
 * Every translated string one bundle tree ships, in EVERY locale.
 *
 * All twelve locales, not just `en`: the wallet teaser is as forbidden in
 * Portuguese. Enumerated from disk so a locale added later is covered without
 * an edit here. A parse failure THROWS rather than being skipped — an
 * unreadable bundle is the "scanned nothing" state, which is the one way this
 * must never be green.
 */
function localeBundles(root: string): {
  readonly locale: string;
  readonly source: string;
  readonly leaves: readonly { readonly key: string; readonly value: string }[];
}[] {
  return readdirSync(root)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const source = readFileSync(join(root, name), 'utf8');
      const leaves: { readonly key: string; readonly value: string }[] = [];
      const walk = (node: unknown, path: string): void => {
        if (typeof node === 'string') {
          leaves.push({ key: path, value: node });
          return;
        }
        if (node !== null && typeof node === 'object') {
          for (const [child, value] of Object.entries(node)) {
            walk(value, path === '' ? child : `${path}.${child}`);
          }
        }
      };
      walk(JSON.parse(source), '');
      return { locale: name.slice(0, -'.json'.length), source, leaves };
    });
}

/**
 * What a leaf is scanned as: its KEY and its VALUE together.
 *
 * The key is the half that survives translation. Every vocabulary in this file
 * is identifier-shaped, so a forbidden fact arriving as `….partnerCommission`
 * or `….payWithOxyPay` is caught in all twelve locales at once, where the
 * translated sentence beneath it would be caught in at most one.
 */
function leafProbe(leaf: { readonly key: string; readonly value: string }): string {
  return `${leaf.key} ${leaf.value}`;
}

/**
 * The keys where FairCoin may legitimately be NAMED, because it is the
 * PRESENTMENT CURRENCY there and not a payment rail.
 *
 * `AGENTS.md` makes FAIR the preferred presentment and display currency — the
 * currency a buyer gets when they have chosen none. What ADR 0004 D11 forbids
 * is FairCoin as a payment RAIL or a benefit: "pay with FairCoin", a wallet
 * row, a conversion teaser. A currency picker that says which currency is the
 * default is the legitimate case, and `buyer-request-isolation.test.ts` already
 * draws exactly this line one domain over, where it excludes the `FAIR` code
 * deliberately because "what is forbidden is FairCoin as a payment rail".
 *
 * Scoped by KEY rather than by phrase: a phrase exclusion would excuse the same
 * words anywhere, including in a checkout sentence. Each entry is asserted to
 * still MATCH below, so an entry that stops naming the currency fails as stale
 * rather than silently excusing nothing (#448). The list is per ROOT, on
 * `BUNDLE_ROOTS` above, because it is a fact about one package's copy.
 *
 * The narrowness of `[Ff]air[Cc]oin` is load-bearing and was measured, not
 * assumed: `ui.condition.label.used_fair` is the sentence "Used — fair", so a
 * detector loosened to `FAIR` or `[Ff]air` would go red on a condition label in
 * every locale — a gate whose cheapest green is rewording correct copy.
 */

/**
 * A commercial mode inferred from something that is not the authority.
 *
 * The three authorities are #57's `offerKind`, a live retail binding and
 * #123's stored `commercialRole`. Deciding from a seller's NAME, a price, a
 * logo or a badge is the inference #55 already refuses one layer down.
 */
const MODE_INFERENCE_REFERENCE =
  /mode\s*=\s*[^;]*\b(name|logo|price|badge|vendorName|storeName)\b|includes\(['"]Mercaria['"]\)/;

/** The ranking domain — #129 ranking rule 1. */
const RANKING_REFERENCE = /\/ranking\/|rankOffers|rankOfferComparison|rankingPolicy|scoreOffer/;

/**
 * The order page deriving its seller from the ORDER's commercial presentation.
 *
 * RETARGETED by #490, not relaxed. `commercialSellerLabel` now takes the
 * translator first (`priceSignalAccessibleSummary`'s shape), so the previous
 * spelling — which required `order.commercial` to be the only argument — went
 * red on a correct change. That is the dangerous direction: a present-assertion
 * reddening during an unrelated refactor points straight at the line it guards,
 * and the cheapest way back to green is deleting it.
 *
 * The argument list may grow; the SUBJECT stays pinned. Self-tested in both
 * directions below, because an exception-shaped pattern that matches nothing is
 * indistinguishable from one that matches the right thing.
 */
const SELLER_FROM_ORDER_PRESENTATION =
  /commercialSellerLabel\((?:[^)]*,\s*)?order\.commercial\b/;

/**
 * The `@mercaria/ui` modules that compose what a buyer reads on the commercial
 * surface — the two the walls below already scan as SOURCE.
 *
 * This is not a second population: it is what the BUNDLE half of walls 1 and 2
 * is derived FROM. When #490 converts these sentences to keys, the namespace
 * those keys name is where the copy went, and the walls follow it there without
 * an edit to this file.
 */
const BUYER_COPY_MODULES = [
  'ui/src/lib/commercial-copy.ts',
  'ui/src/components/marketplace/CommercialDisclosure.tsx',
];

/**
 * A message key as it appears in a module: a dotted identifier under the
 * reserved `ui` namespace, inside a string literal of any delimiter.
 *
 * The optional trailing `.` plus `${` tolerates a template PREFIX —
 * `` t(`ui.commercial.explanation.${key}`) `` yields `ui.commercial.explanation`,
 * which is the namespace that matters — because a computed key is how a
 * `Record`-shaped map is most naturally converted.
 *
 * Restricted to `ui.` deliberately rather than matching any dotted identifier.
 * Two reasons, and the second is the real one: any dotted literal would also
 * match a module specifier or a version string and demand it resolve to a leaf,
 * making the gate red on correct code; and a key OUTSIDE `ui.` cannot resolve at
 * all, because `SharedUiTranslationProvider` merges this package's bundles under
 * that one reserved namespace — so such a key renders as itself on screen and
 * fails visibly rather than silently.
 */
const UI_MESSAGE_KEY = /["'`](ui(?:\.[A-Za-z0-9_]+)+)\.?(?:\$\{)?/g;

/** Every `ui.*` message key one module names. */
function messageKeysIn(source: string): string[] {
  return [...new Set([...source.matchAll(UI_MESSAGE_KEY)].map((match) => match[1]))].sort();
}

/**
 * Every `ui.*` message key the buyer-facing commercial modules name IN CODE.
 *
 * Comment-stripped, and that is load-bearing rather than tidy: a docblock
 * explaining the conversion writes `` `ui.commercial.disclosure.*` `` in prose,
 * and a markdown backtick is the same character the extractor accepts as a
 * string delimiter. Read raw, the census demands that a NAMESPACE MENTIONED IN
 * A SENTENCE resolve to a bundle leaf, and the tripwire fails on documentation.
 * Measured here on #490's own first run — the sanctioned resolution is the
 * house rule that a census over source excludes comments.
 */
function buyerCopyMessageKeys(): string[] {
  return [
    ...new Set(
      BUYER_COPY_MODULES.flatMap((relative) => messageKeysIn(readCode(REPO_PACKAGES, relative))),
    ),
  ].sort();
}

/**
 * The namespaces those keys sit under — `ui.<domain>`, two segments.
 *
 * Scanned as a NAMESPACE rather than as the exact key set so that a sibling key
 * added to the bundle before any module names it is covered too. The commercial
 * namespace is a buyer-facing surface whichever key within it a screen happens
 * to render today.
 */
function buyerCopyNamespaces(): string[] {
  return [
    ...new Set(buyerCopyMessageKeys().map((key) => key.split('.').slice(0, 2).join('.'))),
  ].sort();
}

/** Every bundle leaf under one of those namespaces, across every root and locale. */
function buyerCopyBundleLeaves(): { readonly where: string; readonly probe: string }[] {
  const namespaces = buyerCopyNamespaces();
  if (namespaces.length === 0) return [];
  const found: { where: string; probe: string }[] = [];
  for (const { label, root } of BUNDLE_ROOTS) {
    for (const bundle of localeBundles(root)) {
      for (const leaf of bundle.leaves) {
        if (namespaces.some((space) => leaf.key === space || leaf.key.startsWith(`${space}.`))) {
          found.push({
            where: `${label}/${bundle.locale}.json → ${leaf.key}`,
            probe: leafProbe(leaf),
          });
        }
      }
    }
  }
  return found;
}

/** Read a scanned path, refusing an empty or moved file. */
function readSource(root: string, relative: string): string {
  const source = readFileSync(join(root, relative), 'utf8');
  expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
  return source;
}

/** The same source with comments removed — what the REACHABILITY detectors scan. */
function readCode(root: string, relative: string): string {
  const stripped = readSource(root, relative)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');
  expect(
    stripped.replace(/\s+/g, '').length,
    `${relative} has almost no code left after comment stripping — check the stripper`,
  ).toBeGreaterThan(200);
  return stripped;
}

describe('#460 — the population is closed against the tree', () => {
  it('no commercial-presentation-named module anywhere in src/ sits outside the population', () => {
    // #460's whole-tree assertion, through the shared derivation so the positive
    // control re-derives THIS population against the seeded reader.
    //
    // The population does NOT move: all five backend modules live under
    // `services/commercial-presentation/` and the walk already had them. That is
    // the complete-population case — every floor and count this gate carries was
    // already satisfied, and the only thing a hand-shaped population fails on is
    // the module somebody adds next. The plant is the proof, not a number.
    //
    // Scoped to `src/`. This gate also scans STOREFRONT files, which live in
    // another package and are derived separately; sweeping them here would need
    // a second root and would report every screen as an outsider.
    assertNothingOutsideDomainPopulation({
      population: presentationPopulation,
      pattern: DOMAIN_NAMED,
      // Measured empty: the only modules in `src/` naming this domain are its
      // own five. `routes/retail-offers.ts` is in the population and NOT in the
      // sweep — it is named after its resource — which the one-directional
      // assertion permits.
      notThisDomain: [],
      sweepFloor: 4,
      plantIn: 'lib',
      plantName: 'commercial-presentation-cache.ts',
    });
    // EXACT: the one underivable route is an identity, not a predicate (#448).
    expect(UNDERIVABLE_ROUTES.length, 'a second underivable route was added').toBe(1);
  });
});

describe('a customer commercial surface cannot reach what it must not', () => {
  it('names no procurement economics in code (#129 retail 6, cart 9, order 6)', () => {
    let scanned = 0;
    for (const relative of PRESENTATION_PATHS) {
      expect(
        PROCUREMENT_ECONOMICS_REFERENCE.test(readCode(SRC_ROOT, relative)),
        `${relative} names a wholesale cost, a supplier handle or a carrier account`,
      ).toBe(false);
      scanned += 1;
    }
    for (const relative of STOREFRONT_PATHS) {
      expect(
        PROCUREMENT_ECONOMICS_REFERENCE.test(readCode(REPO_PACKAGES, relative)),
        `${relative} names a wholesale cost, a supplier handle or a carrier account`,
      ).toBe(false);
      scanned += 1;
    }
    // …and wherever the sentences have MOVED to (#507). Empty until #490
    // converts the maps, which is why the tripwire below asserts that emptiness
    // means "not converted" rather than "derivation broken".
    const movedCopy = buyerCopyBundleLeaves();
    for (const leaf of movedCopy) {
      expect(
        PROCUREMENT_ECONOMICS_REFERENCE.test(leaf.probe),
        `${leaf.where} names a wholesale cost, a supplier handle or a carrier account`,
      ).toBe(false);
      scanned += 1;
    }
    // Real floors, not `scanned === length`: that comparison is circular (the
    // loop increments once per entry, so it holds for ANY list including an
    // empty one) and catches a broken loop but never a shrunk population.
    // PER SHAPE, because the three sources break independently.
    expect(
      PRESENTATION_PATHS.filter((path) => path.startsWith('services/commercial-presentation/'))
        .length,
      'the domain walk found nothing',
    ).toBeGreaterThanOrEqual(5);
    // EXACT: both hand lists are identities, not predicates (#448). The
    // storefront list stays a hand list deliberately — walking `packages/frontend`
    // whole would scan every screen in the app for a commercial-disclosure
    // violation, which is a different gate, so the comment above it claims only
    // what the list IS.
    expect(UNDERIVABLE_ROUTES.length, 'a second underivable route was added').toBe(1);
    expect(STOREFRONT_PATHS.length, 'the storefront list changed size').toBe(7);
    for (const path of PRESENTATION_PATHS) {
      expect(statSync(join(SRC_ROOT, path)).isFile(), `${path} is not a file`).toBe(true);
    }
    expect(PRESENTATION_PATHS.filter((path) => path.includes('__tests__'))).toEqual([]);
    expect(scanned).toBe(PRESENTATION_PATHS.length + STOREFRONT_PATHS.length + movedCopy.length);
    // Vacuity floor: a filter that emptied either list would pass every loop.
    // Counted over the FILES alone, so it cannot be satisfied by bundle leaves
    // arriving later — a floor a future population can silently inflate stops
    // measuring the population it was written for.
    expect(scanned - movedCopy.length).toBeGreaterThanOrEqual(12);
  });

  it('reaches no referral partner, code or commission (#129 referral 3, 6, 9)', () => {
    for (const relative of PRESENTATION_PATHS) {
      expect(
        REFERRAL_REFERENCE.test(readCode(SRC_ROOT, relative)),
        `${relative} reaches the referral domain`,
      ).toBe(false);
    }
    for (const relative of STOREFRONT_PATHS) {
      expect(
        REFERRAL_REFERENCE.test(readCode(REPO_PACKAGES, relative)),
        `${relative} reaches the referral domain`,
      ).toBe(false);
    }
    // …and wherever the sentences have MOVED to (#507), scoped to the
    // buyer-facing namespace. NOT the whole tree: `affiliate_disclosure` is
    // REQUIRED copy that says "Mercaria may be paid a commission", and
    // `referral-labels.ts` is a partner's OWN dashboard, where a commission is
    // the subject. What this vocabulary forbids is a partner HANDLE, a code or
    // a payout state reaching a buyer, and none of those is a word — which is
    // why the key is scanned beside the value.
    for (const leaf of buyerCopyBundleLeaves()) {
      expect(REFERRAL_REFERENCE.test(leaf.probe), `${leaf.where} reaches the referral domain`).toBe(
        false,
      );
    }
  });

  it('names no OxyPay or FairCoin payment option, in code OR in copy (#129 acceptance 9)', () => {
    // RAW source, copy included: #129's §"Future OxyPay copy boundary" forbids a
    // `coming soon`, a disabled wallet row and a conversion teaser as firmly as
    // it forbids a provider branch, and every one of those is a STRING.
    for (const relative of PRESENTATION_PATHS) {
      expect(
        OXYPAY_OR_FAIRCOIN_REFERENCE.test(readSource(SRC_ROOT, relative)),
        `${relative} names OxyPay or FairCoin`,
      ).toBe(false);
    }
    for (const relative of STOREFRONT_PATHS) {
      expect(
        OXYPAY_OR_FAIRCOIN_REFERENCE.test(readSource(REPO_PACKAGES, relative)),
        `${relative} names OxyPay or FairCoin`,
      ).toBe(false);
    }

    // …and in the BUNDLES of BOTH packages, which is where #435b and #502 moved
    // the copy (#492, #507). Without this the files above stay clean while a
    // bundle carries "Pay with OxyPay — coming soon" and every assertion here
    // still passes.
    const leavesScanned = new Map<string, number>();
    for (const { label, root, currencyNameKeys } of BUNDLE_ROOTS) {
      leavesScanned.set(label, 0);
      const bundles = localeBundles(root);
      expect(
        bundles.length,
        `${label} ships twelve locales; a shorter list means the bundles moved and this ` +
          'prohibition is no longer scanning the copy',
      ).toBeGreaterThanOrEqual(12);
      for (const bundle of bundles) {
        // A bundle emptied to `{}` would scan clean; the floors are what tell
        // that apart from a bundle that genuinely says nothing forbidden. A byte
        // floor AND a leaf floor, because this scan walks LEAVES: a bundle could
        // keep its bytes while nesting every string out of reach of the walk,
        // and the byte floor alone would call that covered.
        expect(
          bundle.source.length,
          `${label}/${bundle.locale}.json looks empty — an empty bundle passes this vacuously`,
        ).toBeGreaterThan(500);
        expect(
          bundle.leaves.length,
          `${label}/${bundle.locale}.json walked almost no leaves — check the walker`,
        ).toBeGreaterThanOrEqual(100);
        // Scanned per LEAF so the currency-name exception can be scoped to a key
        // rather than to a phrase. A phrase exclusion would excuse the same words
        // in a checkout sentence, which is the thing this wall exists for.
        const excused: string[] = [];
        for (const leaf of bundle.leaves) {
          leavesScanned.set(label, (leavesScanned.get(label) ?? 0) + 1);
          if (currencyNameKeys.includes(leaf.key)) {
            if (OXYPAY_OR_FAIRCOIN_REFERENCE.test(leafProbe(leaf))) excused.push(leaf.key);
            continue;
          }
          expect(
            OXYPAY_OR_FAIRCOIN_REFERENCE.test(leafProbe(leaf)),
            `${label}/${bundle.locale}.json → ${leaf.key} names OxyPay or FairCoin`,
          ).toBe(false);
        }
        // An excusing entry is a PREDICATE, not an identity (#448): assert every
        // excused key is still present AND still naming the currency, so a
        // renamed or reworded key fails here instead of quietly excusing nothing.
        expect(
          excused.sort(),
          `${label}/${bundle.locale}.json: the currency-name exceptions no longer match — ` +
            'remove the stale entry rather than leaving it excusing nothing',
        ).toEqual([...currencyNameKeys].sort());
      }
    }
    // PER ROOT, never a total. A combined floor is satisfied by the wrong
    // things: the storefront tree alone holds ~12,300 leaves and `ui` ~2,400, so
    // any total this scan could clear is one the larger tree clears on its own —
    // and losing `ui` entirely is the exact state #507 found and closed.
    expect(BUNDLE_ROOTS.length, 'a bundle root was dropped').toBe(2);
    expect([...leavesScanned.keys()].sort()).toEqual(['frontend', 'ui']);
    expect(
      leavesScanned.get('frontend'),
      'the storefront bundles walked far fewer leaves than they hold',
    ).toBeGreaterThanOrEqual(9_000);
    expect(
      leavesScanned.get('ui'),
      'the shared-package bundles walked far fewer leaves than they hold — the tree #507 added ' +
        'is no longer being scanned',
    ).toBeGreaterThanOrEqual(1_800);
  });

  /**
   * The #490 tripwire: walls 1 and 2 follow the buyer copy when it moves.
   *
   * `commercial-copy.ts` holds ~50 sentences that render on the LAST screen
   * before payment. Converting them to keys moves them out of every file this
   * gate reads, and a wall reading a file that no longer holds the copy does not
   * fail — it passes, permanently, over nothing.
   *
   * So the coverage is stated as two states with no third: either the modules
   * still hold the sentences, and the source scans above ARE the coverage; or
   * they hold keys, and every one of those keys must resolve to a leaf in every
   * locale, which is what the walls then scan. "Holds keys that resolve to
   * nothing" is the uncovered state, and it is the one this fails on.
   */
  it('the buyer commercial copy is scanned wherever it lives (#507, #490 tripwire)', () => {
    // Positive control on the DERIVATION itself, and the load-bearing assertion
    // here today: the extraction returns [] for `commercial-copy.ts` right now,
    // and [] is also what a BROKEN extractor returns. Running it over a module
    // that HAS been converted is what tells those two apart — without this the
    // tripwire would read as armed while being incapable of ever firing.
    const control = messageKeysIn(readCode(REPO_PACKAGES, 'ui/src/lib/condition.ts'));
    expect(
      control.length,
      'the message-key extraction found nothing in an ALREADY-converted module, so it would ' +
        'return nothing for a converted commercial-copy.ts too and this tripwire could never fire',
    ).toBeGreaterThanOrEqual(20);
    expect(control.every((key) => key.startsWith('ui.condition.'))).toBe(true);

    const keys = buyerCopyMessageKeys();
    const leaves = buyerCopyBundleLeaves();

    if (keys.length === 0) {
      // Not converted yet. The sentences are still in the modules, which walls
      // 1, 2 and 3 read as source, so there is nothing to resolve — and nothing
      // may have been derived either, or the namespace scan is reading a tree
      // the copy does not live in.
      expect(leaves, 'a namespace was derived from modules that name no key').toEqual([]);
      return;
    }

    // Converted (#490). Every key must resolve in EVERY locale of the root that
    // carries its namespace — an unresolved key is copy this gate is not
    // reading, and it fails as STALE rather than quietly scanning less (#448).
    const roots = BUNDLE_ROOTS.map((entry) => ({
      label: entry.label,
      locales: localeBundles(entry.root),
    }));
    for (const key of keys) {
      const carriers = roots.filter(({ locales }) =>
        locales.some((bundle) => bundle.leaves.some((leaf) => leaf.key === key)),
      );
      expect(
        carriers.length,
        `${key} is named by the commercial copy but resolves to no bundle leaf — the copy it ` +
          'renders is scanned by nothing',
      ).toBeGreaterThanOrEqual(1);
      for (const { label, locales } of carriers) {
        const missing = locales
          .filter((bundle) => !bundle.leaves.some((leaf) => leaf.key === key))
          .map((bundle) => bundle.locale);
        expect(missing, `${key} is missing from ${label} locales ${missing.join(', ')}`).toEqual([]);
      }
    }
    // At least one leaf per key per locale; fewer means the namespace derivation
    // and the keys disagree about where the copy sits.
    expect(leaves.length).toBeGreaterThanOrEqual(keys.length * 12);
  });

  it('never infers a commercial mode from a name, a price or a badge (#129 acceptance 2)', () => {
    for (const relative of PRESENTATION_PATHS) {
      expect(
        MODE_INFERENCE_REFERENCE.test(readCode(SRC_ROOT, relative)),
        `${relative} decides a commercial mode from something other than the stored authority`,
      ).toBe(false);
    }
    for (const relative of STOREFRONT_PATHS) {
      expect(
        MODE_INFERENCE_REFERENCE.test(readCode(REPO_PACKAGES, relative)),
        `${relative} decides a commercial mode from something other than the stored authority`,
      ).toBe(false);
    }
  });

  it('creates no retail-only ranking score (#129 ranking rule 1)', () => {
    for (const relative of PRESENTATION_PATHS) {
      expect(
        RANKING_REFERENCE.test(readCode(SRC_ROOT, relative)),
        `${relative} reaches the ranking domain; #74 stays the only ordering authority`,
      ).toBe(false);
    }
  });

  it('the storefront renders the seller from the presentation, never from a vendor name', () => {
    // The cart's group header is the one place the two identities sit side by
    // side, and the tempting bug is rendering `vendor.name` — which on a group
    // Mercaria sells itself is the catalogue owner, not the seller.
    const cart = readCode(REPO_PACKAGES, 'frontend/app/(app)/cart.tsx');
    expect(
      /commercialSellerLabel\(/.test(cart),
      'cart.tsx no longer derives its seller from the commercial presentation',
    ).toBe(true);
    // A positive control on the detector's other half: the string it must NOT
    // find is the raw vendor name inside the header Text element.
    expect(
      /className="text-base font-bold text-foreground">\s*\{vendor\.name\}/.test(cart),
      'cart.tsx renders the catalogue owner as the seller',
    ).toBe(false);

    const orderDetail = readCode(REPO_PACKAGES, 'frontend/app/(app)/orders/[id].tsx');
    expect(
      SELLER_FROM_ORDER_PRESENTATION.test(orderDetail),
      'the order page no longer derives its seller from the order\'s commercial presentation',
    ).toBe(true);
    expect(
      /order\.store\?\.name\s*\?\?\s*order\.seller\?\.displayName/.test(orderDetail),
      'the order page coalesces store and seller, which is empty for a platform order',
    ).toBe(false);
  });

  /**
   * The mutation self-test, run against SEEDED positives.
   *
   * Without it a broken regex passes by matching nothing, and every assertion
   * above would read as a proven wall while proving only that the scanner ran.
   */
  it('every detector above trips on a seeded positive', () => {
    expect(PROCUREMENT_ECONOMICS_REFERENCE.test('const cost = line.supplierUnitCost;')).toBe(true);
    expect(PROCUREMENT_ECONOMICS_REFERENCE.test('sku: quote.supplierSku')).toBe(true);
    expect(PROCUREMENT_ECONOMICS_REFERENCE.test('wholesale: true')).toBe(true);
    expect(PROCUREMENT_ECONOMICS_REFERENCE.test('carrierAccount: acct')).toBe(true);
    expect(REFERRAL_REFERENCE.test("from '../referral/attribution.js'")).toBe(true);
    expect(REFERRAL_REFERENCE.test('const referralPartner = load();')).toBe(true);
    expect(OXYPAY_OR_FAIRCOIN_REFERENCE.test('label: "Pay with FairCoin (coming soon)"')).toBe(true);
    expect(OXYPAY_OR_FAIRCOIN_REFERENCE.test('await payWithOxyPay(order)')).toBe(true);
    expect(MODE_INFERENCE_REFERENCE.test('const mode = vendor.name === "Mercaria" ? a : b;')).toBe(
      true,
    );
    expect(MODE_INFERENCE_REFERENCE.test('if (seller.includes("Mercaria")) return;')).toBe(true);
    expect(RANKING_REFERENCE.test("from '../ranking/comparison.service.js'")).toBe(true);
    expect(RANKING_REFERENCE.test('await rankOfferComparison(request)')).toBe(true);

    // The retargeted seller detector, BOTH directions (#490). It must accept the
    // argument list growing and still refuse every way of naming a seller that
    // is not the order's own commercial presentation — otherwise "retargeted"
    // is a relaxation wearing a better word.
    expect(SELLER_FROM_ORDER_PRESENTATION.test('commercialSellerLabel(order.commercial)')).toBe(
      true,
    );
    expect(SELLER_FROM_ORDER_PRESENTATION.test('commercialSellerLabel(t, order.commercial)')).toBe(
      true,
    );
    expect(
      SELLER_FROM_ORDER_PRESENTATION.test('const n = order.store?.name ?? order.seller?.displayName;'),
    ).toBe(false);
    // A DIFFERENT subject must not satisfy it — this is the half a `[^)]*`
    // pattern gets wrong, by letting anything at all sit before the comma.
    expect(SELLER_FROM_ORDER_PRESENTATION.test('commercialSellerLabel(t, vendor.commercial)')).toBe(
      false,
    );
    expect(SELLER_FROM_ORDER_PRESENTATION.test('commercialSellerLabel(t, order.commercialish)')).toBe(
      false,
    );
  });

  /**
   * The bundle half's own self-test (#507).
   *
   * Every assertion above that reads a leaf reads `leafProbe(leaf)`, so what has
   * to be proven is that the KEY half really is scanned, and that the detectors
   * refuse the legitimate copy they sit next to.
   */
  it('the bundle scan trips on a forbidden KEY, not only on a forbidden sentence', () => {
    // The key half — the whole reason for scanning key AND value: the sentence
    // beneath a key like this is translated twelve ways and matches the detector
    // in at most one of them.
    expect(
      OXYPAY_OR_FAIRCOIN_REFERENCE.test(
        leafProbe({ key: 'ui.checkout.payWithOxyPay', value: 'Pagar con la cartera' }),
      ),
    ).toBe(true);
    expect(
      REFERRAL_REFERENCE.test(
        leafProbe({ key: 'ui.commercial.partnerCommission', value: 'Ganamos una comisión' }),
      ),
    ).toBe(true);
    expect(
      PROCUREMENT_ECONOMICS_REFERENCE.test(
        leafProbe({ key: 'ui.commercial.supplierSku', value: 'Referencia del proveedor' }),
      ),
    ).toBe(true);
    // The value half still works.
    expect(
      OXYPAY_OR_FAIRCOIN_REFERENCE.test(
        leafProbe({ key: 'ui.commercial.wallet', value: 'Pay with FairCoin — coming soon' }),
      ),
    ).toBe(true);

    // …and does NOT trip on the copy it must leave alone. Both of these are real
    // strings in this repository: `affiliate_disclosure` is REQUIRED copy naming
    // a commission, and `used_fair` is a condition label whose English word is
    // literally "fair". A detector that could not tell those from its quarry
    // would be a gate whose cheapest green is rewording correct sentences.
    expect(
      REFERRAL_REFERENCE.test(
        leafProbe({
          key: 'ui.commercial.disclosure.affiliate_disclosure',
          value: 'Mercaria may be paid a commission if you buy through this link.',
        }),
      ),
    ).toBe(false);
    expect(
      OXYPAY_OR_FAIRCOIN_REFERENCE.test(
        leafProbe({ key: 'ui.condition.label.used_fair', value: 'Used — fair' }),
      ),
    ).toBe(false);

    // The message-key extraction, in both directions: it reads a plain literal
    // and a template PREFIX, and it reads neither a module specifier nor a
    // className — either of which would make the tripwire demand that a
    // non-key resolve to a leaf, i.e. go red on correct code.
    expect(messageKeysIn('label: "ui.commercial.disclosure.sold_by_mercaria",')).toEqual([
      'ui.commercial.disclosure.sold_by_mercaria',
    ]);
    expect(messageKeysIn('t(`ui.commercial.explanation.${key}`)')).toEqual([
      'ui.commercial.explanation',
    ]);
    expect(messageKeysIn('import type { X } from "@mercaria/shared-types";')).toEqual([]);
    expect(messageKeysIn('className="text-captionBold text-text"')).toEqual([]);
  });
});

describe('the commercial vocabulary is closed and disjoint', () => {
  it('no forbidden fact is spelled the same as a disclosure key', () => {
    const real = new Set<string>(COMMERCIAL_DISCLOSURE_KEYS);
    expect(real.size).toBe(12);
    for (const forbidden of COMMERCIAL_FORBIDDEN_DISCLOSURE_FACTS) {
      expect(real.has(forbidden), `${forbidden} is both forbidden and disclosable`).toBe(false);
    }
    expect(COMMERCIAL_FORBIDDEN_DISCLOSURE_FACTS.length).toBeGreaterThanOrEqual(11);
  });

  it('only the two native modes may reach the cart, and it is a table not a branch', () => {
    expect(COMMERCIAL_MODE_NATIVE_CHECKOUT).toEqual({
      mercaria_retail: true,
      connected_marketplace: true,
      external_referral: false,
      informational: false,
    });
    // Every mode has an answer — a mode added without one would be `undefined`,
    // which a caller reads as "not buyable" only by accident.
    for (const mode of COMMERCIAL_MODES) {
      expect(typeof COMMERCIAL_MODE_NATIVE_CHECKOUT[mode]).toBe('boolean');
    }
  });

  it('a native offer is Mercaria-sold exactly when a live retail binding says so', () => {
    expect(deriveCommercialMode({ offerKind: 'native', hasLiveRetailBinding: true })).toBe(
      'mercaria_retail',
    );
    expect(deriveCommercialMode({ offerKind: 'native', hasLiveRetailBinding: false })).toBe(
      'connected_marketplace',
    );
    // The binding cannot make an EXTERNAL destination Mercaria's own sale — the
    // offer kind decides first, and a retailer's page is not something Mercaria
    // can sell whatever a binding on some variant says.
    expect(deriveCommercialMode({ offerKind: 'external', hasLiveRetailBinding: true })).toBe(
      'external_referral',
    );
    expect(deriveCommercialMode({ offerKind: 'affiliate', hasLiveRetailBinding: true })).toBe(
      'external_referral',
    );
    expect(deriveCommercialMode({ offerKind: 'informational', hasLiveRetailBinding: true })).toBe(
      'informational',
    );
  });

  it('an affiliate destination owes a paid-relationship disclosure and a plain one does not', () => {
    expect(commercialDisclosureKeys({ mode: 'external_referral', affiliateDisclosureRequired: true }))
      .toEqual(['external_checkout', 'affiliate_disclosure']);
    expect(
      commercialDisclosureKeys({ mode: 'external_referral', affiliateDisclosureRequired: false }),
    ).toEqual(['external_checkout']);
  });
});

describe('a really-emitted presentation carries no forbidden fact', () => {
  /**
   * A runtime WALK, not a scan.
   *
   * The static gate proves what the source says; this proves what the wire
   * carries, which is the thing a buyer actually receives. `SELLER_PROFILE`'s
   * #92 gate is the precedent, and the reason it is worth having both is that a
   * spread of a repository row would introduce every column at once without any
   * of their names appearing in this file.
   */
  function walkKeys(value: unknown, into: Set<string>): void {
    if (Array.isArray(value)) {
      for (const entry of value) walkKeys(entry, into);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value)) {
        into.add(key.toLowerCase());
        walkKeys(nested, into);
      }
    }
  }

  const presentations = [
    retailPresentationFromSnapshot({
      sellerLegalEntityName: 'Mercaria Commerce SL',
      sellerLegalEntityCountry: 'ES',
      supplierFulfilmentDisclosureKey: 'retail.supplier_fulfilled.v1',
      supplierFulfilmentDisclosureVersion: 1,
      customerTermsVersion: '2026-08-10.1',
      cancellationWindowHours: 24,
      withdrawalWindowDays: 14,
      returnWindowDays: 30,
      warrantyMonths: 36,
    }),
    marketplacePresentation({ sellerKind: 'store', sellerLabel: 'Acme Supplies' }),
    externalReferralPresentation({ offerKind: 'affiliate', destinationHost: 'example.com' }),
    informationalPresentation(),
  ];

  it('emits no key naming a supplier, a wholesale cost, a carrier or a referral partner', () => {
    const keys = new Set<string>();
    for (const presentation of presentations) walkKeys(presentation, keys);
    // Vacuity floor: an empty walk would pass every assertion below.
    expect(keys.size).toBeGreaterThanOrEqual(10);

    const forbiddenSubstrings = [
      'wholesale',
      'suppliercost',
      'supplierid',
      'suppliername',
      'suppliersku',
      'agreementid',
      'procurementoffer',
      'carrier',
      'referral',
      'commission',
      'margin',
      'markup',
    ];
    for (const key of keys) {
      for (const forbidden of forbiddenSubstrings) {
        expect(key.includes(forbidden), `a presentation emits the key \`${key}\``).toBe(false);
      }
    }
    // A positive control on the walk itself: it really did see the one supplier
    // word a buyer IS told, so "no matches" cannot mean "walked nothing".
    expect(keys.has('supplierfulfilmentdisclosurekey')).toBe(true);
  });

  it('every presentation carries the disclosures its mode requires', () => {
    for (const presentation of presentations) {
      expect(presentation.disclosures.length).toBe(
        commercialDisclosureKeys(
          presentation.mode === 'external_referral'
            ? {
                mode: 'external_referral',
                affiliateDisclosureRequired: presentation.affiliateDisclosureRequired,
              }
            : { mode: presentation.mode },
        ).length,
      );
    }
  });
});

describe('#668 — the locale-bundle read lists FLAT directories', () => {
  it('every BUNDLE_ROOT holds bundles and no subdirectory', () => {
    // `localeBundles` reads one level and filters `.json`. That is correct only
    // while the bundle roots stay flat, which is a claim about the tree rather
    // than about the code — asserted here so it fails the build the day a
    // per-namespace subdirectory appears, instead of silently reading fewer
    // locales than the file thinks it does.
    assertDirectoriesAreFlat(
      BUNDLE_ROOTS.map((entry) => entry.label),
      (label) => {
        const root = BUNDLE_ROOTS.find((entry) => entry.label === label)?.root;
        if (root === undefined) throw new Error(`no bundle root labelled ${label}`);
        return readdirSync(root, { withFileTypes: true });
      },
    );
  });
});
