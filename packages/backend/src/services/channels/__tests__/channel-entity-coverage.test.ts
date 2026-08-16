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
 *  - MEASUREMENTS against production code for the claims none of those covers.
 *    A member census answers WHICH entities a channel touches; it cannot answer
 *    to what DEGREE, and it is blind to an import that starts using data that
 *    was already arriving. Both of those are settled by running the real
 *    normalizers: `partial` says collection membership arrives, and
 *    `imported_only_as_part_of_an_order` says a redeemed discount's code and a
 *    rate's tax arrive on the order.
 *  - PROBES for the record each absent entry says is never created — by writer
 *    name over the import path, and against the real drizzle columns for the
 *    discount RULE, which has nowhere to land.
 *  - VACUITY FLOORS on every population, and a MUTATION SELF-TEST proving each
 *    comparison bites in both directions.
 *
 * #378 is why the second and third bullets read as they do. It made an imported
 * order carry its discount and tax breakdown, which falsified two entries with
 * no provider member changing — the census saw nothing, and the suite caught it
 * only because it happened to assert the two fields were still written as `[]`.
 * Those literals are gone; what defends the claim now is written to survive the
 * next such change rather than to pin one spelling of the current one.
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
// TYPE-ONLY, and every one is erased: these exist so the forbidden-writer map
// below is checked against the real exports rather than against remembered
// spellings. See `RECORD_WRITERS_THE_IMPORT_MUST_NOT_CALL`.
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
    const entity = PROVIDER_ENTITY_MEMBERS[member];
    if (entity !== undefined) reached.add(entity);
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

  it('every never_synced and mapped_membership entry records a reason', () => {
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
 * The exports of every module that can CREATE one of the records these entries
 * say an import never creates.
 *
 * Type-only, so it costs nothing at runtime and buys the thing a source probe
 * cannot buy for itself: the map below is keyed on this union, so a writer that
 * is renamed or deleted fails `tsc` HERE rather than sitting in the list forever
 * matching nothing. That is not hypothetical — the probe this replaces looked
 * for `createRefund`, which names no writer in this repository at all (the only
 * `createRefund*` is a zod schema), so one of its three tokens could never have
 * fired.
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
 * Every writer the import path must not call, paired with the entry it falsifies.
 *
 * `Partial`, because these are a SUBSET of those modules' exports — and the
 * excess-property check under `satisfies` is what refuses a key that is not one
 * of them.
 */
const RECORD_WRITERS_THE_IMPORT_MUST_NOT_CALL = {
  // `discounts` — "the platform's discount rules are not imported".
  createDiscount: 'discounts',
  insertDiscount: 'discounts',
  redeemDiscountCode: 'discounts',
  // `tax_rates` — "the platform's tax rate table is not imported".
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

/** The SQL column names of one drizzle table — `sqlColumnName`, never `.name` (#354). */
function sqlColumnNames(table: Parameters<typeof getTableColumns>[0]): readonly string[] {
  return Object.values(getTableColumns(table)).map((column) => sqlColumnName(column));
}

/** A Shopify `*_set` money field, in the shop currency the fixtures price in. */
function shopMoney(amount: string) {
  return { shop_money: { amount, currency_code: 'EUR' } };
}

/**
 * Column-name segments that would mean the discount RULE is being imported.
 *
 * The breakdown tables hold one discount's APPLICATION to one order — a code, a
 * title and an amount. What makes the entry's "rules are not imported" half true
 * is that the rule's own terms have nowhere to land: no scope, no usage limit,
 * no combinability, no validity window, and no foreign key to a Mercaria
 * discount or tax rate. A column is how that would change, and a column arrives
 * in a migration nobody reads this file while writing.
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

describe('#380 entity coverage — the never_synced claims are probed, not trusted', () => {
  /**
   * The gap the provider census does NOT close, closed here — in the shape #378
   * proved it actually takes.
   *
   * That census catches a provider growing a data path. It cannot catch a claim
   * going false with no new member at all: `buildExternalOrderDoc` began writing
   * `appliedDiscounts` and `taxLines` from data ALREADY reaching a normalized
   * order, and `discounts`/`tax_rates` went on reading `not_built_for_this_channel`
   * on a merchant's screen. This suite caught it, by asserting those two fields
   * were still written as the literal `[]`.
   *
   * That literal is gone, so the assertion cannot be the same one. What replaced
   * it is three checks around the claim that is true NOW — the breakdown arrives
   * on the ORDER and no Mercaria record is created from it:
   *
   *  - the ARRIVAL is MEASURED by running both real normalizers (below), so a
   *    provider that stops carrying a discount makes the entry's second sentence
   *    false and goes red;
   *  - the RULE has nowhere to land, asserted against the real drizzle columns,
   *    which is what a merchant is told when they read that a platform coupon
   *    cannot be redeemed here;
   *  - and no Mercaria `Discount`, `TaxRate`, `Customer`, `Refund` or
   *    `Collection` is created, probed by writer name over the import path.
   *
   * The one thing genuinely NOT replaced: a tripwire on the two fields' contents
   * as such. It fired once, correctly, and this is its resolution. What now
   * guards that behaviour is `connector-contract-suite.ts`, which drives a real
   * order through the real service into a real database and asserts the persisted
   * rows — a stronger check in a better place, and the reason a source literal is
   * not worth re-inventing here.
   */
  it('an imported order still writes NO discount, tax, customer or refund record', () => {
    const { lines, code } = orderImportSource();

    // The floor: an unreadable or renamed module would make every check below
    // pass against an empty string, which is the one failure a source census
    // cannot otherwise report.
    expect(lines.length).toBeGreaterThan(2000);
    expect(code).toContain('function buildExternalOrderDoc');

    for (const [writer, entity] of Object.entries(RECORD_WRITERS_THE_IMPORT_MUST_NOT_CALL)) {
      expect(
        lines.filter((line) => line.includes(writer)),
        `the connector import path now references ${writer}. CHANNEL_ENTITY_POLICY.${entity} ` +
          'says no such Mercaria record is created from an imported order; if one now is, the ' +
          "coverage on a merchant's screen says the opposite of what happens.",
      ).toEqual([]);
    }
  });

  it('the forbidden-writer map covers every entity that claims no record is created', () => {
    // `tsc` already refuses a key that is not a real export (the `satisfies`
    // above). What it cannot check is the other direction: an entity whose entry
    // claims no record is created and that no writer in this map defends, which
    // is how a claim quietly stops being probed at all.
    const defended = new Set(Object.values(RECORD_WRITERS_THE_IMPORT_MUST_NOT_CALL));
    for (const entity of ['discounts', 'tax_rates', 'customers', 'refunds', 'collections'] as const) {
      expect(defended.has(entity), `nothing in the map defends ${entity}'s claim`).toBe(true);
    }
    // The floor: an empty map would satisfy the loop in the probe above.
    expect(Object.keys(RECORD_WRITERS_THE_IMPORT_MUST_NOT_CALL).length).toBeGreaterThanOrEqual(10);
  });

  it('the absence checks can SEE what they are looking for', () => {
    // A negative control needs its own vacuity floor: "X is absent" is also what
    // a scan that read nothing reports. Each of these is known-present in the
    // same file AND of the same shape as the forbidden tokens it controls for —
    // `toAppliedDiscounts`/`toOrderTaxLines` in particular, because the sharpest
    // way this probe could go blind is by failing to see discount- and
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

  it('an imported order carries the discount and tax breakdown it says it carries', () => {
    // The measured half of `imported_only_as_part_of_an_order`: "what appears
    // comes only from the orders that are". Both providers are run for real, on
    // a payload of the shape each platform publishes. If either stops carrying
    // the breakdown, the entry's second sentence is a promise nothing keeps and
    // the reason must go back to an outright absence.
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
            // allocations, pointing back at the application by index.
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
      'Shopify stopped carrying a redeemed discount code onto an imported order. ' +
        'CHANNEL_ENTITY_POLICY.discounts tells a merchant the code arrives on the order.',
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
          { id: 'l1', name: 'A product', quantity: 1, subtotal: '40.00', total: '40.00', meta_data: [] },
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
        shipping_lines: [{ id: 700, method_title: 'Flat rate', method_id: 'flat_rate', total: '5.00' }],
        refunds: [],
      },
      'EUR',
    );
    expect(
      wooOrder.discounts.map((discount) => discount.code),
      'WooCommerce stopped carrying an order coupon onto an imported order.',
    ).toEqual(['contract10']);
    expect(wooOrder.taxLines.map((line) => line.name)).toEqual(['VAT']);

    // And the claim itself, on the descriptors: measured above, stated here.
    for (const channelType of ['shopify', 'woocommerce'] as const) {
      for (const entity of ['discounts', 'tax_rates'] as const) {
        expect(
          describeChannel(channelType).entityCoverage.find((entry) => entry.entity === entity),
          `${channelType}/${entity}`,
        ).toEqual({ entity, state: 'not_synced', reason: 'imported_only_as_part_of_an_order' });
      }
    }
  });

  it('an imported breakdown has nowhere to put a discount RULE', () => {
    // The other half: "the platform's discount rules are not imported and cannot
    // be redeemed at Mercaria checkout". The application is one code, one title
    // and one amount; the rule's own terms — what it applies to, its limits,
    // whether it combines, when it expires — have no column, and neither table
    // points at a Mercaria `discounts` or `tax_rates` row. That is what makes the
    // sentence structural rather than a description of today's mapping code.
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
        // SQL identifiers or the gate is comparing the wrong string (#354).
        expect(column, `${table}.${column} is not a SQL identifier`).toMatch(/^[a-z][a-z0-9_]*$/);
      }
      expect(
        columns.filter((column) =>
          RULE_SHAPED_COLUMN_SEGMENTS.some((segment) => column.includes(segment)),
        ),
        `${table} grew a column describing the discount RULE rather than its application to ` +
          'one order. CHANNEL_ENTITY_POLICY tells a merchant the rules are not imported; if ' +
          'they now are, that entry is what has to change.',
      ).toEqual([]);
      // A pointer INTO Mercaria's own discount or tax rate would mean the record
      // is being created, which the writer probe covers from the other side.
      expect(
        columns.filter((column) => column === 'mercaria_discount_id' || column === 'tax_rate_id'),
        `${table} now points at a Mercaria discount or tax rate.`,
      ).toEqual([]);
    }

    // The application's own fields ARE present, so the check above is refusing a
    // shape rather than reporting an empty table.
    expect(sqlColumnNames(orderAppliedDiscounts)).toContain('code');
    expect(sqlColumnNames(orderAppliedDiscounts)).toContain('discount_id');
    expect(sqlColumnNames(orderTaxLines)).toContain('rate_bps');
  });
});

