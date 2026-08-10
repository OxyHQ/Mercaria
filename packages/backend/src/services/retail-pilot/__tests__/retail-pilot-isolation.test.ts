/**
 * The walls around the bounded retail pilot and the Printful integration (#125).
 *
 * Static scans, following `fee-ranking-isolation.test.ts`: each wall names what
 * must be unreachable, is applied to a real file set with an anti-vacuity floor,
 * and is MUTATION-TESTED against a synthetic source that genuinely contains what
 * it forbids — so a detector that stopped matching fails HERE rather than
 * passing silently forever.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PRINTFUL_CAPABILITIES,
  PRINTFUL_EU_FULFILMENT_COUNTRIES,
} from '../../supplier-orders/adapters/printful.js';
import {
  RETAIL_PILOT_REFUSALS,
  RETAIL_PILOT_STOP_METRICS,
  SUPPLIER_ADAPTER_CAPABILITIES,
} from '@mercaria/shared-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const PILOT_DIR = join(HERE, '..');
const PRINTFUL_DIR = join(HERE, '..', '..', 'printful');
const PRINTFUL_ADAPTER = join(HERE, '..', '..', 'supplier-orders', 'adapters', 'printful.ts');
const PRINTFUL_CATALOG_ADAPTER = join(
  HERE,
  '..',
  '..',
  'ingestion',
  'adapters',
  'printful-catalog.ts',
);

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
 * Load-bearing rather than tidy: these modules DOCUMENT what they refuse to do,
 * in the same vocabulary the detectors look for. A scan over raw source would
 * fire on the docblock explaining why the payment domain is out of reach, and
 * the "fix" would be to delete the explanation.
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
  /** A source that genuinely contains what the pattern forbids. */
  probe: string;
}

const PILOT_FILES = sourceFiles(PILOT_DIR);
const PRINTFUL_FILES = sourceFiles(PRINTFUL_DIR);

