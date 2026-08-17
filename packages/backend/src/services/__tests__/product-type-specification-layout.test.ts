/**
 * `deriveSpecificationLayout` — the PUBLIC grouping of a specification table
 * (#367 step 3, ADR 0007 D5).
 *
 * Pure, so it is tested without a server. What the cases are actually about:
 *
 * - **A cross-flow disagreement places NOTHING.** `product_type_fields` rows are
 *   per authoring flow and nothing in the schema pins `group_id` across them (the
 *   citation trigger pins `variant_capable`, which is a different column). So one
 *   attribute can be in "Display" on the merchant form and ungrouped on the P2P
 *   one, and picking either would make a shopper's spec table a function of which
 *   flow the read happened to see first. Both halves are asserted: it is reported
 *   as conflicting, and it is reported as unplaced.
 * - **An empty group is still emitted.** Dropping it makes "this type declares no
 *   battery attributes" indistinguishable from "no such group exists", and whether
 *   to render a heading with no rows is a display decision.
 * - **A public layout carries no authoring fact.** The two-gate rule: the static
 *   half is the DTO's own shape, and this is the runtime walk of a real emitted
 *   layout for the five fields `PUBLIC_PRODUCT_TYPE_FORBIDDEN_LAYOUT_FIELDS` names.
 */

import { describe, expect, it } from 'vitest';
import { PUBLIC_PRODUCT_TYPE_FORBIDDEN_LAYOUT_FIELDS } from '@mercaria/shared-types';
import { deriveSpecificationLayout } from '../product-types/product-type.service.js';
import type { ProductTypeDefinitionRow } from '../../db/productTypes/productTypeRepository.js';
import type {
  ProductTypeFieldGroupRow,
  ProductTypeFieldRow,
} from '../../db/productTypes/productTypeFieldRepository.js';

const NOW = new Date('2026-02-01T00:00:00.000Z');