describe('#380 entity coverage — what a merchant is actually told', () => {
  it('Shopify says discount rules are not synced, and says why', () => {
    // The report this issue exists for. Pinned by name because "discounts are
    // not built" is the sentence that was missing, not an example of one.
    //
    // The reason CHANGED with #378, which is the whole of this pin's value: the
    // rules are still not exchanged, but a redeemed discount's code and amount
    // now arrive on the imported order, so `not_built_for_this_channel` — "we do
    // not exchange this with your platform" — had become false on a screen a
    // merchant reads. It is deliberately NOT `partial`: that state renders the
    // entity under "Syncs" on the channel list, which a merchant would read as
    // their platform's coupons working at Mercaria checkout. They do not, and no
    // Mercaria `Discount` is created for them to.
    const discounts = describeChannel('shopify').entityCoverage.find(
      (entry) => entry.entity === 'discounts',
    );
    expect(discounts).toEqual({
      entity: 'discounts',
      state: 'not_synced',
      reason: 'imported_only_as_part_of_an_order',
    });
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
    const mutated: Record<string, ChannelSyncEntity> = {
      ...PROVIDER_ENTITY_MEMBERS,
      fetchProducts: 'discounts',
    };
    const reached = new Set<ChannelSyncEntity>();
    for (const member of Object.keys(shopifyProvider)) {
      const entity = mutated[member];
      if (entity !== undefined) reached.add(entity);
    }
    const carried = describeChannel('shopify')
      .entityCoverage.filter((entry) => entry.state === 'synced')
      .map((entry) => entry.entity);
    expect([...reached].sort()).not.toEqual(carried.sort());
  });
});
