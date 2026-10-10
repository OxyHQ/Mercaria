/**
 * The location editor's forms, turned into GoWay inputs — pure, so what is sent
 * is tested without a renderer or a network.
 *
 * The SDK holds every input to GoWay's own contract before sending (a bad
 * capability value, a country code that is not two letters, a latitude outside
 * ±90 are all `GoWayValidationError` with no request made). This module is the
 * part before that: reading text fields into the shapes, and refusing — with a
 * translation key — what a merchant can fix on the form.
 */

import {
  strongestCapability,
  type Place,
  type PlaceCapabilityAssertion,
  type PlaceContact,
  type PlaceCreateInput,
  type PlaceHoursExceptionInput,
  type SearchResult,
} from '@goway.to/sdk';
import { parseRanges } from './hours';

/** The "create a place" form, as text. */
export interface PlaceDraft {
  name: string;
  street: string;
  houseNumber: string;
  postalCode: string;
  city: string;
  region: string;
  countryCode: string;
  latitude: string;
  longitude: string;
}

export const EMPTY_PLACE_DRAFT: PlaceDraft = {
  name: '',
  street: '',
  houseNumber: '',
  postalCode: '',
  city: '',
  region: '',
  countryCode: '',
  latitude: '',
  longitude: '',
};

/**
 * A draft prefilled from a search result that GoWay holds no place for — an
 * address or a street the geocoder found. Its position is GoWay's answer, so a
 * merchant creating the shop there never types a coordinate.
 */
export function draftFromSearchResult(result: SearchResult, name: string): PlaceDraft {
  const address = result.address ?? {};
  return {
    name,
    street: address.street ?? '',
    houseNumber: address.houseNumber ?? '',
    postalCode: address.postalCode ?? '',
    city: address.city ?? result.context?.city ?? '',
    region: address.region ?? result.context?.region ?? '',
    countryCode: address.countryCode ?? result.context?.countryCode ?? '',
    latitude: String(result.coordinate.latitude),
    longitude: String(result.coordinate.longitude),
  };
}

function nonEmpty(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * The `places.create` body a draft says, or the key of the first thing wrong.
 *
 * A country is required here although GoWay does not require one: Mercaria
 * cannot describe a collection point with no country (the trust rule reports
 * `place_country_missing`), so a place created FROM Mercaria carries one.
 */
export function placeCreateInputOf(
  draft: PlaceDraft,
): { ok: true; input: PlaceCreateInput } | { ok: false; errorKey: string } {
  const name = nonEmpty(draft.name);
  if (name === undefined)
    return { ok: false, errorKey: 'settings.locations.editor.create.nameRequired' };

  const countryCode = nonEmpty(draft.countryCode);
  if (countryCode === undefined || !/^[A-Za-z]{2}$/.test(countryCode)) {
    return { ok: false, errorKey: 'settings.locations.editor.create.countryRequired' };
  }

  const latitude = Number(draft.latitude.trim());
  const longitude = Number(draft.longitude.trim());
  if (
    draft.latitude.trim() === '' ||
    draft.longitude.trim() === '' ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180 ||
    (latitude === 0 && longitude === 0)
  ) {
    return { ok: false, errorKey: 'settings.locations.editor.create.positionRequired' };
  }

  const street = nonEmpty(draft.street);
  const houseNumber = nonEmpty(draft.houseNumber);
  const postalCode = nonEmpty(draft.postalCode);
  const city = nonEmpty(draft.city);
  const region = nonEmpty(draft.region);
  return {
    ok: true,
    input: {
      name,
      location: { latitude, longitude },
      address: {
        ...(street === undefined ? {} : { street }),
        ...(houseNumber === undefined ? {} : { houseNumber }),
        ...(postalCode === undefined ? {} : { postalCode }),
        ...(city === undefined ? {} : { city }),
        ...(region === undefined ? {} : { region }),
        countryCode: countryCode.toUpperCase(),
      },
    },
  };
}

/** The contact form, as text. */
export interface ContactDraft {
  phone: string;
  email: string;
  website: string;
}

export function contactDraftOf(contact: PlaceContact | undefined): ContactDraft {
  return {
    phone: contact?.phone ?? '',
    email: contact?.email ?? '',
    website: contact?.website ?? '',
  };
}

/** The `contact` part of a GoWay merge patch: absent leaves a part alone, `null` clears it. */
export type ContactPatch = {
  phone?: string | null;
  email?: string | null;
  website?: string | null;
};

/**
 * The `contact` update a draft says, as a merge patch (`PATCH /places/{id}`).
 *
 * A filled field is sent; a field the merchant EMPTIED — the place has a value
 * and the draft no longer does — is sent as `null`, which clears it on GoWay; a
 * field that was empty and still is, is not sent at all. The editor says
 * beside the fields that emptying one removes it.
 */
export function contactInputOf(
  draft: ContactDraft,
  current?: PlaceContact,
): { ok: true; contact: ContactPatch } | { ok: false; errorKey: string } {
  const website = nonEmpty(draft.website);
  if (website !== undefined && !/^https?:\/\//i.test(website)) {
    return { ok: false, errorKey: 'settings.locations.editor.contact.websiteInvalid' };
  }
  const email = nonEmpty(draft.email);
  if (email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, errorKey: 'settings.locations.editor.contact.emailInvalid' };
  }
  const phone = nonEmpty(draft.phone);
  const part = (key: keyof ContactDraft, value: string | undefined): ContactPatch => {
    const patch: ContactPatch = {};
    const held = current?.[key];
    if (value !== undefined) patch[key] = value;
    else if (typeof held === 'string' && held.trim() !== '') patch[key] = null;
    return patch;
  };
  return {
    ok: true,
    contact: { ...part('phone', phone), ...part('email', email), ...part('website', website) },
  };
}

