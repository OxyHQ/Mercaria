/**
 * The mapping engine — a merchant's row becomes a `NormalizedSourceRecord`, or
 * an isolated failure (#63 §"Feed configuration" 6/8, processing 2/3/4).
 *
 * ## Validation happens BEFORE normalization, and produces a value
 *
 * Issue processing 2 asks for exactly that ordering and the reason is what the
 * two layers can each see: this function knows which COLUMN a value came from
 * and can say "column `precio` is not a number", where
 * `canonicalizeNormalizedRecord` sees a record with a missing price and can only
 * drop it. So the refusals a merchant can act on are composed here, and #62's
 * normalizer stays the last, format-blind bound on everything that gets past
 * them.
 *
 * ## A failure is a RECORD failure, never a feed failure
 *
 * Every path below returns issues; none throws. A row with an unparseable price
 * yields a record with no price and a warning; a row with no title yields no
 * record and an error. That is issue processing 3 ("preserve source strings and
 * record-level errors") as a signature: there is no exception for a caller to
 * catch and turn into a page-level abort, so a page cannot die on its worst row
 * and leave the cursor stuck there forever.
 *
 * ## Nothing here evaluates anything
 *
 * A role's value is a COLUMN LOOKUP or a CONSTANT, optionally passed through one
 * of ten total transforms. There is no expression evaluator, no template
 * renderer and no pattern engine in this file or reachable from it, which
 * `feed-import-isolation.test.ts` asserts by scanning for the shapes one would
 * take (`eval`, `new Function`, `vm`, a template library) with a mutation
 * self-test on every detector.
 */

import type {
  FeedFieldMapping,
  FeedFieldRole,
  FeedFieldTransform,
  FeedRecordIssue,
  NormalizedIdentifierScheme,
  NormalizedSourceIdentifier,
  NormalizedSourceMoney,
  NormalizedSourceOption,
  NormalizedSourceRecord,
  OfferAvailability,
} from '@mercaria/shared-types';
import { OFFER_AVAILABILITY_STATES } from '@mercaria/shared-types';
import { deriveFeedExternalId } from './external-id.js';
import { parseFeedMoney } from './money.js';
import { applyFeedTransform, readsMinorUnits } from './transforms.js';
import { MALFORMED_RECORD_FIELD, type FeedRawRecord } from './parse/index.js';

/** One active mapping version, in the shape the engine reads it. */
export interface ResolvedFeedMapping {
  readonly fieldMappings: ReadonlyMap<FeedFieldRole, FeedFieldMapping>;
  /** Keyed `${role}:${lower-cased source value}`, which is how the row is stored. */
  readonly valueMappings: ReadonlyMap<string, string>;
  /** The feed's own key columns. FROZEN on the configuration, never on a version. */
  readonly identityKeyFields: readonly string[];
  readonly listSeparator: string;
  readonly defaultCurrency: string | null;
  readonly defaultCountry: string | null;
  readonly defaultLanguage: string | null;
}

/** What one row became. `normalized` is `null` exactly when an ERROR was raised. */
export interface MappedFeedRecord {
  readonly index: number;
  readonly externalId: string | null;
  readonly normalized: NormalizedSourceRecord | null;
  readonly issues: readonly FeedRecordIssue[];
  /** The feed's own values for the MAPPED columns only — what a preview renders. */
  readonly sourceValues: ReadonlyMap<string, string>;
  readonly sourceUpdatedAt: Date | null;
}

/** Bounds mirroring #62's normalizer, so a truncation is REPORTED before it happens. */
const TITLE_LIMIT = 512;
const DESCRIPTION_LIMIT = 4_000;

/** Which identifier scheme each identifier role asserts. */
const IDENTIFIER_ROLE_SCHEME: Readonly<Record<string, NormalizedIdentifierScheme>> = {
  gtin: 'gtin',
  ean: 'ean',
  upc: 'upc',
  isbn: 'isbn',
  mpn: 'mpn',
};

/** The lengths a numeric identifier may have. A check DIGIT is #58's business. */
const NUMERIC_IDENTIFIER_LENGTHS: Readonly<Record<string, readonly number[]>> = {
  gtin: [8, 12, 13, 14],
  ean: [8, 13],
  upc: [12],
  isbn: [10, 13],
};

/** The words a feed writes for each availability state, before any value mapping. */
const AVAILABILITY_SYNONYMS: Readonly<Record<string, OfferAvailability>> = {
  in_stock: 'in_stock',
  instock: 'in_stock',
  'in stock': 'in_stock',
  available: 'in_stock',
  out_of_stock: 'out_of_stock',
  outofstock: 'out_of_stock',
  'out of stock': 'out_of_stock',
  sold_out: 'out_of_stock',
  'sold out': 'out_of_stock',
  preorder: 'preorder',
  'pre-order': 'preorder',
  'pre order': 'preorder',
  unavailable: 'unavailable',
  discontinued: 'unavailable',
};

