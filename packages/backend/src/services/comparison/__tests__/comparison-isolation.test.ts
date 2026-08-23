/**
 * The walls around the comparison domain (#96 explanation rule 8, acceptance 2
 * and 3), asserted STRUCTURALLY.
 *
 * Six properties, each a scan or a type rather than a fixture, because "cannot"
 * is a stronger statement than "did not in this case":
 *
 *  1. **No module here can reach commercial standing.** Not the fee domain, not
 *     referrals, not retail pricing, not the ledger, not a plan or a
 *     commission. A recommendation that cannot READ what a merchant pays cannot
 *     be influenced by it, whatever anybody later wants it to do.
 *  2. **No module here names a currency.** FAIR is Mercaria's display default
 *     and that is product policy stated where the policy lives; a comparison
 *     module reaching for it would make the default a comparison fact.
 *  3. **No module here reads the REVIEW domain.** A star rating is a legitimate
 *     ranking signal one domain over; what it may never become is a row in a
 *     specification table (product-comparison rule 7).
 *  4. **The allowed and forbidden input vocabularies are DISJOINT** — the
 *     `RetailCostComponentKind` device, so widening the allowed set can never
 *     accidentally admit a prohibition.
 *  5. **No type in the domain carries a field for a forbidden input**, checked
 *     against a REAL emitted package rather than only against the declaration.
 *  6. **No module here does its own arithmetic on money outside `render.ts`
 *     and the solver's own totals** — no `Intl.NumberFormat`, no second
 *     currency conversion, no hand-rolled rate lookup.
 *
 * Every scanner carries the metro-gate defences (`~/Oxy/AGENTS.md`): a VACUITY
 * FLOOR so a moved file fails the gate instead of silently shrinking it, and a
 * MUTATION SELF-TEST so a rotted regex cannot pass by matching nothing.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type DirectoryReader,
  assertNothingOutsideDomainPopulation,
  namedInSharedDirectories,
  readSrcDirectory,
  walkOwnedDirectory,
} from '../../../__tests__/domain-population.js';
import {
  COMPARISON_FORBIDDEN_RECOMMENDATION_INPUTS,
  COMPARISON_RECOMMENDATION_INPUTS,
  BASKET_REASON_CODES,
  BASKET_RESULT_KINDS,
} from '@mercaria/shared-types';
import { buildExplanationPackage } from '../explanation/package.js';
import { buildComparisonTable } from '../table.js';
import { COMPARISON_DIRECTION_RULES, resolveComparisonDirection } from '../policy.js';
import { buildConstraintColumn } from '../constraints.js';
import { commerce, eur, subject } from './fixtures.js';
import type {
  ComparisonInput,
  ProductConstraint,
  ShoppingInterpretation,
} from '@mercaria/shared-types';
import { assertEachOf } from '../../../__tests__/assert-each-of.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** What a module of this domain is called, wherever it lives. */
const COMPARISON_NAME_PATTERN = /comparison/i;

/** The one directory this domain owns outright. */
const OWNED_DIRECTORY = 'services/comparison';

/**
 * The flat directories every domain's HTTP surface shares.
 *
 * `db/schema` joined the three with #460. It holds no comparison-named module
 * today — this domain stores nothing of its own — and it is here so that one
 * added tomorrow lands inside the walls rather than only inside the whole-tree
 * assertion below.
 */
const SHARED_DIRECTORIES = ['routes', 'controllers', 'middleware', 'db/schema'] as const;

/** Every non-test module in the domain, read from the real directory tree. */
function domainSources(): { relative: string; source: string }[] {
  return walkOwnedDirectory(OWNED_DIRECTORY).map((relative) => ({
    relative,
    source: readFileSync(join(SRC_ROOT, relative), 'utf8'),
  }));
}

/**
 * Every comparison-NAMED module in a shared flat directory, whoever owns it.
 *
 * RECURSIVE and matched on the PATH with #460, where this read one level and
 * matched the FILENAME. `routes/admin/` and `controllers/admin/` hold 23 and 19
 * modules that a one-level sweep reaches none of.
 */
function comparisonNamedSharedModules(): string[] {
  return namedInSharedDirectories(SHARED_DIRECTORIES, COMPARISON_NAME_PATTERN);
}

