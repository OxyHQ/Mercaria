/**
 * Structured catalog logging: entity ids, schema versions and correlation ids,
 * and nothing about a person (#367 W17).
 *
 * ## The enforcement is the TYPE, and the absences are the mechanism
 *
 * `CatalogLogFields` is a CLOSED field set. There is no `Record<string,
 * unknown>`, no `meta`, no `context`, no `extra` and none may be added — the
 * `services/analytics/` rule ("the whole domain is an allow-list of typed
 * columns; there is no jsonb property bag and none may be added") applied to a
 * log line, and it is the same argument: an analytics property and a log field
 * are both composed by our OWN code, so an open bag is not a defence, it is the
 * one mechanism by which a buyer's address, a seller's email or a bearer token
 * reaches production logs. A caller who wants to log an email finds that there
 * is no property to put it in, which is a compile error rather than a review
 * finding.
 *
 * `CATALOG_LOG_FORBIDDEN_FIELDS` states the prohibition as a VALUE beside it —
 * the `RETAIL_FORBIDDEN_COMPONENT_KINDS` device — and `correlation.test.ts`
 * asserts the two are DISJOINT, so a plausible future addition (`sellerEmail`,
 * `rawQuery`, `displayName`) fails the build rather than passing review.
 *
 * ## And then a runtime guard, because three fields are free text
 *
 * The type cannot help with `reasonCode`, `outcome` and `hop`: they are strings
 * chosen by the caller, and "an operator-friendly reason" is exactly the slot
 * somebody eventually interpolates a listing title or an exception message into.
 * So every string value is inspected before it is emitted, and a value that
 * looks like a credential, an address-bearing contact detail or prose is REFUSED
 * — replaced by a fixed sentinel, never truncated. Truncation ships a prefix of
 * the secret and reads like success; a sentinel ships nothing and the refusal is
 * itself reported on the line (`logValueRefusals`) and counted
 * (`catalogLogValueRefusals`), the `ledgerImbalanceAttempts` shape.
 *
 * ### Why this REFUSES the value where #107's metadata gate THROWS
 *
 * `services/payments/checkout-payment.service.ts` throws on a forbidden metadata
 * key, deliberately, because dropping it silently would ship the defect. That
 * gate sits in a composition that can fail safely. This one sits INSIDE a
 * request path and inside a `res.on('finish')` listener, where a throw fails the
 * request the line was only describing — so the value is refused, the request is
 * unaffected, and the fact that a refusal happened is put where somebody sees
 * it. Divergence stated rather than left to look like an inconsistency.
 *
 * ## The guard is mutation-tested, and `patterns` is the seam
 *
 * `inspectCatalogLogValue` takes its pattern list as a defaulted parameter for
 * exactly one reason: `correlation.test.ts` runs the same corpus through it with
 * the list EMPTIED and asserts every sample then passes unrefused. Without that,
 * a corpus that happened to be refused for some other reason (an over-length
 * bound, a typo in a sample) would read as a working guard. A detector asserted
 * only in the positive direction cannot fail.
 */

import { log } from '../../lib/logger.js';
import { currentCorrelationId } from './correlation.js';

/**
 * The events this domain emits.
 *
 * A closed union rather than a free string, so the set of things worth a
 * structured catalog line stays readable and greppable. A new event is one
 * member added here — which is the point: a log event is part of the contract an
 * operator reads, not an ad-hoc sentence.
 */
export const CATALOG_LOG_EVENTS = [
  /** One served request on an observed catalog route. */
  'route_observed',
  /** A client presented a correlation id that did not pass the shape gate. */
  'correlation_inbound_refused',
  /** A publication trace was read, and which hops it found. */
  'publication_trace_read',
  /** A publication trace found no subject for the handle it was given. */
  'publication_trace_not_found',
  /** A string value was refused by the guard below. Must stay rare. */
  'log_value_refused',
] as const;

export type CatalogLogEvent = (typeof CATALOG_LOG_EVENTS)[number];

/**
 * Everything a catalog log line may carry.
 *
 * Read the ABSENCES: there is no email, no phone, no address, no postal code, no
 * token, no cookie, no IP, no user agent, no Oxy user id, no guest session id,
 * no raw query text and no display label (`title`, `description`, `name`,
 * `handle`). Each is named in `CATALOG_LOG_FORBIDDEN_FIELDS` so the omission
 * reads as a decision.
 *
 * `storeId` IS here and the others are not, and the distinction is the one #367
 * W17 draws: a store is a TENANT, not a person. Every operator surface in this
 * repository already prints store ids; a trace that could not name the tenant
 * would be unusable for the one question it exists to answer.
 */
export interface CatalogLogFields {
  readonly event: CatalogLogEvent;

