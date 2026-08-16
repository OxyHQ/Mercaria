/**
 * The census that keeps #380's coverage statement honest.
 *
 * A statement of what a channel does NOT carry is the one kind of merchant-facing
 * claim that goes stale in SILENCE: nothing errors, no test goes red, and the
 * page keeps saying "discounts are not synced" for however long after somebody
 * builds them. That is strictly worse than the silence it replaces, because a
 * merchant acts on it. So the map is policed the way `merge-plan-census.test.ts`
 * polices the rehoming plan:
 *
 *  - COMPLETENESS over the whole cross product. Every `(channelType, entity)`
 *    pair gets exactly one disposition; an entity in neither the carried nor the
 *    not-carried half fails, and so does one that appears in both.
 *  - A PROVIDER-MEMBER CENSUS walked off the REAL provider objects. Every own
 *    member is either mapped to an entity or explicitly declared not to be a data
 *    path, with a reason. A `fetchDiscounts` landing tomorrow fails the build.
 *  - AGREEMENT between the two. The entities a pull connector's members reach
 *    must be exactly the entities its coverage reports as carried, so a policy
 *    that outlived its code cannot stay green.
 *  - MEASUREMENTS against production code for the claims none of those cover.
 *    `partial` says collection membership arrives and `partial_arrival` says a
 *    redeemed discount's code and a rate's tax arrive on the order; the only
 *    proof of either is running the real normalizers.
 *  - PROBES for the record each entry says is never created — by writer name
 *    over the import path, keyed on those modules' REAL exports, and against the
 *    real drizzle columns for the rule, which has nowhere to land.
 *  - VACUITY FLOORS on every population, and a MUTATION SELF-TEST proving each
 *    comparison bites in both directions.
 *
 * The last two bullets read as they do because of what a caveat now PROMISES. A
 * merchant is told the breakdown arrives on each imported order and that "the
 * rule behind them is not created in Mercaria, so you cannot edit or reuse it
 * here". Both halves were true only because of how one mapping function happens
 * to be written; a claim of that kind, on a screen, about what somebody may do
 * with money, is exactly the sort this file exists to stop going stale in
 * silence. The columns and the normalizers are where each half becomes a fact
 * about the system rather than about today's code.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTableColumns } from 'drizzle-orm';
import { sqlColumnName } from '@oxyhq/db';
import { describe, expect, it } from 'vitest';
import {
  CHANNEL_ENTITY_ABSENCE_REASONS,
  CHANNEL_SYNC_ENTITIES,
  CHANNEL_SYNC_RESOURCES,
  CHANNEL_TYPE_IDS,
  type ChannelSyncEntity,
  type ChannelTypeId,
} from '@mercaria/shared-types';
import { describeChannel } from '../channel-catalog.js';
import {
  CHANNEL_ENTITY_POLICY,
  PROVIDER_ENTITY_MEMBERS,
  PROVIDER_NON_ENTITY_MEMBERS,
} from '../channel-entity-coverage.js';
import { orderAppliedDiscounts, orderTaxLines } from '../../../db/schema/orders.js';
import { shopifyProvider } from '../../../connectors/shopify/index.js';
import { wooCommerceProvider } from '../../../connectors/woocommerce/index.js';
import type { ConnectorProvider } from '../../../connectors/types.js';
// TYPE-ONLY, and every one is erased. They exist so the forbidden-writer map
// below is keyed on the real exports of the modules that can create these
// records, rather than on remembered spellings — see
// `RECORD_WRITERS_THE_IMPORT_MUST_NOT_CALL`.
import type * as collectionService from '../../collection.service.js';
import type * as customerService from '../../customer.service.js';
import type * as discountService from '../../discount.service.js';
import type * as taxService from '../../tax.service.js';
import type * as customerRepository from '../../../db/stores/customerRepository.js';
import type * as discountRepository from '../../../db/merchandising/discountRepository.js';
import type * as refundRepository from '../../../db/orders/refundRepository.js';
import type * as taxRateRepository from '../../../db/stores/taxRateRepository.js';

/** The channel types whose coverage a provider's members can testify about. */
const PROVIDER_BACKED: ReadonlyArray<{ channelType: ChannelTypeId; provider: ConnectorProvider }> =
  [
    { channelType: 'shopify', provider: shopifyProvider },
    { channelType: 'woocommerce', provider: wooCommerceProvider },
  ];

/**
 * `woocommerce_plugin` is deliberately NOT in that list.
 *
 * It shares the WooCommerce provider id and none of its code: the plugin pushes
 * into `channel-ingest.service`, so the provider's members describe a different
 * channel entirely. Running the agreement gate on it would compare a descriptor
 * against a transport it never uses, and the direction it would fail in is the
 * one that makes somebody weaken the gate.
 */