/** The whole population every wall below is applied to. */
function domainRelativePaths(readDir: DirectoryReader = readSrcDirectory): string[] {
  const excused = new Set<string>(RANKING_OWNED_MODULES.map((module) => module.path));
  return [
    ...walkOwnedDirectory(OWNED_DIRECTORY, readDir),
    ...namedInSharedDirectories(SHARED_DIRECTORIES, COMPARISON_NAME_PATTERN, readDir).filter(
      (path) => !excused.has(path),
    ),
  ];
}

/**
 * Comparison-NAMED shared modules that belong to ANOTHER domain — the scope
 * judgement, made explicitly rather than by silence, and with an EXACT count
 * (#448: an excusing entry is a predicate, not an identity).
 *
 * `comparison` in a filename says what a module is ABOUT, not which wall it
 * lives behind. #96's product comparison and #74's OFFER comparison are two
 * different features that share an English word, and the line drawn here is the
 * import graph rather than preference: neither module below imports anything
 * under `services/comparison/`, and both import `services/ranking/` instead.
 *
 * Scoping them IN would be actively harmful rather than merely wrong. Wall 3
 * below forbids reading the REVIEW domain and wall 1 forbids commercial
 * standing — #74's comparison legitimately reads a merchant rating as a ranking
 * signal, so this gate would fail on it for a CORRECT reason about the wrong
 * domain, and the cheapest way to green that is to weaken wall 3. A gate that
 * pushes you toward the hazard.
 */
const RANKING_OWNED_MODULES = [
  {
    path: 'controllers/offer-comparison.controller.ts',
    owner: "#74's offer ranking",
    reaches: 'services/ranking/',
  },
  {
    path: 'routes/offer-comparison.ts',
    owner: "#74's offer ranking",
    reaches: 'middleware/ranking-schemas.js',
  },
  {
    // The THIRD, and it was invisible until #460. The sweep above only looked at
    // the three shared flat directories, so a comparison-named module inside
    // ANOTHER domain's own directory was neither in the population nor excluded
    // from it — it was simply not a question this gate asked. It is #74's
    // `rankOfferComparison`, the entry point #70's search consumes.
    path: 'services/ranking/comparison.service.ts',
    owner: "#74's offer ranking",
    reaches: './ranking.js',
  },
] as const;

/**
 * The rest of the domain — the surfaces outside `services/comparison/`.
 * WALKED and FILTERED, never listed.
 *
 * This was three hand-written paths (#460). The shared flat directories have no
 * directory of their own to walk, so the population is every comparison-NAMED
 * module in them MINUS the exact two that belong to #74.
 */
const OUTER_PATHS = comparisonNamedSharedModules().filter(
  (path) => !RANKING_OWNED_MODULES.some((module) => module.path === path),
);

function outerSources(): { relative: string; source: string }[] {
  return OUTER_PATHS.map((relative) => ({
    relative,
    source: readFileSync(join(SRC_ROOT, relative), 'utf8'),
  }));
}

/** Comment-stripped source: these modules DOCUMENT what they refuse to do. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Reaching anything that could price a recommendation, from any direction.
 *
 * Matched on the bare `<domain>/` path segment as well as the `services/` form,
 * because an import from a sibling directory is written `../fees/…`. The
 * mutation self-test below proves both spellings are covered.
 */
const COMMERCIAL_REFERENCE =
  /\bfees\/|\breferrals\/|\bretail-pricing\/|\bledger|feeSchedule|orderFeeSnapshot|fee_schedules|order_fee_snapshots|marketplaceFee|referralProgram|referral_programs|retailCostQuote|retail_cost_quotes|merchantPlan|commissionRate|affiliate_commission/;

/** Naming a currency. FAIR is the one that matters — the display default. */
const CURRENCY_NAME_REFERENCE = /\bFAIR\b|FairCoin|faircoin|OxyPay|oxy_pay|oxyPay/;

/** Reading review sentiment, which may never become a specification. */
const REVIEW_REFERENCE =
  /services\/reviews\/|\.\.\/reviews\/|review\.service|reviewAggregate|review_aggregates|db\/reviews\//;

