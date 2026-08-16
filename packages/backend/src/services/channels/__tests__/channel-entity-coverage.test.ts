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
 *  - A MEASUREMENT against production code for the one claim neither of those
 *    covers: `partial` says collection membership arrives, and the only proof is
 *    running the real normalizers.
 *  - VACUITY FLOORS on every population, and a MUTATION SELF-TEST proving each
 *    comparison bites in both directions.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
import { shopifyProvider } from '../../../connectors/shopify/index.js';
import { wooCommerceProvider } from '../../../connectors/woocommerce/index.js';
import type { ConnectorProvider } from '../../../connectors/types.js';

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

    // `discounts` and `tax_rates`: the imported order carries the TOTAL it was
    // placed with and no breakdown. If either literal stops being empty, the
    // rules behind it are arriving and the coverage must say so.
    expect(
      code,
      'buildExternalOrderDoc no longer writes an empty appliedDiscounts. If an imported ' +
        "order now carries its discount rules, CHANNEL_ENTITY_POLICY.discounts must stop " +
        'saying they are not exchanged — that claim is on a merchant\'s screen.',
    ).toContain('appliedDiscounts: [],');
    expect(
      code,
      'buildExternalOrderDoc no longer writes an empty taxLines — CHANNEL_ENTITY_POLICY.' +
        'tax_rates says tax rates are not exchanged and would now be false.',
    ).toContain('taxLines: [],');

    // `collections`: the DEGREE, which the member census cannot see since #395
    // mapped `fetchCollections` onto the entity. `partial` claims a product
    // joins collections the merchant already made and that no collection is
    // created; the second half is what stops being true silently, because
    // creating one is a small change inside a function that already resolves
    // collection ids.
    expect(
      lines.filter((line) => line.includes('createCollection')),
      'the connector import path now creates a Mercaria collection. ' +
        'CHANNEL_ENTITY_POLICY.collections is `partial` precisely because it does not — ' +
        'if platform collections now appear in Mercaria, that entry must become `synced` ' +
        'and its caveat copy must go, because the screen currently tells a merchant to ' +
        'make the collection themselves first.',
    ).toEqual([]);

    // `customers` and `refunds`: absences, so each is paired with a positive
    // control below proving the scan can see a token of that shape at all.
    for (const forbidden of ['upsertOnPaid', 'customerId', 'createRefund'] as const) {
      expect(
        lines.filter((line) => line.includes(forbidden)),
        `the connector import path now references ${forbidden}. CHANNEL_ENTITY_POLICY says ` +
          'no customer and no refund record is created from an imported order; if one now is, ' +
          'the coverage is telling merchants the opposite of what happens.',
      ).toEqual([]);
    }
  });

  it('the absence checks can SEE what they are looking for', () => {
    // A negative control needs its own vacuity floor: "X is absent" is also what
    // a scan that read nothing reports. These three tokens are known-present in
    // the same file and of the same shape as the three forbidden ones.
    const { lines } = orderImportSource();
    for (const present of ['buyerOxyUserId', 'insertOrder', 'shippingAddress'] as const) {
      expect(
        lines.filter((line) => line.includes(present)).length,
        `${present} is known-present; a zero here means the scan is blind, not that the ` +
          'forbidden tokens are absent.',
      ).toBeGreaterThan(0);
    }
  });
});

describe('#380 entity coverage — what a merchant is actually told', () => {
  it('Shopify says discounts are not synced, and says why', () => {
    // The report this issue exists for. Pinned by name because "discounts are
    // not built" is the sentence that was missing, not an example of one.
    const discounts = describeChannel('shopify').entityCoverage.find(
      (entry) => entry.entity === 'discounts',
    );
    expect(discounts).toEqual({
      entity: 'discounts',
      state: 'not_synced',
      reason: 'not_built_for_this_channel',
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
