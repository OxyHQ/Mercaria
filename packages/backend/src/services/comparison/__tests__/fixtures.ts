/**
 * Fixtures for the comparison and basket suites (#96).
 *
 * Every builder takes an override object and defaults to the SIMPLEST valid
 * value, so a case says only what it is about. The defaults are deliberately
 * "everything known": a scenario about an unknown shipping cost sets one, and a
 * scenario that forgot to would be testing the known path under a misleading
 * name.
 */

import { createHash } from 'node:crypto';
import type {
  ComparisonConstraintColumn,
  ComparisonFactValue,
  ComparisonMoneyFact,
  CurrencyCode,
} from '@mercaria/shared-types';
import type { BasketCandidate } from '../basket/candidates.js';
import { renderMoney } from '../render.js';
import type {
  DeclaredAttribute,
  TableAttributeFact,
  TableCommerceFacts,
  TableSubjectInput,
} from '../table.js';

export const EUR: CurrencyCode = 'EUR';

/** A known money fact in EUR, from minor units. */
export function eur(amountMinor: number): ComparisonMoneyFact {
  const amount = { amount: amountMinor, currency: EUR };
  return { state: 'known', amount, rendered: renderMoney(amount) };
}

/** An unknown money fact, with the reason a caller means. */
export function unknownMoney(
  reason: 'not_published' | 'not_convertible' | 'component_missing' = 'not_published',
): ComparisonMoneyFact {
  return { state: 'unknown', reason };
}

/** A numeric attribute value with its unit. */
export function numberValue(value: number, unit?: string): ComparisonFactValue {
  return {
    type: 'number',
    value,
    ...(unit === undefined ? {} : { unit }),
    rendered: unit === undefined ? String(value) : `${String(value)} ${unit}`,
  };
}

/** One recorded attribute fact. */
export function fact(overrides: Partial<TableAttributeFact> & { key: string }): TableAttributeFact {
  return {
    label: overrides.key,
    definitionVersion: 1,
    state: 'source_backed',
    recordRefs: [`a${overrides.key.length}`],
    value: numberValue(1),
    ...overrides,
  };
}

/** One declared attribute on a subject's category. */
export function declared(overrides: Partial<DeclaredAttribute> = {}): DeclaredAttribute {
  return { label: 'Attribute', definitionVersion: 1, comparable: true, ...overrides };
}

/** A subject's commerce facts, all known by default. */
export function commerce(overrides: Partial<TableCommerceFacts> = {}): TableCommerceFacts {
  return {
    served: true,
    lowestItemPrice: eur(29900),
    lowestKnownTotal: eur(30400),
    availability: ['in_stock'],
    conditionGroups: ['new'],
    deliveryMaxDays: 3,
    merchantCount: 2,
    hasOfficialChannel: false,
    recordRefs: ['o1'],
    ...overrides,
  };
}

/** An empty constraint column — a comparison with no requirements. */
export function noConstraints(subjectRef: string): ComparisonConstraintColumn {
  return {
    subjectRef,
    verdict: 'included',
    satisfied: [],
    failed: [],
    unknown: [],
    notApplicable: [],
  };
}

/** One comparison subject, ready for the table builder. */
export function subject(
  subjectRef: string,
  overrides: Partial<Omit<TableSubjectInput, 'subjectRef'>> = {},
): TableSubjectInput {
  return {
    subjectRef,
    declared: new Map(),
    facts: new Map(),
    commerce: commerce(),
    constraints: noConstraints(subjectRef),
    ...overrides,
  };
}

/** The digest #74 ties on, so a fixture's tie-break matches production's. */
export function tieBreakFor(offerId: string, policyVersion = 'test-policy-v1'): string {
  return createHash('sha256').update(`${policyVersion}:${offerId}`).digest('hex');
}

/** One solver candidate. Known price, known delivery, one merchant. */
export function candidate(
  overrides: Partial<BasketCandidate> & { lineId: string; offerId: string },
): BasketCandidate {
  return {
    subjectRef: 'p1',
    offerRef: `o-${overrides.offerId}`,
    merchantKey: 'm1',
    merchantRef: 'm1',
    merchantLabel: 'Merchant One',
    channel: 'external_merchant',
    unitItemPrice: eur(10000),
    delivery: eur(500),
    deliveryFreeOver: unknownMoney(),
    taxInclusion: 'inclusive',
    freshness: 'current',
    nativeCheckoutEligible: false,
    tieBreak: tieBreakFor(overrides.offerId),
    ...overrides,
  };
}