/** A second money formatter or a second currency conversion. */
const SECOND_FORMATTER = /Intl\.NumberFormat|toLocaleString|getRates\(|\bpairRate\(/;

describe('the comparison domain has real modules — the vacuity floor', () => {
  it('scans a domain that exists and is not empty', () => {
    const domain = domainSources();
    // A renamed directory or a moved module must fail here rather than make
    // every scan below pass against an empty list.
    expect(domain.length).toBeGreaterThanOrEqual(16);
    for (const file of domain) {
      expect(file.source.length, `${file.relative} looks empty — did it move?`).toBeGreaterThan(200);
    }
    for (const file of outerSources()) {
      expect(file.source.length, `${file.relative} looks empty — did it move?`).toBeGreaterThan(200);
    }
  });

  it('derives the outer surface rather than listing it, and every shape found something', () => {
    // Floors PER SHAPE rather than one on the total: the domain walk and the
    // shared-directory derivation break independently, and a single total lets
    // one collapse to zero while the other carries the number.
    //
    // Each is today's count, because these directories only grow and a SHRINK
    // is the event that should stop the build.
    const outer = OUTER_PATHS;
    expect(outer.filter((p) => p.startsWith('controllers/')).length).toBeGreaterThanOrEqual(1);
    expect(outer.filter((p) => p.startsWith('routes/')).length).toBeGreaterThanOrEqual(1);
    expect(outer.filter((p) => p.startsWith('middleware/')).length).toBeGreaterThanOrEqual(1);
    expect(outer.filter((p) => p.includes('__tests__'))).toEqual([]);
    for (const path of outer) {
      expect(statSync(join(SRC_ROOT, path)).isFile(), `${path} is not a file`).toBe(true);
    }

    // EXACT, not a floor. An excusing entry is a predicate rather than an
    // identity, so a list with no count lets a third comparison-named module be
    // excluded without anybody deciding to (#448).
    expect(RANKING_OWNED_MODULES.length).toBe(3);

    const OWNED = /(?:^|\/)services\/comparison\//;
    for (const { path, owner, reaches } of RANKING_OWNED_MODULES) {
      // The exclusion must name a module that really exists and really is
      // comparison-named — otherwise it is a stale name excusing nothing.
      // Checked against the NAME and the FILESYSTEM rather than against the
      // shared-directory candidate list, because the third entry lives inside
      // another domain's own directory and that list never reaches it.
      expect(
        COMPARISON_NAME_PATTERN.test(path),
        `${path} is excluded but is not a comparison-named module`,
      ).toBe(true);
      expect(statSync(join(SRC_ROOT, path)).isFile(), `${path} does not exist`).toBe(true);

      // And the JUSTIFICATION is measured against the real imports: it must
      // still reach #74, and must still NOT reach this domain. A module that
      // starts importing `services/comparison/` stops being excludable and this
      // gate says which.
      const specifiers = [
        ...readFileSync(join(SRC_ROOT, path), 'utf8').matchAll(/from\s+'([^']+)'/g),
      ].map((match) => match[1] ?? '');
      expect(
        specifiers.some((specifier) => specifier.includes(reaches)),
        `${path} was scoped out as ${owner}'s, and no longer imports ${reaches}`,
      ).toBe(true);
      expect(
        specifiers.filter((specifier) => OWNED.test(specifier)),
        `${path} was scoped out as ${owner}'s, but now imports the comparison domain`,
      ).toEqual([]);
    }
  });
});

describe('WALL 1: a recommendation cannot read commercial standing', () => {
  it('no module references a fee, a referral, a plan, a margin or the ledger', () => {
    let scanned = 0;
    for (const file of [...domainSources(), ...outerSources()]) {
      expect(
        COMMERCIAL_REFERENCE.test(withoutComments(file.source)),
        `${file.relative} reaches commercial standing; a recommendation that can be priced is ` +
          'one that will be sold',
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBeGreaterThanOrEqual(19);
  });

  it('the commercial detector actually detects — the mutation self-test', () => {
    expect(
      COMMERCIAL_REFERENCE.test("import { planFee } from '../fees/order-fees.service.js';"),
    ).toBe(true);
    expect(
      COMMERCIAL_REFERENCE.test("import { attribute } from '../referrals/attribution.service.js';"),
    ).toBe(true);
    expect(COMMERCIAL_REFERENCE.test("import { quote } from '../retail-pricing/cost.js';")).toBe(true);
    expect(COMMERCIAL_REFERENCE.test('select * from order_fee_snapshots')).toBe(true);
    expect(COMMERCIAL_REFERENCE.test('const commissionRate = 0.1;')).toBe(true);
    expect(COMMERCIAL_REFERENCE.test("import { getDb } from '../../db/postgres.js';")).toBe(false);
    expect(COMMERCIAL_REFERENCE.test('const itemPrice = offer.price;')).toBe(false);
  });
});

/**
 * The ONE legitimate mention, narrowed to the declaration that makes it
 * legitimate.
 *
 * `explanation/validation.ts` must name FAIR, because refusing a generated
 * sentence that mentions it is the whole of explanation rule 8 — a refusal
 * pattern cannot refuse a word it does not contain. #65's gate makes the same
 * carve-out for its token lifetime and narrows it to one file for the same
 * reason.
 *
 * The exemption is narrowed FURTHER than the file: the declaration is cut out
 * and the REMAINDER of the file is scanned like every other module, so a second
 * mention anywhere else in it — a branch, a comment, a default — still fails.
 */
function sourceOutsideForbiddenTopic(source: string): string {
  const declaration = source.indexOf('const FORBIDDEN_TOPIC');
  if (declaration === -1) return source;
  const end = source.indexOf(';', declaration);
  if (end === -1) return source;
  // The docblock IMMEDIATELY above it is part of the exemption: it is where the
  // reason for the prohibition is written, and a gate that forced the reason to
  // be unwritable would trade a real explanation for a passing scan. Nothing
  // further up is exempt — the search is bounded to the block that touches the
  // declaration.
  const comment = source.lastIndexOf('/**', declaration);
  const start = comment === -1 ? declaration : comment;
  return source.slice(0, start) + source.slice(end + 1);
}

describe('WALL 2: the domain names no currency', () => {
  it('no module carries a FAIR, FairCoin or OxyPay spelling', () => {
    let scanned = 0;
    for (const file of [...domainSources(), ...outerSources()]) {
      // RAW source, comments included: a comparison that documented a currency
      // preference is one keystroke from acting on it, and the copy is part of
      // what a reviewer reads.
      expect(
        CURRENCY_NAME_REFERENCE.test(sourceOutsideForbiddenTopic(file.source)),
        `${file.relative} names a currency; the caller names the comparison currency`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBeGreaterThanOrEqual(19);
  });

  it('the ONE exempted declaration exists and is the only mention in its file', () => {
    // Without this the carve-out could hide a whole file: a `validation.ts`
    // that lost its `FORBIDDEN_TOPIC` constant would stop refusing the topic
    // AND stop being scanned, and both failures would be silent.
    const validation = domainSources().find((file) =>
      file.relative.endsWith('services/comparison/explanation/validation.ts'),
    );
    expect(validation, 'the validator moved; the carve-out now hides nothing or everything').toBeDefined();
    if (validation === undefined) return;
    expect(validation.source).toContain('const FORBIDDEN_TOPIC');
    expect(CURRENCY_NAME_REFERENCE.test(validation.source)).toBe(true);
    expect(CURRENCY_NAME_REFERENCE.test(sourceOutsideForbiddenTopic(validation.source))).toBe(false);
  });

  it('the currency detector actually detects — the mutation self-test', () => {
    expect(CURRENCY_NAME_REFERENCE.test("const preferred = 'FAIR';")).toBe(true);
    expect(CURRENCY_NAME_REFERENCE.test('// FairCoin is the display default')).toBe(true);
    expect(CURRENCY_NAME_REFERENCE.test('import { OxyPay } from "x";')).toBe(true);
    expect(CURRENCY_NAME_REFERENCE.test("const currency: CurrencyCode = request.currency;")).toBe(false);
    expect(CURRENCY_NAME_REFERENCE.test('const fair = isFairComparison();')).toBe(false);
  });
});

describe('WALL 3: review sentiment can never become a specification', () => {
  it('no module reaches the review domain', () => {
    let scanned = 0;
    for (const file of [...domainSources(), ...outerSources()]) {
      expect(
        REVIEW_REFERENCE.test(withoutComments(file.source)),
        `${file.relative} reaches the review domain; a rating is an aggregate of opinions and a ` +
          'table row reads as a fact about the object',
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBeGreaterThanOrEqual(19);
  });

  it('the review detector actually detects — the mutation self-test', () => {
    expect(REVIEW_REFERENCE.test("import { x } from '../reviews/aggregate.service.js';")).toBe(true);
    expect(REVIEW_REFERENCE.test("import { y } from '../../db/reviews/reviewRepository.js';")).toBe(true);
    expect(REVIEW_REFERENCE.test('const aggregate = await reviewAggregate(id);')).toBe(true);
    expect(REVIEW_REFERENCE.test('const reviewed = false;')).toBe(false);
  });
});

describe('WALL 4: the two vocabularies are disjoint', () => {
  it('no forbidden input is also an allowed one', () => {
    const allowed = new Set<string>(COMPARISON_RECOMMENDATION_INPUTS);
    const overlap = COMPARISON_FORBIDDEN_RECOMMENDATION_INPUTS.filter((input) =>
      allowed.has(input),
    );
    expect(overlap, 'a prohibition became a recommendation input').toEqual([]);
    // Both floors: an empty tuple on either side makes the check vacuous.
    expect(COMPARISON_RECOMMENDATION_INPUTS.length).toBeGreaterThanOrEqual(10);
    expect(COMPARISON_FORBIDDEN_RECOMMENDATION_INPUTS.length).toBeGreaterThanOrEqual(8);
  });

  it('every prohibition the issue names is present as a VALUE', () => {
    assertEachOf([
      'affiliate_commission_rate',
      'merchant_subscription_plan',
      'fair_acceptance',
      'review_sentiment',
      'model_general_knowledge',
      'ingestion_order',
    ], 6, (forbidden) => {
      expect(COMPARISON_FORBIDDEN_RECOMMENDATION_INPUTS).toContain(forbidden);
    });
  });

  it('the reason and result vocabularies are closed and non-empty', () => {
    expect(BASKET_REASON_CODES.length).toBeGreaterThanOrEqual(15);
    expect(new Set(BASKET_REASON_CODES).size).toBe(BASKET_REASON_CODES.length);
    expect(BASKET_RESULT_KINDS).toHaveLength(8);
    expect(new Set(BASKET_RESULT_KINDS).size).toBe(8);
  });
});

describe('WALL 5: a forbidden input has nowhere to live, in a REAL package', () => {
  /** A minimal but non-empty comparison, so the walk has something to walk. */
  function sampleInput(): ComparisonInput {
    return {
      policy: {
        comparisonPolicyVersion: 'compare-test',
        rankingPolicyVersion: 'rank-test',
        constraintEvaluationVersion: 'ce-1',
        normalizationRuleVersion: 'nr-2',
      },
      evaluatedAt: '2026-08-10T00:00:00.000Z',
      comparisonCurrency: 'EUR',
      conditionGroups: [],
      subjects: [
        {
          ref: 'p1',
          name: 'Alpha',
          acquisition: {
            state: 'purchasable',
            channels: ['external_merchant'],
            leadOfferRef: 'o1',
            eligibleOfferCount: 1,
          },
          offerRefs: ['o1'],
        },
        {
          ref: 'p2',
          name: 'Beta',
          acquisition: { state: 'unavailable', reason: 'no_eligible_offer' },
          offerRefs: [],
        },
      ],
      offers: [
        {
          ref: 'o1',
          subjectRef: 'p1',
          variantRef: 'v1',
          kind: 'external',
          merchantRef: 'm1',
          rank: 1,
          itemPrice: eur(29900),
          deliveryCost: eur(500),
          total: eur(30400),
          taxInclusion: 'inclusive',
          availability: 'in_stock',
          nativeCheckoutEligible: false,
          freshness: 'current',
          destinationHost: 'alpha.example',
        },
      ],
      relationships: [],
      priceSignals: [],
      gaps: [],
      table: buildComparisonTable([
        subject('p1', { commerce: commerce({ lowestItemPrice: eur(29900) }) }),
        subject('p2', { commerce: commerce({ lowestItemPrice: eur(34900) }) }),
      ]),
      rates: [],
      records: [
        { ref: 'p1', kind: 'canonical_product', recordId: 'prod-1', canonicalPath: '/p/alpha' },
        { ref: 'o1', kind: 'offer', recordId: 'offer-1' },
      ],
    };
  }

  it('the emitted package carries no id, no path, no host and no forbidden key', () => {
    const pkg = buildExplanationPackage(sampleInput());
    // The floor: an empty package would pass every assertion below.
    expect(pkg.subjects.length).toBeGreaterThanOrEqual(2);
    expect(pkg.rows.length).toBeGreaterThanOrEqual(5);
    expect(pkg.groundedValues.length).toBeGreaterThanOrEqual(3);

    const serialized = JSON.stringify(pkg);
    assertEachOf([
      'prod-1',
      'offer-1',
      '/p/alpha',
      'alpha.example',
      'recordId',
      'canonicalPath',
      'destinationHost',
      'commission',
      'referral',
      'margin',
    ], 10, (forbidden) => {
      expect(serialized.includes(forbidden), `the package leaked ${forbidden}`).toBe(false);
    });
  });

  it('the leak detector actually detects — the mutation self-test', () => {
    // A package that DID carry an id would be caught by exactly this check.
    const leaky = JSON.stringify({ ...buildExplanationPackage(sampleInput()), recordId: 'prod-1' });
    expect(leaky.includes('prod-1')).toBe(true);
    expect(leaky.includes('recordId')).toBe(true);
  });
});

describe('WALL 6: money is formatted and converted in ONE place', () => {
  it('no module outside `render.ts` formats or re-quotes money', () => {
    let scanned = 0;
    for (const file of [...domainSources(), ...outerSources()]) {
      // `render.ts` formats; `basket/candidate-source.ts` is the ONE module
      // that resolves FX rates, so the solve and the revalidation that follows
      // it price an offer's terms the same way. Everything else must go through
      // them — a second `getRates` call site is a second answer to what a
      // free-shipping threshold is worth.
      if (file.relative.endsWith('services/comparison/render.ts')) continue;
      if (file.relative.endsWith('services/comparison/basket/candidate-source.ts')) continue;
      expect(
        SECOND_FORMATTER.test(withoutComments(file.source)),
        `${file.relative} formats or re-quotes money; one renderer is what makes the grounded ` +
          'token set exact',
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBeGreaterThanOrEqual(17);
  });

  it('the formatter detector actually detects — the mutation self-test', () => {
    expect(SECOND_FORMATTER.test('new Intl.NumberFormat("es-ES").format(x)')).toBe(true);
    expect(SECOND_FORMATTER.test('amount.toLocaleString()')).toBe(true);
    expect(SECOND_FORMATTER.test('const rates = await getRates(currency, quotes);')).toBe(true);
    expect(SECOND_FORMATTER.test('const rendered = renderMoney(amount);')).toBe(false);
  });
});

describe('WALL 7: #95 is consumed through #94\u2019s language, with no adapter', () => {
  /**
   * The positive direction, which the other six walls cannot express.
   *
   * Five of the walls say what this domain may not reach; this one says what it
   * MUST still be able to consume. #95's `ShoppingInterpretation.constraints`
   * is a #94 `ConstraintSet`, and `POST /comparison` accepts exactly that
   * language — so a client wires the two together by passing one field, with no
   * translation layer that could reinterpret what a shopper asked for.
   *
   * The assignment below is the gate: the day #95's constraint type diverges
   * from #94's, this file stops compiling and CI goes red, rather than a
   * storefront quietly losing half a query.
   */
  it('an interpretation\u2019s constraints ARE a comparison request\u2019s constraints', () => {
    const interpretationConstraints: ShoppingInterpretation['constraints'] = {
      constraints: [
        {
          kind: 'attribute',
          id: 'ram',
          scope: 'product',
          explanation: 'At least 16 GB of memory',
          strength: 'hard',
          missingDataPolicy: 'exclude_when_unknown',
          attributeKey: 'ram_capacity',
          definitionVersion: 1,
          predicate: { op: 'gte', value: { type: 'measurement', magnitude: 16, unit: 'GB' } },
        },
      ],
    };

    // The exact shape the controller hands to #94's validator, taken straight
    // off the interpretation with no mapping in between.
    const forComparison: readonly ProductConstraint[] = interpretationConstraints.constraints;
    expect(forComparison).toHaveLength(1);
    expect(forComparison[0].id).toBe('ram');

    // …and the same list is what a constraint COLUMN is built from, so a
    // comparison can name the requirement a shopper typed.
    const column = buildConstraintColumn({
      subjectRef: 'p1',
      evaluation: {
        entityKind: 'product',
        entityId: 'prod-1',
        verdict: 'included',
        hardOutcomes: [
          {
            constraintId: 'ram',
            strength: 'hard',
            satisfaction: 'satisfied',
            explanation: 'At least 16 GB of memory',
            reason: '16 GB \u2265 16 GB required',
            sourceBacked: true,
          },
        ],
        preferenceOutcomes: [],
        preferenceScore: 1,
        evaluationVersion: 'ce-1',
        normalizationRuleVersion: 'nr-2',
      },
      constraints: forComparison,
      constraintRefs: new Map([['ram', 'c1']]),
      declaredAttributeKeys: new Set(['ram_capacity']),
    });
    expect(column.satisfied.map((entry) => entry.constraintId)).toEqual(['ram']);
  });

  it('no module in the domain imports the search-intent domain', () => {
    // Consumption happens at the HTTP boundary through a shared vocabulary, not
    // by one domain reaching into the other. A `services/search-intent/` import
    // here would make a comparison unable to render without an interpreter.
    let scanned = 0;
    for (const file of [...domainSources(), ...outerSources()]) {
      expect(
        /search-intent\/|planShoppingIntent|ShoppingIntentResult/.test(
          withoutComments(file.source),
        ),
        `${file.relative} imports the intent domain`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBeGreaterThanOrEqual(19);
  });
});

describe("#94's display policy reaches this surface", () => {
  it('the comparison service applies it, and applies it to BOTH maps', () => {
    // #367 line 277's "displayable" capability. `/comparison` is public and
    // unauthenticated, and a table row publishes the attribute's LABEL and its
    // normalized VALUE, so an `operator_only` attribute reaching it is a public
    // rendering of exactly what the policy withheld. Before this it did: the
    // service read `comparable` off every definition and never `display_policy`.
    //
    // A GREEN-AND-INERT mechanism is the failure mode this asserts against —
    // `listOperatorOnlyAttributeKeys` existing and nothing calling it — so it
    // asserts the ENTRYPOINT calls it rather than that the read exists. What the
    // read ITSELF answers is measured against a real server in
    // `db/__tests__/attribute-registry.realdb.test.ts`.
    const service = readFileSync(join(SRC_ROOT, 'services/comparison/comparison.service.ts'), 'utf8');
    const code = withoutComments(service);
    expect(code).toContain('listOperatorOnlyAttributeKeys');
    expect(code).toContain('withholdOperatorOnlyAttributes(db, declared, facts)');

    // Both maps, and the second is the one that is easy to miss.
    // `buildComparisonTable` builds a row for every key appearing in EITHER, so
    // a fact whose definition sits outside the subject's category reaches the
    // table under its own key even when nothing declares it — which is what
    // `attributeKeysOf` and `toAttributeFact` in this domain say out loud.
    const withhold = code.slice(code.indexOf('async function withholdOperatorOnlyAttributes'));
    expect(withhold).toContain('declared.keys()');
    expect(withhold).toContain('facts.keys()');
    expect(withhold.slice(0, 1200)).toContain('(declared as Map<string, DeclaredAttribute>).delete(key)');
    expect(withhold.slice(0, 1200)).toContain('(facts as Map<string, TableAttributeFact>).delete(key)');
  });

  it('the entrypoint detector actually detects — the mutation self-test', () => {
    // Every assertion above is a `toContain` over source, and a `toContain` that
    // matched a string nobody removed would go on passing after the call site
    // was deleted. Both mutations below are the deletion this gate exists to
    // catch, and both make the assertions fail.
    const service = readFileSync(join(SRC_ROOT, 'services/comparison/comparison.service.ts'), 'utf8');
    const withoutCall = withoutComments(service).replace(
      'withholdOperatorOnlyAttributes(db, declared, facts)',
      '',
    );
    expect(withoutCall).not.toContain('withholdOperatorOnlyAttributes(db, declared, facts)');
    const withoutFacts = withoutComments(service).replace('facts.keys()', 'declared.keys()');
    expect(withoutFacts).not.toContain('facts.keys()');
  });
});

describe('the direction policy defaults to `not_comparable`', () => {
  it('an unclassified attribute has no preferred direction', () => {
    // The default that makes product-comparison rule 6 true. If this ever
    // answers a direction, every unclassified numeric row starts declaring a
    // winner nobody agreed.
    assertEachOf(['weight_grams', 'length_mm', 'capacity_litres', 'anything_at_all'], 4, (key) => {
      expect(resolveComparisonDirection(key)).toBe('not_comparable');
    });
  });

  it('every declared direction carries the reason it is category-independent', () => {
    // The floor: an empty table would make the check above vacuous.
    expect(COMPARISON_DIRECTION_RULES.length).toBeGreaterThanOrEqual(6);
    for (const rule of COMPARISON_DIRECTION_RULES) {
      expect(resolveComparisonDirection(rule.attributeKey)).toBe(rule.direction);
      expect(rule.because.length, `${rule.attributeKey} has no justification`).toBeGreaterThan(30);
    }
    // …and no key is declared twice, which would make the first one silently win.
    const keys = COMPARISON_DIRECTION_RULES.map((rule) => rule.attributeKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('the population every wall above is applied to (#460)', () => {
  it('nothing naming comparison sits outside it', () => {
    // This is what makes the THIRD ranking-owned module a decision rather than
    // an absence. Before #460 the gate swept three shared flat directories and
    // nothing else, so `services/ranking/comparison.service.ts` was neither in
    // the population nor excluded from it — it was not a question the gate
    // asked, and no floor or count here could have said so.
    assertNothingOutsideDomainPopulation({
      population: domainRelativePaths,
      pattern: COMPARISON_NAME_PATTERN,
      notThisDomain: RANKING_OWNED_MODULES.map((module) => ({
        path: module.path,
        why:
          `${module.owner} owns it: it imports ${module.reaches} and imports nothing under ` +
          'services/comparison/. Scoping it IN would fail this gate for a CORRECT reason about ' +
          "the wrong domain — #74's comparison legitimately reads a merchant rating as a " +
          'ranking signal, and the cheapest way to green that is to weaken wall 3.',
      })),
      expectedExclusions: 3,
      // Below today's 28 so a routine deletion does not fail the build, and far
      // enough above zero that a traversal which reached nothing does.
      sweepFloor: 22,
      plantIn: 'lib',
      plantName: 'comparison-cache.ts',
    });
  });

  it('ONE list of ranking-owned modules feeds both the population and the exclusion', () => {
    // Two spellings of one fact can disagree, and the direction they disagree in
    // is always the permissive one. `domainRelativePaths` filters on the same
    // array `notThisDomain` is built from, so a module excused above is the same
    // module kept out of the walls.
    const population = domainRelativePaths();
    for (const { path } of RANKING_OWNED_MODULES) {
      expect(population, `${path} is excused AND scanned`).not.toContain(path);
    }
  });

  it('floors PER SHAPE, because the two sources break independently', () => {
    const owned = walkOwnedDirectory(OWNED_DIRECTORY);
    const shared = comparisonNamedSharedModules();
    expect(owned.length, 'the owned-directory walk reached nothing').toBeGreaterThanOrEqual(18);
    expect(shared.length, 'the shared-directory name sweep reached nothing').toBeGreaterThanOrEqual(
      4,
    );
  });

  it('the shared sweep RECURSES and matches the PATH, which the filename sweep did not', () => {
    // The narrowing this replaced: one level deep, matched on `entry.name`. Both
    // halves are measured with a seeded reader, plus the assertion that makes it
    // non-circular — the module is absent from the real tree.
    const seeded: DirectoryReader = (relative) =>
      relative === 'controllers'
        ? [
            ...readSrcDirectory(relative),
            { name: 'comparison-admin', isDirectory: () => true, isFile: () => false },
          ]
        : relative === 'controllers/comparison-admin'
          ? [{ name: 'overrides.ts', isDirectory: () => false, isFile: () => true }]
          : readSrcDirectory(relative);
    const planted = 'controllers/comparison-admin/overrides.ts';
    expect(domainRelativePaths(seeded), 'the sweep does not recurse').toContain(planted);
    expect(
      domainRelativePaths(),
      'the seeded module exists on disk, so this proves nothing',
    ).not.toContain(planted);
    // And it is the PATH that carries the domain name, not the filename — a
    // filename rule would have missed it.
    expect(/comparison/i.test('overrides.ts')).toBe(false);
    expect(COMPARISON_NAME_PATTERN.test(planted)).toBe(true);
  });
});