const DEFINITION: ProductTypeDefinitionRow = {
  id: 'ptd_1',
  key: 'smartphone',
  version: 3,
  lifecycle: 'published',
  name: 'Smartphone',
  description: null,
  pendingProposalPolicy: 'block_publication',
  createdByOxyUserId: null,
  publishedByOxyUserId: 'oxy_1',
  publishedAt: NOW,
  deprecatedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

function group(
  id: string,
  key: string,
  label: string,
  position: number,
): ProductTypeFieldGroupRow {
  return {
    id,
    productTypeDefinitionId: DEFINITION.id,
    key,
    label,
    position,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function field(
  attributeKey: string,
  groupId: string | null,
  flow: ProductTypeFieldRow['flow'],
  position: number,
): ProductTypeFieldRow {
  return {
    id: `ptf_${attributeKey}_${flow}`,
    productTypeDefinitionId: DEFINITION.id,
    groupId,
    attributeDefinitionId: `ad_${attributeKey}`,
    attributeKey,
    attributeDefinitionVersion: 1,
    scope: 'product',
    flow,
    requirement: 'recommended',
    valuePolicy: 'typed_scalar',
    variantCapable: false,
    position,
    visibilityRule: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const DISPLAY = group('g_display', 'display', 'Display', 0);
const BATTERY = group('g_battery', 'battery', 'Battery', 1);

describe('the specification layout places what every flow agrees about', () => {
  it('groups an attribute both flows put in the same group', () => {
    const layout = deriveSpecificationLayout(
      DEFINITION,
      [DISPLAY, BATTERY],
      [
        field('screen_size', DISPLAY.id, 'merchant', 0),
        field('screen_size', DISPLAY.id, 'p2p', 0),
        field('battery_capacity', BATTERY.id, 'merchant', 1),
      ],
    );
    expect(layout.productTypeKey).toBe('smartphone');
    expect(layout.version).toBe(3);
    expect(layout.groups.map((entry) => entry.key)).toEqual(['display', 'battery']);
    expect(layout.groups[0]?.attributeKeys).toEqual(['screen_size']);
    expect(layout.groups[1]?.attributeKeys).toEqual(['battery_capacity']);
    expect(layout.ungroupedAttributeKeys).toEqual([]);
    expect(layout.conflictingAttributeKeys).toEqual([]);
  });

  it('emits a group nothing is in — an empty section is a fact about the schema', () => {
    const layout = deriveSpecificationLayout(
      DEFINITION,
      [DISPLAY, BATTERY],
      [field('screen_size', DISPLAY.id, 'merchant', 0)],
    );
    expect(layout.groups.map((entry) => entry.key)).toEqual(['display', 'battery']);
    expect(layout.groups[1]?.attributeKeys).toEqual([]);
  });

  it('leaves an attribute no flow grouped ungrouped, and does NOT call it a conflict', () => {
    const layout = deriveSpecificationLayout(
      DEFINITION,
      [DISPLAY],
      [field('warranty_months', null, 'merchant', 0), field('warranty_months', null, 'p2p', 0)],
    );
    expect(layout.ungroupedAttributeKeys).toEqual(['warranty_months']);
    // Every flow agrees it belongs nowhere. That is agreement, not disagreement,
    // and reporting it as a conflict would send somebody looking for a
    // contradiction that is not there.
    expect(layout.conflictingAttributeKeys).toEqual([]);
  });

  it('orders keys inside a group by the version’s own layout position', () => {
    const layout = deriveSpecificationLayout(
      DEFINITION,
      [DISPLAY],
      [
        field('refresh_rate', DISPLAY.id, 'merchant', 5),
        field('screen_size', DISPLAY.id, 'merchant', 1),
        field('panel_type', DISPLAY.id, 'merchant', 3),
      ],
    );
    expect(layout.groups[0]?.attributeKeys).toEqual([
      'screen_size',
      'panel_type',
      'refresh_rate',
    ]);
  });

  it('breaks a shared position by attribute key rather than by row order', () => {
    // Two flows can state the same position, and without a deterministic tiebreak
    // the rendered order would be whichever row the planner returned first.
    const ascending = deriveSpecificationLayout(
      DEFINITION,
      [DISPLAY],
      [field('alpha', DISPLAY.id, 'merchant', 2), field('beta', DISPLAY.id, 'p2p', 2)],
    );
    const descending = deriveSpecificationLayout(
      DEFINITION,
      [DISPLAY],
      [field('beta', DISPLAY.id, 'p2p', 2), field('alpha', DISPLAY.id, 'merchant', 2)],
    );
    expect(ascending.groups[0]?.attributeKeys).toEqual(['alpha', 'beta']);
    expect(descending.groups[0]?.attributeKeys).toEqual(ascending.groups[0]?.attributeKeys);
  });
});

describe('a cross-flow disagreement is reported and never resolved', () => {
  it('places nothing when two flows name different groups', () => {
    const layout = deriveSpecificationLayout(
      DEFINITION,
      [DISPLAY, BATTERY],
      [
        field('standby_time', DISPLAY.id, 'merchant', 0),
        field('standby_time', BATTERY.id, 'p2p', 0),
      ],
    );
    expect(layout.conflictingAttributeKeys).toEqual(['standby_time']);
    expect(layout.ungroupedAttributeKeys).toEqual(['standby_time']);
    // Both groups are empty: picking either would be choosing the flow that was
    // read first, and a shopper cannot see which one that was.
    expect(layout.groups.every((entry) => entry.attributeKeys.length === 0)).toBe(true);
  });

  it('treats grouped-versus-ungrouped as a disagreement too', () => {
    // "This belongs in Display" and "this belongs nowhere" are two different
    // statements about one attribute. Resolving toward the group would let the P2P
    // form's deliberately shorter list silently decide the merchant form's layout.
    const layout = deriveSpecificationLayout(
      DEFINITION,
      [DISPLAY],
      [field('hdr', DISPLAY.id, 'merchant', 0), field('hdr', null, 'p2p', 0)],
    );
    expect(layout.conflictingAttributeKeys).toEqual(['hdr']);
    expect(layout.groups[0]?.attributeKeys).toEqual([]);
  });

  it('a conflict on one attribute does not unplace an agreed one', () => {
    const layout = deriveSpecificationLayout(
      DEFINITION,
      [DISPLAY, BATTERY],
      [
        field('screen_size', DISPLAY.id, 'merchant', 0),
        field('screen_size', DISPLAY.id, 'p2p', 0),
        field('standby_time', DISPLAY.id, 'merchant', 1),
        field('standby_time', BATTERY.id, 'p2p', 1),
      ],
    );
    expect(layout.groups[0]?.attributeKeys).toEqual(['screen_size']);
    expect(layout.conflictingAttributeKeys).toEqual(['standby_time']);
  });
});

describe('the public layout carries no authoring fact — the runtime half', () => {
  it('emits none of the five forbidden fields, at any depth', () => {
    const layout = deriveSpecificationLayout(
      DEFINITION,
      [DISPLAY, BATTERY],
      [
        field('screen_size', DISPLAY.id, 'merchant', 0),
        field('battery_capacity', BATTERY.id, 'p2p', 1),
        field('warranty_months', null, 'operator', 2),
      ],
    );

    const keys = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const entry of value) walk(entry);
        return;
      }
      if (value !== null && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
          keys.add(key);
          walk(child);
        }
      }
    };
    walk(layout);

    // The positive control FIRST: a walk over an empty layout would satisfy every
    // assertion below, so the emitted object has to be a real one.
    expect(keys.size, `walked ${String(keys.size)} key(s)`).toBeGreaterThanOrEqual(8);
    expect(layout.groups.length).toBe(2);
    expect(PUBLIC_PRODUCT_TYPE_FORBIDDEN_LAYOUT_FIELDS.length).toBe(5);
    for (const forbidden of PUBLIC_PRODUCT_TYPE_FORBIDDEN_LAYOUT_FIELDS) {
      expect([...keys], `the layout carries the authoring fact \`${forbidden}\``).not.toContain(
        forbidden,
      );
    }
    // And the mutation self-test for the walk itself: it must find a key that IS
    // there, or the loop above passes by walking nothing.
    expect([...keys]).toContain('attributeKeys');
    expect([...keys]).toContain('conflictingAttributeKeys');
  });
});
