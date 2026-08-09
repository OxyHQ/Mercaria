/**
 * Application configuration.
 *
 * A typed, frozen object of tunables read from the environment with sane
 * defaults. Every magic number used by the marketplace domain lives here so it
 * can be adjusted per-deployment via env vars without touching code.
 *
 * Values are read ONCE at module load. The object (and its nested groups) is
 * deeply frozen so no code can mutate config at runtime.
 */

import type {
  AnalyticsCollectionMode,
  CanonicalReadMode,
  CurrencyCode,
  ModerationEnforcementMode,
} from '@mercaria/shared-types';
import {
  ALL_CURRENCY_CODES,
  ANALYTICS_COLLECTION_MODES,
  CANONICAL_READ_MODES,
} from '@mercaria/shared-types';
import { log } from '../lib/logger.js';

/**
 * Parse an integer environment variable, falling back to `fallback` when the
 * variable is unset, empty, or not a finite integer.
 */
function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Parse a finite floating-point environment variable, falling back to
 * `fallback` when the variable is unset, empty, or not a finite number. Used
 * for decimal tunables (e.g. FX rates like `0.49`) that `intEnv` would truncate.
 */
function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Parse a string environment variable, falling back to `fallback` when the
 * variable is unset or empty after trimming. Returns the TRIMMED value.
 */
function strEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  return raw.trim();
}

/**
 * Parse a boolean environment variable. Truthy values are `1`, `true`, `yes`
 * and `on` (case-insensitive); everything else (including unset) yields
 * `fallback`.
 */
function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

const MINUTE_MS = 60_000;

/** The FX rate provider strategy. */
type FxProviderName = 'faircoin_explorer' | 'static';

/** The two valid FX provider identifiers, used to validate the env value. */
const FX_PROVIDERS: readonly FxProviderName[] = ['faircoin_explorer', 'static'];

/**
 * Resolve the configured FX provider. Defaults to the live FairCoin Explorer in
 * production and the static dev fallback otherwise (mirrors `mockPayEnabled`).
 * An explicitly-set but invalid `FX_PROVIDER` falls back to the default rather
 * than throwing at import time.
 */
function resolveFxProvider(): FxProviderName {
  const fallback: FxProviderName =
    process.env.NODE_ENV === 'production' ? 'faircoin_explorer' : 'static';
  const raw = process.env.FX_PROVIDER?.trim();
  if (!raw) {
    return fallback;
  }
  return FX_PROVIDERS.includes(raw as FxProviderName) ? (raw as FxProviderName) : fallback;
}

/** How much of an enforcement plan is allowed to actually happen. */
const ENFORCEMENT_MODES: readonly ModerationEnforcementMode[] = [
  'observe',
  'manual',
  'automatic',
];

/**
 * Resolve the enforcement mode, defaulting to the mode that changes nothing.
 *
 * An unrecognised value falls back to `observe` rather than throwing: a typo in a
 * deploy variable must not be able to turn enforcement UP, and it must not take
 * the API down either.
 */
function resolveEnforcementMode(): ModerationEnforcementMode {
  const raw = process.env.CROWDSOURCE_ENFORCEMENT_MODE?.trim();
  if (!raw) return 'observe';
  return ENFORCEMENT_MODES.includes(raw as ModerationEnforcementMode)
    ? (raw as ModerationEnforcementMode)
    : 'observe';
}

/**
 * Whether the CrowdSource integration is switched on.
 *
 * Requires BOTH halves of the round trip. A deployment with a service key and no
 * webhook secret sends reports that can never come back — cases open, juries
 * decide, and Mercaria never learns the outcome. That is worse than being off,
 * because it consumes real reviewers' time, so a half-configured integration is
 * treated as not configured and says so once at boot.
 *
 * The gate is on the DISPATCHER, never on intake. Reports taken while this is
 * false still get their outbox row, so switching it on delivers the backlog
 * rather than stranding it.
 */
/**
 * `DATABASE_URL`, or a refusal to build a config at all.
 *
 * Deliberately a THROW rather than a fallback or an optional value. Every route
 * this API serves is backed by Postgres, so there is no degraded mode left to
 * fall back to: the only alternatives to failing here are inventing a connection
 * string (which points a production task at a developer's machine) or deferring
 * the failure to the first request (which turns one startup error into an
 * unbounded stream of 500s that reads as an outage). Failing at config load stops
 * the task before it can be added to a load balancer.
 *
 * Trimmed, and an all-whitespace value is treated as absent — it reaches
 * `postgres()` as a parse error hundreds of lines from whatever set it.
 */
function resolveDatabaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Every Mercaria API route is served from PostgreSQL, ' +
        'so a task without it cannot answer any request. Start a local server with: ' +
        'docker compose -f docker-compose.postgres.yml up -d postgres',
    );
  }
  return url;
}

/**
 * Whether guest commerce is switched on — ADR 0003 M8.
 *
 * `GUEST_COMMERCE_ENABLED=true` requires BOTH `GUEST_PII_ENCRYPTION_KEY` and
 * `GUEST_EMAIL_HASH_KEY`, the `CROWDSOURCE_ENABLED` half-configuration rule:
 * a deployment able to mint guest sessions but not to encrypt a guest
 * checkout's contact (#105–#107) or route a magic link (#108) would take carts
 * it can never carry to an order confirmation. Half-configured stays OFF and
 * says so once at boot. The two keys are SEPARATE by design (D12): the hash
 * key must be usable by the lookup path without ever being able to decrypt.
 *
 * There is deliberately no `GUEST_TOKEN_PEPPER` and none may be added: the
 * session token hashes are keyless SHA-256 on purpose (256-bit random
 * preimages need no key, and a pepper would make every stored hash
 * unverifiable the day it rotated), while the email hash is keyed for the
 * opposite entropy reason — the ADR's Environment section states both.
 *
 * This flag gates ISSUANCE surfaces (the `/guest/session` mount, new-session
 * minting), never durable records: sessions issued while it was on are purged
 * by the retention sweep on their own schedule whatever this says.
 */
function resolveGuestCommerceEnabled(): boolean {
  if (!boolEnv('GUEST_COMMERCE_ENABLED', false)) return false;

  const missing = (['GUEST_PII_ENCRYPTION_KEY', 'GUEST_EMAIL_HASH_KEY'] as const).filter(
    (name) => (process.env[name]?.trim() ?? '') === '',
  );
  if (missing.length === 0) return true;

  log.general.error(
    { missing },
    '[Guest] GUEST_COMMERCE_ENABLED is set but the integration is incomplete; staying OFF. ' +
      'No guest session is issued and the /guest/session surface is not mounted.',
  );
  return false;
}

function resolveCrowdSourceEnabled(): boolean {
  if (!boolEnv('CROWDSOURCE_ENABLED', false)) return false;

  const hasServiceKey = (process.env.CROWDSOURCE_SERVICE_KEY?.trim() ?? '') !== '';
  const hasWebhookSecret = (process.env.CROWDSOURCE_WEBHOOK_SECRET?.trim() ?? '') !== '';
  if (hasServiceKey && hasWebhookSecret) return true;

  const missing = [
    hasServiceKey ? undefined : 'CROWDSOURCE_SERVICE_KEY',
    hasWebhookSecret ? undefined : 'CROWDSOURCE_WEBHOOK_SECRET',
  ].filter((name): name is string => name !== undefined);
  log.general.error(
    { missing },
    '[CrowdSource] CROWDSOURCE_ENABLED is set but the integration is incomplete; ' +
      'staying OFF. Reports are still stored and will deliver once configured.',
  );
  return false;
}

/**
 * Whether the referral domain is switched on (#142, ADR 0005 "Environment").
 *
 * The `resolveCrowdSourceEnabled` rule, applied to the referral program:
 * `REFERRALS_ENABLED=true` requires `REFERRAL_LINK_TOKEN_SECRET`, because a
 * program that can issue codes but not signed links hands partners a
 * half-working instrument set and nothing reports why. Half-configured is
 * treated as OFF and says so once at boot.
 *
 * The gate stops SURFACES and LOOPS, never durable records — programs,
 * partners, attributions and conversions already written remain exactly as
 * they are, the standing rule every gate in this file follows.
 */
function resolveReferralsEnabled(): boolean {
  if (!boolEnv('REFERRALS_ENABLED', false)) return false;

  if ((process.env.REFERRAL_LINK_TOKEN_SECRET?.trim() ?? '') !== '') return true;

  log.general.error(
    { missing: ['REFERRAL_LINK_TOKEN_SECRET'] },
    '[Referrals] REFERRALS_ENABLED is set but the integration is incomplete; staying OFF. ' +
      'Durable referral records are unaffected.',
  );
  return false;
}

/**
 * Whether the Stripe rail is switched on.
 *
 * The `resolveCrowdSourceEnabled` rule, applied to a rail where the consequence
 * of getting it wrong is money rather than reviewer time. `STRIPE_ENABLED=true`
 * requires the secret key AND BOTH webhook secrets (ADR 0001, "Environment"),
 * because the two endpoints are two independent halves of the same integration:
 * a deployment with the platform secret and no Connect secret verifies payment
 * events and rejects every `account.updated`, so sellers silently stop becoming
 * payment-ready while charges keep succeeding. Half-configured is worse than off
 * and says so once at boot.
 *
 * There is no `STRIPE_ACCOUNT_ID`: the platform account is implied by the key,
 * and connected-account ids live only in provider-account records (#46).
 */
