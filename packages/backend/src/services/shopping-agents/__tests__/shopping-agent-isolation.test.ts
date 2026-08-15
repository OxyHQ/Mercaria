/**
 * The walls around #97, and the proof that each of them can fail.
 *
 * #97 acceptance 9 is one sentence — "there is no code path from an agent to
 * autonomous checkout or payment" — and it is the only acceptance criterion in
 * the issue that cannot be demonstrated by making something happen. What can be
 * demonstrated is that the path does not EXIST, and that is what this file is:
 * a scan over the whole domain directory, so the wall holds for modules nobody
 * has written yet, with a vacuity floor so a scan that read nothing cannot
 * report clean, and a mutation self-test per detector so a pattern that matches
 * nothing cannot report clean either.
 *
 * Seven of the ten walls scan COMMENT-STRIPPED source, because these modules
 * document what they refuse to do in exactly the vocabulary the detectors
 * match. Two scan RAW source on purpose: the forbidden-action wall (a
 * `Buy automatically` label in a comment is a sentence somebody pastes into a
 * screen next week — #81's reasoning) and the storefront wall, for the same
 * reason plus #92's: the storefront has no test runner of its own, so the one
 * file that could put a purchase control in front of a shopper is checked from
 * here or nowhere.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { sqlColumnName } from '@oxyhq/db';
import {
  SHOPPING_AGENT_FORBIDDEN_ACTIONS,
  SHOPPING_AGENT_FORBIDDEN_NOTIFICATION_FIELDS,
  SHOPPING_AGENT_FORBIDDEN_SCOPES,
  SHOPPING_AGENT_JOB_KINDS,
} from '@mercaria/shared-types';
import {
  shoppingAgentAudits,
  shoppingAgentEvaluations,
  shoppingAgentFindingLines,
  shoppingAgentFindings,
  shoppingAgentLines,
  shoppingAgentNotifications,
  shoppingAgentTriggers,
  shoppingAgents,
} from '../../../db/schema/shoppingAgents.js';
import { shoppingAgentNotificationPayload } from '../notification.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const REPO_ROOT = join(SRC_ROOT, '..', '..', '..');

/* ────────────────────────────────────────────────────────────────────────── */
/* The files under scan                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

function enumerateDirectory(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) continue;
    if (!entry.endsWith('.ts') && !entry.endsWith('.tsx')) continue;
    files.push(full);
  }
  return files;
}

/** Every file of the backend half of the domain, enumerated from the real tree. */
function enumerateDomain(): string[] {
  const files = [
    ...enumerateDirectory(join(SRC_ROOT, 'services', 'shopping-agents')),
    ...enumerateDirectory(join(SRC_ROOT, 'db', 'shoppingAgents')),
    join(SRC_ROOT, 'controllers', 'shopping-agents.controller.ts'),
    join(SRC_ROOT, 'routes', 'shopping-agents.ts'),
    join(SRC_ROOT, 'middleware', 'shopping-agent-schemas.ts'),
    join(SRC_ROOT, 'db', 'schema', 'shoppingAgents.ts'),
  ];
  return files;
}

/**
 * The storefront half.
 *
 * Scanned from the backend suite for #92's reason: the storefront has no test
 * runner, and the one file that could put a purchase control in front of a
 * shopper is a storefront file.
 */
function enumerateStorefront(): string[] {
  const roots = [
    join(REPO_ROOT, 'packages', 'frontend', 'app', '(app)'),
    join(REPO_ROOT, 'packages', 'ui', 'components'),
  ];
  const files: string[] = [];
  for (const root of roots) {
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!/shopping-?agent/i.test(entry)) continue;
      const full = join(root, entry);
      if (statSync(full).isDirectory()) {
        files.push(...enumerateDirectory(full));
        continue;
      }
      files.push(full);
    }
  }
  return files;
}

/**
 * Files that legitimately NAME the prohibition.
 *
 * Excluded BY PATH rather than by a pattern, #164's decision: the vocabulary
 * has to be declared somewhere, the digest check has to scan for it, and the
 * summary validator has to refuse it — so three files spell every forbidden
 * action out loud and would fail their own gate.
 */
const PROHIBITION_AUTHORS: readonly string[] = [
  join(SRC_ROOT, 'services', 'shopping-agents', 'authorization.ts'),
  join(SRC_ROOT, 'services', 'shopping-agents', 'summary.ts'),
];

const MINIMUM_DOMAIN_FILES = 16;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const files = enumerateDomain();
const storefrontFiles = enumerateStorefront();