/**
 * Map one raw record.
 *
 * The external id is derived FIRST, because every issue this function raises
 * cites it and a report entry with no external id is one a merchant can only
 * locate by counting rows.
 */
export function mapFeedRecord(
  record: FeedRawRecord,
  mapping: ResolvedFeedMapping,
): MappedFeedRecord {
  const issues: FeedRecordIssue[] = [];
  const sourceValues = new Map<string, string>();

  if (record.fields.has(MALFORMED_RECORD_FIELD)) {
    issues.push({ code: 'malformed_record', severity: 'error', recordIndex: record.index });
    return {
      index: record.index,
      externalId: null,
      normalized: null,
      issues,
      sourceValues,
      sourceUpdatedAt: null,
    };
  }

  const identity = deriveFeedExternalId(record.fields, mapping.identityKeyFields);
  if (identity.kind === 'incomplete') {
    issues.push({
      code: 'missing_required_field',
      severity: 'error',
      recordIndex: record.index,
      sourceField: identity.failure.missingField,
    });
    return {
      index: record.index,
      externalId: null,
      normalized: null,
      issues,
      sourceValues,
      sourceUpdatedAt: null,
    };
  }
  const externalId = identity.externalId;
  for (const field of mapping.identityKeyFields) {
    const value = record.fields.get(field);
    if (value !== undefined) sourceValues.set(field, value);
  }

  /** Read one role's value, recording what the feed said for the preview. */
  function read(role: FeedFieldRole): string | null {
    const instruction = mapping.fieldMappings.get(role);
    if (instruction === undefined) return null;
    if (instruction.constantValue !== undefined) return instruction.constantValue;
    const field = instruction.sourceField;
    if (field === undefined) return null;
    const raw = record.fields.get(field);
    if (raw === undefined || raw.trim() === '') return null;
    sourceValues.set(field, raw);
    const transform: FeedFieldTransform | undefined = instruction.transform;
    return transform === undefined
      ? raw.trim()
      : applyFeedTransform(raw, transform, mapping.listSeparator);
  }

  function sourceFieldOf(role: FeedFieldRole): string | undefined {
    return mapping.fieldMappings.get(role)?.sourceField;
  }

  function raise(
    code: FeedRecordIssue['code'],
    severity: FeedRecordIssue['severity'],
    role: FeedFieldRole,
    token?: string,
  ): void {
    issues.push({
      code,
      severity,
      recordIndex: record.index,
      role,
      externalId,
      ...(sourceFieldOf(role) === undefined ? {} : { sourceField: sourceFieldOf(role) }),
      ...(token === undefined ? {} : { observedToken: token }),
    });
  }

  const title = read('title');
  if (title === null) {
    issues.push({
      code: 'missing_required_field',
      severity: 'error',
      recordIndex: record.index,
      role: 'title',
      externalId,
      ...(sourceFieldOf('title') === undefined ? {} : { sourceField: sourceFieldOf('title') }),
    });
    return {
      index: record.index,
      externalId,
      normalized: null,
      issues,
      sourceValues,
      sourceUpdatedAt: null,
    };
  }
  if (title.length > TITLE_LIMIT) raise('value_too_long', 'warning', 'title');

  const description = read('description');
  if (description !== null && description.length > DESCRIPTION_LIMIT) {
    raise('value_too_long', 'warning', 'description');
  }

  const price = readMoney('price', 'price_currency');
  const salePrice = readMoney('sale_price', 'sale_price_currency');
  const deliveryCost = readMoney('delivery_cost', 'delivery_cost_currency');

  function readMoney(
    amountRole: FeedFieldRole,
    currencyRole: FeedFieldRole,
  ): NormalizedSourceMoney | undefined {
    const amountText = read(amountRole);
    if (amountText === null) return undefined;
    const parsed = parseFeedMoney({
      amountText,
      currencyText: read(currencyRole),
      defaultCurrency: mapping.defaultCurrency,
      minorUnits: readsMinorUnits(mapping.fieldMappings.get(amountRole)?.transform ?? null),
    });
    if (parsed.kind === 'money') return parsed.money;
    raise(parsed.failure, 'warning', amountRole, parsed.token);
    return undefined;
  }

  const identifiers: NormalizedSourceIdentifier[] = [];
  for (const [role, scheme] of Object.entries(IDENTIFIER_ROLE_SCHEME)) {
    const value = read(role as FeedFieldRole);
    if (value === null) continue;
    const normalized = value.replace(/[\s-]/gu, '').toUpperCase();
    if (normalized === '' || normalized.length > 64) {
      raise('invalid_identifier', 'warning', role as FeedFieldRole);
      continue;
    }
    const lengths = NUMERIC_IDENTIFIER_LENGTHS[scheme];
    if (lengths !== undefined) {
      const digitsOnly = scheme === 'isbn' ? normalized.replace(/X$/u, '0') : normalized;
      if (!/^\d+$/u.test(digitsOnly) || !lengths.includes(normalized.length)) {
        raise('invalid_identifier', 'warning', role as FeedFieldRole);
        continue;
      }
    }
    identifiers.push({ scheme, value: normalized });
  }

  const options: NormalizedSourceOption[] = [];
  for (const slot of [1, 2, 3] as const) {
    const name = read(`option_name_${slot}` as FeedFieldRole);
    const value = read(`option_value_${slot}` as FeedFieldRole);
    if (name === null || value === null) continue;
    options.push({ name, value });
  }

  const media: string[] = [];
  for (const role of ['image', 'additional_images'] as const) {
    const value = read(role);
    if (value === null) continue;
    for (const candidate of value.split(mapping.listSeparator)) {
      const url = readUrl(candidate.trim());
      if (url === null) {
        if (candidate.trim() !== '') raise('invalid_url', 'warning', role);
        continue;
      }
      media.push(url);
    }
  }

  const destinationUrl = readUrlRole('destination_url');
  const affiliateUrl = readUrlRole('affiliate_url');

  function readUrlRole(role: FeedFieldRole): string | undefined {
    const value = read(role);
    if (value === null) return undefined;
    const url = readUrl(value);
    if (url === null) {
      raise('invalid_url', 'warning', role);
      return undefined;
    }
    return url;
  }

  const availability = readAvailability();

  function readAvailability(): OfferAvailability | undefined {
    const value = read('availability');
    if (value === null) return undefined;
    const key = value.trim().toLowerCase();
    const mapped = mapping.valueMappings.get(`availability:${key}`);
    if (mapped !== undefined && isAvailability(mapped)) return mapped;
    const synonym = AVAILABILITY_SYNONYMS[key];
    if (synonym !== undefined) return synonym;
    // The token is drawn from a closed external vocabulary, which is why it may
    // be carried into the report at all (`FEED_TOKEN_BEARING_ISSUE_CODES`).
    raise('unknown_availability', 'warning', 'availability', boundToken(key));
    return undefined;
  }

  const conditionLabel = readCondition();

  function readCondition(): string | undefined {
    const value = read('condition');
    if (value === null) return undefined;
    const key = value.trim().toLowerCase();
    const mapped = mapping.valueMappings.get(`condition:${key}`);
    if (mapped !== undefined) return mapped;
    // The label is stored VERBATIM either way — #90 owns the condition
    // taxonomy and this importer never decides one. The warning fires only
    // when the merchant configured a translation table and this row's word is
    // not in it, which is a statement about THEIR mapping and not about
    // Mercaria's vocabulary.
    if (hasValueMappingsFor('condition', mapping)) {
      raise('unknown_condition', 'warning', 'condition', boundToken(key));
    }
    return value;
  }

  const availableQuantity = readInteger('available_quantity');
  const deliveryMinDays = readInteger('delivery_min_days');
  const deliveryMaxDays = readInteger('delivery_max_days');
  const returnWindowDays = readInteger('return_window_days');

  function readInteger(role: FeedFieldRole): number | undefined {
    const value = read(role);
    if (value === null) return undefined;
    const parsed = Number.parseInt(value.replace(/[\s,._]/gu, ''), 10);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      raise('unparseable_number', 'warning', role);
      return undefined;
    }
    return parsed;
  }

  const country = readCode('country', /^[A-Za-z]{2}$/u, mapping.defaultCountry);
  const language = readCode('language', /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/u, mapping.defaultLanguage);

  function readCode(role: FeedFieldRole, pattern: RegExp, fallback: string | null): string | undefined {
    const value = read(role);
    if (value === null) return fallback ?? undefined;
    if (!pattern.test(value.trim())) {
      raise('unparseable_number', 'warning', role);
      return fallback ?? undefined;
    }
    return value.trim();
  }

  const sourceUpdatedText = read('source_updated_at');
  const sourceUpdatedAt = readInstant(sourceUpdatedText);
  const sourceCreatedAt = readInstant(read('source_created_at'));

  const delivery =
    deliveryCost === undefined &&
    deliveryMinDays === undefined &&
    deliveryMaxDays === undefined
      ? undefined
      : {
          ...(deliveryCost === undefined ? {} : { cost: deliveryCost }),
          ...(deliveryMinDays === undefined ? {} : { minDays: deliveryMinDays }),
          ...(deliveryMaxDays === undefined ? {} : { maxDays: deliveryMaxDays }),
        };

  const returnPolicyUrl = readUrlRole('return_policy_url');
  const returnPolicy =
    returnPolicyUrl === undefined && returnWindowDays === undefined
      ? undefined
      : {
          ...(returnPolicyUrl === undefined ? {} : { url: returnPolicyUrl }),
          ...(returnWindowDays === undefined ? {} : { windowDays: returnWindowDays }),
        };

  const brandHint = read('brand');
  const model = read('model');
  const merchantSku = read('sku');
  const categoryKey = read('category');
  const merchantHint = read('merchant');
  const storefrontHint = read('storefront');
  const region = read('region');

  // A sale price is what the buyer PAYS, and the list price is what it is
  // compared against — `offers.price_amount` is the payable one, so a feed that
  // publishes both maps `sale_price` onto the price and the list price onto
  // `compareAtPrice`. Getting this the other way round shows every discounted
  // product at its undiscounted price on a comparison surface, which is the
  // failure a shopper notices and Mercaria does not.
  const effectivePrice = salePrice ?? price;
  const compareAtPrice = salePrice === undefined ? undefined : price;

  const normalized: NormalizedSourceRecord = {
    title,
    identifiers,
    options,
    media,
    ...(description === null ? {} : { description }),
    ...(brandHint === null ? {} : { brandHint }),
    ...(model === null ? {} : { model }),
    ...(merchantSku === null ? {} : { merchantSku }),
    ...(categoryKey === null ? {} : { categoryKey }),
    ...(merchantHint === null ? {} : { merchantHint }),
    ...(storefrontHint === null ? {} : { storefrontHint }),
    ...(effectivePrice === undefined ? {} : { price: effectivePrice }),
    ...(compareAtPrice === undefined ? {} : { compareAtPrice }),
    ...(conditionLabel === undefined ? {} : { conditionLabel }),
    ...(availability === undefined ? {} : { availability }),
    ...(availableQuantity === undefined ? {} : { availableQuantity }),
    ...(delivery === undefined ? {} : { delivery }),
    ...(returnPolicy === undefined ? {} : { returnPolicy }),
    ...(country === undefined ? {} : { country }),
    ...(region === null ? {} : { region }),
    ...(language === undefined ? {} : { language }),
    ...(destinationUrl === undefined ? {} : { sourceUrl: destinationUrl }),
    ...(affiliateUrl === undefined ? {} : { affiliateUrl }),
    ...(sourceCreatedAt === null ? {} : { sourceCreatedAt: sourceCreatedAt.toISOString() }),
    ...(sourceUpdatedAt === null ? {} : { sourceUpdatedAt: sourceUpdatedAt.toISOString() }),
  };

  return { index: record.index, externalId, normalized, issues, sourceValues, sourceUpdatedAt };
}

