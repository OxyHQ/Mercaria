import {
  CAPABILITY_KEYS,
  CAPABILITY_VERIFICATIONS,
  capabilityGroupOf,
  capabilityHolds,
  capabilityLabel,
  capabilityValueKind,
  capabilityValueLabel,
  openingStatusAt,
  strongestCapability,
  type CapabilityVerification,
  type Place,
  type PlaceHoursException,
  type PlaceMedia,
} from '@goway.to/sdk';
import type { LocationOpenState } from '@mercaria/shared-types';

/**
 * What the store page's "Visit us" section derives from a GoWay place.
 *
 * Every fact here is the PLACE's (ADR 0013): the storefront reads it from GoWay
 * and only decides how to show it — which weekday rows, which exceptions,
 * which attributes, which photos. Pure, so each decision is tested under the
 * node runner rather than by mounting a component (`vitest.config.ts`, #469).
 *
 * "Open now" is GoWay's own evaluation (`openingStatusAt`), worded through the
 * same `LocationOpenState` the collection surfaces use, so the store page and
 * the nearby list cannot disagree about one door.
 */

/** Monday first: the week as most of the storefront's locales print it. GoWay numbers 0 = Sunday. */
export const VISIT_WEEK = [1, 2, 3, 4, 5, 6, 0] as const;

/** The attribute groups a shopper reads before going: can I get in, and can I pay. */
export const VISIT_ATTRIBUTE_GROUPS = ['accessibility', 'payment'] as const;
export type VisitAttributeGroup = (typeof VISIT_ATTRIBUTE_GROUPS)[number];

/** How many upcoming exceptions the section lists; GoWay's page has the rest. */
export const VISIT_EXCEPTION_LIMIT = 3;

/** The gallery kinds that show the shop itself — not its logo, cover or menu. */
export const VISIT_PHOTO_KINDS = ['photo', 'exterior', 'interior'] as const;

/** How many photos the strip shows. */
export const VISIT_PHOTO_LIMIT = 8;

/** Order a store's locations, the one a `?location=` link named first. */
export function orderLocations<T extends { ref: { id: string } }>(
  locations: readonly T[],
  focusId?: string,
): T[] {
  if (focusId === undefined) return [...locations];
  const focused = locations.filter((location) => location.ref.id === focusId);
  return [...focused, ...locations.filter((location) => location.ref.id !== focusId)];
}

/**
 * The place's address as one line: GoWay's own formatting when it has one,
 * else the parts it publishes, joined. Empty when it publishes none.
 */
export function placeAddressLine(place: Pick<Place, 'address'>): string {
  const address = place.address;
  if (address === undefined) return '';
  if (address.formatted !== undefined && address.formatted.trim() !== '')
    return address.formatted.trim();
  const street = [address.street, address.houseNumber].filter(present).join(' ');
  const town = [address.postalCode, address.city].filter(present).join(' ');
  return [street, address.locality, town, address.region, address.country]
    .filter(present)
    .join(', ');
}

/** Open right now, and when that changes today — GoWay's evaluation, as the shared wording reads it. */
export function placeOpenState(
  place: Pick<Place, 'openingHours' | 'timezone' | 'hoursExceptions'>,
  now: Date,
): LocationOpenState {
  const status = openingStatusAt(place, now);
  if (status.state === 'unknown') return { known: false };
  const changesAt =
    status.nextChange !== undefined && status.nextChange.localDate === status.localDate
      ? status.nextChange.localTime
      : undefined;
  const note = status.exception?.note;
  return {
    known: true,
    open: status.state === 'open',
    ...(changesAt === undefined ? {} : { changesAt }),
    ...(note === undefined ? {} : { exceptionNote: note }),
  };
}

/** One weekday row: the day (0 = Sunday) and its opening spans, `[]` when closed all day. */
export interface WeekdayHours {
  readonly day: number;
  readonly spans: readonly { readonly opens: string; readonly closes: string }[];
}

/**
 * The weekly schedule as seven rows, Monday first, or `null` when the place
 * publishes no weekly hours — which is "not published", never "always closed".
 */