/* ────────────────────────────────────────────────────────────────────────── */
/* The detectors                                                              */
/* ────────────────────────────────────────────────────────────────────────── */

/** Anything that places, pays for, reserves or cancels an order. */
const COMMERCE_ACTION_REFERENCE =
  /(services\/|\.\.\/)(checkout|payments|orders|retail-checkout|supplier-orders)\//;

/**
 * A commerce ACTION, by module name.
 *
 * The `(services\/|\.\.\/)` alternation is not belt-and-braces: every import
 * inside this domain is RELATIVE, so a module reaching the payment domain
 * writes `'../payments/x.js'` and a pattern anchored on `services/` alone would
 * never see it. #125's mutation self-test found exactly this gap in its own
 * detector, and it is repeated here rather than rediscovered.
 */
const COMMERCE_ACTION_SYMBOL =
  /['"][^'"]*\b(order|cart|checkout|refund|draft-order|inventory)\.service\.js['"]|\bopenCheckoutPayment\b|\bplaceOrders\b|\baddCartItem\b/;

/** A fee, a referral, a plan, a commission or the ledger — #74's wall, reused. */
const COMMERCIAL_REFERENCE =
  /(services\/|\.\.\/)(fees|referrals|retail-pricing)\/|\bledger(Transactions|Entries|Repository)\b|\bfee_schedules\b|\bcommission\b|\bmerchant_plans\b|\bplanFee\b/;

/** A person's contact details, in any form. */
const CONTACT_REFERENCE =
  /\b(buyerEmail|emailHash|phoneNumber|pushToken|deviceToken|guestSessionId|cardFingerprint)\b|\bnodemailer\b|@aws-sdk\/client-ses/;

/** An outbound or affiliate destination. */
const DESTINATION_REFERENCE =
  /\b(destinationUrl|destination_url|affiliateUrl|trackingTemplate|affiliateNetwork)\b/;

/** This domain's own rollout levers. */
const LEVER_REFERENCE = /config\.shoppingAgents\b/;

/** Anything that would let a model reach a verdict. */
const SUMMARY_PORT_REFERENCE = /summary\.port\.js|shoppingAgentSummaryProvider|summary\.js/;

/** Anything that evaluates. */
const EVALUATION_REFERENCE =
  /evaluateAgentDeterministically|deterministic\.js|solveBasketRequest|rankOfferComparison|evaluateCandidate/;

/** This domain, seen from somewhere else. */
const AGENT_DOMAIN_REFERENCE = /shopping-agents\/|shoppingAgents\/|shopping_agents\b/;

/**
 * A column name that would mean an agent can transact.
 *
 * Deliberately matched on the SQL identifier and not the TypeScript property:
 * `getTableConfig().columns[].name` is the property name, and a census keyed on
 * that answers about the wrong string. `sqlColumnName` is the repo's own
 * corrective.
 */
const FORBIDDEN_COLUMN =
  /(^|_)(order|cart|payment|card|invoice|charge|transfer|message)(_|$)|checkout_(group|session|id)|merchant_terms|seller_terms|supplier_agreement/;

/* ────────────────────────────────────────────────────────────────────────── */

describe('the scan is not vacuous', () => {
  it('reads a domain that has not silently shrunk', () => {
    expect(files.length).toBeGreaterThanOrEqual(MINIMUM_DOMAIN_FILES);
    for (const file of files) {
      expect(
        readFileSync(file, 'utf8').length,
        `${file} looks empty — did it move?`,
      ).toBeGreaterThan(200);
    }
  });

  it('reads the storefront half too', () => {
    // A FLOOR rather than a presence check: an empty list is exactly what a
    // scan whose glob stopped matching reports, and it is indistinguishable
    // from a screen nobody has written.
    expect(
      storefrontFiles.length,
      'no storefront shopping-agent file was found — the glob is measuring nothing',
    ).toBeGreaterThanOrEqual(1);
    for (const file of storefrontFiles) {
      expect(readFileSync(file, 'utf8').length).toBeGreaterThan(200);
    }
  });

  it('has a non-empty prohibition vocabulary to scan for', () => {
    expect(SHOPPING_AGENT_FORBIDDEN_ACTIONS.length).toBeGreaterThanOrEqual(12);
    expect(SHOPPING_AGENT_FORBIDDEN_SCOPES.length).toBeGreaterThanOrEqual(10);
    expect(SHOPPING_AGENT_FORBIDDEN_NOTIFICATION_FIELDS.length).toBeGreaterThanOrEqual(10);
  });
});

