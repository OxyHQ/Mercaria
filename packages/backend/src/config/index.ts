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
  CheckoutPaymentSurfaceMethod,
  CurrencyCode,
  EbayEnvironment,
  EbayMarketplaceId,
  ModerationEnforcementMode,
  SavedItemsReadMode,
} from '@mercaria/shared-types';
import {
  ALL_CURRENCY_CODES,
  ANALYTICS_COLLECTION_MODES,
  AWIN_PUBLISHER_API_CALLS_PER_MINUTE,
  CANONICAL_READ_MODES,
  CHECKOUT_PAYMENT_SURFACE_METHODS,
  EBAY_ENVIRONMENTS,
  EBAY_MARKETPLACE_IDS,
  SAVED_ITEMS_READ_MODES,
} from '@mercaria/shared-types';
import { tmpdir } from 'node:os';
import { PRINTFUL_BASE_URL } from '../services/printful/transport-contract.js';
import { join } from 'node:path';
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

/**
 * `SUPPLIER_PREFLIGHT_ENABLED`, subject to the half-configuration rule (#122).
 *
 * Enabling preflight without `SUPPLIER_PREFLIGHT_FINGERPRINT_KEY` would leave
 * the request digest unkeyed, and a country plus a postal code is a space small
 * enough to enumerate — so an unkeyed digest is an offline oracle over buyers'
 * addresses sitting in a column. The same argument `GUEST_COMMERCE_ENABLED`
 * makes for its two keys, and it resolves the same way: stay OFF and say so,
 * rather than run in a weaker mode nobody chose.
 *
 * Staying off is SAFE here in a way it would not be for a delivery queue: every
 * preflight still runs, still records its attempt and still writes a quote —
 * answering `unknown`, which blocks checkout. Nothing is silently permitted.
 */
function resolveSupplierPreflightEnabled(): boolean {
  if (!boolEnv('SUPPLIER_PREFLIGHT_ENABLED', false)) return false;

  if ((process.env.SUPPLIER_PREFLIGHT_FINGERPRINT_KEY?.trim() ?? '') !== '') return true;

  log.general.error(
    { missing: ['SUPPLIER_PREFLIGHT_FINGERPRINT_KEY'] },
    '[SupplierPreflight] SUPPLIER_PREFLIGHT_ENABLED is set but the fingerprint key is ' +
      'missing; staying OFF. Every preflight answers `unknown`, which blocks checkout.',
  );
  return false;
}

/**
 * `FEED_IMPORT_ENABLED`, subject to the half-configuration rule (#63).
 *
 * The lever gates two things and neither of them is a durable record: whether
 * the `product_feed` ADAPTER is registered (so whether any feed is fetched at
 * all) and whether the merchant surface is mounted. Configurations, mapping
 * versions, uploads and reports are stored either way, and turning the lever on
 * drains the backlog — the `CATALOG_INGESTION_ENABLED` arrangement one layer up.
 *
 * `FEED_IMPORT_AUTH_ENCRYPTION_KEY` is demanded up front rather than on first
 * use, because a feed whose download URL needs a bearer token cannot be
 * CONFIGURED without it: the credential has nowhere to go. Running without the
 * key would mean accepting authenticated-feed configurations that can never
 * fetch, and reporting each failure as a source outage.
 */
function resolveFeedImportEnabled(): boolean {
  if (!boolEnv('FEED_IMPORT_ENABLED', false)) return false;

  if ((process.env.FEED_IMPORT_AUTH_ENCRYPTION_KEY?.trim() ?? '') !== '') return true;

  log.general.error(
    { missing: ['FEED_IMPORT_AUTH_ENCRYPTION_KEY'] },
    '[FeedImport] FEED_IMPORT_ENABLED is set but the auth encryption key is missing; ' +
      'staying OFF. Stored configurations, versions and reports are untouched.',
  );
  return false;
}

/**
 * `MERCARIA_RETAIL_ENABLED`, with ADR 0004 D13's half-configuration rule.
 *
 * Both demands are things without which retail checkout would be ON and refuse
 * every line, which is worse than being off: a catalogue that shows retail
 * offers nobody can buy produces support tickets rather than an error somebody
 * fixes. See {@link MercariaRetailConfig} for why each of the two matters.
 *
 * It logs ONCE at boot and stays off, rather than throwing: refusing to boot
 * would take an otherwise healthy marketplace down over a feature that is off
 * by default.
 */
function retailSellerLegalEntityName(): string {
  return strEnv('MERCARIA_RETAIL_SELLER_LEGAL_ENTITY', '').trim();
}

/**
 * `MERCARIA_RETAIL_SELLER_COUNTRY`, upper-cased.
 *
 * Not defaulted to a market. ADR 0004 D9.9 puts the platform entity in Spain at
 * launch, and defaulting to `ES` would let a deployment that never configured
 * one write `ES` onto every receipt it issues — which is worse than being off,
 * because it is wrong in a way nobody notices until a consumer authority asks.
 */
function retailSellerLegalEntityCountry(): string {
  return strEnv('MERCARIA_RETAIL_SELLER_COUNTRY', '').trim().toUpperCase();
}