/** The four GoWay accessibility flags that absorbed Mercaria's own four, in display order. */
export const ACCESSIBILITY_FLAGS = [
  'accessibility.step_free_entrance',
  'accessibility.toilets_wheelchair',
  'accessibility.parking_accessible',
  'accessibility.hearing_loop',
] as const;

export type AccessibilityFlag = (typeof ACCESSIBILITY_FLAGS)[number];

/** The three-valued wheelchair key GoWay reads from OpenStreetMap. */
export const WHEELCHAIR_KEY = 'accessibility.wheelchair' as const;

/** What the editor shows per key: the place's strongest assertion, or none. */
export type FlagChoice = 'yes' | 'no' | 'unset';
export type WheelchairChoice = 'yes' | 'limited' | 'no' | 'unset';

export interface AccessibilityChoices {
  flags: Record<AccessibilityFlag, FlagChoice>;
  wheelchair: WheelchairChoice;
}

export const ACCESSIBILITY_FLAG_LABEL_KEYS: Record<AccessibilityFlag, string> = {
  'accessibility.step_free_entrance': 'settings.locations.editor.accessibility.stepFree',
  'accessibility.toilets_wheelchair': 'settings.locations.editor.accessibility.toilet',
  'accessibility.parking_accessible': 'settings.locations.editor.accessibility.parking',
  'accessibility.hearing_loop': 'settings.locations.editor.accessibility.hearingLoop',
};

/** The choices a place's strongest assertions add up to. */
export function accessibilityChoicesOf(place: Pick<Place, 'capabilities'>): AccessibilityChoices {
  const flags = {} as Record<AccessibilityFlag, FlagChoice>;
  for (const key of ACCESSIBILITY_FLAGS) {
    const strongest = strongestCapability(place, key);
    flags[key] = strongest === undefined ? 'unset' : strongest.value === true ? 'yes' : 'no';
  }
  const wheelchair = strongestCapability(place, WHEELCHAIR_KEY);
  const value = wheelchair?.value;
  return {
    flags,
    wheelchair: value === 'yes' || value === 'limited' || value === 'no' ? value : 'unset',
  };
}

/** One write the accessibility form needs: assert a value, or withdraw the business's own. */
export type CapabilityOperation =
  | {
      kind: 'put';
      key: AccessibilityFlag | typeof WHEELCHAIR_KEY;
      assertion: PlaceCapabilityAssertion;
    }
  | { kind: 'delete'; key: AccessibilityFlag | typeof WHEELCHAIR_KEY };

/**
 * The writes that take a place from `current` to `desired`, and only those —
 * an untouched key is not re-asserted, so saving the form does not refresh a
 * claim nobody re-checked. `unset` withdraws the business's own assertion; a
 * community report beside it stays, which GoWay decides and the editor says.
 */
export function accessibilityOperations(
  current: AccessibilityChoices,
  desired: AccessibilityChoices,
): CapabilityOperation[] {
  const operations: CapabilityOperation[] = [];
  for (const key of ACCESSIBILITY_FLAGS) {
    const next = desired.flags[key];
    if (next === current.flags[key]) continue;
    operations.push(
      next === 'unset'
        ? { kind: 'delete', key }
        : { kind: 'put', key, assertion: { value: next === 'yes' } },
    );
  }
  if (desired.wheelchair !== current.wheelchair) {
    operations.push(
      desired.wheelchair === 'unset'
        ? { kind: 'delete', key: WHEELCHAIR_KEY }
        : { kind: 'put', key: WHEELCHAIR_KEY, assertion: { value: desired.wheelchair } },
    );
  }
  return operations;
}

/** The "add an exception" form, as text. */
export interface ExceptionDraft {
  startsOn: string;
  endsOn: string;
  closed: boolean;
  hours: string;
  note: string;
}

export const EMPTY_EXCEPTION_DRAFT: ExceptionDraft = {
  startsOn: '',
  endsOn: '',
  closed: true,
  hours: '',
  note: '',
};

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The `hoursExceptions.create` body a draft says, or the key of the first thing
 * wrong. Dates are the shop's own calendar (`YYYY-MM-DD`); an open exception
 * needs its hours, a closed one has none.
 */
export function hoursExceptionInputOf(
  draft: ExceptionDraft,
): { ok: true; input: PlaceHoursExceptionInput } | { ok: false; errorKey: string } {
  const startsOn = draft.startsOn.trim();
  const endsOn = draft.endsOn.trim() === '' ? startsOn : draft.endsOn.trim();
  if (!LOCAL_DATE.test(startsOn) || !LOCAL_DATE.test(endsOn)) {
    return { ok: false, errorKey: 'settings.locations.editor.exceptions.datesInvalid' };
  }
  if (endsOn < startsOn)
    return { ok: false, errorKey: 'settings.locations.editor.exceptions.datesInvalid' };
  const note = nonEmpty(draft.note);
  if (draft.closed) {
    return {
      ok: true,
      input: { startsOn, endsOn, closed: true, ...(note === undefined ? {} : { note }) },
    };
  }
  const intervals = parseRanges(draft.hours);
  if (intervals === null || intervals.length === 0) {
    return { ok: false, errorKey: 'settings.locations.editor.exceptions.hoursInvalid' };
  }
  return {
    ok: true,
    input: { startsOn, endsOn, closed: false, intervals, ...(note === undefined ? {} : { note }) },
  };
}