const PROVIDER_MEMBERS_DO_NOT_DESCRIBE: readonly ChannelTypeId[] = ['woocommerce_plugin'];

function entitiesReachedBy(provider: ConnectorProvider): Set<ChannelSyncEntity> {
  const reached = new Set<ChannelSyncEntity>();
  for (const member of Object.keys(provider)) {
    // A member may reach several entities — `normalizeOrder` carries the order,
    // its discount allocations and its tax lines — so this iterates rather than
    // adding one. A single-value read here would silently drop all but the first.
    for (const entity of PROVIDER_ENTITY_MEMBERS[member] ?? []) reached.add(entity);
  }
  return reached;
}

describe('#380 entity coverage — the population is complete', () => {
  it('is not vacuous: both tuples and every descriptor are large', () => {
    // The floors catch a broken import that would make every comparison below
    // pass against empty sets — the one failure mode a census cannot report.
    expect(CHANNEL_SYNC_ENTITIES.length).toBeGreaterThanOrEqual(10);
    expect(CHANNEL_TYPE_IDS.length).toBeGreaterThanOrEqual(8);
    expect(Object.keys(CHANNEL_ENTITY_POLICY).length).toBe(CHANNEL_SYNC_ENTITIES.length);
    expect(Object.keys(PROVIDER_ENTITY_MEMBERS).length).toBeGreaterThanOrEqual(8);
    expect(Object.keys(PROVIDER_NON_ENTITY_MEMBERS).length).toBeGreaterThanOrEqual(12);
  });

  it('the policy answers every entity, and names none that is not one', () => {
    // Both `string[]`: the comparison is a SET difference over spellings, and
    // narrowing either side to `ChannelSyncEntity` would make a misspelled key
    // unrepresentable in the very check whose job is to report one.
    const declared: string[] = Object.keys(CHANNEL_ENTITY_POLICY).sort();
    const expected: string[] = [...CHANNEL_SYNC_ENTITIES].sort();

    expect(
      expected.filter((entity) => !declared.includes(entity)),
      'these entities have no entry in CHANNEL_ENTITY_POLICY. Add one — including a ' +
        '`never_synced` reason, which is a decision the census accepts and silence is not.',
    ).toEqual([]);
    expect(
      declared.filter((entity) => !expected.includes(entity)),
      'CHANNEL_ENTITY_POLICY names these and CHANNEL_SYNC_ENTITIES does not. Either the ' +
        'entity was removed (delete the entry) or the key is misspelled, in which case ' +
        'the entity it was meant to answer is being answered by nothing.',
    ).toEqual([]);
  });

  it('the entities answered from `resources` are EXACTLY the sync resources', () => {
    // Both directions. A resource with no `sync_resource` policy would be
    // hand-written and free to disagree with the capability behind it; a
    // `sync_resource` policy for something `ChannelResourceSupport` does not
    // model would read `undefined.length` and report an absence.
    const fromResources = CHANNEL_SYNC_ENTITIES.filter(
      (entity) => CHANNEL_ENTITY_POLICY[entity].kind === 'sync_resource',
    ).sort();
    expect(fromResources).toEqual([...CHANNEL_SYNC_RESOURCES].sort());
  });

  it('every never_synced and partial_arrival entry records a reason', () => {
    let checked = 0;
    for (const entity of CHANNEL_SYNC_ENTITIES) {
      const policy = CHANNEL_ENTITY_POLICY[entity];
      if (policy.kind === 'sync_resource') continue;
      checked += 1;
      expect(policy.note.length, `${entity} has no reason recorded`).toBeGreaterThan(40);
      if (policy.kind === 'never_synced') {
        expect(CHANNEL_ENTITY_ABSENCE_REASONS).toContain(policy.reason);
      }
    }
    // The floor: "every entry has a reason" is also what zero entries reports.
    expect(checked).toBeGreaterThanOrEqual(7);
  });

  it('EVERY channel answers EVERY entity, exactly once, in tuple order', () => {
    for (const channelType of CHANNEL_TYPE_IDS) {
      const coverage = describeChannel(channelType).entityCoverage;

      expect(
        coverage.map((entry) => entry.entity),
        `${channelType} must answer every entity in CHANNEL_SYNC_ENTITIES, in order`,
      ).toEqual([...CHANNEL_SYNC_ENTITIES]);

      for (const entry of coverage) {
        if (entry.state === 'not_synced') {
          expect(CHANNEL_ENTITY_ABSENCE_REASONS).toContain(entry.reason);
        } else {
          // A claim that something moves with no direction to move it in is the
          // shape `resources.orders: []` already had, and the shape that let a
          // merchant read an absence as a presence.
          expect(entry.directions.length, `${channelType}/${entry.entity}`).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe('#380 entity coverage — the provider census', () => {
  for (const { channelType, provider } of PROVIDER_BACKED) {
    it(`${channelType}: every provider member is mapped or declared not a data path`, () => {
      const members = Object.keys(provider);
      // The floor: an empty member list would make both filters below pass.
      expect(members.length).toBeGreaterThanOrEqual(15);

      const unclassified = members
        .filter(
          (member) =>
            PROVIDER_ENTITY_MEMBERS[member] === undefined &&
            PROVIDER_NON_ENTITY_MEMBERS[member] === undefined,
        )
        .sort();
      expect(
        unclassified,
        'these provider members are in neither PROVIDER_ENTITY_MEMBERS nor ' +
          'PROVIDER_NON_ENTITY_MEMBERS. If one moves an entity, map it AND say what the ' +
          "coverage now claims about that entity; if it does not, say so with a reason. A " +
          'provider that grew a data path while the coverage still reported the entity as ' +
          'not synced is exactly what this gate exists to stop.',
      ).toEqual([]);

      const invented = [
        ...Object.keys(PROVIDER_ENTITY_MEMBERS),
        ...Object.keys(PROVIDER_NON_ENTITY_MEMBERS),
      ]
        .filter((member) => !members.includes(member))
        .sort();
      expect(
        invented,
        `these members are mapped and ${channelType}'s provider does not have them. Either ` +
          'the member was removed (delete the entry) or it is misspelled, in which case the ' +
          'real member is being classified by nothing.',
      ).toEqual([]);
    });

    it(`${channelType}: the entities its members reach are EXACTLY the ones it carries`, () => {
      // Compared against every entity the coverage does NOT call `not_synced`,
      // which is the honest reading of what a member census can testify to: it
      // answers WHICH entities a channel touches, and the three-valued state
      // answers TO WHAT DEGREE. A member cannot tell the two apart.
      //
      // It was `synced`-only until #395 added `fetchCollections`, and it passed
      // for the wrong reason: no member reached `collections`, so the stricter
      // comparison was never exercised on a `partial` entry. The distinction it
      // looked like it was buying is bought instead by the measurement below,
      // which runs the real code — the degree is not something this comparison
      // can see, and a gate that appears to check it is worse than one that says
      // it does not.
      const reached = [...entitiesReachedBy(provider)].sort();
      const touched = describeChannel(channelType)
        .entityCoverage.filter((entry) => entry.state !== 'not_synced')
        .map((entry) => entry.entity)
        .sort();

      expect(reached.length).toBeGreaterThan(0);
      expect(
        touched,
        'the coverage and the provider disagree about which entities move. A member mapped ' +
          'to an entity the policy still calls not_synced is a merchant being told a ' +
          'feature does not exist; the reverse is a promise nothing keeps.',
      ).toEqual(reached);
    });
  }

  it('a channel a provider cannot describe is excluded deliberately, not forgotten', () => {
    // The exclusion is checked rather than merely written down: the plugin must
    // still be a real channel type, and it must still be one this file skips for
    // the stated reason rather than one that quietly stopped existing.
    for (const channelType of PROVIDER_MEMBERS_DO_NOT_DESCRIBE) {
      expect(CHANNEL_TYPE_IDS).toContain(channelType);
      expect(PROVIDER_BACKED.map((entry) => entry.channelType)).not.toContain(channelType);
      // It still answers every entity — being outside the agreement gate is not
      // being outside the coverage statement.
      expect(describeChannel(channelType).entityCoverage.map((entry) => entry.entity)).toEqual([
        ...CHANNEL_SYNC_ENTITIES,
      ]);
    }
  });
});

describe('#380 entity coverage — the partial claim is measured, not asserted', () => {
  /**
   * A minimal platform product carrying collection membership, per platform.
   *
   * `partial` for `collections` claims that membership arrives while the
   * collection itself does not, and nothing in a type or a capability says so —
   * it is a property of each provider's `normalizeProduct`. So the claim is
   * measured by running the real normalizer, which is the only thing that can go
   * red when somebody removes the mapping.
   */
  it('both pull connectors really do carry collection membership onto a product', () => {
    const shopifyProduct = shopifyProvider.normalizeProduct(
      {
        id: 1,
        title: 'A product',
        status: 'active',
        variants: [{ id: 11, price: '10.00', inventory_quantity: 1 }],
      },
      'EUR',
    );
    // Shopify's REST product payload carries no membership at all — the provider
    // fills `collectionRefs` during `fetchProducts` from a per-run index. The
    // measurable half here is that the field is a real part of the shape and is
    // absent rather than invented when the payload has none.
    expect(shopifyProduct.collectionRefs).toBeUndefined();

    const wooProduct = wooCommerceProvider.normalizeProduct(
      {
        id: 2,
        name: 'A product',
        status: 'publish',
        type: 'simple',
        price: '10.00',
        categories: [{ id: 77, name: 'Shoes' }],
      },
      'EUR',
    );
    expect(
      wooProduct.collectionRefs,
      'WooCommerce maps a product category onto collectionRefs. If this is empty, the ' +
        "coverage's `partial` claim for collections is no longer true and must be changed " +
        'to not_synced rather than left saying membership arrives.',
    ).toEqual(['77']);

    // And the claim itself, on the descriptors: measured above, stated here.
    for (const channelType of ['shopify', 'woocommerce'] as const) {
      const collections = describeChannel(channelType).entityCoverage.find(
        (entry) => entry.entity === 'collections',
      );
      expect(collections?.state).toBe('partial');
    }
  });

  it('a channel with no such mapping reports collections as not synced', () => {
    for (const channelType of ['woocommerce_plugin', 'product_feed', 'native'] as const) {
      const collections = describeChannel(channelType).entityCoverage.find(
        (entry) => entry.entity === 'collections',
      );
      expect(collections?.state, channelType).toBe('not_synced');
    }
  });
});

/**
 * The order-import path, with its comments stripped.
 *
 * Comment-stripped because a census over source that counts prose is inflated by
 * exactly the files most careful about the thing being counted — and this module
 * documents at length what it does NOT write. Lines whose trimmed form opens a
 * comment are dropped; a trailing comment on a code line survives, which can only
 * make an absence check FAIL noisily and never make one pass.
 */
function orderImportSource(): { readonly lines: readonly string[]; readonly code: string } {
  const path = fileURLToPath(new URL('../../connector-sync.service.ts', import.meta.url));
  const lines = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
    });
  return { lines, code: lines.join('\n') };
}

/**
 * The exports of every module that can CREATE one of the records the coverage
 * says an imported order never creates.
 *
 * Type-only, so it is erased at runtime and buys the one thing a source probe
 * cannot buy for itself: the map below is keyed on this union, so a writer that
 * is renamed or deleted fails `tsc` HERE instead of sitting in the list matching
 * nothing. That is not hypothetical. This probe used to look for `createRefund`,
 * which names no writer in this repository at all — the only `createRefund*` is
 * `createRefundSchema`, a zod schema in `middleware/schemas.ts` — so one of its
 * three tokens could never have fired, and an inert probe reads exactly like a
 * passing one.
 */
type RecordWriterExport =
  | keyof typeof collectionService
  | keyof typeof customerService
  | keyof typeof customerRepository
  | keyof typeof discountService
  | keyof typeof discountRepository
  | keyof typeof refundRepository
  | keyof typeof taxService
  | keyof typeof taxRateRepository;

/**
 * Every writer the import path must not call, paired with the claim it falsifies.
 *
 * `Partial`, because these are a SUBSET of those modules' exports — and the
 * excess-property check under `satisfies` is what refuses a key that is not one
 * of them.
 */
const RECORD_WRITERS_THE_IMPORT_MUST_NOT_CALL = {
  // `discounts` — the caveat says the rule "is not created in Mercaria".
  createDiscount: 'discounts',
  insertDiscount: 'discounts',
  redeemDiscountCode: 'discounts',
  // `tax_rates` — same caveat, same promise.
  createTaxRate: 'tax_rates',
  insertTaxRate: 'tax_rates',
  // `customers` — "no Mercaria customer record is created from them".
  upsertOnPaid: 'customers',
  createCustomer: 'customers',
  resolveOrCreate: 'customers',
  insertCustomer: 'customers',
  // `refunds` — "no Mercaria refund record is created".
  insertRefund: 'refunds',
  // `collections` — `partial` says membership arrives and no collection is made.
  createCollection: 'collections',
} as const satisfies Partial<Record<RecordWriterExport, ChannelSyncEntity>>;

/**
 * Column-name segments that would mean the discount or tax RULE is being stored.
 *
 * The two breakdown tables hold one discount's APPLICATION to one order — a
 * code, a title, an amount. What makes the merchant-facing caveat true is that
 * the rule's own terms have nowhere to land: no scope, no usage limit, no
 * combinability, no validity window, no jurisdiction, and no pointer at a
 * Mercaria `discounts` or `tax_rates` row. A column is how that changes, and a
 * column arrives in a migration written by somebody who never opened this file.
 */
const RULE_SHAPED_COLUMN_SEGMENTS: readonly string[] = [
  'usage',
  'limit',
  'combin',
  'scope',
  'starts',
  'ends',
  'expires',
  'applies',
  'minimum',
  'jurisdiction',
];

/** The SQL column names of one drizzle table — `sqlColumnName`, never `.name` (#354). */
function sqlColumnNames(table: Parameters<typeof getTableColumns>[0]): readonly string[] {
  return Object.values(getTableColumns(table)).map((column) => sqlColumnName(column));
}

/** A Shopify `*_set` money field, in the currency the fixtures below price in. */
function shopMoney(amount: string) {
  return { shop_money: { amount, currency_code: 'EUR' } };
}

describe('#380 entity coverage — the never_synced claims are probed, not trusted', () => {
  /**
   * The gap the provider census does NOT close, closed here.
   *
   * That census catches a provider growing a data path. It cannot catch the other
   * way these four claims go false: `buildExternalOrderDoc` starting to populate
   * `appliedDiscounts`, `taxLines` or a customer from data ALREADY arriving on a
   * normalized order, with no new provider member and no new import. The claim is
   * about what the import WRITES, so that is what is measured.
   */
  it('an imported order still writes NO discount, tax, customer or refund record', () => {
    const { lines, code } = orderImportSource();

    // The floor: an unreadable or renamed module would make every check below
    // pass against an empty string, which is the one failure a source census
    // cannot otherwise report.
    expect(lines.length).toBeGreaterThan(2000);
    expect(code).toContain('function buildExternalOrderDoc');

    // `discounts` and `tax_rates`: what the import WRITES and what the policy
    // CLAIMS, asserted against each other rather than either one alone.
    //
    // The first spelling of this checked only that the source still contained
    // `appliedDiscounts: [],`. It fired correctly when #378 populated the field
    // — and it could only ever fire in that one direction. Had the policy been
    // loosened to `partial` while the import still wrote an empty array, the
    // merchant would have been promised a breakdown that never arrives and this
    // gate would have stayed green. Binding the two together fails on either
    // side moving without the other.
    for (const { entity, emptyLiteral, populatedCall } of [
      {
        entity: 'discounts',
        emptyLiteral: 'appliedDiscounts: [],',
        populatedCall: 'appliedDiscounts: toAppliedDiscounts(order)',
      },
      {
        entity: 'tax_rates',
        emptyLiteral: 'taxLines: [],',
        populatedCall: 'taxLines: toOrderTaxLines(order)',
      },
    ] as const) {
      const writesNothing = code.includes(emptyLiteral);
      const writesBreakdown = code.includes(populatedCall);

      // Neither and both are each a reading of the source nobody intended: the
      // field was renamed, or two writers disagree. Either way the checks below
      // would be measuring nothing, so say so instead of passing.
      expect(
        [writesNothing, writesBreakdown].filter(Boolean).length,
        `buildExternalOrderDoc's ${entity} write matched ${
          writesNothing && writesBreakdown ? 'BOTH' : 'NEITHER'
        } of the two shapes this gate knows. The field was renamed or is written twice; ` +
          'until this is updated the coverage claim for that entity is unmeasured.',
      ).toBe(1);

      const policy = CHANNEL_ENTITY_POLICY[entity];
      expect(
        policy.kind,
        writesBreakdown
          ? `an imported order now carries its ${entity} breakdown, so CHANNEL_ENTITY_POLICY.` +
            `${entity} must not say it is never exchanged — that claim is on a merchant's screen.`
          : `an imported order writes an empty ${entity} breakdown again, so CHANNEL_ENTITY_POLICY.` +
            `${entity} promises a merchant lines that never arrive.`,
      ).toBe(writesBreakdown ? 'partial_arrival' : 'never_synced');
    }

    // The RECORD half, for every entity whose entry says none is created. It
    // covers `collections` — `partial` claims a product joins collections the
    // merchant already made and that no collection is CREATED, and creating one
    // is a small change inside a function that already resolves collection ids —
    // as well as `customers` and `refunds`, and now `discounts` and `tax_rates`,
    // whose caveat tells a merchant the rule is not created here.
    //
    // Absences, so each is paired with a positive control below proving the scan
    // can see a token of that shape at all. The map itself is keyed on the real
    // exports of the modules that own these writers, so a name that no longer
    // exists is a `tsc` failure rather than a check that quietly stops firing.
    for (const [writer, entity] of Object.entries(RECORD_WRITERS_THE_IMPORT_MUST_NOT_CALL)) {
      expect(
        lines.filter((line) => line.includes(writer)),
        `the connector import path now references ${writer}. CHANNEL_ENTITY_POLICY.${entity} ` +
          'says no such Mercaria record is created from an imported order; if one now is, the ' +
          "coverage on a merchant's screen says the opposite of what happens.",
      ).toEqual([]);
    }

    // `customerId` is kept as a token in its own right rather than as a writer:
    // it is a FIELD name, so it catches the order document growing a pointer to
    // a Mercaria customer without any of the writers above being called.
    expect(
      lines.filter((line) => line.includes('customerId')),
      'the connector import path now references customerId. An imported order carries the ' +
        "buyer's name and address and links to no Mercaria customer record.",
    ).toEqual([]);
  });

  it('the forbidden-writer map defends every entity that claims no record is created', () => {
    // `tsc` already refuses a key that is not a real export. What it cannot check
    // is the other direction — an entity whose entry makes that claim and that no
    // writer in the map defends, which is how a claim silently stops being probed.
    const defended = new Set<string>(Object.values(RECORD_WRITERS_THE_IMPORT_MUST_NOT_CALL));
    for (const entity of [
      'discounts',
      'tax_rates',
      'customers',
      'refunds',
      'collections',
    ] as const) {
      expect(defended.has(entity), `nothing in the map defends ${entity}'s claim`).toBe(true);
    }
    // The floor: an empty map would satisfy the loop in the probe above.
    expect(Object.keys(RECORD_WRITERS_THE_IMPORT_MUST_NOT_CALL).length).toBeGreaterThanOrEqual(10);
  });

  it('the absence checks can SEE what they are looking for', () => {
    // A negative control needs its own vacuity floor: "X is absent" is also what
    // a scan that read nothing reports. Each of these is known-present in the
    // same file AND of the same shape as the forbidden tokens it controls for.
    // `toAppliedDiscounts`/`toOrderTaxLines` earn their place specifically: the
    // sharpest way this probe could go blind is by failing to see discount- and
    // tax-spelled identifiers in a file that is full of them.
    const { lines } = orderImportSource();
    for (const present of [
      'buyerOxyUserId',
      'insertOrder',
      'shippingAddress',
      'toAppliedDiscounts',
      'toOrderTaxLines',
    ] as const) {
      expect(
        lines.filter((line) => line.includes(present)).length,
        `${present} is known-present; a zero here means the scan is blind, not that the ` +
          'forbidden tokens are absent.',
      ).toBeGreaterThan(0);
    }
  });

  it('the imported breakdown has nowhere to store a discount or tax RULE', () => {
    // The structural half of the caveat a merchant now reads: "the rule behind
    // them is not created in Mercaria, so you cannot edit or reuse it here."
    //
    // Nothing enforced that. It is true because of how `buildExternalOrderDoc`
    // and its two mappers happen to be written today, and it is a promise about
    // what a merchant can and cannot do, on a screen. Here it becomes a property
    // of the schema instead: the tables hold one discount's APPLICATION to one
    // order, and the rule's own terms have no column to arrive in.
    const tables = [
      { table: 'order_applied_discounts', columns: sqlColumnNames(orderAppliedDiscounts) },
      { table: 'order_tax_lines', columns: sqlColumnNames(orderTaxLines) },
    ];

    for (const { table, columns } of tables) {
      // The floor: a traversal that returned nothing passes every check below.
      expect(columns.length, `${table} has no columns — did the traversal break?`).toBeGreaterThan(
        5,
      );
      for (const column of columns) {
        // SQL identifiers, or this gate is comparing against the TypeScript
        // property name and its tokens can never match (#354).
        expect(column, `${table}.${column} is not a SQL identifier`).toMatch(/^[a-z][a-z0-9_]*$/);
      }

      expect(
        columns.filter((column) =>
          RULE_SHAPED_COLUMN_SEGMENTS.some((segment) => column.includes(segment)),
        ),
        `${table} grew a column describing the discount or tax RULE rather than its ` +
          "application to one order. The channel screen tells a merchant the rule is not " +
          'created in Mercaria and cannot be edited or reused here; if it now is, that caveat ' +
          'is what has to change.',
      ).toEqual([]);

      expect(
        columns.filter((column) => column === 'mercaria_discount_id' || column === 'tax_rate_id'),
        `${table} now points at a Mercaria discount or tax rate, which would mean the record ` +
          'is being created after all.',
      ).toEqual([]);
    }

    // And the application's OWN fields are present, so the refusals above are
    // rejecting a shape rather than reporting two empty tables.
    expect(sqlColumnNames(orderAppliedDiscounts)).toContain('code');
    expect(sqlColumnNames(orderAppliedDiscounts)).toContain('discount_id');
    expect(sqlColumnNames(orderTaxLines)).toContain('rate_bps');
  });

  it('both connectors really do carry a discount and tax breakdown onto an order', () => {
    // The ARRIVAL half of `partial_arrival`, measured rather than read off the
    // source. The bidirectional binding above compares what the import WRITES
    // against what the policy CLAIMS — but both sides are satisfied by
    // `toAppliedDiscounts` mapping an array that is always empty, because
    // neither provider populates `NormalizedOrder.discounts`. Running the real
    // normalizers is what rules that out, and it is the device this file already
    // uses one describe block down for `collections`.
    const shopifyOrder = shopifyProvider.normalizeOrder(
      {
        id: 5001,
        name: '#1001',
        currency: 'EUR',
        presentment_currency: 'EUR',
        financial_status: 'paid',
        fulfillment_status: null,
        subtotal_price_set: shopMoney('40.00'),
        total_tax_set: shopMoney('8.40'),
        total_discounts_set: shopMoney('4.00'),
        total_shipping_price_set: shopMoney('5.00'),
        total_price_set: shopMoney('49.40'),
        line_items: [
          {
            id: 'l1',
            title: 'A product',
            variant_title: null,
            quantity: 1,
            price_set: shopMoney('40.00'),
            // Shopify states a discount's MONEY only in the per-line
            // allocations, which point back at the application by index.
            discount_allocations: [
              { amount_set: shopMoney('4.00'), discount_application_index: 0 },
            ],
          },
        ],
        discount_applications: [
          {
            type: 'discount_code',
            title: null,
            code: 'CONTRACT10',
            value_type: 'percentage',
            target_type: 'line_item',
          },
        ],
        tax_lines: [{ title: 'VAT', price_set: shopMoney('8.40'), rate: 0.21 }],
        shipping_lines: [{ title: 'Express (2 days)', code: 'EXPRESS', discount_allocations: [] }],
      },
      'EUR',
    );
    expect(
      shopifyOrder.discounts.map((discount) => discount.code),
      'Shopify stopped carrying a redeemed discount code onto an imported order, so the ' +
        'channel screen promises a merchant lines that no longer arrive.',
    ).toEqual(['CONTRACT10']);
    expect(shopifyOrder.discounts[0]?.amount.amount).toBe(400);
    expect(shopifyOrder.taxLines.map((line) => line.name)).toEqual(['VAT']);

    const wooOrder = wooCommerceProvider.normalizeOrder(
      {
        id: 6001,
        number: '6001',
        status: 'completed',
        currency: 'EUR',
        date_created: '2026-01-01T00:00:00',
        total: '49.40',
        total_tax: '8.40',
        discount_total: '4.00',
        shipping_total: '5.00',
        line_items: [
          {
            id: 'l1',
            name: 'A product',
            quantity: 1,
            subtotal: '40.00',
            total: '40.00',
            meta_data: [],
          },
        ],
        coupon_lines: [{ id: 900, code: 'contract10', discount: '4.00', discount_tax: '0.00' }],
        tax_lines: [
          {
            id: 800,
            rate_code: 'VAT',
            label: 'VAT',
            rate_percent: 21,
            tax_total: '8.40',
            shipping_tax_total: '0.00',
          },
        ],
        shipping_lines: [
          { id: 700, method_title: 'Flat rate', method_id: 'flat_rate', total: '5.00' },
        ],
        refunds: [],
      },
      'EUR',
    );
    expect(
      wooOrder.discounts.map((discount) => discount.code),
      'WooCommerce stopped carrying an order coupon onto an imported order.',
    ).toEqual(['contract10']);
    expect(wooOrder.taxLines.map((line) => line.name)).toEqual(['VAT']);
  });
});

describe('#380 entity coverage — what a merchant is actually told', () => {
  it('Shopify says discounts arrive as order lines only, and says what is missing', () => {
    // The report this issue exists for, and what it became. The merchant's
    // complaint was that the screen said nothing about discounts at all; #380
    // made it say "not exchanged", and #378 then made an imported order carry
    // the breakdown, so "not exchanged" became the new wrong sentence.
    //
    // `partial` rather than `synced` is the whole point: the lines arrive, the
    // RULE does not, and a merchant who reads `synced` goes looking for a
    // discount they can edit. Pinned by value because the distinction is the
    // sentence on the screen, not an implementation detail.
    const discounts = describeChannel('shopify').entityCoverage.find(
      (entry) => entry.entity === 'discounts',
    );
    expect(discounts).toEqual({
      entity: 'discounts',
      state: 'partial',
      directions: ['pull'],
      caveat: 'breakdown_only_on_imported_orders',
    });
  });

  it('an unimplemented channel still says discounts are not synced', () => {
    // The other half of `partial_arrival`: the caveat is a fact about a
    // provider's normalizer, so a channel with no connector must not inherit it.
    // Without this, adding a channel id to `channels` would be the only thing
    // standing between an unbuilt integration and a promise of imported lines.
    const discounts = describeChannel('etsy').entityCoverage.find(
      (entry) => entry.entity === 'discounts',
    );
    expect(discounts?.state).toBe('not_synced');
  });

  it('a model-level absence outranks the channel it is asked about', () => {
    // `gift_cards` is absent because Mercaria models nothing of the kind, which
    // is true of Etsy (unbuilt) and of the native catalogue alike. Refining it to
    // `channel_not_implemented` would promise it arrives once somebody writes an
    // Etsy connector.
    for (const channelType of ['shopify', 'etsy', 'native'] as const) {
      const giftCards = describeChannel(channelType).entityCoverage.find(
        (entry) => entry.entity === 'gift_cards',
      );
      expect(giftCards, channelType).toEqual({
        entity: 'gift_cards',
        state: 'not_synced',
        reason: 'not_modelled_by_mercaria',
      });
    }
  });

  it('an unbuilt connector says so rather than saying "not built for this channel"', () => {
    const products = describeChannel('etsy').entityCoverage.find(
      (entry) => entry.entity === 'products',
    );
    expect(products).toEqual({
      entity: 'products',
      state: 'not_synced',
      reason: 'channel_not_implemented',
    });
  });

  it('the native catalogue is not described as a sync that has not been built', () => {
    const products = describeChannel('native').entityCoverage.find(
      (entry) => entry.entity === 'products',
    );
    expect(products).toEqual({
      entity: 'products',
      state: 'not_synced',
      reason: 'native_catalog_is_not_a_sync',
    });
  });

  it('a product feed says its transport carries products only', () => {
    const orders = describeChannel('product_feed').entityCoverage.find(
      (entry) => entry.entity === 'orders',
    );
    expect(orders).toEqual({
      entity: 'orders',
      state: 'not_synced',
      reason: 'channel_transports_products_only',
    });
  });

  it('the carried half tracks the capability declaration rather than restating it', () => {
    // Shopify pushes products and fulfilments; WooCommerce does neither. The
    // coverage must be the descriptor's `resources` and nothing else, or a
    // capability change would move one and leave the other.
    const shopifyOrders = describeChannel('shopify').entityCoverage.find(
      (entry) => entry.entity === 'orders',
    );
    expect(shopifyOrders).toEqual({
      entity: 'orders',
      state: 'synced',
      directions: describeChannel('shopify').resources.orders,
    });
    expect(shopifyOrders?.state === 'synced' && shopifyOrders.directions).toEqual(['pull', 'push']);

    const wooOrders = describeChannel('woocommerce').entityCoverage.find(
      (entry) => entry.entity === 'orders',
    );
    expect(wooOrders?.state === 'synced' && wooOrders.directions).toEqual(['pull']);
  });
});

describe('#380 entity coverage — MUTATION SELF-TEST', () => {
  it('a dropped policy entry is caught, and so is an invented one', () => {
    // A census that compared nothing would pass every assertion above. These
    // mutate COPIES — never the real map — and assert the comparison notices.
    const declared = Object.keys(CHANNEL_ENTITY_POLICY);
    const expected = [...CHANNEL_SYNC_ENTITIES];

    const withOneDropped = declared.filter((entity) => entity !== 'discounts');
    expect(expected.filter((entity) => !withOneDropped.includes(entity))).toEqual(['discounts']);

    const withOneInvented = [...declared, 'loyalty_points'];
    expect(
      withOneInvented.filter((entity) => !expected.includes(entity as ChannelSyncEntity)),
    ).toEqual(['loyalty_points']);
  });

  it('an unclassified provider member is caught', () => {
    // The interlock that stops the policy outliving the code. A provider growing
    // `fetchDiscounts` must land here, not in a merchant's inbox.
    const members = [...Object.keys(shopifyProvider), 'fetchDiscounts'];
    const unclassified = members.filter(
      (member) =>
        PROVIDER_ENTITY_MEMBERS[member] === undefined &&
        PROVIDER_NON_ENTITY_MEMBERS[member] === undefined,
    );
    expect(unclassified).toEqual(['fetchDiscounts']);
  });

  it('a policy that disagrees with the provider is caught', () => {
    // Mapping a member to an entity the coverage still calls never_synced must
    // break the agreement gate — this is that comparison, run on a mutated copy
    // of the member map.
    // `touched` must use the SAME filter the real gate uses. It compared against
    // `synced` only, which — now that `normalizeOrder` legitimately reaches two
    // `partial` entities — differs from `reached` even with NO mutation applied.
    // The self-test was passing without exercising the mutation at all, which is
    // the exact failure a mutation self-test exists to rule out. So the control
    // is asserted first: unmutated the two agree, and only then does the mutation
    // have anything to break.
    const touchedBy = (map: Record<string, readonly ChannelSyncEntity[]>): string[] => {
      const reached = new Set<ChannelSyncEntity>();
      for (const member of Object.keys(shopifyProvider)) {
        for (const entity of map[member] ?? []) reached.add(entity);
      }
      return [...reached].sort();
    };
    const carried = describeChannel('shopify')
      .entityCoverage.filter((entry) => entry.state !== 'not_synced')
      .map((entry) => entry.entity)
      .sort();

    expect(
      touchedBy(PROVIDER_ENTITY_MEMBERS),
      'CONTROL: unmutated, the member census and the coverage must agree — otherwise the ' +
        'mutation below proves nothing, because the comparison was already unequal.',
    ).toEqual(carried);

    expect(
      touchedBy({ ...PROVIDER_ENTITY_MEMBERS, fetchProducts: ['gift_cards'] }),
      'mapping a member onto an entity the coverage calls never_synced must break the ' +
        'agreement gate.',
    ).not.toEqual(carried);
  });
});