/** Does the version translate this role's values at all? */
function hasValueMappingsFor(role: FeedFieldRole, mapping: ResolvedFeedMapping): boolean {
  const prefix = `${role}:`;
  for (const key of mapping.valueMappings.keys()) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

function isAvailability(value: string): value is OfferAvailability {
  return (OFFER_AVAILABILITY_STATES as readonly string[]).includes(value);
}

/**
 * An absolute `http(s)` URL, or nothing.
 *
 * `URL` parsing rather than a pattern, so the refusal is the platform's own
 * reading of the string — a `javascript:` scheme and a `data:` blob are both
 * things a feed can put in an image column and both become a link Mercaria
 * would render.
 */
function readUrl(value: string): string | null {
  if (value === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.toString();
}

function readInstant(value: string | null): Date | null {
  if (value === null) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * A token safe for `feed_import_report_entries.observed_token`.
 *
 * The column's CHECK enforces the same bound; this makes the writer produce a
 * value that satisfies it rather than discovering a 23514 mid-import. A token
 * that cannot be reduced to the permitted alphabet is dropped entirely, which is
 * the fail-closed direction: the issue is still reported, just without the word.
 */
function boundToken(value: string): string | undefined {
  const cleaned = value.replace(/[^A-Za-z0-9 _./-]/gu, '').slice(0, 16);
  return cleaned === '' ? undefined : cleaned;
}