function resolveMercariaRetailEnabled(): boolean {
  if (!boolEnv('MERCARIA_RETAIL_ENABLED', false)) return false;

  const hasPreflight = resolveSupplierPreflightEnabled();
  const hasRetailOperators = resolveRetailOperatorIds().length > 0;
  // #126: a retail order's role snapshot names the selling entity, is written
  // in the buyer's own transaction, and its CHECK refuses an empty name or a
  // country that is not two upper-case letters. Demanding both here turns that
  // into a boot-time message instead of a failed checkout for the first buyer.
  const hasSeller =
    retailSellerLegalEntityName() !== '' && /^[A-Z]{2}$/.test(retailSellerLegalEntityCountry());
  if (hasPreflight && hasRetailOperators && hasSeller) return true;

  const missing = [
    hasPreflight ? undefined : 'SUPPLIER_PREFLIGHT_ENABLED',
    hasRetailOperators ? undefined : 'RETAIL_OPERATOR_OXY_USER_IDS',
    hasSeller ? undefined : 'MERCARIA_RETAIL_SELLER_LEGAL_ENTITY/MERCARIA_RETAIL_SELLER_COUNTRY',
  ].filter((name): name is string => name !== undefined);
  log.general.error(
    { missing },
    '[MercariaRetail] MERCARIA_RETAIL_ENABLED is set but the retail stack is incomplete; ' +
      'staying OFF. Placed retail orders, their procurement, refunds and reconciliation are ' +
      'unaffected — this flag gates checkout ENTRY only (ADR 0004 D4 concern 13).',
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
 * Split `STRIPE_PAYMENT_SURFACE_METHODS` into the surfaces a client may render
 * — #107's payment-method kill switch. See {@link StripeConfig.paymentSurfaceMethods}.
 *
 * VALIDATED against the closed tuple, for the reason
 * `resolveStripePresentmentCurrencies` validates its own: a surface Mercaria
 * does not know is a surface no client can render, so accepting it would put a
 * value into a handoff that every reader would then have to defend against.
 *
 * `card` is re-added whatever the variable says, and that is not a silent
 * override of an operator's intent — it is the difference between narrowing a
 * checkout and breaking it. "No card form at all" is `STRIPE_ENABLED=false`,
 * which also unmounts the webhooks and is a decision with a blast radius; a
 * method list that could produce it by typo would be an incident lever whose
 * worst failure is silent.
 */
function resolveStripePaymentSurfaceMethods(): readonly CheckoutPaymentSurfaceMethod[] {
  const raw = process.env.STRIPE_PAYMENT_SURFACE_METHODS?.trim();
  if (raw === undefined || raw === '') return [...CHECKOUT_PAYMENT_SURFACE_METHODS];

  const configured = raw
    .split(',')
    .map((method) => method.trim().toLowerCase())
    .filter((method) => method !== '');

  const known = configured.filter((method): method is CheckoutPaymentSurfaceMethod =>
    (CHECKOUT_PAYMENT_SURFACE_METHODS as readonly string[]).includes(method),
  );
  const unknown = configured.filter((method) => !(known as readonly string[]).includes(method));
  if (unknown.length > 0) {
    log.general.error(
      { unknown, known },
      '[Stripe] STRIPE_PAYMENT_SURFACE_METHODS names payment surfaces Mercaria does not know; ' +
        'they are ignored.',
    );
  }
  return known.includes('card') ? known : ['card', ...known];
}

/**
 * Split one of the `GUEST_CHECKOUT_BLOCKED_*` incident levers.
 *
 * Upper-cased or not according to what the dimension's values actually are: a
 * country code is compared upper-case, a seller key and a method name
 * lower-case. Passing that in rather than normalising both ways is what stops
 * `store:ABC` and `store:abc` being treated as one seller.
 */
function blockedListEnv(name: string, casing: 'upper' | 'lower'): readonly string[] {
  return strEnv(name, '')
    .split(',')
    .map((value) => (casing === 'upper' ? value.trim().toUpperCase() : value.trim().toLowerCase()))
    .filter((value) => value !== '');
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
/**
 * `PRODUCT_SAVE_READS` → which surfaces a saved-items read draws from (#80).
 *
 * Falls back to `off` — today's behaviour — where `resolveCanonicalReadMode`
 * falls back to `on`, and the difference is deliberate: that lever gates
 * surfaces that already SHIPPED and defaulting it off would withdraw them, while
 * this one gates a surface nobody has yet, so an unrecognised value must not
 * roll a deployment forward into it by accident.
 */
function resolveSavedItemsReadMode(): SavedItemsReadMode {
  const raw = strEnv('PRODUCT_SAVE_READS', 'off').trim().toLowerCase();
  const mode = SAVED_ITEMS_READ_MODES.find((candidate) => candidate === raw);
  if (mode !== undefined) return mode;
  log.general.error(
    { variable: 'PRODUCT_SAVE_READS', value: raw, allowed: SAVED_ITEMS_READ_MODES },
    "[config] saved-items read mode is not recognised; falling back to 'off'",
  );
  return 'off';
}

function resolveCanonicalReadMode(
  variable: string,
  fallback: CanonicalReadMode = 'on',
): CanonicalReadMode {
  const raw = strEnv(variable, fallback).trim().toLowerCase();
  const mode = CANONICAL_READ_MODES.find((candidate) => candidate === raw);
  if (mode !== undefined) return mode;
  log.general.error(
    { variable, value: raw, allowed: CANONICAL_READ_MODES, fallback },
    '[config] canonical read mode is not recognised; falling back',
  );
  return fallback;
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
 * `PROCUREMENT_OPERATOR_OXY_USER_IDS` → the supplier-preflight allow-list
 * (#122 operations 4–5).
 *
 * A SIXTH list, and the reason is the same one that made the other five
 * separate, applied to a power none of them holds: this surface reads what
 * Mercaria PAYS its suppliers — wholesale unit costs, supplier fees, quoted
 * shipping — and it flips the supplier and market kill switches. A compliance
 * reviewer vetted to verify a product-safety certificate is not thereby vetted
 * to see Mercaria's cost base, and a payments operator vetted to replay a
 * charge is not thereby vetted to turn a market back on.
 *
 * Empty means `/internal/supplier-preflight` is not mounted at all: 404, never
 * a 401 that would tell an unauthenticated caller the surface exists. That is a
 * working configuration and it means nobody can publish a sourcing policy
 * version, read a quote trace or stop a failing supplier — so it must be
 * populated before `mercaria_retail` carries a live order.
 */
function resolveProcurementOperatorIds(): readonly string[] {
  return strEnv('PROCUREMENT_OPERATOR_OXY_USER_IDS', '')
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
  /**
   * Which payment SURFACES a client may render — `STRIPE_PAYMENT_SURFACE_METHODS`,
   * defaulting to every member of `CHECKOUT_PAYMENT_SURFACE_METHODS`.
   *
   * #107's payment-method kill switch, and it is DEPLOYMENT-WIDE rather than
   * guest-scoped. ADR 0006 G2 puts both actor kinds on one `CardPaymentStep`,
   * so a wallet whose domain registration lapsed or whose sheet is broken is
   * broken for everybody — a guest-only lever would be a second answer to one
   * question, drifting from the first exactly when somebody is using it in an
   * incident.
   *
   * `card` is refused as a removal: a checkout with no way to enter a card is
   * a checkout nobody can complete, and the lever for that is `STRIPE_ENABLED`.
   * Narrowing to the empty set therefore cannot happen by typo.
   *
   * This can only ever REMOVE a surface. Adding `link` here does not add
   * Stripe's `link` payment-method TYPE to the adapter's `['card']` constant
   * (ADR 0006 G15) — Link surfaces as autofill over the card form and every
   * resulting charge is a card charge.
   */
  readonly paymentSurfaceMethods: readonly CheckoutPaymentSurfaceMethod[];
  /**
   * Where a buyer sent to their bank for authentication comes back to —
   * `STRIPE_CHECKOUT_RETURN_URL`, ADR 0006 G10.
   *
   * Configured rather than derived from the request, for the reason
   * `onboardingBaseUrl` is: `req.get('host')` behind an ALB is
   * attacker-controlled, so a return URL built from it is an open redirect with
   * a bank's own first hop in front of it.
   *
   * Optional, like the onboarding URLs and unlike the webhook secrets. Its
   * absence has no silent failure mode: `confirmPayment` runs with
   * `redirect: 'if_required'`, in-frame 3-D Secure still completes, and an
   * authentication that insists on a full redirect fails visibly in front of
   * the buyer instead of landing somewhere unintended. Requiring it would take
   * the whole rail down over a URL typo.
   */
  readonly checkoutReturnUrl?: string;
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
  /**
   * The guest-checkout rollout kill switches (#107 fraud rule 8, acceptance
   * 13). See {@link GuestCheckoutRolloutConfig}.
   */
  readonly checkoutRollout: GuestCheckoutRolloutConfig;
  /** The guest ORDER PORTAL (#108). See {@link GuestPortalConfig}. */
  readonly portal: GuestPortalConfig;
  /** Claiming a group into an Oxy account (#109). See {@link GuestClaimConfig}. */
  readonly claim: GuestClaimConfig;
}

/**
 * Claiming a guest checkout group into an Oxy account (#109, ADR 0003 D14).
 *
 * ## Three levers, and NOT ONE of them gates a stored claim
 *
 * A claim is an ownership record. Turning a lever off must never make an
 * already-claimed order stop belonging to the account that claimed it, stop
 * appearing in its history, or stop being readable by an operator — so
 * `authorizeOrderAccess`, the buyer list predicate, the claim trace and the
 * consistency probe read NONE of these, and
 * `guest-claim-isolation.test.ts` fails the build if one starts to.
 *
 *  - **`enabled`** gates the claim WRITE. This is the `GUEST_CART_ENABLED`
 *    shape rather than the outbox one: refusing a claim writes nothing at all,
 *    so there is no durable record being suppressed. What it must not do — and
 *    does not — is gate the READ of a claim already made.
 *  - **`projectionEnabled`** gates the dispatcher LOOP. Follow-up work keeps
 *    being enqueued while it is off and drains when it comes back, the
 *    moderation-outbox rule.
 *  - **`fourEyesRequired`** decides whether a revocation needs a SECOND
 *    operator, and it is snapshotted onto the request row when the request is
 *    opened (the `catalog_merge_jobs` device, #59) — so flipping it can never
 *    retroactively unapprove a correction somebody already executed, nor
 *    silently approve one already pending.
 */
export interface GuestClaimConfig {
  /**
   * `GUEST_CLAIM_ENABLED` — may a group be claimed right now. Default TRUE.
   *
   * Default true rather than false, matching `cartEnabled` and
   * `inlineDestinationEnabled`: `GUEST_COMMERCE_ENABLED` is the flag that is
   * off by default and gates the whole domain, and an inner lever defaulting
   * off would mean a deployment that turned the portal on gets a claim endpoint
   * refusing for a reason nobody chose. This is an incident lever — the case it
   * exists for is an abuse pattern in claiming specifically, where the remedy
   * must not be switching guest commerce off underneath people who have already
   * paid.
   */
  readonly enabled: boolean;
  /**
   * `GUEST_CLAIM_FOUR_EYES_REQUIRED` — must a revocation be approved by a
   * SECOND operator. Default TRUE.
   *
   * Detaching a claim is the one operator power in guest commerce that changes
   * who owns a purchase, and the shape of its misuse is a single insider
   * quietly moving somebody's order history. Default on for the reason
   * `CATALOG_FOUR_EYES_REQUIRED` is: the flag exists so a deployment with one
   * operator can function at all, not so a deployment with several can skip it.
   */
  readonly fourEyesRequired: boolean;
  /**
   * `GUEST_CLAIM_PROJECTION_ENABLED` — the follow-up dispatcher LOOP, default
   * true. Never the row.
   */
  readonly projectionEnabled: boolean;
  /** `GUEST_CLAIM_JOB_BATCH_SIZE` — rows claimed per dispatcher pass. */
  readonly jobBatchSize: number;
  /** `GUEST_CLAIM_JOB_POLL_INTERVAL_MS` — how often the dispatcher wakes. */
  readonly jobPollIntervalMs: number;
  /** `GUEST_CLAIM_JOB_LEASE_MS` — how long a claimed row stays claimed. */
  readonly jobLeaseMs: number;
  /**
   * `GUEST_CLAIM_JOB_MAX_ATTEMPTS` — attempts before `dead_letter`.
   *
   * A dead letter is VISIBLE in the claim trace, which is the point: an
   * eligibility grant that never ran is a buyer who owns a purchase and cannot
   * review it, and the alternative to a terminal state is a row retrying
   * forever with nobody looking at it.
   */
  readonly jobMaxAttempts: number;
}

/**
 * The guest order portal (#108, ADR 0003 D5/D11/D17).
 *
 * ## Nothing here gates portal ACCESS, and that is acceptance 10
 *
 * "Existing guest orders remain accessible when guest checkout creation is
 * feature-disabled later" — so the portal router mounts unconditionally, the
 * exchange resolves unconditionally, and recovery answers unconditionally. Not
 * one of the four levers above (`GUEST_COMMERCE_ENABLED`,
 * `GUEST_SESSION_ISSUANCE_ENABLED`, `GUEST_CART_ENABLED`,
 * `GUEST_INLINE_DESTINATION_ENABLED`) is read by any portal read path, and
 * `guest-portal-isolation.test.ts` fails the build if one starts to be. ADR
 * 0003 M8 states it in as many words: the flag gates issuance and guest
 * checkout, "never the durable records: existing portal grants and magic-link
 * recovery for already-placed guest orders keep working with the flag off".
 *
 * The ONE interaction worth stating, because it is a real consequence rather
 * than an oversight: `POST /guest/orders/confirmation` mints a `post_checkout`
 * grant from a live guest SESSION, and a session only resolves while
 * `GUEST_COMMERCE_ENABLED` is on. With guest commerce switched off mid-flight,
 * a buyer who has already paid reaches their orders through the emailed link
 * rather than from the tab they paid in. That is the correct trade: the
 * confirmation grant is a NEW credential derived from a credential the
 * deployment has stopped honouring.
 *
 * ## The fifth lever gates a LOOP
 *
 * `deliveryEnabled` stops the dispatcher, never the row: messages keep being
 * enqueued while it is off and drain when it is switched back on, the
 * moderation-outbox rule. An incident in which mail must stop going out is the
 * case it exists for, and losing the record of what was owed would turn a
 * two-hour pause into a permanent gap.
 */
export interface GuestPortalConfig {
  /**
   * `GUEST_PORTAL_GRANT_DAYS` — how long a portal credential lives (ADR 0003
   * D5/D11). ABSOLUTE: using a credential does not extend it, so a stolen one
   * cannot be kept alive by using it.
   */
  readonly grantDays: number;
  /**
   * `GUEST_MAGIC_LINK_MINUTES` — an exchange token's whole lifetime (D5).
   * Short because it rides in a URL, however carefully: the fragment keeps it
   * out of server and proxy logs, and nothing keeps it out of a screenshot, a
   * forwarded mail or a synced clipboard.
   */
  readonly magicLinkMinutes: number;
  /**
   * `GUEST_PORTAL_STEP_UP_MINUTES` — how recently the inbox must have been
   * proven for a sensitive mutation (#108 authorization rule 3).
   *
   * A FRESHNESS window over `email_verified_at`, not a second credential: the
   * portal session already proved the inbox, and what a step-up adds is that it
   * proved it just now. Consuming a step-up link ROTATES the session (magic-link
   * rule 9), so the window measures the newest proof rather than the oldest.
   */
  readonly stepUpMinutes: number;
  /**
   * `GUEST_MAGIC_LINK_BASE_URL` — the HTTPS universal/app-link base every
   * emailed link is built on (ADR 0003 T14).
   *
   * EMPTY by default and refused rather than defaulted: a link built on a
   * guessed host is a link that either does not work or works somewhere
   * Mercaria does not control, and a custom scheme (which a rogue app can
   * register) is not an option at all. An unset value makes every link-bearing
   * message fail with `transport_unconfigured`, visibly, instead of mailing a
   * broken URL.
   */
  readonly magicLinkBaseUrl: string;
  /**
   * `GUEST_PORTAL_MESSAGE_DELIVERY_ENABLED` — the dispatcher LOOP, default
   * true. See the interface docblock: the row is never gated.
   */
  readonly deliveryEnabled: boolean;
  /** `GUEST_PORTAL_MESSAGE_BATCH_SIZE` — rows claimed per dispatcher pass. */
  readonly messageBatchSize: number;
  /** `GUEST_PORTAL_MESSAGE_POLL_INTERVAL_MS` — how often the dispatcher wakes. */
  readonly messagePollIntervalMs: number;
  /** `GUEST_PORTAL_MESSAGE_LEASE_MS` — how long a claimed row stays claimed. */
  readonly messageLeaseMs: number;
  /**
   * `GUEST_PORTAL_MESSAGE_MAX_ATTEMPTS` — attempts before `dead_letter`.
   *
   * A dead letter is VISIBLE in the operator trace, which is the point: a
   * confirmation that never sent is a buyer who cannot find their order, and
   * the alternative to a terminal state is a row retrying forever with nobody
   * looking at it.
   */
  readonly messageMaxAttempts: number;
  /**
   * `GUEST_RECOVERY_WINDOW_MINUTES` — the durable throttle's counting window
   * (#108 recovery rule 2).
   */
  readonly recoveryWindowMinutes: number;
  /** `GUEST_RECOVERY_MAX_PER_EMAIL` — links per inbox per window. */
  readonly recoveryMaxPerEmail: number;
  /** `GUEST_RECOVERY_MAX_PER_ORDER` — attempts naming one order per window. */
  readonly recoveryMaxPerOrder: number;
  /**
   * `GUEST_RECOVERY_MAX_PER_NETWORK` — attempts from one coarse address prefix
   * per window. The WEAKEST axis deliberately: an IPv4 /24 and an IPv6 /64 are
   * shared by whole offices and carriers, so this bounds a flood and identifies
   * nobody.
   */
  readonly recoveryMaxPerNetwork: number;
}

/**
 * The independent guest-checkout kill switches — #107 acceptance 13, and every
 * one of them is a BLOCK list that is empty by default.
 *
 * ## Why block lists and not allow lists
 *
 * The house convention elsewhere (`CHECKOUT_DESTINATION_COUNTRIES`,
 * `STRIPE_PRESENTMENT_CURRENCIES`) is an allow-list whose empty value means
 * unrestricted, and that is right for a market POLICY: the set is small, known
 * and changes with a business decision. These four are not policy, they are
 * incident levers, and the two want opposite defaults. Turning one market off
 * at 3am must be adding one value, not enumerating the thirty that stay on —
 * and an allow-list with a typo silently switches everything else off, which is
 * the one failure an incident lever must not have.
 *
 * The fourth dimension #107 names — payment method — is deliberately NOT here:
 * it is `stripe.paymentSurfaceMethods`, deployment-wide, for the reason stated
 * there.
 *
 * ## None of them gates anything durable
 *
 * ADR 0006 G17: every lever here is read at the CHECKOUT REQUEST, and by
 * nothing in the webhook ingress, the outbox, settlement, refunds or
 * reconciliation. A guest checkout blocked while a PaymentIntent is already
 * open drains to a terminal state exactly as it would have, and a
 * `guest-rollout-isolation.test.ts` gate fails the build if a module in those
 * paths learns to read this config.
 */
export interface GuestCheckoutRolloutConfig {
  /**
   * `GUEST_CHECKOUT_BLOCKED_PLATFORMS` — `web`, `native`, or both.
   *
   * DERIVED from which carriage the guest credential arrived in (ADR 0003 D9:
   * cookie is web, the `X-Mercaria-Guest-Token` header is native), so it is
   * server-observed rather than read off a client-supplied name. It is still an
   * OPERATIONAL lever and not a security boundary — a native client could
   * present a cookie — which is exactly why every gate that carries security
   * weight (seller readiness, the P2P exclusion, currency, market) is derived
   * from server state and none of them is on this list.
   */
  readonly blockedPlatforms: readonly string[];
  /**
   * `GUEST_CHECKOUT_BLOCKED_MARKETS` — ISO-3166 alpha-2 destination countries.
   *
   * Composes with `CHECKOUT_DESTINATION_COUNTRIES` rather than replacing it:
   * that one is Mercaria's market policy for EVERY buyer, this one withdraws a
   * market from GUESTS while authenticated checkout there keeps working.
   */
  readonly blockedMarkets: readonly string[];
  /**
   * `GUEST_CHECKOUT_BLOCKED_SELLER_KEYS` — `store:<id>` / `user:<id>`.
   *
   * The merchant dimension. It can only ever REMOVE a seller: there is
   * deliberately no per-merchant guest OPT-IN list, because ADR 0006 G14
   * decided guest eligibility is the intersection of the gates that already
   * exist ("a store payment-ready for Oxy buyers is payment-ready for guests")
   * and an opt-in list would be a second, drifting answer to the question
   * `onboarding_state` already answers.
   */
  readonly blockedSellerKeys: readonly string[];
  /**
   * `GUEST_CHECKOUT_BLOCKED_FULFILMENT_METHODS` — `standard`, `express`,
   * `pickup`.
   *
   * The fulfilment-path dimension. `pickup` is already refused for every actor
   * by the #93 seam, so blocking it changes nothing today; it is on the list
   * because the lever must exist before the path does, not after.
   */
  readonly blockedFulfilmentMethods: readonly string[];
  /**
   * `GUEST_SELLER_ACTIVATION_REQUIRED` — the #85 seam, default FALSE.
   *
   * #85 owns merchant activation readiness and has not landed, so no seller
   * carries an activation record and nothing can invent one. Turning this ON
   * therefore refuses EVERY guest checkout, by name, until #85 supplies the
   * state — which is the fail-closed direction and the whole point of shipping
   * the lever now: the seam cannot be satisfied by accident, and the day #85
   * lands its author changes one function body rather than discovering that
   * guest checkout had been quietly ignoring merchant activation all along.
   *
   * OFF by default because that is ADR 0006 G14's decision, not an omission:
   * at launch there is no per-merchant guest activation concept, and defaulting
   * this on would refuse a checkout the ADR says is eligible.
   */
  readonly sellerActivationRequired: boolean;
  /**
   * `GUEST_CHECKOUT_BLOCKED_SUPPLIERS` — supplier ids, the #123 axis.
   *
   * A FIFTH block list, and it exists because guest eligibility for a
   * `mercaria_retail` line is a question about a SUPPLIER, not about a seller:
   * every retail order names Mercaria as its seller, so
   * `blockedSellerKeys` above cannot express "signed-out buyers may not order
   * from this supplier while we investigate its fulfilment" — it would take
   * every retail sale off with it.
   *
   * Like its four siblings it can only ever REMOVE, is empty by default, and is
   * an incident lever rather than a policy surface: withdrawing one supplier
   * from guest checkout at 3am must be adding one value, and an allow-list typo
   * would silently switch the rest off.
   */
  readonly blockedSuppliers: readonly string[];
}

/**
 * Mercaria-retail native checkout (#123, ADR 0004 D13).
 *
 * ## `enabled` gates ENTRY and nothing else, and that is the whole design
 *
 * ADR 0004 D4 concern 13 is explicit: the flag gates offer visibility and NEW
 * retail checkouts. It never gates the outbox, the purchase-order
 * orchestration, refunds or reconciliation, because a rollback that stranded
 * those would leave buyers who had already been charged with no procurement and
 * no refund — the failure the flag exists to avoid.
 *
 * This is the payment domain's standing "gate the loop, never the durable
 * record" with ENTRY as the gated thing, and it is enforced structurally rather
 * than by care: `retail-checkout-isolation.test.ts` fails the build if the
 * payment outbox handlers, the procurement trigger, the compensating-refund
 * path or the authorization reader learn to read `config.retail.enabled`.
 *
 * ## Half-configured is OFF, and the two demands are not decoration
 *
 * `MERCARIA_RETAIL_ENABLED=true` requires supplier preflight to be enabled and
 * an eligibility operator list to exist — the `CROWDSOURCE_ENABLED` validation
 * pattern. Without preflight every retail line refuses at checkout anyway
 * (#122's quote answers `unknown` with the loop off), so enabling retail
 * without it produces a catalogue of items nobody can buy and no message saying
 * why. Without `RETAIL_OPERATOR_OXY_USER_IDS` nobody can publish an eligibility
 * policy version, so `getRetailEligibility` answers `unknown`/`policy_missing`
 * for every line — the same outcome, from the other end.
 *
 * ## `blockedSuppliers` / `blockedMarkets` are #123's own incident levers
 *
 * Separate from the guest lists above because they apply to EVERY buyer: a
 * supplier whose fulfilment has failed must stop selling to account holders
 * too. Both are block lists, both empty by default, and a refusal names
 * NEITHER — one reason code (`retail_disabled`) covers the flag and both lists,
 * so a client cannot map the switchboard one input at a time (ADR 0006's rule,
 * reused).
 */
export interface MercariaRetailConfig {
  /** `MERCARIA_RETAIL_ENABLED`, default FALSE (ADR 0004 D13's shipped default). */
  readonly enabled: boolean;
  /** `RETAIL_BLOCKED_SUPPLIERS` — supplier ids withdrawn from sale entirely. */
  readonly blockedSuppliers: readonly string[];
  /** `RETAIL_BLOCKED_MARKETS` — ISO-3166 alpha-2 destinations withdrawn from sale. */
  readonly blockedMarkets: readonly string[];
  /**
   * `MERCARIA_RETAIL_SELLER_LEGAL_ENTITY` — the legal entity named as seller on
   * every `mercaria_retail` order (#126 order-role snapshot item 1).
   *
   * Deployment configuration rather than a code constant because it is a
   * real-world fact about whoever is running this deployment, and a wrong one
   * is on a receipt. It is demanded by the half-configuration rule below: a
   * retail order's role snapshot is written in the buyer's own transaction and
   * its CHECK refuses an empty entity name, so a deployment that cannot name
   * its seller would fail at the moment a buyer paid rather than at boot.
   */
  readonly sellerLegalEntityName: string;
  /** `MERCARIA_RETAIL_SELLER_COUNTRY` — ISO-3166-1 alpha-2 of that entity. */
  readonly sellerLegalEntityCountry: string;
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
   * Whether a high-impact canonical-graph act needs a SECOND operator's approval
   * — `CATALOG_FOUR_EYES_REQUIRED`, defaulting ON.
   *
   * TWO domains read it and it is deliberately ONE field: verifying a
   * badge-producing relationship (#55) and merging or splitting a canonical
   * entity (#59) are the same kind of decision — irreversible in practice,
   * invisible to the person it affects — and a deployment that wants one gated
   * wants the other. A second variable would be a second thing to keep in step
   * for a distinction nobody has drawn.
   *
   * Fail-closed is the right default here specifically because the artefact is a
   * public claim about who a shopper is dealing with: an "Official store" badge
   * minted in error misleads a buyer and is invisible to them, so the cost of
   * requiring a second pair of eyes is a delay and the cost of not requiring one
   * is a false statement. The merge half is the same argument with the artefact
   * changed: a wrong merge ends an identity, and the seller whose sales landed
   * on somebody else's page finds out months later. A single-operator deployment
   * turns it off deliberately, rather than discovering it was never on.
   */
  readonly fourEyesRequired: boolean;
  /**
   * Whether the #59 curation dispatcher RUNS — `CURATION_JOBS_ENABLED`,
   * defaulting on.
   *
   * It gates the LOOP and nothing else. An operator may still request a merge
   * with it off; the job sits `pending` and runs when it comes back. Gating the
   * REQUEST instead would silently lose work somebody thought they had
   * scheduled, which is the inversion the payment and moderation outboxes
   * already record.
   */
  readonly curationJobsEnabled: boolean;
  /** How many merge and split jobs one dispatcher pass claims. */
  readonly curationBatchSize: number;
  /** How often the dispatcher looks for work. */
  readonly curationPollIntervalMs: number;
}

/**
 * Canonical product saves (#80).
 *
 * THREE independent levers, and the interaction is the point (#80 acceptance
 * 8): `enabled` decides whether the surface exists at all, `readMode` decides
 * what a saved list is made of, and `migrationApplyEnabled` decides whether the
 * migration may WRITE.
 *
 * - `enabled=false` is the full withdrawal: `/product-saves` and `/saved-items`
 *   404, `/favorites` is untouched, and a deployment behaves exactly as it did
 *   before #80. Saves already stored are not deleted and not gated — turning it
 *   back on restores them.
 * - `readMode` is the rollback INSIDE an enabled deployment. `off` serves the
 *   listing saves a buyer had before #80 and nothing else; `dual` serves both,
 *   which is the comparison window; `on` serves product saves plus the listing
 *   saves no product save represents. `on` never drops an unmatched P2P
 *   favorite — see `SavedItemsReadMode`, where the reasoning belongs.
 * - `migrationApplyEnabled=false` downgrades every migration request to a DRY
 *   RUN that reports what it would do. The #60 `CANONICAL_WRITE_PUBLICATION_ENABLED`
 *   shape: the request is always answerable, only the write is gated, so an
 *   operator can measure the migration before authorising it.
 */
export interface ProductSavesConfig {
  /** `PRODUCT_SAVES_ENABLED` — mounts `/product-saves` and `/saved-items`. */
  readonly enabled: boolean;
  /** `PRODUCT_SAVE_READS` — `off | dual | on`. */
  readonly readMode: SavedItemsReadMode;
  /** `PRODUCT_SAVE_MIGRATION_ENABLED` — may a migration page WRITE? */
  readonly migrationApplyEnabled: boolean;
  /** How many favorites one migration page examines. */
  readonly migrationBatchSize: number;
  /** How many aggregate rows one counter sweep page examines. */
  readonly counterSweepBatchSize: number;
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

/**
 * The external ingestion framework (#62).
 *
 * `CATALOG_INGESTION_ENABLED` gates the LOOP and never the durable record — the
 * `CROWDSOURCE_ENABLED` rule. A source can be configured, its policy reviewed
 * and published, and a manual run opened while the dispatcher is off; turning it
 * on drains the backlog rather than stranding it.
 *
 * There is deliberately NO flag over the rights, the tables or the operator
 * surface. Rights are per-source and versioned, which is a finer instrument than
 * a global switch and the one an incident actually needs; and the evidence has
 * to stay readable during the incident that turned the loop off, which is why
 * `/internal/ingestion` stays mounted whatever this flag says.
 */
export interface CatalogIngestionConfig {
  /** `CATALOG_INGESTION_ENABLED` — does the dispatcher run. */
  readonly enabled: boolean;
  /** How many sources one dispatcher tick claims. */
  readonly batchSize: number;
  /** How often the dispatcher polls, in milliseconds. */
  readonly pollIntervalMs: number;
  /** How long a source or run lease lasts. Long enough for one page. */
  readonly leaseMs: number;
  /** The ceiling on the exponential backoff between failed refreshes. */
  readonly maxBackoffMs: number;
  /** How many unseen objects one closing run may retire. */
  readonly retirementBatchSize: number;
  /**
   * How far a price may move before the observation is quarantined instead of
   * applied (#62 health 8). A ratio, either direction: 20 means a twentyfold
   * rise or a twentyfold fall.
   */
  readonly anomalyPriceFactor: number;
}

/**
 * #68 — source-aware refresh scheduling, expiry and catalogue health.
 *
 * Note what is NOT here, deliberately: there is no default TTL, no default
 * warning threshold and no default expiry. Every freshness duration is a
 * property of ONE source and lives on that source's row, and
 * `services/offer-freshness/policy.ts` imports no configuration at all so the
 * temptation cannot be acted on — `freshness-isolation.test.ts` fails the build
 * if it ever is. What lives here is the LOOP's shape: how often it polls, how
 * many tasks it claims, how long it holds a lease.
 */
/**
 * Offer ranking (#74).
 *
 * ONE lever, and it deliberately gates neither a durable record nor the
 * comparison surface itself. Ranking is DERIVED at read time from offers this
 * domain never writes, so the rollback acceptance 7 asks for is activating an
 * earlier policy version — a row, not an environment variable. What an incident
 * needs instead is a way to stop routing anybody to a canary WITHOUT editing the
 * row, so the canary can be resumed once the cause is understood; that is this.
 *
 * There is deliberately no `RANKING_ENABLED`. Turning ranking off would leave
 * the comparison surface with no defined order at all, and a deployment that has
 * published no policy already has one — `BUILTIN_RANKING_POLICY`, a named
 * version every impression records.
 */
export interface RankingConfig {
  /**
   * `RANKING_CANARY_ENABLED` — may a `canary` policy version serve anybody.
   *
   * Defaults TRUE, which is not a rollout decision: a canary exists only because
   * an operator created one, and requiring a second switch to make their own
   * creation take effect is the half-configuration trap this codebase refuses
   * elsewhere. Setting it false pins every comparison to the active arm and
   * leaves the canary row exactly as it was.
   */
  readonly canaryEnabled: boolean;
}

/**
 * Currency-safe price history (#78).
 *
 * ## The anchor interval is NOT the global TTL #68 forbids
 *
 * #68's prohibition is on a deployment-wide FRESHNESS LIFETIME — how long a
 * source's facts stay trustworthy — because that is a property of an agreement
 * with one source, and one number cannot be right for eBay's licence, an
 * Amazon-style 24-hour cap and an Awin feed at once. `anchorIntervalSeconds` is
 * a property of Mercaria's own STORAGE: how often it is prepared to write a row
 * saying nothing changed. It cannot extend how long anything is SHOWN, and it
 * is the same class as a poll interval, which #68 explicitly permits to be
 * deployment-wide.
 *
 * ## `seriesCurrencies` is EMPTY by default, and that is the rollout position
 *
 * With no currencies configured, every observation is still written and NO
 * series is enqueued — the durable record is never gated and the derived answer
 * is (the "gate the loop, never the record" rule applied one level up). A
 * deployment lists the currencies it will actually serve charts in; there is no
 * hard-coded default currency here, because #78 forbids adding a
 * FairCoin-specific assumption and a default of any single code would be one.
 */
export interface PriceHistoryConfig {
  /** `PRICE_HISTORY_ENABLED` — does the rebuild dispatcher run. Gates the LOOP only. */
  readonly enabled: boolean;
  /** `PRICE_HISTORY_PUBLIC_READS_ENABLED` — is `/price-history` mounted at all. */
  readonly publicReadsEnabled: boolean;
  /** Which display currencies this deployment builds series in. Empty = none. */
  readonly seriesCurrencies: readonly CurrencyCode[];
  /** How long an identical observation is suppressed before it is written as an anchor. */
  readonly anchorIntervalSeconds: number;
  /** How far back a rebuild looks, and the oldest range a read may ask for. */
  readonly retentionWindowDays: number;
  /** The widest span one read may request. */
  readonly maxQuerySpanDays: number;
  /** How many observations one rebuild may pull into the process. */
  readonly rebuildObservationLimit: number;
  readonly rebuildBatchSize: number;
  readonly rebuildPollIntervalMs: number;
  readonly rebuildLeaseMs: number;
  readonly rebuildMaxBackoffMs: number;
  /** How many observations an operator trace returns for one offer. */
  readonly traceLimit: number;
}

/**
 * Price alerts (#79).
 *
 * THREE independent levers, and the middle one is issue operations 5's "global
 * notification kill switch independent of alert storage" — which is why it is
 * separate from the other two rather than folded into `enabled`. With alerts
 * enabled, evaluation running and notifications OFF, alerts keep being
 * evaluated and triggers keep being written; nothing is delivered and nothing
 * is lost, so flipping it back drains the backlog.
 *
 * NOT ONE of the three gates a durable record. `price-alert-isolation.test.ts`
 * fails the build if the trigger writer, the evaluation enqueue or the
 * notification enqueue learns to read one.
 */
export interface PriceAlertsConfig {
  /** `PRICE_ALERTS_ENABLED` — is the buyer surface mounted at all. */
  readonly enabled: boolean;
  /** `PRICE_ALERT_EVALUATION_ENABLED` — does the evaluator run. The LOOP only. */
  readonly evaluationEnabled: boolean;
  /** `PRICE_ALERT_NOTIFICATIONS_ENABLED` — the kill switch. The LOOP only. */
  readonly notificationsEnabled: boolean;
  /** Issue abuse rule 1: how many non-deleted alerts one account may hold. */
  readonly maxActivePerUser: number;
  /** Issue abuse rule 1: how many an account may create per window. */
  readonly createRateLimit: number;
  readonly createRateWindowMs: number;
  readonly evaluationBatchSize: number;
  readonly evaluationPollIntervalMs: number;
  readonly evaluationLeaseMs: number;
  readonly evaluationMaxBackoffMs: number;
  /** How many offers one comparison read pulls per subject. */
  readonly evaluationOfferLimit: number;
  readonly notificationBatchSize: number;
  readonly notificationPollIntervalMs: number;
  readonly notificationLeaseMs: number;
  readonly notificationMaxBackoffMs: number;
  /** After this many failed attempts a delivery becomes a visible `dead_letter`. */
  readonly notificationMaxAttempts: number;
  /** How many rows an operator trace returns for one alert. */
  readonly traceLimit: number;
}

export interface OfferFreshnessConfig {
  /** `OFFER_REFRESH_ENABLED` — does the refresh dispatcher run. Gates the LOOP only. */
  readonly refreshEnabled: boolean;
  /** How many refresh tasks one dispatcher tick claims. */
  readonly refreshBatchSize: number;
  /** How often the refresh dispatcher polls, in milliseconds. */
  readonly refreshPollIntervalMs: number;
  /** How long a refresh task lease lasts. Long enough for one provider call. */
  readonly refreshLeaseMs: number;
  /** The ceiling on the exponential backoff between refused refresh attempts. */
  readonly refreshMaxBackoffMs: number;
  /**
   * Concurrency and per-minute allowance a source gets when its own config
   * states none.
   *
   * NOT a freshness duration: it is how hard Mercaria may knock, which is a
   * property of Mercaria's own politeness rather than of any source's contract.
   * A source that publishes its own limits carries them on
   * `catalog_source_configs`, and those always win.
   */
  readonly defaultRefreshConcurrency: number;
  readonly defaultRefreshCallsPerMinute: number;
  /** `OFFER_EXPIRY_SWEEP_ENABLED` — does the expiry sweep run. Gates the LOOP only. */
  readonly expirySweepEnabled: boolean;
  /** How many offers one expiry sweep pass may retire. */
  readonly expirySweepBatchSize: number;
  /** How often the expiry sweep runs, in milliseconds. */
  readonly expirySweepIntervalMs: number;
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
   * `CANONICAL_SEARCH` — #70's canonical multi-entity discovery, `off` by
   * default.
   *
   * The exception to the paragraph above, and it proves the rule rather than
   * breaking it: the read levers default to TODAY'S BEHAVIOUR, and today's
   * behaviour for `GET /search` is that it does not exist. `off` and `shadow`
   * both answer 404 and leave `GET /listings` — the listing-first search #70
   * replaces — serving exactly as it does now, which is what makes the rollback
   * in #70 acceptance 8 one environment variable.
   */
  readonly search: CanonicalReadMode;
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

/**
 * Live supplier preflight (#122).
 *
 * Four independent levers, and the interaction is the part worth stating:
 *
 *  - `enabled` gates whether a PROVIDER IS CALLED at all. Off, every preflight
 *    still runs, still records its attempt and still writes a durable quote —
 *    one whose availability is `unknown` and whose block reason is
 *    `preflight_disabled`, so checkout refuses. That is deliberately NOT the
 *    "gate the loop, never the record" shape: there is no durable record being
 *    withheld here, only a supplier not being asked, and the answer to not
 *    having asked is `unknown`, which is exactly what the domain's honesty rule
 *    requires.
 *  - `sweepEnabled` gates the LOOP that releases lapsed holds and evaluates
 *    health. Off, holds still lapse on the supplier's own clock and quotes
 *    still expire against theirs — what stops is Mercaria recording it, which
 *    is the ordinary outbox inversion.
 *  - `fakeAdapterEnabled` is the failure-injection tooling (#122 operations 8).
 *    It is double-gated: this flag AND the supplier account being in the `test`
 *    environment, so a `live` account can never be served a fabricated answer
 *    however the flag is set.
 *  - `fingerprintKey` is demanded whenever `enabled` is true — the
 *    half-configuration rule `GUEST_COMMERCE_ENABLED` established. An unset key
 *    would mean an unkeyed request digest, which is an offline oracle over
 *    buyers' postal codes.
 */
export interface SupplierPreflightConfig {
  /** `SUPPLIER_PREFLIGHT_ENABLED` — may an adapter be called. Default false. */
  readonly enabled: boolean;
  /** `SUPPLIER_PREFLIGHT_SWEEP_ENABLED` — does the release/health loop run. */
  readonly sweepEnabled: boolean;
  readonly sweepIntervalMs: number;
  readonly sweepBatchSize: number;
  /** How many times a lapsed hold's release is retried before it is left visible. */
  readonly maxReleaseAttempts: number;
  /** `SUPPLIER_PREFLIGHT_FAKE_ADAPTER_ENABLED` — the failure-injection adapter. */
  readonly fakeAdapterEnabled: boolean;
  /** HMAC key for the request digest. 64 hex characters; validated on first use. */
  readonly fingerprintKey: string;
  /**
   * The Oxy accounts that may reach `/internal/supplier-preflight/*`. A SIXTH
   * allow-list — see `resolveProcurementOperatorIds`.
   */
  readonly operatorOxyUserIds: readonly string[];
  /** DERIVED from the allow-list. Empty = not mounted (404). */
  readonly operatorSurfaceEnabled: boolean;
}

/**
 * The supplier ORDER orchestration (#124).
 *
 * THREE independent loop levers, and the independence is the point (#124
 * polling and webhooks 10: "keep provider fetch and public-order projection
 * independently pausable"):
 *
 *  - {@link orchestrationEnabled} gates the dispatcher that SUBMITS and CANCELS.
 *    Off, a paid retail order's job is parked and delivers when it is back on.
 *  - {@link providerFetchEnabled} gates OUTBOUND reads — polling and status
 *    lookups. Off, webhooks are still received and still stored; Mercaria just
 *    stops asking.
 *  - {@link eventProcessingEnabled} gates APPLYING stored events, which is what
 *    moves a purchase order and therefore what a customer sees. Off, events
 *    accumulate durably and nothing customer-visible changes.
 *
 * None of the three gates a durable record, and a static gate fails the build
 * if one starts to. The PER-SUPPLIER kill switch is a different mechanism
 * entirely — `supplier_accounts.state = 'killed'` (#118) — and stops NEW
 * submissions while status, cancellation, return and reconciliation keep
 * working, which is #124 acceptance 5.
 */
export interface ProcurementConfig {
  /** `PROCUREMENT_ORCHESTRATION_ENABLED` — the submit/cancel dispatcher. Default false. */
  readonly orchestrationEnabled: boolean;
  /** `PROCUREMENT_PROVIDER_FETCH_ENABLED` — outbound status reads and polling. */
  readonly providerFetchEnabled: boolean;
  /** `PROCUREMENT_EVENT_PROCESSING_ENABLED` — applying stored provider events. */
  readonly eventProcessingEnabled: boolean;
  readonly outboxBatchSize: number;
  readonly outboxPollIntervalMs: number;
  readonly outboxLeaseMs: number;
  readonly eventBatchSize: number;
  readonly eventPollIntervalMs: number;
  readonly eventLeaseMs: number;
  /** Never poll one purchase order more often than this — the provider's limit. */
  readonly pollMinIntervalMs: number;
  /** How long a TERMINAL order keeps being confirmed before polling stops. */
  readonly pollTerminalGraceMs: number;
  /** How long a provider may go silent before `event_lag_sla_breach` is raised. */
  readonly eventLagSlaMs: number;
  /** The deadline every provider call carries. */
  readonly callTimeoutMs: number;
  /** How old an unresolved attempt must be before the converger picks it up. */
  readonly convergenceGraceMs: number;
  /** `PROCUREMENT_FAKE_ADAPTER_ENABLED` — the conformance/rehearsal adapter. */
  readonly fakeAdapterEnabled: boolean;
}

/**
 * The universal product-feed importer (#63).
 *
 * Every bound here is a REFUSAL threshold rather than a tuning knob: a feed that
 * exceeds one is rejected with the limit named, never truncated. Truncating a
 * feed produces a completed enumeration over half a catalogue, which is the one
 * shape that retires the other half.
 */
/**
 * The Awin retailer-network source (#66).
 *
 * `AWIN_ENABLED` gates the ADAPTER's registration and nothing durable: accounts,
 * advertisers, feeds, quality snapshots, samples and every #62 row are stored
 * and readable either way, every run refuses with #62's own `adapter_missing`,
 * and turning it on drains the backlog.
 *
 * **It deliberately does NOT demand a credential**, unlike `FEED_IMPORT_ENABLED`
 * and unlike the half-configuration rule elsewhere in this file. The difference
 * is real: #63 demands its encryption key because a feed's credential has
 * nowhere to GO without it, so a configuration would be unstorable. Awin's key
 * is a LOCATOR on a row — storable and reviewable with no key present — and a
 * deployment that registered the adapter before the locator resolves gets an
 * honest `auth_failure` naming the missing secret rather than a silent no-op.
 *
 * `networkCallsPerMinute` defaults to Awin's own published limit rather than to
 * a Mercaria guess, and it binds the FLEET: the lease that enforces it is keyed
 * on the publisher ACCOUNT, because with one Mercaria source per advertiser a
 * per-source budget bounds each advertiser separately and the network not at
 * all.
 */
export interface AwinConfig {
  /** `AWIN_ENABLED` — register the adapter. Never gates a durable record. */
  readonly enabled: boolean;
  /** Where the product-data feed list and downloads live. */
  readonly feedListBaseUrl: string;
  /** Where the Publisher API lives. #67 spends it; #66 calls it from nowhere. */
  readonly publisherApiBaseUrl: string;
  /** Concurrent calls to Awin, across the whole fleet. The lease slot count. */
  readonly networkConcurrency: number;
  /** The account's whole per-minute allowance, divided evenly across slots. */
  readonly networkCallsPerMinute: number;
  /** How long one network lease is held before another task may reclaim it. */
  readonly networkLeaseMs: number;
  /** Header timeout for the feed-list read. A product feed uses #63's. */
  readonly listTimeoutMs: number;
  /** Rows a pre-activation destination/tracking sample examines. */
  readonly sampleSize: number;
}

export interface FeedImportConfig {
  /** `FEED_IMPORT_ENABLED` — register the adapter and mount the merchant surface. */
  readonly enabled: boolean;
  /** AES-256-GCM key for a feed's stored credential. 64 hex chars; validated on first use. */
  readonly authEncryptionKey: string;
  /** Where a fetched feed and an upload are staged on the task's own disk. */
  readonly stagingDir: string;
  /** Hard cap on bytes read from a source, BEFORE decompression. */
  readonly maxDownloadBytes: number;
  /** Hard cap on bytes produced BY decompression — half of the bomb defence. */
  readonly maxDecompressedBytes: number;
  /** Cap on decompressed ÷ compressed — the other half; either alone is defeatable. */
  readonly maxCompressionRatio: number;
  /** Cap on records in one feed. A feed past it is refused, never truncated. */
  readonly maxRecords: number;
  /** Cap on ONE record's serialized size. Bounds the parser's own memory. */
  readonly maxRecordBytes: number;
  /** Time-to-first-byte deadline for a feed fetch. */
  readonly fetchTimeoutMs: number;
  /** How long a staged artefact survives before the sweep removes it. */
  readonly stageTtlMs: number;
  /** How many records a preview reads. Bounded by definition (issue Mapping UX 1). */
  readonly previewSampleSize: number;
  /** How many report entries one pass may write before it stops recording detail. */
  readonly maxReportEntries: number;
}

/**
 * The eBay Browse catalog source (#65, the provider #64 selected).
 *
 * ## Two switches that are deliberately NOT the same lever
 *
 * Issue #65 adapter rule 10 asks for "a hard kill switch for fetch and a
 * separate public-display switch", and they are separate here — but only one of
 * them is an environment variable, on purpose.
 *
 * `EBAY_FETCH_ENABLED` is the FETCH kill switch: deployment-wide, in front of
 * every per-source right, and the thing somebody flips at 3am when eBay pages
 * about traffic. The adapter answers it with a RETRYABLE outage, so #62 releases
 * the run with its cursor intact, moves no health, retires nothing, and resumes
 * from the same page the moment it is flipped back.
 *
 * The DISPLAY switch is `may_display` on the source's own rights policy (#62) —
 * versioned, per source, reviewed and attributable. It is not an environment
 * variable because withdrawing display is a rights decision with a paper trail
 * and a per-market grain, where stopping fetch is a deployment lever. Making it
 * an env var too would create a second answer to a question `catalog_source_policies`
 * already answers, and the two could disagree.
 *
 * ## `EBAY_MARKETS` is an ALLOW-list, unlike the guest-rollout block lists
 *
 * ADR 0006's kill switches are block lists because they are incident levers and
 * an allow-list typo silently switches everything else off. This is the opposite
 * kind of thing: issue #65 acceptance 7 asks that "public rollout starts with a
 * bounded category or market cohort before full enablement", so the default has
 * to be the SMALLEST set rather than the largest. It defaults to `EBAY_ES`,
 * which is #64's launch market, and widening it is a deliberate act.
 *
 * A value outside `EBAY_MARKETPLACE_IDS` is dropped rather than passed through:
 * every member of that tuple costs a rights review, an EPN campaign and a
 * category cohort, and a marketplace nobody reviewed is a marketplace Mercaria
 * has no terms for.
 */
export interface EbayConfig {
  /** `EBAY_ENABLED` — is the adapter registered at all. Default false. */
  readonly enabled: boolean;
  /** `EBAY_FETCH_ENABLED` — the HARD fetch kill switch. Default true. */
  readonly fetchEnabled: boolean;
  /** `EBAY_ENVIRONMENT` — `sandbox` or `production`. A sandbox keyset never feeds public pages. */
  readonly environment: EbayEnvironment;
  /** The marketplaces this deployment may query. The rollout cohort; defaults to ES. */
  readonly markets: readonly EbayMarketplaceId[];
  /** `EPN_CAMPAIGN_ID` — ten digits. Empty means run unattributed, which is a working state. */
  readonly campaignId: string;
  /** DERIVED: attribution is only requested when the campaign id is one EPN could have issued. */
  readonly attributionEnabled: boolean;
  /** `EBAY_DAILY_CALL_LIMIT` — the allowance each budget day is measured against. */
  readonly dailyCallLimit: number;
  /** How many tracked items one reconciliation sweep re-reads. */
  readonly reconciliationSampleSize: number;
}

/**
 * The Printful supplier integration (#125), the provider #119 selected.
 *
 * `PRINTFUL_ENABLED` gates the REGISTRATION of the two adapters and nothing
 * durable: supplier accounts, agreements, procurement offers, purchase orders,
 * quotes and every #62 row are stored and readable either way. With it off,
 * every preflight answers `provider_unconfigured` (which blocks) and every
 * purchase order refuses with `adapter_missing`, and turning it on drains the
 * backlog — the `AWIN_ENABLED` arrangement.
 *
 * **It deliberately demands NO credential**, for Awin's reason rather than
 * #63's: Printful's token is a LOCATOR on a `supplier_accounts` row (an SSM
 * path), so an account is storable and reviewable with no secret present, and a
 * deployment that registers the adapter before the locator resolves gets an
 * honest refusal naming the missing secret rather than a silent no-op.
 *
 * **There is no `PRINTFUL_ENVIRONMENT` variable, and none may be added.** A
 * supplier account carries its own `environment`, frozen by trigger (#124), and
 * a deployment-wide variable able to disagree with it is the one shape that
 * could point a live account at a rehearsal — the `CROWDSOURCE_APP_ID` rule.
 * Whether a call may go live is decided by the account plus the presence of a
 * provisioned credential, which is a fact a flag cannot fake.
 */
export interface PrintfulConfig {
  /** `PRINTFUL_ENABLED` — register the adapters. Never gates a durable record. */
  readonly enabled: boolean;
  /** The API root. A code default; overridable only to point a rehearsal elsewhere. */
  readonly baseUrl: string;
}

/**
 * Buyer post-purchase requests — cancellations, returns and support (#110).
 *
 * THREE levers and none of them gates a durable record. See the value block at
 * the bottom of this file for what each one stops.
 */
export interface BuyerRequestsConfig {
  /** Gates the buyer-facing WRITE paths. Reads and decisions stay open. */
  readonly requestsEnabled: boolean;
  /** Gates the refund-settlement sweep LOOP, never a row. */
  readonly reconcilerEnabled: boolean;
  readonly reconcileIntervalMs: number;
  readonly reconcileBatchSize: number;
  readonly reconcileGraceMs: number;
}

export interface AppConfig {
  readonly pagination: PaginationConfig;
  readonly catalog: CatalogConfig;
  readonly productSaves: ProductSavesConfig;
  readonly offers: OffersConfig;
  readonly canonicalRollout: CanonicalRolloutConfig;
  readonly matching: MatchingConfig;
  readonly catalogIngestion: CatalogIngestionConfig;
  readonly offerFreshness: OfferFreshnessConfig;
  readonly ranking: RankingConfig;
  readonly priceHistory: PriceHistoryConfig;
  readonly priceAlerts: PriceAlertsConfig;
  readonly feedImport: FeedImportConfig;
  readonly ebay: EbayConfig;
  readonly awin: AwinConfig;
  readonly printful: PrintfulConfig;
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
  readonly buyerRequests: BuyerRequestsConfig;
  readonly analytics: AnalyticsConfig;
  readonly retailEligibility: RetailEligibilityConfig;
  readonly supplierPreflight: SupplierPreflightConfig;
  readonly procurement: ProcurementConfig;
  readonly retail: MercariaRetailConfig;
  readonly postgres: PostgresConfig;
}

/**
 * `EBAY_MARKETS` → the marketplaces this deployment may query.
 *
 * An ALLOW-list defaulting to the launch market alone (#65 acceptance 7). A
 * value the tuple does not name is DROPPED rather than passed through: every
 * marketplace costs a rights review, an EPN campaign and a category cohort, so
 * one nobody reviewed is one Mercaria has no terms for. An entirely unrecognised
 * list therefore resolves to NOTHING and the adapter queries nothing at all —
 * fail-closed, and visible immediately as a source that fetches no records.
 */
/**
 * `PRICE_HISTORY_SERIES_CURRENCIES` → the display currencies this deployment
 * builds price series in (#78).
 *
 * EMPTY by default, and unlike `EBAY_MARKETS` there is no fallback member:
 * every default here would name one currency, and #78 currency rule 9 forbids
 * adding a FairCoin-specific assumption while rule 8 warns that a currency
 * being representable does not make it a rail. An unrecognised code is dropped
 * rather than accepted, so a typo builds one fewer series instead of failing
 * every rebuild against a CHECK.
 */
function resolvePriceHistorySeriesCurrencies(): readonly CurrencyCode[] {
  const configured = strEnv('PRICE_HISTORY_SERIES_CURRENCIES', '')
    .split(',')
    .map((value) => value.trim().toUpperCase())
    .filter((value) => value !== '');
  return configured.filter((value): value is CurrencyCode =>
    (ALL_CURRENCY_CODES as readonly string[]).includes(value),
  );
}

function resolveEbayMarkets(): readonly EbayMarketplaceId[] {
  const configured = strEnv('EBAY_MARKETS', 'EBAY_ES')
    .split(',')
    .map((value) => value.trim().toUpperCase())
    .filter((value) => value !== '');
  return configured.filter((value): value is EbayMarketplaceId =>
    (EBAY_MARKETPLACE_IDS as readonly string[]).includes(value),
  );
}

/**
 * `EBAY_ENVIRONMENT` → which eBay key space this deployment's credential belongs
 * to.
 *
 * Anything unrecognised resolves to `sandbox`, never to `production`. The two
 * are different key spaces and a typo that promoted a sandbox keyset to the
 * production host would fail every call with an auth error — which is loud, but
 * the reverse (a production keyset pointed at sandbox) is quiet and would ingest
 * eBay's TEST catalogue into a live comparison surface.
 */
function resolveEbayEnvironment(): EbayEnvironment {
  const raw = strEnv('EBAY_ENVIRONMENT', 'sandbox').toLowerCase();
  return (EBAY_ENVIRONMENTS as readonly string[]).includes(raw)
    ? (raw as EbayEnvironment)
    : 'sandbox';
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
    fourEyesRequired: boolEnv('CATALOG_FOUR_EYES_REQUIRED', true),
    curationJobsEnabled: boolEnv('CURATION_JOBS_ENABLED', true),
    curationBatchSize: intEnv('CURATION_JOB_BATCH_SIZE', 5),
    curationPollIntervalMs: intEnv('CURATION_JOB_POLL_INTERVAL_MS', 10_000),
  }),
  productSaves: Object.freeze({
    enabled: boolEnv('PRODUCT_SAVES_ENABLED', false),
    readMode: resolveSavedItemsReadMode(),
    migrationApplyEnabled: boolEnv('PRODUCT_SAVE_MIGRATION_ENABLED', false),
    migrationBatchSize: intEnv('PRODUCT_SAVE_MIGRATION_BATCH_SIZE', 200),
    counterSweepBatchSize: intEnv('PRODUCT_SAVE_COUNTER_SWEEP_BATCH_SIZE', 500),
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
    // The one canonical read lever that defaults OFF — see its own doc comment
    // on `CanonicalRolloutConfig.search`. An unrecognised value must not roll a
    // deployment FORWARD into a surface it has not adopted, which is why the
    // fallback is passed explicitly rather than inherited.
    search: resolveCanonicalReadMode('CANONICAL_SEARCH', 'off'),
    publicRoutesEnabled: boolEnv('CANONICAL_PUBLIC_ROUTES_ENABLED', true),
    searchIndexingEnabled: boolEnv('CANONICAL_SEARCH_INDEXING_ENABLED', false),
    readCohorts: Object.freeze(resolveCanonicalReadCohorts()),
    backfillBatchSize: intEnv('CANONICAL_BACKFILL_BATCH_SIZE', 200),
    backfillPollIntervalMs: intEnv('CANONICAL_BACKFILL_POLL_INTERVAL_MS', 15_000),
  }),
  catalogIngestion: Object.freeze({
    enabled: boolEnv('CATALOG_INGESTION_ENABLED', false),
    batchSize: intEnv('CATALOG_INGESTION_BATCH_SIZE', 5),
    pollIntervalMs: intEnv('CATALOG_INGESTION_POLL_INTERVAL_MS', 30_000),
    leaseMs: intEnv('CATALOG_INGESTION_LEASE_MS', 120_000),
    maxBackoffMs: intEnv('CATALOG_INGESTION_MAX_BACKOFF_MS', 6 * 60 * 60 * 1_000),
    retirementBatchSize: intEnv('CATALOG_INGESTION_RETIREMENT_BATCH_SIZE', 500),
    anomalyPriceFactor: intEnv('CATALOG_INGESTION_ANOMALY_PRICE_FACTOR', 20),
  }),
  ranking: Object.freeze({
    canaryEnabled: boolEnv('RANKING_CANARY_ENABLED', true),
  }),
  offerFreshness: Object.freeze({
    refreshEnabled: boolEnv('OFFER_REFRESH_ENABLED', false),
    refreshBatchSize: intEnv('OFFER_REFRESH_BATCH_SIZE', 25),
    refreshPollIntervalMs: intEnv('OFFER_REFRESH_POLL_INTERVAL_MS', 15_000),
    refreshLeaseMs: intEnv('OFFER_REFRESH_LEASE_MS', 120_000),
    refreshMaxBackoffMs: intEnv('OFFER_REFRESH_MAX_BACKOFF_MS', 6 * 60 * 60 * 1_000),
    defaultRefreshConcurrency: intEnv('OFFER_REFRESH_DEFAULT_CONCURRENCY', 2),
    defaultRefreshCallsPerMinute: intEnv('OFFER_REFRESH_DEFAULT_CALLS_PER_MINUTE', 60),
    expirySweepEnabled: boolEnv('OFFER_EXPIRY_SWEEP_ENABLED', false),
    expirySweepBatchSize: intEnv('OFFER_EXPIRY_SWEEP_BATCH_SIZE', 500),
    expirySweepIntervalMs: intEnv('OFFER_EXPIRY_SWEEP_INTERVAL_MS', 60_000),
  }),
  priceHistory: Object.freeze({
    enabled: boolEnv('PRICE_HISTORY_ENABLED', false),
    publicReadsEnabled: boolEnv('PRICE_HISTORY_PUBLIC_READS_ENABLED', false),
    seriesCurrencies: Object.freeze(resolvePriceHistorySeriesCurrencies()),
    anchorIntervalSeconds: intEnv('PRICE_HISTORY_ANCHOR_INTERVAL_SECONDS', 24 * 60 * 60),
    retentionWindowDays: intEnv('PRICE_HISTORY_RETENTION_WINDOW_DAYS', 400),
    maxQuerySpanDays: intEnv('PRICE_HISTORY_MAX_QUERY_SPAN_DAYS', 400),
    rebuildObservationLimit: intEnv('PRICE_HISTORY_REBUILD_OBSERVATION_LIMIT', 50_000),
    rebuildBatchSize: intEnv('PRICE_HISTORY_REBUILD_BATCH_SIZE', 10),
    rebuildPollIntervalMs: intEnv('PRICE_HISTORY_REBUILD_POLL_INTERVAL_MS', 30_000),
    rebuildLeaseMs: intEnv('PRICE_HISTORY_REBUILD_LEASE_MS', 120_000),
    rebuildMaxBackoffMs: intEnv('PRICE_HISTORY_REBUILD_MAX_BACKOFF_MS', 6 * 60 * 60 * 1_000),
    traceLimit: intEnv('PRICE_HISTORY_TRACE_LIMIT', 500),
  }),
  priceAlerts: Object.freeze({
    enabled: boolEnv('PRICE_ALERTS_ENABLED', false),
    evaluationEnabled: boolEnv('PRICE_ALERT_EVALUATION_ENABLED', false),
    // Default TRUE, unlike the other two: it is an INCIDENT lever, and an
    // incident lever that ships in the off position is a feature nobody notices
    // is missing. The two above are rollout levers and default off.
    notificationsEnabled: boolEnv('PRICE_ALERT_NOTIFICATIONS_ENABLED', true),
    maxActivePerUser: intEnv('PRICE_ALERT_MAX_ACTIVE_PER_USER', 200),
    createRateLimit: intEnv('PRICE_ALERT_CREATE_RATE_LIMIT', 60),
    createRateWindowMs: intEnv('PRICE_ALERT_CREATE_RATE_WINDOW_MS', 60 * 60 * 1_000),
    evaluationBatchSize: intEnv('PRICE_ALERT_EVALUATION_BATCH_SIZE', 20),
    evaluationPollIntervalMs: intEnv('PRICE_ALERT_EVALUATION_POLL_INTERVAL_MS', 15_000),
    evaluationLeaseMs: intEnv('PRICE_ALERT_EVALUATION_LEASE_MS', 120_000),
    evaluationMaxBackoffMs: intEnv('PRICE_ALERT_EVALUATION_MAX_BACKOFF_MS', 60 * 60 * 1_000),
    evaluationOfferLimit: intEnv('PRICE_ALERT_EVALUATION_OFFER_LIMIT', 50),
    notificationBatchSize: intEnv('PRICE_ALERT_NOTIFICATION_BATCH_SIZE', 50),
    notificationPollIntervalMs: intEnv('PRICE_ALERT_NOTIFICATION_POLL_INTERVAL_MS', 10_000),
    notificationLeaseMs: intEnv('PRICE_ALERT_NOTIFICATION_LEASE_MS', 60_000),
    notificationMaxBackoffMs: intEnv('PRICE_ALERT_NOTIFICATION_MAX_BACKOFF_MS', 6 * 60 * 60 * 1_000),
    notificationMaxAttempts: intEnv('PRICE_ALERT_NOTIFICATION_MAX_ATTEMPTS', 8),
    traceLimit: intEnv('PRICE_ALERT_TRACE_LIMIT', 100),
  }),
  feedImport: Object.freeze({
    enabled: resolveFeedImportEnabled(),
    authEncryptionKey: strEnv('FEED_IMPORT_AUTH_ENCRYPTION_KEY', ''),
    stagingDir: strEnv('FEED_IMPORT_STAGING_DIR', join(tmpdir(), 'mercaria-feed-import')),
    maxDownloadBytes: intEnv('FEED_IMPORT_MAX_DOWNLOAD_BYTES', 2 * 1024 * 1024 * 1024),
    maxDecompressedBytes: intEnv('FEED_IMPORT_MAX_DECOMPRESSED_BYTES', 16 * 1024 * 1024 * 1024),
    maxCompressionRatio: intEnv('FEED_IMPORT_MAX_COMPRESSION_RATIO', 200),
    maxRecords: intEnv('FEED_IMPORT_MAX_RECORDS', 5_000_000),
    maxRecordBytes: intEnv('FEED_IMPORT_MAX_RECORD_BYTES', 256 * 1024),
    fetchTimeoutMs: intEnv('FEED_IMPORT_FETCH_TIMEOUT_MS', 30_000),
    stageTtlMs: intEnv('FEED_IMPORT_STAGE_TTL_MS', 6 * 60 * 60 * 1_000),
    previewSampleSize: intEnv('FEED_IMPORT_PREVIEW_SAMPLE_SIZE', 50),
    maxReportEntries: intEnv('FEED_IMPORT_MAX_REPORT_ENTRIES', 10_000),
  }),
  ebay: Object.freeze({
    enabled: boolEnv('EBAY_ENABLED', false),
    fetchEnabled: boolEnv('EBAY_FETCH_ENABLED', true),
    environment: resolveEbayEnvironment(),
    markets: Object.freeze(resolveEbayMarkets()),
    campaignId: strEnv('EPN_CAMPAIGN_ID', ''),
    // DERIVED from the id's own shape rather than configured beside it: eBay
    // ignores an unrecognised `affiliateCampaignId` and answers with plain URLs,
    // so a typo would present as "attribution silently stopped working" — the
    // one failure mode this integration cannot otherwise see.
    attributionEnabled: /^\d{10}$/u.test(strEnv('EPN_CAMPAIGN_ID', '')),
    dailyCallLimit: intEnv('EBAY_DAILY_CALL_LIMIT', 5_000),
    reconciliationSampleSize: intEnv('EBAY_RECONCILIATION_SAMPLE_SIZE', 40),
  }),
  awin: Object.freeze({
    enabled: boolEnv('AWIN_ENABLED', false),
    feedListBaseUrl: strEnv('AWIN_FEED_LIST_BASE_URL', 'https://productdata.awin.com'),
    publisherApiBaseUrl: strEnv('AWIN_PUBLISHER_API_BASE_URL', 'https://api.awin.com'),
    networkConcurrency: intEnv('AWIN_NETWORK_CONCURRENCY', 2),
    networkCallsPerMinute: intEnv(
      'AWIN_NETWORK_CALLS_PER_MINUTE',
      AWIN_PUBLISHER_API_CALLS_PER_MINUTE,
    ),
    networkLeaseMs: intEnv('AWIN_NETWORK_LEASE_MS', 120_000),
    listTimeoutMs: intEnv('AWIN_LIST_TIMEOUT_MS', 30_000),
    sampleSize: intEnv('AWIN_SAMPLE_SIZE', 25),
  }),
  printful: Object.freeze({
    enabled: boolEnv('PRINTFUL_ENABLED', false),
    baseUrl: strEnv('PRINTFUL_BASE_URL', PRINTFUL_BASE_URL),
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
      paymentSurfaceMethods: Object.freeze(resolveStripePaymentSurfaceMethods()),
      // Spread-when-present, like the onboarding URLs above: absent rather than
      // `''`, so the handoff omits the field instead of handing a client an
      // empty string it would confirm a payment against.
      ...(process.env.STRIPE_CHECKOUT_RETURN_URL?.trim()
        ? { checkoutReturnUrl: process.env.STRIPE_CHECKOUT_RETURN_URL.trim() }
        : {}),
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
    checkoutRollout: Object.freeze({
      blockedPlatforms: Object.freeze(
        blockedListEnv('GUEST_CHECKOUT_BLOCKED_PLATFORMS', 'lower'),
      ),
      blockedMarkets: Object.freeze(blockedListEnv('GUEST_CHECKOUT_BLOCKED_MARKETS', 'upper')),
      blockedSellerKeys: Object.freeze(
        // NOT lower-cased: a seller key embeds a uuid, and folding its case
        // would make one lever entry match two different sellers.
        strEnv('GUEST_CHECKOUT_BLOCKED_SELLER_KEYS', '')
          .split(',')
          .map((value) => value.trim())
          .filter((value) => value !== ''),
      ),
      blockedFulfilmentMethods: Object.freeze(
        blockedListEnv('GUEST_CHECKOUT_BLOCKED_FULFILMENT_METHODS', 'lower'),
      ),
      sellerActivationRequired: boolEnv('GUEST_SELLER_ACTIVATION_REQUIRED', false),
      blockedSuppliers: Object.freeze(
        blockedListEnv('GUEST_CHECKOUT_BLOCKED_SUPPLIERS', 'lower'),
      ),
    }),
    portal: Object.freeze({
      grantDays: intEnv('GUEST_PORTAL_GRANT_DAYS', 30),
      magicLinkMinutes: intEnv('GUEST_MAGIC_LINK_MINUTES', 15),
      stepUpMinutes: intEnv('GUEST_PORTAL_STEP_UP_MINUTES', 15),
      magicLinkBaseUrl: strEnv('GUEST_MAGIC_LINK_BASE_URL', ''),
      deliveryEnabled: boolEnv('GUEST_PORTAL_MESSAGE_DELIVERY_ENABLED', true),
      messageBatchSize: intEnv('GUEST_PORTAL_MESSAGE_BATCH_SIZE', 25),
      messagePollIntervalMs: intEnv('GUEST_PORTAL_MESSAGE_POLL_INTERVAL_MS', 5_000),
      messageLeaseMs: intEnv('GUEST_PORTAL_MESSAGE_LEASE_MS', 60_000),
      messageMaxAttempts: intEnv('GUEST_PORTAL_MESSAGE_MAX_ATTEMPTS', 8),
      recoveryWindowMinutes: intEnv('GUEST_RECOVERY_WINDOW_MINUTES', 60),
      recoveryMaxPerEmail: intEnv('GUEST_RECOVERY_MAX_PER_EMAIL', 5),
      recoveryMaxPerOrder: intEnv('GUEST_RECOVERY_MAX_PER_ORDER', 5),
      recoveryMaxPerNetwork: intEnv('GUEST_RECOVERY_MAX_PER_NETWORK', 30),
    }),
    claim: Object.freeze({
      enabled: boolEnv('GUEST_CLAIM_ENABLED', true),
      fourEyesRequired: boolEnv('GUEST_CLAIM_FOUR_EYES_REQUIRED', true),
      projectionEnabled: boolEnv('GUEST_CLAIM_PROJECTION_ENABLED', true),
      jobBatchSize: intEnv('GUEST_CLAIM_JOB_BATCH_SIZE', 25),
      jobPollIntervalMs: intEnv('GUEST_CLAIM_JOB_POLL_INTERVAL_MS', 5_000),
      jobLeaseMs: intEnv('GUEST_CLAIM_JOB_LEASE_MS', 60_000),
      jobMaxAttempts: intEnv('GUEST_CLAIM_JOB_MAX_ATTEMPTS', 8),
    }),
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
  /**
   * Buyer post-purchase requests — cancellations, returns and support (#110).
   *
   * THREE levers and none of them gates a durable record, which is the house
   * rule and is load-bearing here: a cancellation request is a buyer waiting
   * for an answer, and a flag that stopped the row being written would lose it
   * silently.
   *
   * `requestsEnabled` gates the buyer-facing MOUNT, so a deployment can stop
   * accepting NEW requests during an incident while every request already filed
   * stays decidable by its seller and readable by its buyer — the
   * `GUEST_SESSION_ISSUANCE_ENABLED` shape.
   *
   * `reconcilerEnabled` gates the sweep LOOP only. A return waiting on a rail
   * is still advanced by the merchant and operator surfaces, so turning the
   * timer off during an incident cannot make a refund unfinishable.
   */
  buyerRequests: Object.freeze({
    requestsEnabled: boolEnv('BUYER_REQUESTS_ENABLED', true),
    reconcilerEnabled: boolEnv('BUYER_REQUEST_RECONCILER_ENABLED', true),
    reconcileIntervalMs: intEnv('BUYER_REQUEST_RECONCILE_INTERVAL_MS', MINUTE_MS),
    reconcileBatchSize: intEnv('BUYER_REQUEST_RECONCILE_BATCH_SIZE', 50),
    // A grace period before a `refund_pending` return is swept. The inline
    // drain in `refund.service` usually finishes the job, and sweeping a row a
    // request handler is still working on would race it into the same
    // compare-and-swap for no benefit.
    reconcileGraceMs: intEnv('BUYER_REQUEST_RECONCILE_GRACE_MS', 30_000),
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
  supplierPreflight: Object.freeze({
    enabled: resolveSupplierPreflightEnabled(),
    sweepEnabled: boolEnv('SUPPLIER_PREFLIGHT_SWEEP_ENABLED', true),
    sweepIntervalMs: intEnv('SUPPLIER_PREFLIGHT_SWEEP_INTERVAL_MS', 30_000),
    sweepBatchSize: intEnv('SUPPLIER_PREFLIGHT_SWEEP_BATCH_SIZE', 50),
    maxReleaseAttempts: intEnv('SUPPLIER_PREFLIGHT_MAX_RELEASE_ATTEMPTS', 5),
    fakeAdapterEnabled: boolEnv('SUPPLIER_PREFLIGHT_FAKE_ADAPTER_ENABLED', false),
    fingerprintKey: strEnv('SUPPLIER_PREFLIGHT_FINGERPRINT_KEY', ''),
    operatorOxyUserIds: Object.freeze(resolveProcurementOperatorIds()),
    operatorSurfaceEnabled: resolveProcurementOperatorIds().length > 0,
  }),
  procurement: Object.freeze({
    orchestrationEnabled: boolEnv('PROCUREMENT_ORCHESTRATION_ENABLED', false),
    providerFetchEnabled: boolEnv('PROCUREMENT_PROVIDER_FETCH_ENABLED', true),
    eventProcessingEnabled: boolEnv('PROCUREMENT_EVENT_PROCESSING_ENABLED', true),
    outboxBatchSize: intEnv('PROCUREMENT_OUTBOX_BATCH_SIZE', 25),
    outboxPollIntervalMs: intEnv('PROCUREMENT_OUTBOX_POLL_INTERVAL_MS', 5_000),
    outboxLeaseMs: intEnv('PROCUREMENT_OUTBOX_LEASE_MS', 60_000),
    eventBatchSize: intEnv('PROCUREMENT_EVENT_BATCH_SIZE', 50),
    eventPollIntervalMs: intEnv('PROCUREMENT_EVENT_POLL_INTERVAL_MS', 5_000),
    eventLeaseMs: intEnv('PROCUREMENT_EVENT_LEASE_MS', 60_000),
    pollMinIntervalMs: intEnv('PROCUREMENT_POLL_MIN_INTERVAL_MS', 300_000),
    pollTerminalGraceMs: intEnv('PROCUREMENT_POLL_TERMINAL_GRACE_MS', 86_400_000),
    eventLagSlaMs: intEnv('PROCUREMENT_EVENT_LAG_SLA_MS', 3_600_000),
    callTimeoutMs: intEnv('PROCUREMENT_CALL_TIMEOUT_MS', 20_000),
    convergenceGraceMs: intEnv('PROCUREMENT_CONVERGENCE_GRACE_MS', 60_000),
    fakeAdapterEnabled: boolEnv('PROCUREMENT_FAKE_ADAPTER_ENABLED', false),
  }),
  retail: Object.freeze({
    enabled: resolveMercariaRetailEnabled(),
    blockedSuppliers: Object.freeze(blockedListEnv('RETAIL_BLOCKED_SUPPLIERS', 'lower')),
    blockedMarkets: Object.freeze(blockedListEnv('RETAIL_BLOCKED_MARKETS', 'upper')),
    sellerLegalEntityName: retailSellerLegalEntityName(),
    sellerLegalEntityCountry: retailSellerLegalEntityCountry(),
  }),
  postgres: Object.freeze({
    url: resolveDatabaseUrl(),
    maxPoolSize: intEnv('PG_MAX_POOL_SIZE', 20),
    idleTimeoutSeconds: intEnv('PG_IDLE_TIMEOUT_SECONDS', 30),
    connectTimeoutSeconds: intEnv('PG_CONNECT_TIMEOUT_SECONDS', 10),
    maxLifetimeSeconds: intEnv('PG_MAX_LIFETIME_SECONDS', 1_800),
  }),
});