export function weeklyHours(place: Pick<Place, 'openingHours'>): WeekdayHours[] | null {
  const intervals = place.openingHours?.intervals ?? [];
  if (intervals.length === 0) return null;
  return VISIT_WEEK.map((day) => ({
    day,
    spans: intervals
      .filter((interval) => interval.day === day)
      .map((interval) => ({ opens: interval.opens, closes: interval.closes }))
      .sort((left, right) => left.opens.localeCompare(right.opens)),
  }));
}

/**
 * The exceptions that have not ended by `today` (the place's local date),
 * earliest first, at most {@link VISIT_EXCEPTION_LIMIT}.
 *
 * Where two tiers state the same dates, the STRONGER one is shown — the one
 * `openingStatusAt` obeys — so the list never contradicts the open state
 * printed above it.
 */
export function upcomingExceptions(
  place: Pick<Place, 'hoursExceptions'>,
  today: string,
): PlaceHoursException[] {
  const strongest = new Map<string, PlaceHoursException>();
  for (const exception of place.hoursExceptions ?? []) {
    if (exception.endsOn < today) continue;
    const key = `${exception.startsOn}/${exception.endsOn}`;
    const held = strongest.get(key);
    if (held === undefined || tierOf(exception.verification) > tierOf(held.verification)) {
      strongest.set(key, exception);
    }
  }
  return [...strongest.values()]
    .sort((left, right) => left.startsOn.localeCompare(right.startsOn))
    .slice(0, VISIT_EXCEPTION_LIMIT);
}

/** Today in the place's own calendar when GoWay can say, else the UTC date. */
export function placeToday(
  place: Pick<Place, 'openingHours' | 'timezone' | 'hoursExceptions'>,
  now: Date,
): string {
  const status = openingStatusAt(place, now);
  return status.state === 'unknown' ? now.toISOString().slice(0, 10) : status.localDate;
}

/**
 * A `YYYY-MM-DD` calendar date as a `Date` at LOCAL noon, so a date formatter
 * prints the same day in every timezone — UTC midnight would print the day
 * before anywhere west of Greenwich.
 */
export function calendarDate(isoDate: string): Date {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1, 12);
}

/** One attribute a place holds, as GoWay labels it. */
export interface VisitAttribute {
  readonly group: VisitAttributeGroup;
  readonly key: string;
  readonly label: string;
  /** The value's own label, for a key whose value is a choice (`wheelchair: limited`). */
  readonly valueLabel?: string;
}

/**
 * The accessibility and payment attributes the place HAS, by its strongest
 * assertion of each key — GoWay's own rule, so a business saying "no" outranks
 * a community "yes". A key asserted absent (`false`, `wheelchair = no`) is left
 * out rather than shown as a negative chip. Labels are GoWay's registry's, in
 * the locale when GoWay has it and in English otherwise.
 */
export function visitAttributes(
  place: Pick<Place, 'capabilities'>,
  locale: string,
): VisitAttribute[] {
  const attributes: VisitAttribute[] = [];
  for (const key of CAPABILITY_KEYS) {
    const group = capabilityGroupOf(key);
    if (group !== 'accessibility' && group !== 'payment') continue;
    const strongest = strongestCapability(place, key);
    if (strongest === undefined || !capabilityHolds(key, strongest.value)) continue;
    const choice = capabilityValueKind(key) === 'enum' && typeof strongest.value === 'string';
    attributes.push({
      group,
      key,
      label: capabilityLabel(key, locale),
      ...(choice ? { valueLabel: capabilityValueLabel(key, String(strongest.value), locale) } : {}),
    });
  }
  return attributes;
}

/** The photos that show the shop, in the business's order, at most {@link VISIT_PHOTO_LIMIT}. */
export function visitPhotos(media: readonly PlaceMedia[]): PlaceMedia[] {
  const kinds: readonly string[] = VISIT_PHOTO_KINDS;
  return media
    .filter((item) => kinds.includes(item.kind))
    .sort((left, right) => left.position - right.position)
    .slice(0, VISIT_PHOTO_LIMIT);
}

function tierOf(verification: CapabilityVerification): number {
  return CAPABILITY_VERIFICATIONS.indexOf(verification);
}

function present(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}
