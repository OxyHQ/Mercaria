/**
 * The walls this domain must not reach through, as a build gate.
 *
 * `fee-ranking-isolation.test.ts` is the precedent and
 * `supplier-preflight-isolation.test.ts` the near neighbour. Six boundaries,
 * each a rule stated somewhere in #124 that a plausible future edit would
 * quietly undo:
 *
 *  1. **An adapter gets no database.** Nothing under `adapters/` may import a
 *     repository, a service, the database handle or the config — so the write
 *     boundary holds for #125's adapter, which nobody has written.
 *  2. **Only ONE module calls a provider.** No module in this domain may invoke
 *     an adapter method except `provider-call.ts`, because every gate, the
 *     lease and the attempt log live in that one chokepoint.
 *  3. **No lever gates a durable record** (#124 acceptance 5). The ingress, the
 *     repositories and the exception path may not read
 *     `config.procurement.*Enabled` — a kill switch that stopped a webhook
 *     being STORED would lose updates for orders already placed.
 *  4. **Procurement never touches payments** (ADR 0004 D1). No module here may
 *     import the payment domain: a supplier acceptance is not a payment fact,
 *     and a Stripe success is not a procurement one.
 *  5. **Nothing here refunds, restocks or moves money.** No import of the
 *     refund service, the ledger or the inventory writers.
 *  6. **No OxyPay, no FairCoin** (ADR 0004 D11). Not a type, not a column, not
 *     a mock, not a comment.
 *
 * Each detector is MUTATION-TESTED below: a synthetic source string containing
 * the forbidden reference must be caught. A scan that cannot fail is worse than
 * no scan, because it reads as a guarantee.
 */

import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type DirectoryReader,
  assertNothingOutsideDomainPopulation,
  namedInSharedDirectories,
  readSrcDirectory,
  walkOwnedDirectory,
} from '../../../__tests__/domain-population.js';
import {
  SUPPLIER_ADAPTER_CAPABILITIES,
  SUPPLIER_EMULATED_COMMITMENTS,
  SUPPLIER_ORDER_CAPABILITIES,
  SUPPLIER_ORDER_EMULATED_COMMITMENTS,
} from '@mercaria/shared-types';
import { assertEachOf } from '../../../__tests__/assert-each-of.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Walked whole, so a module added to the domain tomorrow is gated the moment it
 * exists.
 *
 * `adapters/` is a SUBSET of the first, kept separate on purpose: wall 1 is
 * deliberately narrow — it is about what an ADAPTER may reach, not about the
 * domain — and widening a deliberately narrow wall is the census that pushes
 * you toward the hazard (`docs/isolation-gates.md`).
 */
const OWNED_DIRECTORIES = ['services/supplier-orders', 'db/supplierOrders'];
const ADAPTERS_DIRECTORY = 'services/supplier-orders/adapters';

/**
 * The shared directories, where this domain sits beside every other domain's.
 *
 * They were ABSENT, so two modules sat behind none of the walls that scan "the
 * domain":
 *
 * - **`db/schema/supplierOrders.ts`**, the module DECLARING the seven tables.
 *   Wall 6 says OxyPay and FairCoin may appear here as "not a type, not a
 *   column, not a mock, not a comment" — and the one file in which a COLUMN is
 *   declared was outside it.
 * - **`routes/supplier-webhook.ts`**, `POST /webhooks/suppliers/:supplierAccountId`
 *   — this domain's HTTP ingress, the FOURTH raw-body mount, and the module
 *   that resolves a supplier's credential and hands it to the adapter. It
 *   imports `services/supplier-orders/credential.port.js` and
 *   `provider-call.js` and is named in this gate nowhere.
 *
 * `namedInSharedDirectories` recurses, so `routes/admin/` and
 * `controllers/admin/` are reached too. Measured: this domain has no module in
 * either today, so the recursion adds nothing HERE and is the class fix rather
 * than a count.
 */
const SHARED_DIRECTORIES = ['controllers', 'routes', 'middleware', 'db/schema'];

/**
 * What a module BELONGING to this domain is called, wherever it lives.
 *
 * Three spellings, each measured rather than assumed:
 *
 * - the HYPHEN is optional, because `db/schema/supplierOrders.ts` and
 *   `db/supplierOrders/` are camelCase and a hyphenated pattern reaches
 *   neither — adding `db/schema` above without this would have changed nothing
 *   while looking exactly like a fix;
 * - the PLURAL is optional, for symmetry with the other spellings this
 *   repository uses;
 * - `webhook` is an alternative rather than a named path, because
 *   `routes/supplier-webhook.ts` is this domain's ingress and a NAMED path
 *   would leave the module somebody adds beside it in no population at all —
 *   the #460 failure, one file later.
 *
 * The FULL two words, never a bare `supplier`: `services/supplier-preflight/`
 * is #122's domain with its own gate and `db/procurement/supplierRepository.ts`
 * is #118's. Measured: `/supplier-?(orders?|webhook)/i` over the whole of
 * `src/` selects 31 modules and every one is this domain's, while a bare
 * `/supplier/i` selects 32 more across four foreign domains.
 */
