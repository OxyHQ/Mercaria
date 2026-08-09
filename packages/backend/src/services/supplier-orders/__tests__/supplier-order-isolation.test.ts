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

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SUPPLIER_ADAPTER_CAPABILITIES,
  SUPPLIER_EMULATED_COMMITMENTS,
  SUPPLIER_ORDER_CAPABILITIES,
  SUPPLIER_ORDER_EMULATED_COMMITMENTS,
} from '@mercaria/shared-types';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const DOMAIN_DIR = join(HERE, '..');
const ADAPTERS_DIR = join(HERE, '..', 'adapters');
const REPOSITORY_DIR = join(HERE, '..', '..', '..', 'db', 'supplierOrders');

/** Every `.ts` under a directory, excluding its own tests. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === '__tests__') continue;
      out.push(...sourceFiles(path));
      continue;
    }
    if (entry.endsWith('.ts')) out.push(path);
  }
  return out;
}

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

const DOMAIN_FILES = sourceFiles(DOMAIN_DIR);
const ADAPTER_FILES = sourceFiles(ADAPTERS_DIR);
const REPOSITORY_FILES = sourceFiles(REPOSITORY_DIR);

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
    files: [...REPOSITORY_FILES, join(DOMAIN_DIR, 'event-ingest.service.ts'), join(DOMAIN_DIR, 'exception.service.ts')],
    pattern: /config\.procurement\.\w*(Enabled|enabled)/,
  },
  {
    name: 'the payment domain',
    files: [...DOMAIN_FILES, ...REPOSITORY_FILES],
    pattern: /from\s+['"][^'"]*(services\/payments|db\/payments|schema\/payments|schema\/ledger)[^'"]*['"]/,
  },
  {
    name: 'a refund, ledger or inventory writer',
    files: [...DOMAIN_FILES, ...REPOSITORY_FILES],
    pattern: /from\s+['"][^'"]*(refund\.service|ledgerRepository|inventory\.service|inventoryRepository)[^'"]*['"]/,
  },
  {
    name: 'OxyPay or FairCoin',
    // RAW source, comments included, deliberately: ADR 0004 D11 says nothing
    // here may NAME them, and a comment naming one is exactly the anticipation
    // it forbids.
    files: [...DOMAIN_FILES, ...REPOSITORY_FILES],
    pattern: /oxy[_\s-]?pay|oxypay|faircoin|fair[_\s-]coin/i,
  },
];

describe('supplier order isolation (static)', () => {
  it('scans a non-trivial number of files', () => {
    // The anti-vacuity floor. A broken traversal scans nothing and every wall
    // below passes, which is exactly what a BROKEN scan produces.
    expect(DOMAIN_FILES.length).toBeGreaterThanOrEqual(15);
    expect(ADAPTER_FILES.length).toBeGreaterThanOrEqual(1);
    expect(REPOSITORY_FILES.length).toBeGreaterThanOrEqual(4);
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
      const probes: Record<string, string> = {
        'a database, repository or service, from inside an adapter':
          "import { findPurchaseOrderById } from '../../../db/procurement/purchaseOrderRepository.js';",
        'the adapter registry, from anywhere but the provider-call chokepoint':
          "import { findSupplierAdapter } from '../supplier-preflight/registry.js';",
        'a procurement lever, from a durable-record path':
          'if (config.procurement.orchestrationEnabled) { return; }',
        'the payment domain':
          "import { paymentService } from '../../services/payments/payment.service.js';",
        'a refund, ledger or inventory writer':
          "import { bookLedger } from '../../db/payments/ledgerRepository.js';",
        'OxyPay or FairCoin': 'const rail = "oxy_pay";',
      };
      const probe = probes[wall.name];
      expect(probe).toBeDefined();
      expect(wall.pattern.test(probe ?? '')).toBe(true);
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
