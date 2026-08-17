/**
 * The walls around the catalog governance surface (#367 Workstream 12).
 *
 * Six scanned walls, each with a vacuity floor and a mutation self-test —
 * because a detector that cannot fire is indistinguishable from one doing work,
 * and a scan that read nothing reports the same tidy zero as a clean codebase.
 *
 * Every count is printed on SUCCESS and not only on failure: a population size
 * in a passing run is what makes an unrelated red legible later.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CATALOG_GOVERNANCE_ACTIONS,
  COMPATIBILITY_CLAIM_PROMOTION_FORBIDDEN_INPUTS,
  CATALOG_GOVERNANCE_ACTION_DOMAINS,
  CATALOG_GOVERNANCE_ACTION_ROLES,
  CATALOG_GOVERNANCE_ACTION_SUBJECTS,
  CATALOG_GOVERNANCE_AUDIT_ACTIONS,
  CATALOG_GOVERNANCE_COUNTED_SUBJECT_KINDS,
  CATALOG_GOVERNANCE_FORBIDDEN_CAPABILITIES,
  CATALOG_GOVERNANCE_LIFECYCLE_ACTIONS,
  CATALOG_GOVERNANCE_PROPOSE_ROLE,
  CATALOG_GOVERNANCE_READ_ROLE,
  CATALOG_GOVERNANCE_REVIEW_ACTIONS,
  CATALOG_GOVERNANCE_ROLES,
  CATALOG_GOVERNANCE_SNAPSHOT_SCOPES,
  CATALOG_GOVERNANCE_SUBJECT_KINDS,
} from '@mercaria/shared-types';
import { DIRECT_APPLY_ACTIONS } from '../apply.js';
import { RESTORE_UNSUPPORTED_SCOPES } from '../snapshot.service.js';

const SRC_ROOT = join(import.meta.dirname, '..', '..', '..');

/** The whole domain — services, repositories, schema, route, controller, schemas. */
const SCANNED_PATHS: readonly string[] = [
  join('services', 'catalog-governance'),
  join('db', 'catalogGovernance'),
  join('db', 'schema', 'catalogGovernance.ts'),
  join('routes', 'internal-catalog-governance.ts'),
  join('controllers', 'catalog-governance.controller.ts'),
  join('middleware', 'catalog-governance-schemas.ts'),
];

function walk(dir: string, into: Map<string, string>): void {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === '__tests__') continue;
      walk(path, into);
      continue;
    }
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
    into.set(relative(SRC_ROOT, path), readFileSync(path, 'utf8'));
  }
}

/** `{relative path → source}` for every production file in the domain. */
function domainSources(): Map<string, string> {
  const sources = new Map<string, string>();
  for (const path of SCANNED_PATHS) {
    const absolute = join(SRC_ROOT, path);
    if (statSync(absolute).isDirectory()) walk(absolute, sources);
    else sources.set(path, readFileSync(absolute, 'utf8'));
  }
  return sources;
}

/**
 * Source with comments removed.
 *
 * Load-bearing here: every module in this domain DOCUMENTS what it refuses to
 * do, in the same vocabulary a detector scans for. A scan over raw source would
 * fire on the prose explaining why the thing is forbidden — the
 * `checkout-contact-isolation` finding.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/.*$/gmu, '$1');
}

interface Wall {
  readonly name: string;
  readonly pattern: RegExp;
  readonly why: string;
  /** Files this wall does not apply to, each with a reason. */
  readonly exempt?: readonly { readonly path: string; readonly reason: string }[];
}