const DOMAIN_NAME_PATTERN = /supplier-?(orders?|webhook)/i;

/** Every module of the domain, DERIVED, relative to `src/`. */
function domainRelativePaths(readDir: DirectoryReader = readSrcDirectory): string[] {
  return [
    ...OWNED_DIRECTORIES.flatMap((relative) => walkOwnedDirectory(relative, readDir)),
    ...namedInSharedDirectories(SHARED_DIRECTORIES, DOMAIN_NAME_PATTERN, readDir),
  ];
}

const absolute = (relative: string): string => join(SRC_ROOT, relative);

/**
 * Source with comments stripped.
 *
 * Load-bearing here, not tidiness: these modules DOCUMENT what they refuse to
 * do, in the same vocabulary the detectors look for. A scan over raw source
 * would fire on the docblock explaining why the payment domain is out of reach
 * — and the fix would be to delete the explanation.
 */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

interface Wall {
  name: string;
  files: string[];
  pattern: RegExp;
  /** Files exempt from this wall, with the reason they are. */
  exempt?: string[];
}

const DOMAIN_FILES = walkOwnedDirectory('services/supplier-orders').map(absolute);
const ADAPTER_FILES = walkOwnedDirectory(ADAPTERS_DIRECTORY).map(absolute);
const REPOSITORY_FILES = walkOwnedDirectory('db/supplierOrders').map(absolute);
/** The modules serving this domain from a shared directory. */
const SHARED_FILES = namedInSharedDirectories(SHARED_DIRECTORIES, DOMAIN_NAME_PATTERN).map(absolute);