  /* Identities of THINGS. Every one is a Mercaria row id or a stable key. */
  readonly draftId?: string;
  readonly listingId?: string;
  readonly storeId?: string;
  readonly productVariantId?: string;
  readonly canonicalProductId?: string;
  readonly canonicalVariantId?: string;
  readonly categoryId?: string;
  readonly offerOutboxId?: string;
  readonly matchQueueId?: string;

  /* Versions — what rules a fact was recorded under (#367 W17 verbatim). */
  readonly schemaHash?: string;
  readonly productTypeDefinitionId?: string;
  readonly definitionVersion?: number;
  readonly draftVersion?: number;

  /* Stable keys, never localized labels. */
  readonly categoryKey?: string;
  readonly productTypeKey?: string;
  readonly attributeKey?: string;
  readonly locale?: string;
  readonly market?: string;

  /* Outcomes. The three free-text fields, and why the runtime guard exists. */
  readonly outcome?: string;
  readonly reasonCode?: string;
  readonly hop?: string;

  /* Measurements. */
  readonly count?: number;
  readonly durationMs?: number;
  readonly attempts?: number;
  readonly statusCode?: number;
  readonly requestedRevision?: number;
  readonly claimedRevision?: number;

  /* Request shape. `route` is a TEMPLATE; see `route-observations.ts`. */
  readonly method?: string;
  readonly route?: string;
}

/**
 * Field names that may never appear on a catalog log line.
 *
 * Not a runtime filter — none of these is a property of `CatalogLogFields`, so
 * none can be passed. This tuple is the prohibition written down as data, gated
 * by a disjointness test against the permitted names, so adding any of them
 * fails the build instead of a review.
 */
export const CATALOG_LOG_FORBIDDEN_FIELDS = [
  // Contact details — a buyer's or a seller's.
  'buyerEmail',
  'sellerEmail',
  'email',
  'emailHash',
  'phone',
  'phoneNumber',
  'address',
  'addressLine1',
  'postalCode',
  // Credentials, live or irreversible.
  'token',
  'accessToken',
  'bearerToken',
  'authorization',
  'cookie',
  'secret',
  'apiKey',
  // What somebody searched for. #77 keeps this to a redacted column with a
  // 30-day life; a log line has neither.
  'rawQuery',
  'queryText',
  'searchQuery',
  // Display labels. Seller-authored prose, and the field a title leaks through.
  'title',
  'description',
  'name',
  'displayName',
  'label',
  'handle',
  // People. Oxy owns identity and a log line is not the place it appears.
  'oxyUserId',
  'createdByOxyUserId',
  'buyerOxyUserId',
  'sellerOxyUserId',
  'guestSessionId',
  // Device and network fingerprints.
  'ipAddress',
  'userAgent',
  'deviceId',
] as const;

export type CatalogLogForbiddenField = (typeof CATALOG_LOG_FORBIDDEN_FIELDS)[number];

/**
 * The permitted field names, as data.
 *
 * TypeScript cannot enumerate an interface's keys at runtime, so the disjointness
 * gate needs the list. It is asserted against `CatalogLogFields` by a type-level
 * check below rather than kept in step by hand: a field added to the interface
 * and not to this tuple fails `tsc`, and vice versa.
 */
export const CATALOG_LOG_PERMITTED_FIELDS = [
  'event',
  'draftId',
  'listingId',
  'storeId',
  'productVariantId',
  'canonicalProductId',
  'canonicalVariantId',
  'categoryId',
  'offerOutboxId',
  'matchQueueId',
  'schemaHash',
  'productTypeDefinitionId',
  'definitionVersion',
  'draftVersion',
  'categoryKey',
  'productTypeKey',
  'attributeKey',
  'locale',
  'market',
  'outcome',
  'reasonCode',
  'hop',
  'count',
  'durationMs',
  'attempts',
  'statusCode',
  'requestedRevision',
  'claimedRevision',
  'method',
  'route',
] as const;

/**
 * The two lists above describe one fact, so they are tied together at the type
 * level in both directions.
 *
 * Each of these is `never` when the two agree and a readable type error naming
 * the offending key when they do not. A one-directional check would let the
 * tuple carry a name the interface dropped, which is a gate that guards nothing.
 */
type PermittedFieldName = (typeof CATALOG_LOG_PERMITTED_FIELDS)[number];
type FieldMissingFromTuple = Exclude<keyof CatalogLogFields, PermittedFieldName>;
type TupleNameMissingFromFields = Exclude<PermittedFieldName, keyof CatalogLogFields>;
const _everyFieldIsListed: FieldMissingFromTuple extends never ? true : never = true;
const _everyListedNameIsAField: TupleNameMissingFromFields extends never ? true : never = true;
void _everyFieldIsListed;
void _everyListedNameIsAField;