function resolveStripeEnabled(): boolean {
  if (!boolEnv('STRIPE_ENABLED', false)) return false;

  const missing = (
    [
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'STRIPE_CONNECT_WEBHOOK_SECRET',
    ] as const
  ).filter((name) => (process.env[name]?.trim() ?? '') === '');
  if (missing.length === 0) return true;

  log.general.error(
    { missing },
    '[Stripe] STRIPE_ENABLED is set but the integration is incomplete; staying OFF. ' +
      'No webhook endpoint is mounted and no payment can be created.',
  );
  return false;
}

/**
 * Split `STRIPE_SELLER_COUNTRIES` into an upper-cased allow-list.
 *
 * Constrained by ADR 0001 D8 to the {US, CA, UK, EEA, CH} transfer region, but
 * NOT validated against that set here: the region is Stripe's and changes on
 * their schedule, so a hard-coded list in this file would eventually refuse a
 * country Stripe had started supporting. Onboarding (#46) is where a country is
 * checked, against this list.
 */
function resolveStripeSellerCountries(): readonly string[] {
  return strEnv('STRIPE_SELLER_COUNTRIES', 'ES')
    .split(',')
    .map((code) => code.trim().toUpperCase())
    .filter((code) => code !== '');
}

/**
 * Split `STRIPE_PRESENTMENT_CURRENCIES` into the currencies a card checkout may
 * be denominated in — ADR 0001 D8, `EUR` and `USD` at launch.
 *
 * VALIDATED against `ALL_CURRENCY_CODES` here, unlike the seller countries
 * above, and the asymmetry is the point: a country is Stripe's vocabulary and
 * changes on their schedule, while a currency code has to exist in Mercaria's
 * own closed set or nothing downstream can price, convert or store it. A typo
 * would otherwise become a checkout that refuses every cart with a message
 * naming a currency that does not exist.
 */
function resolveStripePresentmentCurrencies(): readonly CurrencyCode[] {
  const configured = strEnv('STRIPE_PRESENTMENT_CURRENCIES', 'EUR,USD')
    .split(',')
    .map((code) => code.trim().toUpperCase())
    .filter((code) => code !== '');

  const known = configured.filter((code): code is CurrencyCode =>
    (ALL_CURRENCY_CODES as readonly string[]).includes(code),
  );
  const unknown = configured.filter((code) => !(known as readonly string[]).includes(code));
  if (unknown.length > 0) {
    log.general.error(
      { unknown, known },
      '[Stripe] STRIPE_PRESENTMENT_CURRENCIES names currencies Mercaria does not know; ' +
        'they are ignored. A card checkout accepts only the recognised ones.',
    );
  }
  return known;
}

/**
 * Split `PAYMENT_OPERATOR_OXY_USER_IDS` into the allow-list that IS the operator
 * surface's authorization (#50).
 *
 * ## An allow-list, and why Mercaria must not invent a role for this
 *
 * Mercaria has exactly one authorization vocabulary — store permissions — and it
 * is scoped to a STORE by construction (`requireStorePermission` reads
 * `req.storeMembership`). The operator surface is the opposite scope: it reads
 * across every store and every P2P seller, and issue #50 is explicit that seller
 * operators must not reach it. There is no store permission that could express
 * "may see all stores' money" without becoming a permission a store owner could
 * grant themselves.
 *
 * Inventing a platform-wide role here would mean inventing a platform-wide role
 * STORE, its grant surface, its audit and its recovery path — a second identity
 * system beside Oxy's, in the one repository that must not have one. So the
 * allow-list is deliberately the crudest thing that is correct: a list of Oxy
 * user ids in configuration, changed by whoever can deploy, with no in-app way
 * to grant it.
 *
 * **This is interim.** When Oxy grows a platform-level operator role, this
 * function and `requirePaymentOperator` are the two places that change, and the
 * variable goes away — it is a stand-in for a claim on a credential, not a
 * design Mercaria intends to keep.
 *
 * ## Empty means the surface does not exist
 *
 * Not "nobody may use it" — the routes are not mounted at all, and every path
 * under `/internal/payments` answers 404. That follows `STRIPE_ENABLED`'s rule
 * rather than the outbox's: there is nothing to park here, and a 401 would tell
 * an unauthenticated caller that an operator surface exists on this deployment.
 */