const WALLS: Wall[] = [
  {
    // The whole content of "a stop preserves existing-order operations" is that
    // the gate is asked at checkout and NOWHERE ELSE. If the pilot could reach
    // the procurement, fulfilment or refund path, a stop could strand a buyer
    // who has already paid — which is the one thing #125 says it must not do.
    name: 'the procurement, purchase-order or refund path, from the pilot',
    files: PILOT_FILES,
    pattern:
      /from\s+['"][^'"]*(supplier-orders\/|procurement\/purchase-order|refund\.service|retail-checkout\/fulfilment)[^'"]*['"]/,
    probe: "import { submitPurchaseOrderToSupplier } from '../supplier-orders/submission.service.js';",
  },
  {
    // A pilot bound is not a payment decision and must never become one. The
    // ledger, the payment service and the Stripe adapter are all out of reach:
    // a cohort that could book or refuse a charge would be a second answer to
    // what `payment.service` already answers.
    name: 'the payment domain, from the pilot',
    files: PILOT_FILES,
    // `\.\./payments/` as well as `services/payments`: a sibling domain is one
    // `../` away from here, so a detector anchored on the absolute-looking form
    // would miss the import somebody would actually write. The mutation
    // self-test below is what found that — the first spelling of this pattern
    // passed the wall and failed its own probe.
    pattern:
      /from\s+['"][^'"]*(services\/payments|\.\.\/payments\/|db\/payments|schema\/payments|schema\/ledger)[^'"]*['"]/,
    probe: "import { paymentService } from '../payments/payment.service.js';",
  },
  {
    // #125's own rule, and the reason the pilot is a bound rather than a
    // ranking input: nothing here may read or write what a buyer sees.
    name: 'a feed, search or ranking module, from the pilot',
    files: PILOT_FILES,
    pattern: /from\s+['"][^'"]*(feed\.service|search\.service|ranking|merchandising)[^'"]*['"]/,
    probe: "import { rankFeed } from '../feed/ranking.service.js';",
  },
  {
    // ADR 0004 D11: nothing in the retail chain may NAME them, comments
    // included — a comment naming one is exactly the anticipation it forbids.
    name: 'OxyPay or FairCoin, anywhere in the pilot or the Printful integration',
    files: [...PILOT_FILES, ...PRINTFUL_FILES, PRINTFUL_ADAPTER, PRINTFUL_CATALOG_ADAPTER],
    pattern: /oxy[_\s-]?pay|oxypay|faircoin|fair[_\s-]coin/i,
    probe: 'const rail = "oxy_pay";',
  },
  {
    // The credential is resolved per call and never held. A Printful module
    // that read a token out of the process environment would put it in every
    // core dump and every `printenv` an operator runs while debugging.
    name: 'a bearer token read from the environment, in the Printful integration',
    files: [...PRINTFUL_FILES, PRINTFUL_ADAPTER, PRINTFUL_CATALOG_ADAPTER],
    pattern: /process\.env\s*(\.|\[)\s*['"]?PRINTFUL/i,
    probe: "const token = process.env['PRINTFUL_API_TOKEN'];",
  },
];

describe('retail pilot and Printful isolation (static)', () => {
  it('scans a non-trivial number of files', () => {
    // The anti-vacuity floor. A broken traversal scans nothing and every wall
    // below passes, which is exactly what a BROKEN scan produces.
    expect(PILOT_FILES.length).toBeGreaterThanOrEqual(3);
    expect(PRINTFUL_FILES.length).toBeGreaterThanOrEqual(3);
  });

  for (const wall of WALLS) {
    it(`does not reach ${wall.name}`, () => {
      const offenders = wall.files.filter((path) => {
        const source = wall.name.includes('OxyPay') ? readFileSync(path, 'utf8') : code(path);
        return wall.pattern.test(source);
      });
      expect(offenders.map((path) => path.split('/').pop())).toEqual([]);
    });

    it(`would CATCH a reference to ${wall.name}`, () => {
      expect(wall.pattern.test(wall.probe)).toBe(true);
    });
  }
});

describe('the pilot and the adapter declare closed, consistent vocabularies', () => {
  it('names all thirteen stop metrics, and a refusal for every bound', () => {
    // A floor AND a ceiling. One quietly removed would stop being enforceable;
    // one quietly added would be enforced by nothing, because a cohort could
    // not carry a threshold for it.
    expect(RETAIL_PILOT_STOP_METRICS).toHaveLength(13);
    expect(new Set(RETAIL_PILOT_STOP_METRICS).size).toBe(13);
    expect(RETAIL_PILOT_REFUSALS).toHaveLength(13);
    expect(new Set(RETAIL_PILOT_REFUSALS).size).toBe(13);
  });

  it('declares only capabilities the shared contract knows', () => {
    const known = new Set<string>(SUPPLIER_ADAPTER_CAPABILITIES);
    expect(PRINTFUL_CAPABILITIES.filter((entry) => !known.has(entry))).toEqual([]);
    // Fewer than every capability, which is the point: six absences are
    // load-bearing and a Printful adapter claiming all 24 would be lying.
    expect(PRINTFUL_CAPABILITIES.length).toBeLessThan(SUPPLIER_ADAPTER_CAPABILITIES.length);
  });

  it('pins the EU customs territory as a code constant, not configuration', () => {
    // "Which countries are inside the EU customs territory" is a fact about the
    // customs union, and a configurable list is one typo from admitting a
    // dispatch ADR 0004 D2.9 forbids.
    expect(PRINTFUL_EU_FULFILMENT_COUNTRIES).toHaveLength(27);
    expect(PRINTFUL_EU_FULFILMENT_COUNTRIES).toContain('ES');
    expect(PRINTFUL_EU_FULFILMENT_COUNTRIES).not.toContain('GB');
    expect(PRINTFUL_EU_FULFILMENT_COUNTRIES).not.toContain('US');
  });
});