/** What replaces a refused value. Fixed, and carries no part of the original. */
export const CATALOG_LOG_REFUSED_VALUE = '[refused]';

/**
 * The longest a permitted string value may be.
 *
 * 256 characters. No field in `CatalogLogFields` is legitimately longer — an id
 * is 36, a schema hash 64, a locale a handful — so anything longer is prose, and
 * prose in `reasonCode` is how a seller-authored description or an exception
 * message carrying a row's contents reaches a log line. It is REFUSED rather
 * than truncated, for the reason in the header.
 */
export const CATALOG_LOG_MAX_VALUE_LENGTH = 256;

/** A shape a string value may not have. */
export interface CatalogLogValuePattern {
  readonly kind: string;
  readonly pattern: RegExp;
}

/**
 * The credential and contact shapes a string value is refused for.
 *
 * Every one is a REGEX LITERAL. None is assembled from a template string, and
 * that is not stylistic: a template swallows backslashes, and the resulting
 * pattern matches more than intended while every test stays green
 * (`~/Oxy/AGENTS.md`). Here the direction is doubly bad — a broken pattern
 * matches nothing rather than too much, so the guard reports clean.
 * `correlation.test.ts` therefore drives one positive sample per pattern AND
 * asserts each sample passes once the list is emptied.
 *
 * The token shapes are this repository's own vocabularies (`mgs_` guest cart,
 * `mgx_`/`mgp_` portal, `mercaria_sk_` developer key) plus Stripe's and JWT's,
 * because those are the strings that actually exist here to be leaked.
 */
export const CATALOG_LOG_VALUE_REFUSAL_PATTERNS: readonly CatalogLogValuePattern[] = [
  { kind: 'email_address', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { kind: 'bearer_credential', pattern: /\bbearer\s+\S/i },
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/ },
  { kind: 'guest_session_token', pattern: /\bmgs_[A-Za-z0-9_-]{10,}/ },
  { kind: 'guest_portal_token', pattern: /\bmg[xp]_[A-Za-z0-9_-]{10,}/ },
  { kind: 'mercaria_developer_key', pattern: /\bmercaria_sk_[A-Za-z0-9_-]{10,}/ },
  { kind: 'stripe_secret_key', pattern: /\b[sr]k_(test|live)_[A-Za-z0-9]{10,}/ },
  /**
   * An international phone number in `+` form ONLY, and this pattern is the one
   * that has already been wrong twice. Read the whole note before loosening it.
   *
   * A MANDATORY `+` prefix, which is #77's lesson stated at its strongest: a bare
   * digit run turns `iphone 15 128 256` into a phone number and destroys the best
   * values in the dataset. `+` appears in no id, hash, uuid, locale, market,
   * route template or reason code this field set carries, so the pattern's
   * false-positive surface here is empty.
   *
   * **The `00` international prefix is DELIBERATELY NOT DETECTED**, and that is a
   * decision rather than an omission. Two measured false positives, both caught
   * by the tests on their first run and both permanent and silent had they
   * shipped:
   *
   *  - `7a7a…6379000000000000000000000000`, a real `schema_hash` from
   *    `trace.realdb.test.ts`. `00` followed by a long digit run, so EVERY schema
   *    hash with a zero run in it was refused, and the trace's own log line
   *    carried `[refused]` exactly where W17 asks for a schema version.
   *  - `00000000-0000-7000-8000-000000000000`, a uuid. Tightening the rule to
   *    demand a separator after the country code did not help: a hyphenated
   *    digit-heavy identifier is INDISTINGUISHABLE from a dialled number with
   *    separators, which is what this field set is mostly made of.
   *
   * So the `00` form is out. The cost is stated plainly: a phone number written
   * `0034600123456` in a `reasonCode` passes this guard. That is the right way
   * round — the `CatalogLogFields` allow-list is what keeps contact details out,
   * this is defence in depth behind it, and a defence in depth that eats the
   * primary field it sits in front of is a net loss.
   *
   * The lesson generalises to any pattern added here: the failure direction of a
   * value-shape guard is a legitimate value it eats, and what catches that is the
   * PERMITTED corpus in `correlation.test.ts`, not this comment. Add a realistic
   * sample there for anything new — the original corpus used `'a'.repeat(64)` as
   * its hash sample, all letters and no digit run, which is exactly why it missed
   * both of the above.
   */
  { kind: 'phone_number', pattern: /(?<![A-Za-z0-9])\+\d[\d\s().-]{7,}\d/ },
];

/** The verdict on one string value. A STRING discriminant (`strict: false`). */
export type CatalogLogValueVerdict =
  | { readonly verdict: 'permitted' }
  | { readonly verdict: 'refused'; readonly kind: string };