const WALLS: Wall[] = [
  {
    name: 'a database, repository or service, from inside an adapter',
    files: ADAPTER_FILES,
    pattern: /from\s+['"][^'"]*(db\/|repository|Repository|\.service|postgres|config\/index)[^'"]*['"]/,
  },
  {
    name: 'the adapter registry, from anywhere but the provider-call chokepoint',
    files: DOMAIN_FILES,
    // The REGISTRY, not the method names. A service does call
    // `adapter.submitOrder(...)` — inside the `invoke` callback the chokepoint
    // hands it an adapter through, which is the arrangement, not a bypass.
    // What must be impossible is OBTAINING an adapter any other way, because
    // that is the only route around the account gates, the provider lease and
    // the attempt row. `fake-adapter-registration.ts` is exempt because
    // registering one is the opposite act.
    pattern: /from\s+['"][^'"]*supplier-preflight\/registry[^'"]*['"]/,
    exempt: ['provider-call.ts', 'fake-adapter-registration.ts'],
  },
  {
    name: 'a procurement lever, from a durable-record path',
    // Deliberately NARROW: the durable-record paths named by #124 acceptance 5,
    // not the domain. Widening it to the whole population would make this wall
    // a restatement of "no module reads a lever", which is not what the rule
    // says — the LOOP is allowed to read one.
    files: [
      ...REPOSITORY_FILES,
      absolute('services/supplier-orders/event-ingest.service.ts'),
      absolute('services/supplier-orders/exception.service.ts'),
    ],
    pattern: /config\.procurement\.\w*(Enabled|enabled)/,
  },
  {
    name: 'the payment domain',
    files: [...DOMAIN_FILES, ...REPOSITORY_FILES, ...SHARED_FILES],
    // `\.\./payments/` is the specifier a module in `services/supplier-orders/`
    // actually writes — the payment domain is one `../` away — and the
    // absolute-looking forms alone never see it. One alternative covers every
    // depth: the last `../` always abuts the directory name.
    pattern:
      /from\s+['"][^'"]*(services\/payments|\.\.\/payments\/|db\/payments|schema\/payments|schema\/ledger)[^'"]*['"]/,
  },
  {
    name: 'a refund, ledger or inventory writer',
    files: [...DOMAIN_FILES, ...REPOSITORY_FILES, ...SHARED_FILES],
    pattern: /from\s+['"][^'"]*(refund\.service|ledgerRepository|inventory\.service|inventoryRepository)[^'"]*['"]/,
  },
  {
    name: 'OxyPay or FairCoin',
    // RAW source, comments included, deliberately: ADR 0004 D11 says nothing
    // here may NAME them, and a comment naming one is exactly the anticipation
    // it forbids.
    files: [...DOMAIN_FILES, ...REPOSITORY_FILES, ...SHARED_FILES],
    pattern: /oxy[_\s-]?pay|oxypay|faircoin|fair[_\s-]coin/i,
  },
];

describe('supplier order isolation (static)', () => {
  it('scans a non-trivial number of files', () => {
    // The anti-vacuity floor. A broken traversal scans nothing and every wall
    // below passes, which is exactly what a BROKEN scan produces.
    // Floored PER SHAPE, measured off this branch: 24 service modules
    // (including 2 adapters), 5 repositories, 2 shared. A TOTAL floor lets one
    // shape collapse to zero behind another's number.
    expect(DOMAIN_FILES.length).toBeGreaterThanOrEqual(15);
    expect(ADAPTER_FILES.length).toBeGreaterThanOrEqual(1);
    expect(REPOSITORY_FILES.length).toBeGreaterThanOrEqual(4);
    expect(
      SHARED_FILES.length,
      'no route or schema module is named for this domain — did the derivation break?',
    ).toBeGreaterThanOrEqual(2);
    for (const path of [...DOMAIN_FILES, ...REPOSITORY_FILES, ...SHARED_FILES]) {
      expect(statSync(path).isFile(), `${path} is in the population but is not a file`).toBe(true);
    }
  });

  it('the widening reaches the two modules it exists for', () => {
    // NAMED rather than floored. A floor on the population cannot detect the
    // derivation examining LESS — the modules it stops examining are exactly
    // the ones a smaller number is consistent with — and these two are the
    // whole reason the shared half was added, so a floor met by the
    // twenty-nine owned modules alone would report a healthy run.
    const population = domainRelativePaths();
    for (const expected of ['db/schema/supplierOrders.ts', 'routes/supplier-webhook.ts']) {
      expect(population, `${expected} left the population`).toContain(expected);
    }

    // The half that makes this a measurement rather than an assertion about a
    // tree that happens to be convenient: the OWNED walk alone reaches neither.
    const owned = OWNED_DIRECTORIES.flatMap((relative) => walkOwnedDirectory(relative));
    for (const expected of ['db/schema/supplierOrders.ts', 'routes/supplier-webhook.ts']) {
      expect(owned, `${expected} is reached without the shared sweep`).not.toContain(expected);
    }

    // …and the same for each half of the pattern, so neither can be narrowed
    // back in silence. The hyphen-only spelling cannot reach the module
    // declaring this domain's seven tables; the `orders`-only spelling cannot
    // reach its HTTP ingress.
    expect(/supplier-orders?/i.test('db/schema/supplierOrders.ts')).toBe(false);
    expect(/supplier-?orders?/i.test('routes/supplier-webhook.ts')).toBe(false);
    expect(DOMAIN_NAME_PATTERN.test('db/schema/supplierOrders.ts')).toBe(true);
    expect(DOMAIN_NAME_PATTERN.test('routes/supplier-webhook.ts')).toBe(true);

    // And the neighbours the pattern must NOT drag in, or these walls fire at
    // whoever edits #122 or #118.
    assertEachOf([
      'services/supplier-preflight/preflight.service.ts',
      'db/procurement/supplierRepository.ts',
      'db/supplierPreflight/quoteRepository.ts',
    ], 3, (foreign) => {
      expect(DOMAIN_NAME_PATTERN.test(foreign), `${foreign} belongs to another domain`).toBe(false);
      expect(population, `${foreign} belongs to another domain`).not.toContain(foreign);
    });
  });

  for (const wall of WALLS) {
    it(`does not reach ${wall.name}`, () => {
      const offenders = wall.files.filter((path) => {
        const base = path.split('/').pop() ?? '';
        if (wall.exempt?.includes(base)) return false;
        const source = wall.name.includes('OxyPay') ? readFileSync(path, 'utf8') : code(path);
        return wall.pattern.test(source);
      });
      expect(offenders.map((path) => path.split('/').pop())).toEqual([]);
    });

    it(`would CATCH a reference to ${wall.name}`, () => {
      // The mutation self-test. Each pattern is fed a synthetic source that
      // genuinely contains what it forbids, so a detector that stopped matching
      // fails HERE rather than passing silently forever.
      // A LIST per wall, not one string: a single probe can only demonstrate the
      // one spelling whoever wrote it had in mind, and the spelling a real file
      // here would use is usually a different one. The payment wall is the
      // worked example — its absolute-looking probe passed for months while the
      // relative form a sibling module actually writes walked straight through.
      const probes: Record<string, readonly string[]> = {
        'a database, repository or service, from inside an adapter': [
          "import { findPurchaseOrderById } from '../../../db/procurement/purchaseOrderRepository.js';",
        ],
        'the adapter registry, from anywhere but the provider-call chokepoint': [
          "import { findSupplierAdapter } from '../supplier-preflight/registry.js';",
        ],
        'a procurement lever, from a durable-record path': [
          'if (config.procurement.orchestrationEnabled) { return; }',
        ],
        'the payment domain': [
          "import { paymentService } from '../../services/payments/payment.service.js';",
          // The relative specifier — one `../` from here to a sibling domain.
          "import { paymentService } from '../payments/payment.service.js';",
          "import { bookLedger } from '../../payments/ledger-postings.js';",
        ],
        'a refund, ledger or inventory writer': [
          "import { bookLedger } from '../../db/payments/ledgerRepository.js';",
        ],
        'OxyPay or FairCoin': ['const rail = "oxy_pay";'],
      };
      const forWall = probes[wall.name];
      expect(forWall, `no probe registered for the ${wall.name} wall`).toBeDefined();
      expect((forWall ?? []).length).toBeGreaterThan(0);
      for (const probe of forWall ?? []) {
        expect(wall.pattern.test(probe), `the ${wall.name} wall misses: ${probe}`).toBe(true);
      }
    });
  }
});

describe('supplier order vocabularies', () => {
  it('keeps order emulations disjoint from order capabilities', () => {
    // The `RETAIL_FORBIDDEN_COMPONENT_KINDS` device: the two unions must have
    // no member in common, so no emulation can be typed as a capability,
    // stored in a declared-capability array or required by a policy version.
    const capabilities = new Set<string>(SUPPLIER_ADAPTER_CAPABILITIES);
    const overlap = SUPPLIER_ORDER_EMULATED_COMMITMENTS.filter((entry) => capabilities.has(entry));
    expect(overlap).toEqual([]);
  });

  it('declares exactly the twelve order capabilities #124 names', () => {
    // A floor AND a ceiling, the #122 arrangement: one quietly removed would
    // stop being enforced by `applyDeclaredOrderCapabilities`, and one quietly
    // added would be enforced by nothing.
    expect(SUPPLIER_ORDER_CAPABILITIES).toHaveLength(12);
  });

  it('declares exactly the seven order emulations #124 names', () => {
    expect(SUPPLIER_ORDER_EMULATED_COMMITMENTS).toHaveLength(7);
    // Every one of them is in the shared union the label table is keyed on, so
    // a refusal can name it rather than answering "unsupported".
    const shared = new Set<string>(SUPPLIER_EMULATED_COMMITMENTS);
    expect(SUPPLIER_ORDER_EMULATED_COMMITMENTS.filter((entry) => !shared.has(entry))).toEqual([]);
  });

  it('has no order capability that names a commission, a rank or a payment rail', () => {
    // A shape check beside the set checks above, because disjointness only
    // catches an EXACT duplicate. A capability called `preferred_placement`
    // would pass that and fail this.
    const forbidden = /commission|affiliate|referral|rank|sponsor|placement|stripe|oxypay|faircoin/i;
    expect(SUPPLIER_ORDER_CAPABILITIES.filter((entry) => forbidden.test(entry))).toEqual([]);
  });
});

/**
 * The population's own defence, and the general form of the fix above.
 *
 * Adding the shared directories closes today's gap; this closes the CLASS. The
 * DIRECTORY list is the last hand list here, and hand lists fail silently —
 * every floor and count stayed green while the schema module and the HTTP
 * ingress sat outside every wall that scans "the domain".
 *
 * The exclusion set is EMPTY, measured rather than assumed:
 * `/supplier-?(orders?|webhook)/i` over the whole of `src/` selects 31 modules
 * and all 31 are this domain's.
 */
describe('#460: nothing named for this domain sits outside the scanned population', () => {
  it('every supplier-order-named module in src/ is inside the population', () => {
    assertNothingOutsideDomainPopulation({
      population: domainRelativePaths,
      pattern: DOMAIN_NAME_PATTERN,
      notThisDomain: [],
      // Below today's 31 so a routine deletion does not fail the build, and far
      // enough above zero that a traversal which reached nothing does.
      sweepFloor: 26,
      plantIn: 'lib',
      plantName: 'supplier-order-cache.ts',
    });
  });

  it('the derived population really is the one the walls scan', () => {
    // Two spellings of one population can disagree, so this pins them together.
    expect(domainRelativePaths(readSrcDirectory).sort()).toEqual(
      [...DOMAIN_FILES, ...REPOSITORY_FILES, ...SHARED_FILES]
        .map((path) => path.slice(SRC_ROOT.length + 1))
        .sort(),
    );
  });
});