const WALLS: readonly Wall[] = [
  {
    name: 'no catalogue write',
    // Every governance apply DRIVES the owning domain's writer. A `.insert(`,
    // `.update(` or `.delete(` against a catalogue table here would be a second
    // writer of something whose derivations live in one place.
    pattern:
      /\.\s*(?:insert|update|delete)\s*\(\s*(?:categories|listings|productTypeDefinitions|productTypeFields|productTypeFieldGroups|productTypeCategoryScopes|attributeDefinitions|attributeEnumValues|attributeLabels|attributeValueAliases|canonicalProducts|canonicalVariants|brands|navigationTrees|navigationNodes|categoryAliases|categoryRedirects)\s*\)/u,
    why: 'This domain writes NOTHING in the catalogue. Every apply calls the owning domain\'s own writer — taxonomyRepository, publishProductTypeVersion, publishAttributeDefinition, publishNavigationTree.',
  },
  {
    name: 'no second operator allow-list',
    // The roles refine `CATALOG_OPERATOR_OXY_USER_IDS`; they never extend it.
    // A module here writing that config would be one that could admit somebody
    // the deployment excluded, which is what makes this not a seventh list.
    pattern: /graphOperatorOxyUserIds\s*[.=[]|OPERATOR_OXY_USER_IDS\s*=/u,
    why: 'Role grants narrow WITHIN the env allow-list and may never extend it. `grant_operator_membership` is named in CATALOG_GOVERNANCE_FORBIDDEN_CAPABILITIES.',
  },
  {
    name: 'no order, payment or buyer data in an export',
    // The snapshot document is jsonb, so the schema cannot constrain it. This
    // is the static half; `catalog-governance.realdb.test.ts` walks a real one.
    pattern:
      /\b(?:from\s+orders\b|from\s+order_items\b|from\s+payments\b|from\s+refunds\b|from\s+ledger_entries\b|from\s+carts\b|from\s+guest_checkouts\b|buyerOxyUserId|orderNumber)\b/iu,
    why: 'Export, snapshot and restore cover catalog DEFINITIONS. Production order data has no column here and must have no query either.',
  },
  {
    name: 'no ranking, fee or referral reference',
    // A governance surface one join from a plan-weighted ordering is how
    // "publishing a category can change where it ranks" arrives.
    pattern:
      /services\/ranking\/|services\/fees\/|feeSchedule|fee_schedules|marketplaceFee|services\/referrals\/|referral_|commission_revenue/u,
    why: 'Administering the catalogue may not read or write commercial ranking, fees or referrals.',
  },
  {
    name: 'no store-scoped permission',
    // A merchant path cannot construct a `CatalogGovernanceActor`. A module
    // here importing store authorization would be one building a second, weaker
    // door into the same functions.
    pattern: /requireStorePermission|store-authz|loadStore|storeScopeFrom/u,
    why: 'A merchant role may never publish a global catalog change. The guarantee is the branded actor type; importing store authorization here would be the beginning of a second path.',
  },
  {
    name: 'nothing derives the vehicle a claim is promoted to',
    // The trap this whole surface is shaped around: an ambiguous fitment
    // resolved to the LIKELIEST vehicle. It is #58's false merge one domain
    // over, and worse — a wrong product match shows the wrong page, a wrong
    // fitment sells somebody a brake pad that does not fit their car, and only
    // the customer finds out.
    //
    // The pattern is RENDERED from `COMPATIBILITY_CLAIM_PROMOTION_FORBIDDEN_INPUTS`
    // rather than written out, so a value added to that tuple is scanned for
    // without anybody editing this file — and the values do not appear literally
    // here, so the wall cannot trip over stating itself.
    pattern: new RegExp(COMPATIBILITY_CLAIM_PROMOTION_FORBIDDEN_INPUTS.join('|'), 'u'),
    why: 'The operator names the vehicle in full or the promotion is refused. Nothing here may suggest, rank, infer or read it out of the claim\'s own words.',
  },
  {
    name: 'no code execution from stored input',
    // `parameters`, the snapshot document and the audit before/after are all
    // caller-influenced jsonb.
    pattern: /\beval\s*\(|new\s+Function\s*\(|node:vm\b|require\s*\(\s*['"]vm['"]/u,
    why: 'Change-request parameters and snapshot documents are caller-supplied jsonb. Nothing here executes them.',
  },
];

describe('the catalog governance walls', () => {
  it('scans a domain that is actually there', () => {
    const sources = domainSources();
    const bytes = [...sources.values()].reduce((sum, source) => sum + source.length, 0);
    // Two floors, because a walk that found the files and an extension filter
    // that dropped their contents fail differently.
    expect(sources.size, `the scan read ${String(sources.size)} files`).toBeGreaterThanOrEqual(13);
    expect(bytes, `the scan read ${String(bytes)} bytes`).toBeGreaterThan(60_000);
  });

  for (const wall of WALLS) {
    it(`holds: ${wall.name}`, () => {
      const sources = domainSources();
      const offenders = [...sources]
        .filter(([path]) => !wall.exempt?.some((entry) => entry.path === path))
        .filter(([, source]) => wall.pattern.test(stripComments(source)))
        .map(([path]) => path)
        .sort();

      expect(offenders, `${wall.name}: ${wall.why}`).toEqual([]);
      // The population this wall was applied over, on SUCCESS.
      expect(
        sources.size,
        `${wall.name} was applied to ${String(sources.size)} files`,
      ).toBeGreaterThanOrEqual(13);
    });

    it(`is mutation-tested: ${wall.name} fires on a planted violation`, () => {
      // Without this, a pattern that stopped matching — a rename, a `\s*` that
      // no longer covers the house line breaks — would report a clean zero.
      const planted = plantedViolation(wall.name);
      expect(
        wall.pattern.test(stripComments(planted)),
        `${wall.name}'s detector did not fire on a planted violation; it measures nothing`,
      ).toBe(true);
    });
  }

  it('holds the vehicle-derivation wall over `services/compatibility/` too', () => {
    // The wall above scans THIS domain. A `likeliestVehicle` helper would just
    // as naturally land in the domain that owns fitment, and be imported from
    // here — so the prohibition is applied over both trees or it is applied over
    // the half somebody did not use.
    //
    // `services/compatibility/`'s own isolation gate cannot carry this: its
    // patterns are about what that domain may IMPORT, and this is about a
    // function it may not DEFINE. Scanning it from here also keeps the tuple and
    // both scans in one file, which is what stops them drifting.
    const scanned = new Map<string, string>();
    for (const directory of [join('services', 'compatibility'), join('db', 'compatibility')]) {
      walk(join(SRC_ROOT, directory), scanned);
    }
    // Vacuity floor first: eight files today, and a walk that found nothing
    // satisfies the assertion below without measuring anything.
    expect(scanned.size, `the compatibility walk read ${String(scanned.size)} files`).toBeGreaterThanOrEqual(8);

    const pattern = new RegExp(COMPATIBILITY_CLAIM_PROMOTION_FORBIDDEN_INPUTS.join('|'), 'u');
    const offenders = [...scanned]
      .filter(([, source]) => pattern.test(stripComments(source)))
      .map(([path]) => path)
      .sort();
    expect(
      offenders,
      'a compatibility module derives the vehicle a claim is promoted to; the operator must name it',
    ).toEqual([]);

    // And the detector fires, so the clean zero above is a measurement.
    expect(pattern.test('const v = guessVehicle(claim.rawTargetText);')).toBe(true);
  });

  it('exempts nothing that does not exist', () => {
    // An exemption naming a file the scan never read permits nothing and reads
    // exactly like one doing work. Reconciled in BOTH directions: every
    // exemption names a scanned file, and every scanned file is scanned.
    const sources = domainSources();
    let exemptions = 0;
    for (const wall of WALLS) {
      for (const entry of wall.exempt ?? []) {
        expect(sources.has(entry.path), `stale exemption on ${wall.name}: ${entry.path}`).toBe(true);
        expect(entry.reason.length, `exemption without a reason: ${entry.path}`).toBeGreaterThan(20);
        exemptions += 1;
      }
    }
    // Today there are none, and stating the exact count is what stops one being
    // added without anybody noticing the list grew.
    expect(exemptions, `${String(exemptions)} wall exemptions declared`).toBe(0);
  });
});

/** A source string that SHOULD trip exactly one named wall. */
function plantedViolation(wallName: string): string {
  switch (wallName) {
    case 'no catalogue write':
      return 'await tx.insert(categories).values({ key: "x" });';
    case 'no second operator allow-list':
      return 'const ids = config.catalog.graphOperatorOxyUserIds.concat(extra);';
    case 'no order, payment or buyer data in an export':
      return 'const rows = await db.execute(sql`select id from orders`);';
    case 'no ranking, fee or referral reference':
      return "import { rankOffers } from '../services/ranking/rank.js';";
    case 'no store-scoped permission':
      return "import { requireStorePermission } from '../middleware/store-authz.js';";
    case 'nothing derives the vehicle a claim is promoted to':
      return 'const target = await likeliestVehicle(claim.rawTargetText);';
    case 'no code execution from stored input':
      return 'const run = new Function("return " + parameters.expression);';
    default:
      throw new Error(`no planted violation for ${wallName}`);
  }
}

describe('the governance vocabularies reconcile in both directions', () => {
  it('makes the audit action tuple exactly the union of the three it is built from', () => {
    const union = [
      ...CATALOG_GOVERNANCE_ACTIONS,
      ...CATALOG_GOVERNANCE_REVIEW_ACTIONS,
      ...CATALOG_GOVERNANCE_LIFECYCLE_ACTIONS,
    ].sort();
    // Both directions. Containment one way would let an audit value nothing
    // produces survive; containment the other would let an act with no audit
    // vocabulary survive, and that one fails at runtime on a CHECK.
    expect([...CATALOG_GOVERNANCE_AUDIT_ACTIONS].sort()).toEqual(union);
    expect(union.length, `${String(union.length)} audited actions`).toBeGreaterThan(30);
  });

  it('keeps the change, review and lifecycle tuples disjoint', () => {
    const change = new Set<string>(CATALOG_GOVERNANCE_ACTIONS);
    const review = new Set<string>(CATALOG_GOVERNANCE_REVIEW_ACTIONS);
    const lifecycle = new Set<string>(CATALOG_GOVERNANCE_LIFECYCLE_ACTIONS);
    for (const value of review) expect(change.has(value), `${value} is in two tuples`).toBe(false);
    for (const value of lifecycle) {
      expect(change.has(value), `${value} is in two tuples`).toBe(false);
      expect(review.has(value), `${value} is in two tuples`).toBe(false);
    }
    expect(
      change.size + review.size + lifecycle.size,
      `${String(change.size + review.size + lifecycle.size)} distinct actions`,
    ).toBe(CATALOG_GOVERNANCE_AUDIT_ACTIONS.length);
  });

  it('uses every role, counting the two GATE roles no action names', () => {
    // Two of the five gate a STEP rather than an act, so neither appears in the
    // image of the action→role map and both would look dead if the image were
    // reconciled alone:
    //
    //   `view`    gates every read on the surface.
    //   `propose` gates PLANNING a change — which is the whole reason the role
    //             means anything, because an operator who may draft a taxonomy
    //             change and not publish it holds exactly this and no more.
    //
    // Reconciling `{view, propose} ∪ image` against the tuple is what makes a
    // role that nothing requires and nobody grants fail here. This assertion
    // caught `propose` being unreconciled on its first run.
    const used = new Set<string>([
      CATALOG_GOVERNANCE_READ_ROLE,
      CATALOG_GOVERNANCE_PROPOSE_ROLE,
      ...Object.values(CATALOG_GOVERNANCE_ACTION_ROLES),
    ]);
    expect([...used].sort()).toEqual([...CATALOG_GOVERNANCE_ROLES].sort());
    expect(used.size, `${String(used.size)} roles reconciled`).toBe(
      CATALOG_GOVERNANCE_ROLES.length,
    );
  });

  it('keeps the two gate roles OUT of the action map', () => {
    // The other direction. If `propose` ever became an action's required role,
    // the reconciliation above would still pass while the distinction it
    // documents had quietly collapsed — planning and publishing would need one
    // capability, and the role separation the epic asks for would be gone.
    const actionRoles = new Set<string>(Object.values(CATALOG_GOVERNANCE_ACTION_ROLES));
    expect(actionRoles.has(CATALOG_GOVERNANCE_READ_ROLE), 'view became an action role').toBe(false);
    expect(
      actionRoles.has(CATALOG_GOVERNANCE_PROPOSE_ROLE),
      'propose became an action role, collapsing planning into publishing',
    ).toBe(false);
    expect(actionRoles.size, `${String(actionRoles.size)} distinct action roles`).toBe(3);
  });

  it('gives every change action a domain, a subject kind and a role', () => {
    // A `Record` over a union cannot omit a member, so this cannot fail while
    // `tsc` passes — which is exactly why it is here as a runtime check too:
    // the maps are also read by name at runtime through indexes, and a member
    // whose value is `undefined` at runtime type-checks fine.
    for (const action of CATALOG_GOVERNANCE_ACTIONS) {
      expect(CATALOG_GOVERNANCE_ACTION_DOMAINS[action], `${action} has no domain`).toBeTruthy();
      expect(CATALOG_GOVERNANCE_ACTION_SUBJECTS[action], `${action} has no subject`).toBeTruthy();
      expect(CATALOG_GOVERNANCE_ACTION_ROLES[action], `${action} has no role`).toBeTruthy();
    }
    expect(
      CATALOG_GOVERNANCE_ACTIONS.length,
      `${String(CATALOG_GOVERNANCE_ACTIONS.length)} change actions mapped`,
    ).toBeGreaterThan(10);
  });

  it('routes every change action either to a driver or to its own service', () => {
    // The failure this prevents is an approved request that reaches no driver
    // and reports a generic conflict days after somebody approved it.
    const direct = new Set<string>(DIRECT_APPLY_ACTIONS);
    const ownService = new Set<string>(['definition_snapshot_restore', 'vertical_package_apply']);
    for (const action of CATALOG_GOVERNANCE_ACTIONS) {
      expect(
        direct.has(action) || ownService.has(action),
        `${action} has no apply path`,
      ).toBe(true);
      expect(direct.has(action) && ownService.has(action), `${action} has two apply paths`).toBe(
        false,
      );
    }
    expect(direct.size + ownService.size).toBe(CATALOG_GOVERNANCE_ACTIONS.length);
  });

  it('keeps the counted subject kinds a strict subset of all of them', () => {
    for (const kind of CATALOG_GOVERNANCE_COUNTED_SUBJECT_KINDS) {
      expect(
        (CATALOG_GOVERNANCE_SUBJECT_KINDS as readonly string[]).includes(kind),
        `${kind} is counted but is not a subject kind`,
      ).toBe(true);
    }
    expect(CATALOG_GOVERNANCE_COUNTED_SUBJECT_KINDS.length).toBeLessThan(
      CATALOG_GOVERNANCE_SUBJECT_KINDS.length,
    );
  });

  it('gives every unsupported restore scope a stated reason, and no supported one', () => {
    // Reconciled in both directions. A scope missing from the map is one a
    // restore silently treats as a no-op and reports as a clean run; a scope in
    // the map that IS supported is a refusal nobody can reach.
    const unsupported = new Set(Object.keys(RESTORE_UNSUPPORTED_SCOPES));
    const supported = new Set(['taxonomy', 'all']);
    for (const scope of CATALOG_GOVERNANCE_SNAPSHOT_SCOPES) {
      expect(
        unsupported.has(scope) !== supported.has(scope),
        `${scope} is in neither or both of the restore lists`,
      ).toBe(true);
    }
    for (const [scope, reason] of Object.entries(RESTORE_UNSUPPORTED_SCOPES)) {
      expect(reason.length, `${scope}'s refusal states no reason`).toBeGreaterThan(60);
    }
    expect(
      unsupported.size + supported.size,
      `${String(unsupported.size + supported.size)} scopes classified`,
    ).toBe(CATALOG_GOVERNANCE_SNAPSHOT_SCOPES.length);
  });

  it('names the forbidden capabilities as values disjoint from every action', () => {
    const actions = new Set<string>(CATALOG_GOVERNANCE_AUDIT_ACTIONS);
    for (const capability of CATALOG_GOVERNANCE_FORBIDDEN_CAPABILITIES) {
      expect(
        actions.has(capability),
        `${capability} is both forbidden and an action this surface performs`,
      ).toBe(false);
    }
    expect(
      CATALOG_GOVERNANCE_FORBIDDEN_CAPABILITIES.length,
      `${String(CATALOG_GOVERNANCE_FORBIDDEN_CAPABILITIES.length)} prohibitions named`,
    ).toBeGreaterThanOrEqual(6);
  });
});

describe('the route set is closed', () => {
  it('registers exactly the paths #367 Workstream 12 decided on', () => {
    const source = readFileSync(
      join(SRC_ROOT, 'routes', 'internal-catalog-governance.ts'),
      'utf8',
    );
    const registered = [...source.matchAll(/router\.(get|post)\(\s*\n?\s*'([^']+)'/gu)]
      .map((match) => `${match[1].toUpperCase()} ${match[2]}`)
      .sort();

    // Exact identity, never containment. A route set that may only grow is how
    // a boost, a pin or a "set this applied" arrives one defensible addition at
    // a time; every omission in this file's header is a decision.
    expect(registered).toEqual(
      [
        'GET /me',
        'GET /impact',
        'POST /changes',
        'GET /changes',
        'GET /changes/:changeId',
        'POST /changes/:changeId/approve',
        'POST /changes/:changeId/apply',
        'POST /changes/:changeId/reject',
        'POST /changes/:changeId/withdraw',
        'GET /diff/product-types/:key',
        'GET /diff/attributes/:key',
        'GET /audit',
        'GET /queues',
        'GET /quality',
        'GET /quality/orphans',
        'GET /roles',
        'POST /roles',
        'POST /roles/revoke',
        'GET /snapshots',
        'POST /snapshots',
        'GET /snapshots/:snapshotId',
        'POST /snapshots/:snapshotId/restore',
        'GET /vertical-packages',
        'POST /vertical-packages/:packageName',
        'GET /vertical-packages/:packageName/census',
        'POST /reviews/localization',
        'POST /reviews/external-mappings/:mappingId',
        'POST /reviews/compatibility-claims/:claimId',
        // #367 Workstream 14. The queue READ is what made the
        // `unresolved_compatibility_claim` count on `GET /queues` actionable —
        // before it, the number was the only thing an operator could learn. The
        // `/fitment` POST is the one act that empties the queue, and it is a
        // separate route from the review beside it because it needs a different
        // ROLE: a review publishes nothing, a promotion creates the fitment a
        // shopper acts on.
        'GET /reviews/compatibility-claims',
        'POST /reviews/compatibility-claims/:claimId/fitment',
      ].sort(),
    );
    expect(registered.length, `${String(registered.length)} routes registered`).toBe(30);
  });

  it('mounts authentication before the allow-list', () => {
    const source = readFileSync(
      join(SRC_ROOT, 'routes', 'internal-catalog-governance.ts'),
      'utf8',
    );
    const auth = source.indexOf('router.use(authenticateToken)');
    const operator = source.indexOf('router.use(requireCatalogOperator)');
    expect(auth, 'the router does not authenticate at all').toBeGreaterThan(-1);
    expect(operator, 'the router does not gate on the operator allow-list').toBeGreaterThan(-1);
    // An allow-list consulted before authentication compares against whatever a
    // client claimed.
    expect(auth).toBeLessThan(operator);
  });

  it('registers no delete verb anywhere', () => {
    const source = stripComments(
      readFileSync(join(SRC_ROOT, 'routes', 'internal-catalog-governance.ts'), 'utf8'),
    );
    // `delete_definition` and `rewrite_audit_history` are forbidden
    // capabilities. The triggers refuse both, and there is no route that could
    // reach them — a revocation is a POST precisely because it keeps the row.
    expect(/router\.\s*delete\s*\(/u.test(source), 'a DELETE route was added').toBe(false);
    expect(source.length, `${String(source.length)} bytes of route source scanned`).toBeGreaterThan(
      2000,
    );
  });
});

/** The scan paths themselves, reconciled against what exists on disk. */
describe('the scan covers the whole domain', () => {
  it('names only paths that exist, and reads every file under them', () => {
    for (const path of SCANNED_PATHS) {
      expect(() => statSync(join(SRC_ROOT, path)), `scanned path is stale: ${path}`).not.toThrow();
    }
    const sources = domainSources();
    // Every module the domain ships must be IN the scan. A file added under a
    // directory nobody scans is a wall that stops covering it silently.
    const services = [...sources.keys()].filter((path) =>
      path.startsWith(join('services', 'catalog-governance')),
    );
    expect(
      services.length,
      `${String(services.length)} service modules scanned`,
    ).toBeGreaterThanOrEqual(10);
  });
});