function resolvePaymentOperatorIds(): readonly string[] {
  return strEnv('PAYMENT_OPERATOR_OXY_USER_IDS', '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
}

/**
 * `CATALOG_OPERATOR_OXY_USER_IDS` → the canonical-graph operator allow-list
 * (ADR 0002 D17/D24). The same interim-allow-list reasoning as
 * `resolvePaymentOperatorIds` above, deliberately a SEPARATE variable: who may
 * link merchants to stores and who may repair payments are different powers,
 * and one list for both would grant whichever one the operator was not vetted
 * for. Empty means the `/internal/commerce-graph` surface is not mounted.
 */
function resolveCatalogOperatorIds(): readonly string[] {
  return strEnv('CATALOG_OPERATOR_OXY_USER_IDS', '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
}

/**
 * `GUEST_OPERATOR_OXY_USER_IDS` → the guest-commerce diagnostic allow-list
 * (#104 idempotency requirement 8).
 *
 * A THIRD list, for the third reason the two above are separate from each
 * other: reading who merged which cart is a different power from repairing
 * payments and from rewiring the catalogue, and one list for all three would
 * grant whichever an operator was not vetted for. Empty means the
 * `/internal/guest-commerce` surface is not mounted at all — 404, never a 401
 * that would advertise it.
 */
function resolveGuestOperatorIds(): readonly string[] {
  return strEnv('GUEST_OPERATOR_OXY_USER_IDS', '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
}

/**
 * `CHECKOUT_DESTINATION_COUNTRIES` → the markets this deployment delivers to
 * (#105 eligibility rule 1).
 *
 * EMPTY means unrestricted, which is exactly the behaviour every checkout had
 * before #105 — so adding the lever changes nothing until somebody sets it, and
 * no existing buyer's saved address becomes undeliverable on deploy.
 *
 * It is deliberately NOT derived from `STRIPE_SELLER_COUNTRIES`: that list says
 * where a SELLER's payout account may be incorporated (ADR 0001 D8), which is a
 * different question from where a parcel may go, and conflating them would
 * silently refuse an EEA seller shipping to a buyer one country outside the
 * list. Real per-carrier destination coverage belongs to Moovo and this repo
 * must not recreate it (`AGENTS.md` §Shipping); this is Mercaria's own market
 * policy and nothing more.
 *
 * Values are upper-cased on read so `es,fr` and `ES,FR` mean the same thing;
 * an entry that is not an assigned ISO-3166 alpha-2 code is dropped rather than
 * carried, because a typo in this list would otherwise become a country nobody
 * can ever deliver to and the symptom would be a buyer's refusal, not a boot
 * error.
 */
function resolveCheckoutDestinationCountries(): readonly string[] {
  return strEnv('CHECKOUT_DESTINATION_COUNTRIES', '')
    .split(',')
    .map((code) => code.trim().toUpperCase())
    .filter((code) => /^[A-Z]{2}$/.test(code));
}

/**
 * A canonical READ lever — `off | shadow | on` (ADR 0002 D24, #60 flags 2–3).
 *
 * An unrecognised value falls back to `on` rather than throwing, and that
 * direction is deliberate and the opposite of `resolveAnalyticsCollectionMode`'s:
 * there, an unreadable value must not turn collection ON, because collecting
 * what nobody asked for is the harm. Here the harm runs the other way — a typo
 * in a rollout variable must not withdraw a shipped public surface from every
 * shopper, which is an outage caused by a config file nobody was watching. The
 * fallback is LOGGED at boot so it is never silent.
 */
function resolveCanonicalReadMode(variable: string): CanonicalReadMode {
  const raw = strEnv(variable, 'on').trim().toLowerCase();
  const mode = CANONICAL_READ_MODES.find((candidate) => candidate === raw);
  if (mode !== undefined) return mode;
  log.general.error(
    { variable, value: raw, allowed: CANONICAL_READ_MODES },
    "[config] canonical read mode is not recognised; falling back to 'on'",
  );
  return 'on';
}

/**
 * `CANONICAL_READ_COHORTS` → which cohorts a canonical read may answer for.
 *
 * EMPTY means every cohort — the `CHECKOUT_DESTINATION_COUNTRIES` rule, and for
 * the same reason: a list that meant "nothing" when unset would make adding the
 * lever a silent outage. Entries are `<kind>:<value>` or the literal `all`; a
 * malformed entry is DROPPED here and then matches nothing in
 * `canonicalReadAllowedFor`, so a typo narrows the rollout instead of widening
 * it.
 */
function resolveCanonicalReadCohorts(): readonly string[] {
  return strEnv('CANONICAL_READ_COHORTS', '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry === 'all' || /^[a-z_]+:.+$/.test(entry));
}

/**
 * `ANALYTICS_OPERATOR_OXY_USER_IDS` → the discovery-analytics allow-list (#77
 * dashboards).
 *
 * A FOURTH list, for the fourth instance of the reason the other three are
 * separate: reading what everybody searched for, tracing a funnel and reading a
 * pseudonym epoch is a different power from repairing payments, from rewiring
 * the catalogue and from inspecting a cart merge. One list for all four would
 * grant whichever an operator was not vetted for — and this one is arguably the
 * most sensitive of the four in aggregate, because it is the only surface that
 * can answer "what are people looking for" across the whole marketplace.
 *
 * Empty means `/internal/analytics` is not mounted at all: 404, never a 401
 * that would tell an unauthenticated caller the surface exists.
 */
function resolveAnalyticsOperatorIds(): readonly string[] {
  return strEnv('ANALYTICS_OPERATOR_OXY_USER_IDS', '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
}

/**
 * `RETAIL_OPERATOR_OXY_USER_IDS` → the retail-eligibility allow-list (#121).
 *
 * A FIFTH list, for the fifth instance of the reason the other four are
 * separate: approving a resale authorization, verifying a product-safety
 * certificate and — above all — LIFTING A RECALL is a compliance power, not a
 * payments one, not a catalogue-curation one, not a cart-diagnostic one and not
 * an analytics one. Granting it to whoever may repair payments would grant the
 * power they were not vetted for, which is the argument
 * `resolveCatalogOperatorIds` already makes against sharing with payments.
 *
 * Empty means `/internal/retail-eligibility` is not mounted at all: 404, never
 * a 401 that would tell an unauthenticated caller the surface exists. That is a
 * working configuration and it means nobody can record a policy version, verify
 * a document or raise a recall — so it must be populated before
 * `mercaria_retail` carries a live order.
 */
function resolveRetailOperatorIds(): readonly string[] {
  return strEnv('RETAIL_OPERATOR_OXY_USER_IDS', '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
}

/**
 * Resolve the analytics collection mode (#77 envelope field 11, acceptance 8).
 *
 * Defaults to `off`, and an unrecognised value falls back to `off` rather than
 * throwing — the same shape `resolveEnforcementMode` uses and for a stronger
 * version of the same reason: a typo in a deploy variable must not be able to
 * turn COLLECTION UP, and it must not take the API down either. Every other
 * fallback in this file that could go either way defaults to the permissive
 * side; this one defaults to collecting nothing.
 */
function resolveAnalyticsCollectionMode(): AnalyticsCollectionMode {
  const raw = process.env.ANALYTICS_COLLECTION_MODE?.trim();
  if (!raw) return 'off';
  return (ANALYTICS_COLLECTION_MODES as readonly string[]).includes(raw)
    ? (raw as AnalyticsCollectionMode)
    : 'off';
}

/**
 * Whether analytics collection is on.
 *
 * DERIVED from the mode, never a separate flag: `ANALYTICS_ENABLED=true` with
 * `ANALYTICS_COLLECTION_MODE=off` is a contradiction, and the failure it
 * produces — a deployment collecting under a mode it believes is off — is
 * exactly the one acceptance 8 exists to prevent. `ANALYTICS_ENABLED` is still
 * read, as a kill switch that can only ever turn collection DOWN.
 */
function resolveAnalyticsEnabled(): boolean {
  if (resolveAnalyticsCollectionMode() === 'off') return false;
  return boolEnv('ANALYTICS_ENABLED', false);
}

/**
 * The currency the platform account settles in — ADR 0001 D8, `EUR`.
 *
 * Falls back to `EUR` when the configured value is not a currency Mercaria
 * knows, because this one is load-bearing in a way the list above is not: every
 * transfer is denominated in it and every ledger leg of a card charge is booked
 * in it, so an unrecognised value would produce rows no report could sum.
 */
function resolveStripePlatformCurrency(): CurrencyCode {
  const configured = strEnv('STRIPE_PLATFORM_CURRENCY', 'EUR').trim().toUpperCase();
  if ((ALL_CURRENCY_CODES as readonly string[]).includes(configured)) {
    return configured as CurrencyCode;
  }
  log.general.error(
    { configured },
    '[Stripe] STRIPE_PLATFORM_CURRENCY is not a currency Mercaria knows; falling back to EUR.',
  );
  return 'EUR';
}

export interface WebConfig {
  /**
   * The storefront origin, used to build permalinks.
   *
   * A permalink is where MERCARIA's own users see an object — it is provenance on
   * the case, and no jury client ever fetches it. That is the whole reason
   * evidence carries bare Oxy file ids instead: a reviewer's browser resolving a
   * URL on this host would tell the host when its content is under review.
   */
  readonly origin: string;
}

export interface CrowdSourceConfig {
  /** Whether the outbox dispatcher delivers. Never gates the durable record. */
  readonly enabled: boolean;
  /**
   * `applicationId:credentialId:secret` — ONE opaque value, parsed by the SDK.
   *
   * There is deliberately no `CROWDSOURCE_APP_ID` here or anywhere else, and
   * adding one would be a security regression rather than a convenience.
   * `applicationId` is read OFF this credential; a separate variable holding it
   * could only ever disagree with the credential, and any surface able to carry
   * an `applicationId` independently is the cross-tenant IDOR the tenancy model
   * exists to prevent.
   */
  readonly serviceKey: string;
  /** Optional override; the SDK defaults to the one deployment. */
  readonly baseUrl?: string;
  readonly outboxBatchSize: number;
  readonly outboxPollIntervalMs: number;
  readonly enforcementMode: ModerationEnforcementMode;
}

/**
 * The Stripe rail's configuration. Names are ADR 0001's, verbatim.
 *
 * The API VERSION is deliberately absent: it is a code constant
 * (`STRIPE_API_VERSION` in `services/payments/stripe/api-version.ts`), because
 * an event payload's shape is a property of the code that parses it. An env var
 * would let a deployment be pointed at a version whose fixtures were never
 * verified — silently, and only for the events that actually changed shape.
 */
export interface StripeConfig {
  /**
   * Whether the rail is configured at all. Gates the webhook MOUNT, not just the
   * handler: a deployment without Stripe answers 404 on those paths, which is
   * the truthful answer and stops an endpoint being registered in the Stripe
   * dashboard against a deployment that could never verify its deliveries.
   *
   * Note this is NOT the `crowdSource.enabled`/`payments.outboxEnabled` shape,
   * where the loop is gated and the durable record never is. There is nothing to
   * park here: an unconfigured deployment has no secret and therefore cannot
   * tell a real delivery from a forged one, so accepting the bytes to process
   * later would be storing a stranger's opinion.
   */
  readonly enabled: boolean;
  /** The platform secret key. `sk_test_…` or `sk_live_…`; see `livemode`. */
  readonly secretKey: string;
  /** Platform-scope endpoint secret (`connect=false` events). */
  readonly webhookSecret: string;
  /** Accepted alongside the current one during a rotation window. */
  readonly webhookSecretPrevious?: string;
  /** Connect-scope endpoint secret (`connect=true` events). */
  readonly connectWebhookSecret: string;
  /** Accepted alongside the current one during a rotation window. */
  readonly connectWebhookSecretPrevious?: string;
  /**
   * Which mode this deployment is. DERIVED from the secret key's prefix rather
   * than configured, because it is not an independent fact: a `sk_test_` key can
   * only ever see test objects, so a variable able to disagree with it could
   * only ever be wrong. An event whose `livemode` does not match is acknowledged
   * and dropped — a production URL receives test events too (ADR 0001).
   */
  readonly livemode: boolean;
  /**
   * The platform's PUBLISHABLE key, returned to a buyer's client beside the
   * client secret when it is set.
   *
   * Optional, and its absence is an ordinary configuration: an app built with
   * `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY` already has one. It exists because the
   * publishable key and the secret key that created the payment MUST belong to
   * the same Stripe account, and two independently-configured values can
   * silently disagree — after which every confirmation fails with an error that
   * reads as a client bug. Returning it from the server makes them one fact.
   *
   * It is a public value by construction (`pk_test_…`/`pk_live_…`), so unlike
   * every other key here it may travel to a client.
   */
  readonly publishableKey?: string;
  /** Seller countries onboarding accepts (#46). ADR 0001 D8. */
  readonly sellerCountries: readonly string[];
  /**
   * The currency the platform account settles in — ADR 0001 D8.
   *
   * Every transfer to a seller is denominated in it (a transfer's currency must
   * match the charge's balance-transaction currency), and a card charge's ledger
   * legs are booked in it, so this is the currency Mercaria's card money
   * actually moves in. `EUR`, with a platform account in Spain.
   */
  readonly platformCurrency: CurrencyCode;
  /**
   * The presentment currencies a card checkout may be denominated in — ADR 0001
   * D8: `EUR` and `USD` at launch.
   *
   * A cart in anything else is refused BEFORE any stock is reserved, naming this
   * set. It is an allow-list rather than "whatever Stripe accepts" because the
   * constraint is Mercaria's: every currency here has to be one the FX service
   * can quote, the ledger can hold and an operator can reconcile.
   */
  readonly presentmentCurrencies: readonly CurrencyCode[];
  /**
   * Attempts after which a retryable processing failure becomes a `dead_letter`.
   *
   * Much smaller than the outbox's 25, deliberately. An outbox row is Mercaria's
   * own consequence and the only way it ever happens; a provider event that
   * cannot be interpreted is one Stripe is also retrying, and whose object can
   * be re-read from Stripe at any time by the reconciliation sweep (#50). Eight
   * attempts at exponential backoff is a bit over a day — long enough to ride
   * out an outage, short enough that a genuinely unmappable event reaches an
   * operator while the context is still fresh.
   */
  readonly eventMaxAttempts: number;
  /** Rows the event dispatcher claims per tick. */
  readonly eventBatchSize: number;
  /** How often the event dispatcher looks for due work. */
  readonly eventPollIntervalMs: number;
  /** How long a claimed event row is leased for. */
  readonly eventLeaseMs: number;
  /**
   * This API's own public origin, e.g. `https://api.mercaria.co`.
   *
   * Stripe's hosted onboarding needs a `refresh_url` and a `return_url`, and
   * both point back HERE rather than at an app: a browser redirect proves
   * nothing about readiness (ADR 0001 D2), so the API receives the round trip,
   * verifies the signed state it issued, and only then sends the seller onward.
   *
   * Configured rather than derived from the request, which is the whole point:
   * `req.get('host')` behind an ALB is attacker-controlled, and a redirect URL
   * built from it is an open redirect with a Stripe-branded first hop.
   *
   * ## Optional here, REQUIRED at use
   *
   * The three onboarding values below deliberately do NOT join
   * `resolveStripeEnabled`'s required set, unlike the two webhook secrets. That
   * rule exists for a SILENT failure — a deployment missing the Connect secret
   * verifies charges and drops every `account.updated`, so sellers stop becoming
   * ready with nothing to see. Missing onboarding configuration is the opposite:
   * the onboarding route fails immediately, loudly, naming the variable, and the
   * already-shipped webhook ingress keeps working meanwhile. Turning the whole
   * rail off for it would take payments down to fix an onboarding typo.
   *
   * `stripeOnboardingConfig()` in `services/payments/stripe/onboarding-config.ts`
   * is the one reader, and it names every missing variable at once.
   */
  readonly onboardingBaseUrl?: string;
  /** Where the seller's browser lands after the hosted flow — the dashboard. */
  readonly onboardingReturnUrl?: string;
  /** HMAC secret for the signed, expiring onboarding round-trip state token. */
  readonly onboardingStateSecret?: string;
  /**
   * How long an account may go unread before the reconciliation sweep refreshes
   * it. Six hours: long enough that the sweep is a safety net rather than a
   * polling loop, short enough that a webhook Stripe never delivered costs a
   * seller part of a day rather than a support ticket.
   */
  readonly accountSyncStaleAfterMs: number;
  /** Accounts the sweep refreshes per tick — one Stripe API call each. */
  readonly accountSyncBatchSize: number;
  /** How often the sweep looks for stale accounts. */
  readonly accountSyncIntervalMs: number;
}

/**
 * The reconciliation sweeps (#50).
 *
 * Every value here bounds WORK rather than correctness: a sweep that runs less
 * often, in smaller pages, over a shorter window still detects the same
 * discrepancies, just later. That is why none of them joins a required set the
 * way the webhook secrets do — a misconfigured reconciliation job is slow, and a
 * missing webhook secret is silent.
 */
export interface ReconciliationConfig {
  /**
   * Whether the sweeps RUN. Like the outbox's flag and unlike `STRIPE_ENABLED`,
   * this gates only the loop: the discrepancy rows a manual run writes are
   * durable whatever it says, and switching it off during an incident stops the
   * sweeps competing with whatever an operator is doing by hand.
   */
  readonly enabled: boolean;
  /** How often a task tries to claim a sweep. Only one task wins per job. */
  readonly intervalMs: number;
  /** Rows (or provider objects) one page of a sweep handles. */
  readonly batchSize: number;
  /**
   * How long a payment may sit in a non-terminal status before the sweep asks
   * the rail about it.
   *
   * The buffer between "a buyer is still typing their card number" and "nobody
   * is coming back". Shorter than `RESERVATION_TTL_MS` (15 minutes) on purpose:
   * the sweep must be able to notice a missed success BEFORE the reservation
   * sweep cancels the orders, because after that the same condition becomes the
   * much worse `payment_succeeded_after_release`.
   */
  readonly openPaymentMinAgeMs: number;
  /**
   * How far back a full pass looks when it has never completed one.
   *
   * Only ever used to seed `window_start_at`; after the first completed pass the
   * cursor row carries the real boundary and this is not read again. Seven days
   * because that is comfortably past every provider's own redelivery schedule —
   * a discrepancy older than that was never going to be found by a webhook.
   */
  readonly lookbackMs: number;
}

export interface PaymentsConfig {
  /**
   * Whether the payment outbox DISPATCHER runs. The durable record is never
   * gated: rows are written whatever this says, so switching it on delivers the
   * backlog rather than stranding it, and switching it off during an incident
   * parks work instead of losing it. Exactly the `crowdSource.enabled` rule, for
   * exactly the same reason.
   *
   * Defaults ON, unlike CrowdSource's — this loop has no external dependency to
   * be half-configured against. It drains Mercaria's own consequences of a
   * payment (an order reaching `paid`, a seller being told), and a deployment
   * that quietly did not do those would be a worse default than one that does.
   */
  readonly outboxEnabled: boolean;
  /** Rows drained per tick. */
  readonly outboxBatchSize: number;
  /** How often the dispatcher looks for due work. */
  readonly outboxPollIntervalMs: number;
  /**
   * How long a claimed row is leased for. A dead task's lease expires and the
   * row is reclaimed, so this is also the longest a crash can strand one.
   */
  readonly outboxLeaseMs: number;
  /** The Stripe rail (ADR 0001, issues #46–#50). */
  readonly stripe: StripeConfig;
  /** Reconciliation and the operator surface (#50). */
  readonly reconciliation: ReconciliationConfig;
  /**
   * The Oxy accounts that may reach `/internal/payments/*` — see
   * `resolvePaymentOperatorIds`. An empty list means the surface is not mounted.
   */
  readonly operatorOxyUserIds: readonly string[];
  /**
   * Whether the operator surface exists on this deployment.
   *
   * DERIVED from the allow-list rather than configured beside it, for the reason
   * `stripe.livemode` is derived from the key prefix: a separate flag could only
   * ever disagree with the list, and the disagreement that matters is
   * `enabled: true` with nobody on it — an operator surface reachable by no one,
   * which reads as a permission bug for as long as it takes someone to find the
   * empty variable.
   */
  readonly operatorSurfaceEnabled: boolean;
}

/**
 * Guest commerce (ADR 0003, #103). Variable names are the ADR's, verbatim.
 */
export interface GuestConfig {
  /**
   * Whether guest commerce exists on this deployment — see
   * `resolveGuestCommerceEnabled`. Gates the `/guest/session` MOUNT (an
   * unconfigured deployment answers 404, the `STRIPE_ENABLED` rule) and the
   * resolver's willingness to read guest credentials at all.
   */
  readonly enabled: boolean;
  /**
   * The issuance KILL SWITCH — `GUEST_SESSION_ISSUANCE_ENABLED`, default true.
   *
   * Distinct from `enabled` on purpose: flipping THIS off during an abuse
   * incident stops new sessions being minted while every existing session
   * keeps resolving, rotating and revoking — nobody's cart is destroyed to
   * stop a farmer. Flipping `enabled` off is a decommission, not a lever.
   */
  readonly issuanceEnabled: boolean;
  /**
   * Whether a guest session may OWN a cart — `GUEST_CART_ENABLED`, default
   * true, meaningful only while `enabled` is on (#104 acceptance 10).
   *
   * The third lever, independent of the two above because it answers a
   * different question. `enabled` is "does this deployment have guest commerce
   * at all"; `issuanceEnabled` is "may new credentials be minted right now";
   * this is "may a credential own commerce state". Guest CHECKOUT (#105–#107)
   * gets a fourth for the same reason, which is what "feature flags support
   * guest cart independently from guest checkout" asks for.
   *
   * With this OFF, guest cart reads answer empty and guest cart writes are
   * refused — but the MERGE stays available, because gating it would strand
   * every cart created while it was on. Gate the loop, never the durable
   * record.
   */
  readonly cartEnabled: boolean;
  /**
   * Whether a guest may place an ORDER with an inline destination —
   * `GUEST_INLINE_DESTINATION_ENABLED`, default true, meaningful only while
   * `enabled` is on (#105 migration rule 8).
   *
   * The fourth lever, and separate from `cartEnabled` because the two bound
   * different blast radii. The three states worth knowing:
   *
   *  - **`enabled` off** — no guest credential resolves at all; a signed-out
   *    buyer is `anonymous`, has no cart, and checkout tells them to sign in.
   *    This is a decommission, not a lever.
   *  - **`cartEnabled` off, this on** — a guest session still resolves but owns
   *    no cart, so there is nothing to check out and the refusal comes from the
   *    cart surface. Turning THIS on cannot rescue that; the two compose, they
   *    do not substitute.
   *  - **`cartEnabled` on, this off** — the incident lever this issue adds. A
   *    guest keeps their cart, keeps browsing, and is told plainly at checkout
   *    that placing an order needs an account right now. Nothing durable is
   *    gated: guest orders ALREADY placed keep their contact record, their
   *    payment drains through the rail, and the webhook chain never reads this
   *    flag (ADR 0006 G17 — gate the loop, never the durable record).
   *
   * Default TRUE rather than false, matching `cartEnabled`: `enabled` is the
   * flag that is off by default and gates the whole domain, and an inner lever
   * defaulting off would mean two switches to find during a rollout and one to
   * forget.
   */
  readonly inlineDestinationEnabled: boolean;
  /**
   * `GUEST_OPERATOR_OXY_USER_IDS` — who may read the guest-commerce
   * diagnostic. See `resolveGuestOperatorIds`.
   */
  readonly operatorOxyUserIds: readonly string[];
  /**
   * Whether `/internal/guest-commerce` exists on this deployment. DERIVED from
   * the allow-list for the reason `payments.operatorSurfaceEnabled` is: a
   * separate flag could only ever disagree with the list.
   */
  readonly operatorSurfaceEnabled: boolean;
  /**
   * `GUEST_PII_ENCRYPTION_KEY` — AES-256-GCM key for the guest checkout
   * contact snapshot (D12). Required for `enabled`; CONSUMED by #105–#107,
   * carried here so the M8 half-configuration rule holds from day one.
   */
  readonly piiEncryptionKey: string;
  /**
   * `GUEST_EMAIL_HASH_KEY` — HMAC-SHA-256 key for email routing lookups
   * (D12). Required for `enabled`; consumed by #108. SEPARATE from the
   * encryption key by design: the lookup path must never be able to decrypt.
   */
  readonly emailHashKey: string;
  /** Idle expiry, enforced by the resolver against `last_seen_at` (D3). */
  readonly sessionIdleDays: number;
  /** Absolute expiry, the `expires_at` column stamped at issuance (D3). */
  readonly sessionAbsoluteDays: number;
}

export interface PaginationConfig {
  /** Default page size when the client does not specify a `limit`. */
  readonly defaultPageSize: number;
  /** Hard upper bound on `limit`; larger requests are clamped to this. */
  readonly maxPageSize: number;
}

export interface CatalogConfig {
  /** Maximum number of variants a single product (Listing) may have. */
  readonly maxVariantsPerProduct: number;
  /** Maximum number of gallery images a single listing may have. */
  readonly maxImagesPerListing: number;
  /**
   * The Oxy accounts that may reach `/internal/commerce-graph/*` — the
   * canonical-graph operator surface (#54's linkage endpoints today; #59's
   * merge tooling reads the SAME list when it lands). ADR 0002 D17/D24 name
   * the variable (`CATALOG_OPERATOR_OXY_USER_IDS`) and bind it to the payments
   * precedent: an interim allow-list, not a role — see
   * `resolveCatalogOperatorIds`.
   */
  readonly graphOperatorOxyUserIds: readonly string[];
  /**
   * DERIVED from the allow-list, exactly as `payments.operatorSurfaceEnabled`
   * is and for the same reason: a separate flag could only ever disagree with
   * the list. Empty list = the surface is not mounted at all (404, never 401).
   */
  readonly graphOperatorSurfaceEnabled: boolean;
  /**
   * Whether verifying a BADGE-producing relationship (#55) needs a second
   * operator's approval — `CATALOG_FOUR_EYES_REQUIRED`, defaulting ON.
   *
   * Fail-closed is the right default here specifically because the artefact is a
   * public claim about who a shopper is dealing with: an "Official store" badge
   * minted in error misleads a buyer and is invisible to them, so the cost of
   * requiring a second pair of eyes is a delay and the cost of not requiring one
   * is a false statement. A single-operator deployment turns it off
   * deliberately, rather than discovering it was never on.
   */
  readonly relationshipFourEyesRequired: boolean;
}

/**
 * The unified offer model (#57, ADR 0002 D18).
 *
 * ONE lever and two tunables. `materializationEnabled` gates the convergence
 * LOOP and nothing else: catalogue writes keep enqueuing while it is off, so
 * turning it on drains the backlog rather than stranding it (the
 * `CROWDSOURCE_ENABLED` rule — gate the loop, never the durable record).
 *
 * There is deliberately no flag over the offer TABLES and none over the READ
 * surface. Rows written while the loop is off stay valid when it turns on, and a
 * comparison read of an empty offer table is an empty list, which is the honest
 * answer rather than an error. Nor is there a second flag over checkout: only
 * `native` offers can reach it structurally, and the verdict is derived live —
 * so there is no state a flag could protect that the shape does not.
 */
/**
 * Deterministic matching (#58).
 *
 * `MATCH_PIPELINE_ENABLED` gates the LOOP and never the durable record: with it
 * off the queue still accepts every request and drains them once it is switched
 * on. `MATCH_SEMANTIC_ENABLED` is the operational half of the three levers that
 * keep semantic scoring off — the other two are the absence of a registered
 * scorer (the default) and the policy version's own `semantic_enabled`.
 */
export interface MatchingConfig {
  /** `MATCH_PIPELINE_ENABLED` — does the queue dispatcher run. */
  readonly pipelineEnabled: boolean;
  /** How many subjects one drain claims. */
  readonly queueBatchSize: number;
  /** How often the dispatcher polls, in milliseconds. */
  readonly queuePollIntervalMs: number;
  /** How many rows one bulk-sweep PAGE enqueues. */
  readonly sweepBatchSize: number;
  /**
   * `MATCH_SEMANTIC_ENABLED` — may a REGISTERED scorer be consulted at all.
   * Off by default, and off is the shipped state: no scorer exists in this
   * repository, so the deterministic path is the one that actually runs.
   */
  readonly semanticEnabled: boolean;
}

export interface OffersConfig {
  /** `OFFER_MATERIALIZATION_ENABLED` — does the convergence dispatcher run. */
  readonly materializationEnabled: boolean;
  /** How many listings one drain claims. */
  readonly outboxBatchSize: number;
  /** How often the dispatcher polls, in milliseconds. */
  readonly outboxPollIntervalMs: number;
}

/**
 * The canonical-graph ROLLOUT levers (#60, ADR 0002 D24).
 *
 * Six independent switches plus two tunables, and the reason they are six rather
 * than one is that each bounds a different blast radius. Turning off the offer
 * comparison must not take the brand pages down with it; taking the public
 * surface off the air is a blunter act than telling a product page to stop
 * answering; and stopping the backfill LOOP is a different decision from
 * forbidding an `apply` run to write.
 *
 * `services/backfill/read-mode.ts` holds the table of which lever gates what and
 * the full argument for the defaults. The short version, because it is the part
 * a reader will want here:
 *
 * - The two WRITE levers default OFF, as D24 binds. They are the ones that
 *   mutate.
 * - The four READ levers default to today's behaviour, because #53–#57 already
 *   SHIPPED the routes they gate. A lever introduced with an `off` default would
 *   withdraw four live public surfaces on the deploy that added it, which is not
 *   a rollout — and #60 acceptance 5 asks that turning reads OFF restores the
 *   listing-first experience, which says nothing about the default.
 */
export interface CanonicalRolloutConfig {
  /** `CANONICAL_GRAPH_ENABLED` — does the backfill dispatcher LOOP run. */
  readonly graphEnabled: boolean;
  /**
   * `CANONICAL_WRITE_PUBLICATION_ENABLED` — may an `apply` run mutate the
   * canonical graph. Off downgrades every apply run to the dry-run writer, so
   * the run still produces its complete report and changes nothing.
   */
  readonly writePublicationEnabled: boolean;
  /** `CANONICAL_READS` — `off | shadow | on`, gating canonical PRODUCT reads. */
  readonly reads: CanonicalReadMode;
  /** `CANONICAL_OFFER_COMPARISON` — the same vocabulary, gating `GET /offers`. */
  readonly offerComparison: CanonicalReadMode;
  /**
   * `CANONICAL_PUBLIC_ROUTES_ENABLED` — whether the public canonical routers are
   * MOUNTED at all. The blunt lever, for a rollback that must not depend on
   * every handler having remembered its gate.
   */
  readonly publicRoutesEnabled: boolean;
  /**
   * `CANONICAL_SEARCH_INDEXING_ENABLED` — may the backfill enqueue reindex
   * requests. Off by default: #61 owns the consumer and has not landed, and a
   * queue growing one row per canonical product with nothing draining it is
   * work nobody asked for.
   */
  readonly searchIndexingEnabled: boolean;
  /**
   * `CANONICAL_READ_COHORTS` — which cohorts a canonical read may answer for.
   * EMPTY means every cohort, the `CHECKOUT_DESTINATION_COUNTRIES` rule.
   * Entries are `<kind>:<value>`, or the literal `all`.
   */
  readonly readCohorts: readonly string[];
  /** How many subjects one backfill PAGE examines. */
  readonly backfillBatchSize: number;
  /** How often the backfill dispatcher polls, in milliseconds. */
  readonly backfillPollIntervalMs: number;
}

/**
 * Merchant claiming (#83). Every value here is a BOUND rather than a feature
 * switch — the claim surface itself is always mounted, because a merchant page
 * that cannot say "claim this" is a dead end for the one person entitled to
 * fix it.
 */
export interface MerchantClaimsConfig {
  /**
   * How long a claimant has to finish an attempt, in hours. Past it the claim
   * expires lazily on the next read, the `guest_sessions` idle-expiry rule —
   * the deadline is enforced where it is observed, so nothing can disagree
   * with it.
   */
  readonly attemptTtlHours: number;
  /** How long one challenge stays open, in minutes. Short by design. */
  readonly challengeTtlMinutes: number;
  /**
   * How long a verified claim stands before it must prove itself again, in
   * days (issue model field 9). Surfaced as `revalidationDue`; nothing
   * automatically revokes on it, because losing a merchant's operator without
   * a human deciding is worse than a stale verification.
   */
  readonly revalidateAfterDays: number;
  /** Maximum verification attempts against one challenge before it is refused. */
  readonly maxAttemptsPerChallenge: number;
  /**
   * The three DURABLE issuance budgets (issue security control 1: rate-limit
   * by user, merchant, domain and network). The fourth axis — network — is the
   * HTTP limiter's `rl:merchant-claims:` bucket, which is per-IP for anonymous
   * callers and per-user for authenticated ones.
   *
   * These three are counted in Postgres rather than Redis on purpose: they are
   * about how often a MERCHANT or a DOMAIN may be challenged across every
   * claimant and every ECS task, which an in-memory or per-instance bucket
   * cannot answer at all.
   */
  readonly maxChallengesPerUserPerHour: number;
  readonly maxChallengesPerMerchantPerHour: number;
  readonly maxChallengesPerDomainPerHour: number;
}

export interface FeedConfig {
  /** TTL (seconds) of the assembled home feed cached in Redis. */
  readonly cacheTtlSeconds: number;
  /** Number of products in the "New arrivals" shelf. */
  readonly newArrivalsSize: number;
  /** Number of products in the "On sale" shelf. */
  readonly onSaleSize: number;
  /** Number of stores in the "Worth the hype" merchant shelf. */
  readonly merchantsSize: number;
  /** Number of top-level categories shown in the "Shop by category" shelf. */
  readonly categoriesSize: number;
  /** Number of subcategory tiles shown per category card (2×2 grid). */
  readonly categoryTilesPerCard: number;
  /** Number of thumbnails shown on a store/merchant card. */
  readonly storeCardThumbnails: number;
}

export interface CartConfig {
  /**
   * Hard upper bound on the quantity of a single variant a cart line may hold.
   * Untracked variants (no inventory ceiling) are clamped to this; tracked
   * variants are additionally clamped to their live `available`.
   */
  readonly maxQuantityPerItem: number;
}

export interface OrdersConfig {
  /**
   * How long an inventory reservation (a `pending_payment` order) is held
   * before the maintenance job may expire it and release the stock.
   */
  readonly reservationTtlMs: number;
  /**
   * Whether the test-only mock-pay endpoint is enabled. Off in production.
   */
  readonly mockPayEnabled: boolean;
  /**
   * Flat shipping cost (integer minor units) for each shipping method, added to
   * the order subtotal at checkout.
   */
  readonly shippingRates: {
    /** Cost of standard shipping. */
    readonly standard: number;
    /** Cost of express shipping. */
    readonly express: number;
    /** Cost of pickup (typically free). */
    readonly pickup: number;
  };
  /**
   * TTL of a checkout idempotency claim in Redis. A replayed checkout within
   * this window returns the original orders instead of creating duplicates.
   */
  readonly idempotencyTtlMs: number;
  /**
   * `available` at or below which a tracked variant counts as "low stock" for
   * the store dashboard's low-stock metric.
   */
  readonly lowStockThreshold: number;
}

export interface FxConfig {
  /**
   * Which rate provider to use. `'faircoin_explorer'` hits the live FairCoin
   * Explorer (FAIR→USD only); `'static'` uses the env-configured `staticRates`.
   */
  readonly provider: FxProviderName;
  /** TTL (seconds) the resolved rates are cached for (Redis + in-process). */
  readonly cacheTtlSeconds: number;
  /** Base URL of the FairCoin Explorer (the `/api/price` endpoint is appended). */
  readonly faircoinExplorerBaseUrl: string;
  /** Per-request timeout (ms) for the upstream provider fetch. */
  readonly requestTimeoutMs: number;
  /**
   * Dev/last-resort fallback rates: how many fiat units ONE FAIR is worth
   * (`1 FAIR = staticRates[X]` of currency X). FAIR→FAIR is always 1 and is
   * never stored here. Keyed by the non-FAIR `CurrencyCode`s.
   */
  readonly staticRates: Readonly<Partial<Record<Exclude<CurrencyCode, 'FAIR'>, number>>>;
}

export interface ReferralsConfig {
  /**
   * Whether the referral domain's surfaces and loops run — see
   * `resolveReferralsEnabled`. Durable referral records are written regardless;
   * the gate follows the standing "gate the loop, never the record" rule.
   */
  readonly enabled: boolean;
  /**
   * HMAC key for signed referral link tokens (#142). Absent rather than `''`
   * when unset, so the link-token service names the missing variable instead of
   * signing with an empty key.
   */
  readonly linkTokenSecret?: string;
}

/**
 * Discovery analytics (#77).
 *
 * The whole domain is OFF by default and stays off in production until the
 * privacy and retention review #77 acceptance 8 requires has been recorded.
 * That is why `enabled` defaults to `false` while every other flag in this file
 * that gates a mature subsystem defaults to `true`: collecting nothing is the
 * safe failure, and a deployment that forgets to enable it loses telemetry
 * rather than collecting under an unreviewed policy.
 */
export interface AnalyticsConfig {
  /**
   * Whether ANY event is recorded — see `resolveAnalyticsEnabled`. Gates the
   * sink at its entry point, so with it off `recordAnalyticsEvent` returns
   * before touching a queue and no timer is started at all.
   */
  readonly enabled: boolean;
  /**
   * `off | essential | full` — the collection mode a stored row records
   * (envelope field 11). `off` and `enabled: false` are the same state
   * expressed twice, which is why `enabled` is DERIVED from this rather than
   * configured beside it: two flags for one fact could disagree, and the
   * disagreement that matters is "we thought collection was off".
   */
  readonly collectionMode: AnalyticsCollectionMode;
  /**
   * The Oxy accounts that may reach `/internal/analytics/*`. A FOURTH
   * allow-list beside payments, catalog and guest — see
   * `resolveAnalyticsOperatorIds`.
   */
  readonly operatorOxyUserIds: readonly string[];
  /**
   * DERIVED from the allow-list, exactly as the other three are: a separate
   * flag could only ever disagree with the list. Empty = not mounted (404).
   */
  readonly operatorSurfaceEnabled: boolean;
  /**
   * The hard cap on the in-process queue. When it is reached the OLDEST
   * pending events are dropped — bounded memory is the property, and losing
   * telemetry is the price. See `services/analytics/sink.ts`.
   */
  readonly queueMaxEvents: number;
  /** How often the sink writes what is queued. */
  readonly flushIntervalMs: number;
  /** How many rows one flush statement carries. */
  readonly flushBatchSize: number;
  /**
   * How long one pseudonym salt epoch lasts before a new one is opened
   * (data-lifecycle rule 7). The retired epoch's salt is then DELETED on the
   * shared expiry sweep, which is what makes rotation irreversible.
   */
  readonly pseudonymRotationHours: number;
  /**
   * The shared secret an internal client sets in `X-Mercaria-Internal-Traffic`
   * so its requests are classified `internal` and excluded from every quality
   * metric.
   *
   * Deliberately NOT an IP allow-list: an IP is one of the identifiers #77
   * forbids as an analytics dimension, and a CIDR list would have needed the
   * address recorded somewhere to be debuggable. Empty means no traffic can
   * declare itself internal, which is the safe default — the failure is a
   * smoke test appearing in a metric, not arbitrary traffic hiding from one.
   */
  readonly internalTrafficToken: string;
  /** Whether the daily rollup loop runs on this task. Gates the LOOP only. */
  readonly rollupEnabled: boolean;
  /** How often the rollup looks for a day to compute. */
  readonly rollupIntervalMs: number;
  /** How many days back a cold start will compute before giving up on a pass. */
  readonly rollupMaxBackfillDays: number;
}

export interface PostgresConfig {
  /**
   * `DATABASE_URL`. REQUIRED — every route this API serves reads Postgres.
   *
   * There is no second store, so a task without one cannot answer a single
   * request. Resolving it to `undefined` would only defer the failure from
   * startup to the first user, one "PostgreSQL is not connected" per request —
   * which reads as an outage rather than as the misconfiguration it is.
   *
   * Declared `string`, not `string | undefined`, so nothing downstream has to
   * re-check it.
   */
  readonly url: string;
  /** postgres.js pool ceiling per task. */
  readonly maxPoolSize: number;
  /** Seconds an idle pooled connection is kept before being closed. */
  readonly idleTimeoutSeconds: number;
  /** Seconds to wait for a new connection before failing the query. */
  readonly connectTimeoutSeconds: number;
  /**
   * Seconds a connection may live before being recycled. Bounded so a pool
   * behind a load balancer (RDS Proxy, a failover) cannot pin itself to a
   * retired endpoint indefinitely.
   */
  readonly maxLifetimeSeconds: number;
}

/**
 * Checkout policy that is neither an order tunable nor a payment one (#105).
 *
 * Separate from `orders` because `orders` holds the mechanics of a placed
 * order — reservation TTL, flat shipping rates, idempotency window — and this
 * holds the policy that decides whether a checkout may be ATTEMPTED at all.
 */
export interface CheckoutConfig {
  /**
   * The markets this deployment delivers to, upper-case ISO-3166 alpha-2.
   * EMPTY means unrestricted — see `resolveCheckoutDestinationCountries`.
   */
  readonly destinationCountries: readonly string[];
}

/** The retail eligibility gate's configuration (#121). */
export interface RetailEligibilityConfig {
  /**
   * The Oxy accounts that may reach `/internal/retail-eligibility/*`. A FIFTH
   * allow-list beside payments, catalog, guest and analytics — see
   * `resolveRetailOperatorIds`.
   */
  readonly operatorOxyUserIds: readonly string[];
  /**
   * DERIVED from the allow-list, exactly as the other four are: a separate flag
   * could only ever disagree with the list. Empty = not mounted (404).
   */
  readonly operatorSurfaceEnabled: boolean;
  /**
   * How far ahead the expiring-evidence dashboard looks (#121 operations 1).
   * A window, not a threshold: documents that have ALREADY expired are always
   * included, because a board that hides them looks clean while the catalogue
   * is dark.
   */
  readonly expiryHorizonDays: number;
}

export interface AppConfig {
  readonly pagination: PaginationConfig;
  readonly catalog: CatalogConfig;
  readonly offers: OffersConfig;
  readonly canonicalRollout: CanonicalRolloutConfig;
  readonly matching: MatchingConfig;
  readonly merchantClaims: MerchantClaimsConfig;
  readonly feed: FeedConfig;
  readonly cart: CartConfig;
  readonly checkout: CheckoutConfig;
  readonly orders: OrdersConfig;
  readonly fx: FxConfig;
  readonly web: WebConfig;
  readonly crowdSource: CrowdSourceConfig;
  readonly payments: PaymentsConfig;
  readonly guest: GuestConfig;
  readonly referrals: ReferralsConfig;
  readonly analytics: AnalyticsConfig;
  readonly retailEligibility: RetailEligibilityConfig;
  readonly postgres: PostgresConfig;
}

/**
 * The single, frozen application config. Import this everywhere instead of
 * inlining magic numbers or reading `process.env` directly for tunables.
 */
export const config: AppConfig = Object.freeze({
  pagination: Object.freeze({
    defaultPageSize: intEnv('PAGE_SIZE_DEFAULT', 20),
    maxPageSize: intEnv('PAGE_SIZE_MAX', 100),
  }),
  catalog: Object.freeze({
    maxVariantsPerProduct: intEnv('MAX_VARIANTS_PER_PRODUCT', 100),
    maxImagesPerListing: intEnv('MAX_IMAGES_PER_LISTING', 12),
    graphOperatorOxyUserIds: Object.freeze(resolveCatalogOperatorIds()),
    graphOperatorSurfaceEnabled: resolveCatalogOperatorIds().length > 0,
    relationshipFourEyesRequired: boolEnv('CATALOG_FOUR_EYES_REQUIRED', true),
  }),
  offers: Object.freeze({
    materializationEnabled: boolEnv('OFFER_MATERIALIZATION_ENABLED', true),
    outboxBatchSize: intEnv('OFFER_OUTBOX_BATCH_SIZE', 25),
    outboxPollIntervalMs: intEnv('OFFER_OUTBOX_POLL_INTERVAL_MS', 5_000),
  }),
  canonicalRollout: Object.freeze({
    graphEnabled: boolEnv('CANONICAL_GRAPH_ENABLED', false),
    writePublicationEnabled: boolEnv('CANONICAL_WRITE_PUBLICATION_ENABLED', false),
    reads: resolveCanonicalReadMode('CANONICAL_READS'),
    offerComparison: resolveCanonicalReadMode('CANONICAL_OFFER_COMPARISON'),
    publicRoutesEnabled: boolEnv('CANONICAL_PUBLIC_ROUTES_ENABLED', true),
    searchIndexingEnabled: boolEnv('CANONICAL_SEARCH_INDEXING_ENABLED', false),
    readCohorts: Object.freeze(resolveCanonicalReadCohorts()),
    backfillBatchSize: intEnv('CANONICAL_BACKFILL_BATCH_SIZE', 200),
    backfillPollIntervalMs: intEnv('CANONICAL_BACKFILL_POLL_INTERVAL_MS', 15_000),
  }),
  matching: Object.freeze({
    pipelineEnabled: boolEnv('MATCH_PIPELINE_ENABLED', true),
    queueBatchSize: intEnv('MATCH_QUEUE_BATCH_SIZE', 25),
    queuePollIntervalMs: intEnv('MATCH_QUEUE_POLL_INTERVAL_MS', 5_000),
    sweepBatchSize: intEnv('MATCH_SWEEP_BATCH_SIZE', 500),
    semanticEnabled: boolEnv('MATCH_SEMANTIC_ENABLED', false),
  }),
  merchantClaims: Object.freeze({
    attemptTtlHours: intEnv('MERCHANT_CLAIM_ATTEMPT_TTL_HOURS', 14 * 24),
    challengeTtlMinutes: intEnv('MERCHANT_CLAIM_CHALLENGE_TTL_MINUTES', 60 * 24),
    revalidateAfterDays: intEnv('MERCHANT_CLAIM_REVALIDATE_AFTER_DAYS', 365),
    maxAttemptsPerChallenge: intEnv('MERCHANT_CLAIM_MAX_ATTEMPTS_PER_CHALLENGE', 25),
    maxChallengesPerUserPerHour: intEnv('MERCHANT_CLAIM_MAX_CHALLENGES_PER_USER_PER_HOUR', 20),
    maxChallengesPerMerchantPerHour: intEnv(
      'MERCHANT_CLAIM_MAX_CHALLENGES_PER_MERCHANT_PER_HOUR',
      10,
    ),
    maxChallengesPerDomainPerHour: intEnv('MERCHANT_CLAIM_MAX_CHALLENGES_PER_DOMAIN_PER_HOUR', 10),
  }),
  feed: Object.freeze({
    cacheTtlSeconds: intEnv('FEED_CACHE_TTL_SECONDS', 60),
    newArrivalsSize: intEnv('FEED_NEW_ARRIVALS_SIZE', 12),
    onSaleSize: intEnv('FEED_ON_SALE_SIZE', 12),
    merchantsSize: intEnv('FEED_MERCHANTS_SIZE', 8),
    categoriesSize: intEnv('FEED_CATEGORIES_SIZE', 8),
    categoryTilesPerCard: intEnv('FEED_CATEGORY_TILES_PER_CARD', 4),
    storeCardThumbnails: intEnv('FEED_STORE_CARD_THUMBNAILS', 3),
  }),
  cart: Object.freeze({
    maxQuantityPerItem: intEnv('CART_MAX_QUANTITY_PER_ITEM', 99),
  }),
  checkout: Object.freeze({
    destinationCountries: Object.freeze(resolveCheckoutDestinationCountries()),
  }),
  orders: Object.freeze({
    reservationTtlMs: intEnv('RESERVATION_TTL_MS', 15 * MINUTE_MS),
    mockPayEnabled:
      process.env.NODE_ENV === 'production' ? false : boolEnv('MOCK_PAY_ENABLED', true),
    shippingRates: Object.freeze({
      standard: intEnv('SHIPPING_RATE_STANDARD', 500),
      express: intEnv('SHIPPING_RATE_EXPRESS', 1500),
      pickup: intEnv('SHIPPING_RATE_PICKUP', 0),
    }),
    idempotencyTtlMs: intEnv('CHECKOUT_IDEMPOTENCY_TTL_MS', 10 * MINUTE_MS),
    lowStockThreshold: intEnv('LOW_STOCK_THRESHOLD', 5),
  }),
  fx: Object.freeze({
    provider: resolveFxProvider(),
    cacheTtlSeconds: intEnv('FX_CACHE_TTL_SECONDS', 300),
    faircoinExplorerBaseUrl: strEnv('FX_FAIRCOIN_EXPLORER_BASE_URL', 'https://explorer.fairco.in'),
    requestTimeoutMs: intEnv('FX_REQUEST_TIMEOUT_MS', 5_000),
    // Dev / last-resort fallback rates (how many units of the currency ONE FAIR
    // is worth). The live provider ONLY yields FAIR→USD, so every other quote is
    // served from here. These defaults are the FAIR→USD anchor (~0.49) times an
    // approximate USD→currency rate — good enough for dev and a graceful
    // degraded fallback, but PRODUCTION MUST supply a real multi-currency FX
    // source (override each `FX_STATIC_RATE_*`, or add a multi-fiat provider);
    // do not trust these frozen approximations for real presentment.
    staticRates: Object.freeze({
      USD: numEnv('FX_STATIC_RATE_USD', 0.49),
      EUR: numEnv('FX_STATIC_RATE_EUR', 0.45),
      GBP: numEnv('FX_STATIC_RATE_GBP', 0.39),
      CAD: numEnv('FX_STATIC_RATE_CAD', 0.67),
      AUD: numEnv('FX_STATIC_RATE_AUD', 0.75),
      JPY: numEnv('FX_STATIC_RATE_JPY', 73.5),
      CHF: numEnv('FX_STATIC_RATE_CHF', 0.43),
      CNY: numEnv('FX_STATIC_RATE_CNY', 3.53),
      SEK: numEnv('FX_STATIC_RATE_SEK', 5.15),
      NOK: numEnv('FX_STATIC_RATE_NOK', 5.24),
      DKK: numEnv('FX_STATIC_RATE_DKK', 3.38),
      PLN: numEnv('FX_STATIC_RATE_PLN', 1.96),
      MXN: numEnv('FX_STATIC_RATE_MXN', 8.3),
      BRL: numEnv('FX_STATIC_RATE_BRL', 2.45),
      INR: numEnv('FX_STATIC_RATE_INR', 40.7),
      NZD: numEnv('FX_STATIC_RATE_NZD', 0.81),
      ZAR: numEnv('FX_STATIC_RATE_ZAR', 9.07),
      SGD: numEnv('FX_STATIC_RATE_SGD', 0.66),
      HKD: numEnv('FX_STATIC_RATE_HKD', 3.82),
      AED: numEnv('FX_STATIC_RATE_AED', 1.80),
    }),
  }),
  web: Object.freeze({
    origin: strEnv('WEB_URL', 'https://mercaria.co'),
  }),
  crowdSource: Object.freeze({
    enabled: resolveCrowdSourceEnabled(),
    serviceKey: strEnv('CROWDSOURCE_SERVICE_KEY', ''),
    ...(process.env.CROWDSOURCE_BASE_URL?.trim()
      ? { baseUrl: process.env.CROWDSOURCE_BASE_URL.trim() }
      : {}),
    outboxBatchSize: intEnv('CROWDSOURCE_OUTBOX_BATCH_SIZE', 50),
    outboxPollIntervalMs: intEnv('CROWDSOURCE_OUTBOX_POLL_INTERVAL_MS', 5_000),
    enforcementMode: resolveEnforcementMode(),
  }),
  payments: Object.freeze({
    outboxEnabled: boolEnv('PAYMENT_OUTBOX_ENABLED', true),
    outboxBatchSize: intEnv('PAYMENT_OUTBOX_BATCH_SIZE', 50),
    outboxPollIntervalMs: intEnv('PAYMENT_OUTBOX_POLL_INTERVAL_MS', 5_000),
    outboxLeaseMs: intEnv('PAYMENT_OUTBOX_LEASE_MS', 60_000),
    stripe: Object.freeze({
      enabled: resolveStripeEnabled(),
      secretKey: strEnv('STRIPE_SECRET_KEY', ''),
      webhookSecret: strEnv('STRIPE_WEBHOOK_SECRET', ''),
      // Spread-when-present, like `crowdSource.baseUrl`: the property is ABSENT
      // rather than an empty string, so the rotation loop can iterate the
      // secrets it actually has instead of skipping falsy ones.
      ...(process.env.STRIPE_WEBHOOK_SECRET_PREVIOUS?.trim()
        ? { webhookSecretPrevious: process.env.STRIPE_WEBHOOK_SECRET_PREVIOUS.trim() }
        : {}),
      connectWebhookSecret: strEnv('STRIPE_CONNECT_WEBHOOK_SECRET', ''),
      ...(process.env.STRIPE_CONNECT_WEBHOOK_SECRET_PREVIOUS?.trim()
        ? {
            connectWebhookSecretPrevious:
              process.env.STRIPE_CONNECT_WEBHOOK_SECRET_PREVIOUS.trim(),
          }
        : {}),
      livemode: strEnv('STRIPE_SECRET_KEY', '').startsWith('sk_live_'),
      // Spread-when-present, like the rotation secrets below: absent rather than
      // `''`, so the checkout handoff can omit the field instead of handing a
      // client an empty key it would try to initialise a payment sheet with.
      ...(process.env.STRIPE_PUBLISHABLE_KEY?.trim()
        ? { publishableKey: process.env.STRIPE_PUBLISHABLE_KEY.trim() }
        : {}),
      sellerCountries: Object.freeze(resolveStripeSellerCountries()),
      platformCurrency: resolveStripePlatformCurrency(),
      presentmentCurrencies: Object.freeze(resolveStripePresentmentCurrencies()),
      eventMaxAttempts: intEnv('STRIPE_EVENT_MAX_ATTEMPTS', 8),
      eventBatchSize: intEnv('STRIPE_EVENT_BATCH_SIZE', 50),
      eventPollIntervalMs: intEnv('STRIPE_EVENT_POLL_INTERVAL_MS', 5_000),
      eventLeaseMs: intEnv('STRIPE_EVENT_LEASE_MS', 60_000),
      // Spread-when-present, like the rotation secrets above: absent rather than
      // `''`, so `stripeOnboardingConfig()` can name exactly which variables are
      // missing instead of building a URL out of an empty string.
      ...(process.env.STRIPE_ONBOARDING_BASE_URL?.trim()
        ? { onboardingBaseUrl: process.env.STRIPE_ONBOARDING_BASE_URL.trim() }
        : {}),
      ...(process.env.STRIPE_ONBOARDING_RETURN_URL?.trim()
        ? { onboardingReturnUrl: process.env.STRIPE_ONBOARDING_RETURN_URL.trim() }
        : {}),
      ...(process.env.STRIPE_ONBOARDING_STATE_SECRET?.trim()
        ? { onboardingStateSecret: process.env.STRIPE_ONBOARDING_STATE_SECRET.trim() }
        : {}),
      accountSyncStaleAfterMs: intEnv('STRIPE_ACCOUNT_SYNC_STALE_AFTER_MS', 6 * 60 * 60 * 1_000),
      accountSyncBatchSize: intEnv('STRIPE_ACCOUNT_SYNC_BATCH_SIZE', 25),
      accountSyncIntervalMs: intEnv('STRIPE_ACCOUNT_SYNC_INTERVAL_MS', 15 * 60 * 1_000),
    }),
    reconciliation: Object.freeze({
      enabled: boolEnv('PAYMENT_RECONCILIATION_ENABLED', true),
      intervalMs: intEnv('PAYMENT_RECONCILIATION_INTERVAL_MS', 5 * MINUTE_MS),
      batchSize: intEnv('PAYMENT_RECONCILIATION_BATCH_SIZE', 100),
      openPaymentMinAgeMs: intEnv('PAYMENT_RECONCILIATION_OPEN_PAYMENT_MIN_AGE_MS', 10 * MINUTE_MS),
      lookbackMs: intEnv('PAYMENT_RECONCILIATION_LOOKBACK_MS', 7 * 24 * 60 * MINUTE_MS),
    }),
    operatorOxyUserIds: Object.freeze(resolvePaymentOperatorIds()),
    operatorSurfaceEnabled: resolvePaymentOperatorIds().length > 0,
  }),
  guest: Object.freeze({
    enabled: resolveGuestCommerceEnabled(),
    issuanceEnabled: boolEnv('GUEST_SESSION_ISSUANCE_ENABLED', true),
    cartEnabled: boolEnv('GUEST_CART_ENABLED', true),
    inlineDestinationEnabled: boolEnv('GUEST_INLINE_DESTINATION_ENABLED', true),
    operatorOxyUserIds: Object.freeze(resolveGuestOperatorIds()),
    operatorSurfaceEnabled: resolveGuestOperatorIds().length > 0,
    piiEncryptionKey: strEnv('GUEST_PII_ENCRYPTION_KEY', ''),
    emailHashKey: strEnv('GUEST_EMAIL_HASH_KEY', ''),
    sessionIdleDays: intEnv('GUEST_SESSION_IDLE_DAYS', 30),
    sessionAbsoluteDays: intEnv('GUEST_SESSION_ABSOLUTE_DAYS', 90),
  }),
  referrals: Object.freeze({
    enabled: resolveReferralsEnabled(),
    // Spread-when-present, like the Stripe onboarding secret: absent rather
    // than `''`, so the link-token service can name the missing variable
    // instead of signing with an empty key.
    ...(process.env.REFERRAL_LINK_TOKEN_SECRET?.trim()
      ? { linkTokenSecret: process.env.REFERRAL_LINK_TOKEN_SECRET.trim() }
      : {}),
  }),
  analytics: Object.freeze({
    enabled: resolveAnalyticsEnabled(),
    collectionMode: resolveAnalyticsCollectionMode(),
    operatorOxyUserIds: Object.freeze(resolveAnalyticsOperatorIds()),
    operatorSurfaceEnabled: resolveAnalyticsOperatorIds().length > 0,
    queueMaxEvents: intEnv('ANALYTICS_QUEUE_MAX_EVENTS', 10_000),
    flushIntervalMs: intEnv('ANALYTICS_FLUSH_INTERVAL_MS', 2_000),
    flushBatchSize: intEnv('ANALYTICS_FLUSH_BATCH_SIZE', 500),
    pseudonymRotationHours: intEnv('ANALYTICS_PSEUDONYM_ROTATION_HOURS', 24),
    internalTrafficToken: strEnv('ANALYTICS_INTERNAL_TRAFFIC_TOKEN', ''),
    rollupEnabled: boolEnv('ANALYTICS_ROLLUP_ENABLED', true),
    rollupIntervalMs: intEnv('ANALYTICS_ROLLUP_INTERVAL_MS', 15 * MINUTE_MS),
    rollupMaxBackfillDays: intEnv('ANALYTICS_ROLLUP_MAX_BACKFILL_DAYS', 30),
  }),
  retailEligibility: Object.freeze({
    operatorOxyUserIds: Object.freeze(resolveRetailOperatorIds()),
    operatorSurfaceEnabled: resolveRetailOperatorIds().length > 0,
    expiryHorizonDays: intEnv('RETAIL_EVIDENCE_EXPIRY_HORIZON_DAYS', 30),
  }),
  postgres: Object.freeze({
    url: resolveDatabaseUrl(),
    maxPoolSize: intEnv('PG_MAX_POOL_SIZE', 20),
    idleTimeoutSeconds: intEnv('PG_IDLE_TIMEOUT_SECONDS', 30),
    connectTimeoutSeconds: intEnv('PG_CONNECT_TIMEOUT_SECONDS', 10),
    maxLifetimeSeconds: intEnv('PG_MAX_LIFETIME_SECONDS', 1_800),
  }),
});