describe('WALL 1 — an agent cannot transact', () => {
  it('no module in the domain reaches a commerce ACTION', () => {
    let scanned = 0;
    for (const file of files) {
      const source = stripComments(readFileSync(file, 'utf8'));
      expect(
        COMMERCE_ACTION_REFERENCE.test(source),
        `${file} reaches the checkout, payment, order or procurement domain — #97 acceptance 9`,
      ).toBe(false);
      expect(
        COMMERCE_ACTION_SYMBOL.test(source),
        `${file} names a commerce writer — #97 acceptance 9`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(files.length);
  });

  it('no table in the domain has a column that could mean a transaction', () => {
    const tables = [
      shoppingAgents,
      shoppingAgentLines,
      shoppingAgentTriggers,
      shoppingAgentEvaluations,
      shoppingAgentFindings,
      shoppingAgentFindingLines,
      shoppingAgentNotifications,
      shoppingAgentAudits,
    ];
    let columnsInspected = 0;
    for (const table of tables) {
      for (const column of Object.values(getTableColumns(table))) {
        const name = sqlColumnName(column);
        expect(
          FORBIDDEN_COLUMN.test(name),
          `${getTableName(table)}.${name} names a transaction — #97 acceptance 9 is the ABSENCE of these columns`,
        ).toBe(false);
        columnsInspected += 1;
      }
    }
    // The floor is the positive control: eight empty tables would pass the loop
    // above without inspecting anything.
    expect(columnsInspected).toBeGreaterThanOrEqual(120);
  });

  it('the job kinds and the forbidden actions are DISJOINT', () => {
    const forbidden = new Set<string>(SHOPPING_AGENT_FORBIDDEN_ACTIONS);
    for (const kind of SHOPPING_AGENT_JOB_KINDS) {
      expect(forbidden.has(kind), `${kind} is both a job kind and a forbidden action`).toBe(false);
    }
    const scopes = new Set<string>(SHOPPING_AGENT_FORBIDDEN_SCOPES);
    for (const kind of SHOPPING_AGENT_JOB_KINDS) {
      expect(scopes.has(kind)).toBe(false);
    }
  });
});

describe('WALL 2 — no purchase language reaches a shopper', () => {
  it('no forbidden action is written anywhere in the domain, comments included', () => {
    const authors = new Set(PROHIBITION_AUTHORS);
    let scanned = 0;
    for (const file of [...files, ...storefrontFiles]) {
      if (authors.has(file)) continue;
      // RAW source, deliberately — a label in a comment is a sentence somebody
      // pastes into a screen next week (#81's rule).
      const source = readFileSync(file, 'utf8');
      for (const action of SHOPPING_AGENT_FORBIDDEN_ACTIONS) {
        const spelled = action.replace(/_/g, '[ _-]?');
        expect(
          new RegExp(spelled, 'i').test(source),
          `${file} contains the forbidden action "${action}"`,
        ).toBe(false);
      }
      scanned += 1;
    }
    expect(scanned).toBeGreaterThanOrEqual(MINIMUM_DOMAIN_FILES - PROHIBITION_AUTHORS.length);
  });
});

describe('WALL 3 — no lever gates a durable record', () => {
  const DURABLE_WRITERS: readonly string[] = [
    join('db', 'shoppingAgents', 'shoppingAgentFindingRepository.ts'),
    join('db', 'shoppingAgents', 'shoppingAgentTriggerRepository.ts'),
    join('db', 'shoppingAgents', 'shoppingAgentEvaluationRepository.ts'),
    join('db', 'shoppingAgents', 'shoppingAgentNotificationRepository.ts'),
    join('db', 'shoppingAgents', 'shoppingAgentAuditRepository.ts'),
  ];

  it('the four writers of a durable row read no rollout lever', () => {
    let scanned = 0;
    for (const relative of DURABLE_WRITERS) {
      const source = readFileSync(join(SRC_ROOT, relative), 'utf8');
      expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
      expect(
        LEVER_REFERENCE.test(stripComments(source)),
        `${relative} reads a shopping-agent lever; a flag stops a LOOP and never a row`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(DURABLE_WRITERS.length);
  });
});

describe('WALL 4 — a model can never reach a verdict', () => {
  it('the deterministic evaluator does not import the summary seam', () => {
    const source = stripComments(
      readFileSync(join(SRC_ROOT, 'services', 'shopping-agents', 'deterministic.ts'), 'utf8'),
    );
    expect(source.length).toBeGreaterThan(200);
    expect(
      SUMMARY_PORT_REFERENCE.test(source),
      'deterministic.ts reaches the summary provider — a model may only summarise a COMPLETED finding',
    ).toBe(false);
  });

  it('the summary modules import nothing that decides an outcome', () => {
    for (const name of ['summary.ts', 'summary.port.ts']) {
      const source = stripComments(
        readFileSync(join(SRC_ROOT, 'services', 'shopping-agents', name), 'utf8'),
      );
      expect(
        EVALUATION_REFERENCE.test(source),
        `${name} reaches an evaluator; a summary describes a finding and never produces one`,
      ).toBe(false);
    }
  });
});

describe('WALL 5 — a delivery retry never re-evaluates', () => {
  const DELIVERY_MODULES: readonly string[] = [
    join('services', 'shopping-agents', 'delivery.service.ts'),
    join('services', 'shopping-agents', 'delivery-dispatcher.ts'),
    join('services', 'shopping-agents', 'notification.ts'),
    join('services', 'shopping-agents', 'transport.ts'),
  ];

  it('no delivery module imports anything that evaluates', () => {
    let scanned = 0;
    for (const relative of DELIVERY_MODULES) {
      const source = stripComments(readFileSync(join(SRC_ROOT, relative), 'utf8'));
      expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
      expect(
        EVALUATION_REFERENCE.test(source),
        `${relative} reaches an evaluator; a retried delivery must re-read its ROW and never the catalogue`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(DELIVERY_MODULES.length);
  });
});

describe('WALL 6 — ranking isolation, both ways', () => {
  it('no module in the domain reaches a fee, a referral, a plan or the ledger', () => {
    for (const file of files) {
      const source = stripComments(readFileSync(file, 'utf8'));
      expect(
        COMMERCIAL_REFERENCE.test(source),
        `${file} reaches a commercial signal; what a shopper is told must not depend on what a seller pays`,
      ).toBe(false);
    }
  });

  it('no module under services/ranking/ reaches this domain', () => {
    const rankingFiles = enumerateDirectory(join(SRC_ROOT, 'services', 'ranking'));
    expect(rankingFiles.length).toBeGreaterThanOrEqual(8);
    for (const file of rankingFiles) {
      const source = stripComments(readFileSync(file, 'utf8'));
      expect(
        AGENT_DOMAIN_REFERENCE.test(source),
        `${file} reaches the shopping-agent domain; a saved objective is one join from a weighted ordering`,
      ).toBe(false);
    }
  });
});

describe('WALL 7 — nothing here holds a person', () => {
  it('no contact detail and no outbound destination appears in the domain', () => {
    for (const file of files) {
      if (file.endsWith('transport.ts')) continue; // The seam legitimately names email.
      const source = stripComments(readFileSync(file, 'utf8'));
      expect(CONTACT_REFERENCE.test(source), `${file} names a contact detail`).toBe(false);
      expect(DESTINATION_REFERENCE.test(source), `${file} names an outbound destination`).toBe(
        false,
      );
    }
  });

  it('a real emitted payload carries none of the forbidden fields', () => {
    // A RUNTIME walk over a real payload, not only a static scan: #92's
    // two-gate rule, because a spread adds fields no scan of the source sees.
    const payload = shoppingAgentNotificationPayload({
      agentId: 'agent-1',
      findingId: 'finding-1',
      kind: 'offer_price_threshold',
      priceBasis: 'item_price',
      objectiveAmountMinor: 12_345,
      objectiveCurrency: 'EUR',
      completeness: 'complete',
      freshness: 'current',
      agentPolicyVersion: 'test',
      selection: [
        {
          lineId: 'line-1',
          canonicalProductId: 'product-1',
          offerRef: 'o1',
          quantity: 1,
          nativeCheckoutEligible: true,
          officialChannel: false,
        },
      ],
    });
    const keys = Object.keys(payload);
    // The floor: an empty object would satisfy every assertion below.
    expect(keys.length).toBeGreaterThanOrEqual(11);
    for (const forbidden of SHOPPING_AGENT_FORBIDDEN_NOTIFICATION_FIELDS) {
      expect(keys, `the payload carries ${forbidden}`).not.toContain(forbidden);
    }
    expect(JSON.stringify(payload)).not.toMatch(/https?:\/\//);
  });
});

describe('the detectors actually detect — the mutation self-tests', () => {
  it('the commerce-action detector sees a real import and not an innocent one', () => {
    expect(
      COMMERCE_ACTION_REFERENCE.test("import { x } from '../checkout/checkout.service.js';"),
    ).toBe(true);
    // The RELATIVE spelling, which is the only one a module in this domain
    // would ever write. #125's own detector missed exactly this.
    expect(COMMERCE_ACTION_REFERENCE.test("import { x } from '../payments/y.js';")).toBe(true);
    expect(COMMERCE_ACTION_REFERENCE.test("import { getRates } from '../fx.service.js';")).toBe(
      false,
    );
    expect(
      COMMERCE_ACTION_SYMBOL.test("import { placeOrders } from '../checkout/x.js';"),
    ).toBe(true);
    expect(COMMERCE_ACTION_SYMBOL.test('const evaluated = true;')).toBe(false);
  });

  it('the commercial detector sees a fee import and not an innocent one', () => {
    expect(COMMERCIAL_REFERENCE.test("import { planFee } from '../fees/fee-plan.service.js';")).toBe(
      true,
    );
    expect(COMMERCIAL_REFERENCE.test('select * from fee_schedules')).toBe(true);
    expect(COMMERCIAL_REFERENCE.test("import { x } from '../fees/y.js';")).toBe(true);
    expect(COMMERCIAL_REFERENCE.test("import { solveBasketRequest } from '../comparison/basket.service.js';")).toBe(
      false,
    );
  });

  it('the contact detector sees a real field and not an innocent one', () => {
    expect(CONTACT_REFERENCE.test('const buyerEmail = row.email;')).toBe(true);
    expect(CONTACT_REFERENCE.test("import nodemailer from 'nodemailer';")).toBe(true);
    expect(CONTACT_REFERENCE.test('const emailOptIn = true;')).toBe(false);
  });

  it('the destination detector sees a real field and not an innocent one', () => {
    expect(DESTINATION_REFERENCE.test('const url = offer.destinationUrl;')).toBe(true);
    expect(DESTINATION_REFERENCE.test('const path = `/p/${slug}`;')).toBe(false);
  });

  it('the lever detector sees a real read and not an innocent one', () => {
    expect(LEVER_REFERENCE.test('if (config.shoppingAgents.evaluationEnabled) return;')).toBe(true);
    expect(LEVER_REFERENCE.test('if (config.priceAlerts.enabled) return;')).toBe(false);
  });

  it('the evaluation detector sees a real evaluator and not an innocent one', () => {
    expect(EVALUATION_REFERENCE.test("import { solveBasketRequest } from '../comparison/basket.service.js';")).toBe(
      true,
    );
    expect(EVALUATION_REFERENCE.test('const evaluatedAt = new Date();')).toBe(false);
  });

  it('the domain detector sees a real reference and not an innocent one', () => {
    expect(AGENT_DOMAIN_REFERENCE.test("from '../shopping-agents/deterministic.js'")).toBe(true);
    expect(AGENT_DOMAIN_REFERENCE.test('const agents = [];')).toBe(false);
  });

  it('the column detector sees a forbidden name and not an innocent one', () => {
    expect(FORBIDDEN_COLUMN.test('order_id')).toBe(true);
    expect(FORBIDDEN_COLUMN.test('payment_method')).toBe(true);
    expect(FORBIDDEN_COLUMN.test('merchant_terms_version')).toBe(true);
    // `terms_version` is MERCARIA's own agent terms and is legitimate. The
    // detector was narrowed to say so: a bare `terms` would have forbidden the
    // one column #97 model 12 requires, and an exception list beside a wide
    // pattern is how a wall stops meaning anything.
    expect(FORBIDDEN_COLUMN.test('terms_version')).toBe(false);
    expect(FORBIDDEN_COLUMN.test('checkout_group_id')).toBe(true);
    expect(FORBIDDEN_COLUMN.test('canonical_product_id')).toBe(false);
    expect(FORBIDDEN_COLUMN.test('cooldown_seconds')).toBe(false);
    // `native_checkout_eligible` is #97 notification 4's own information —
    // whether the shopper could buy this HERE — and is legitimate. The detector
    // was narrowed to a checkout OBJECT rather than the word, because a
    // pattern that forbids the word would have forbidden the fact.
    expect(FORBIDDEN_COLUMN.test('native_checkout_eligible')).toBe(false);
  });

  it('the comment stripper does not hide a real reference on the same line', () => {
    const stripped = stripComments("import { x } from '../fees/y.js'; // a note");
    expect(COMMERCIAL_REFERENCE.test(stripped)).toBe(true);
    expect(stripComments('/* fee_schedules */').trim()).toBe('');
  });
});