/**
 * Decide whether one string value may be emitted.
 *
 * Pure, and the pattern list is a parameter so the guard can be run with it
 * emptied — the mutation seam described in the header. The over-length rule is
 * checked FIRST: a 10 KB value is refused for being prose whether or not it also
 * happens to contain an email, and reporting the length is the more useful
 * answer to whoever has to fix the call site.
 */
export function inspectCatalogLogValue(
  value: string,
  patterns: readonly CatalogLogValuePattern[] = CATALOG_LOG_VALUE_REFUSAL_PATTERNS,
): CatalogLogValueVerdict {
  if (value.length > CATALOG_LOG_MAX_VALUE_LENGTH) {
    return { verdict: 'refused', kind: 'over_length' };
  }
  for (const candidate of patterns) {
    if (candidate.pattern.test(value)) {
      return { verdict: 'refused', kind: candidate.kind };
    }
  }
  return { verdict: 'permitted' };
}

/**
 * Readings that should never happen.
 *
 * Process-local and reset by nothing in production, the
 * `unobservedRouteReports` shape: a number nobody expects to be non-zero,
 * incremented through one private function so it cannot drift from the condition
 * it measures.
 */
let valueRefusals = 0;

function recordValueRefusal(): void {
  valueRefusals += 1;
}

/** How many string values this process has refused to log. Expected: zero. */
export function catalogLogValueRefusals(): number {
  return valueRefusals;
}

/** The test seam, `resetCatalogRouteObservations`' shape. */
export function resetCatalogLogCounters(): void {
  valueRefusals = 0;
}

/** A line as it will be handed to pino, after the guard has run. */
export interface CatalogLogLine {
  readonly domain: 'catalog';
  readonly event: CatalogLogEvent;
  readonly correlationId?: string;
  /** `<field>:<kind>` for every value the guard refused. Absent when none was. */
  readonly logValueRefusals?: readonly string[];
  readonly [field: string]: unknown;
}

/**
 * Compose the line pino will receive: guard every string, attach the correlation
 * id, drop nothing silently.
 *
 * Exported because `correlation.test.ts` asserts on the composed line rather
 * than on pino's output — a test that captured a log transport would be
 * measuring the transport, and the property under test is what the composition
 * decided to put in.
 *
 * A `null` or `undefined` field is dropped: an absent value and a null one carry
 * the same information here, and one spelling reads better in an aggregator.
 */
export function composeCatalogLogLine(
  fields: CatalogLogFields,
  patterns: readonly CatalogLogValuePattern[] = CATALOG_LOG_VALUE_REFUSAL_PATTERNS,
): CatalogLogLine {
  const refusals: string[] = [];
  const line: Record<string, unknown> = { domain: 'catalog', event: fields.event };

  for (const field of CATALOG_LOG_PERMITTED_FIELDS) {
    if (field === 'event') continue;
    const value = fields[field];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') {
      const verdict = inspectCatalogLogValue(value, patterns);
      if (verdict.verdict === 'refused') {
        refusals.push(`${field}:${verdict.kind}`);
        recordValueRefusal();
        line[field] = CATALOG_LOG_REFUSED_VALUE;
        continue;
      }
    }
    line[field] = value;
  }

  const correlationId = currentCorrelationId();
  if (correlationId !== undefined) line.correlationId = correlationId;
  if (refusals.length > 0) line.logValueRefusals = refusals;

  // The cast names what the loop built. `CatalogLogLine`'s index signature
  // admits it; the two declared members are set unconditionally above.
  return line as CatalogLogLine;
}

/**
 * Emit a catalog line at `info`.
 *
 * `log.general` with a stable `catalog.<event>` message, rather than a sixth
 * namespace in `lib/logger.ts`: that file is the shared logger and a namespace
 * per domain is how it grows without bound. The `domain: 'catalog'` field is
 * what an aggregator filters on.
 */
export function catalogLogInfo(fields: CatalogLogFields): void {
  log.general.info(composeCatalogLogLine(fields), `catalog.${fields.event}`);
}

/** Emit at `warn` — something an operator may want to know about later. */
export function catalogLogWarn(fields: CatalogLogFields): void {
  log.general.warn(composeCatalogLogLine(fields), `catalog.${fields.event}`);
}

/** Emit at `error` — something is wrong now. */
export function catalogLogError(fields: CatalogLogFields): void {
  log.general.error(composeCatalogLogLine(fields), `catalog.${fields.event}`);
}

/** Emit at `debug` — per-request volume, off in production by default. */
export function catalogLogDebug(fields: CatalogLogFields): void {
  log.general.debug(composeCatalogLogLine(fields), `catalog.${fields.event}`);
}
