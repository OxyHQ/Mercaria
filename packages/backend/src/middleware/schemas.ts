/**
 * Domain request schemas (Zod).
 *
 * The reusable validation FACTORIES live in `validate.ts`; this module holds the
 * concrete per-endpoint schemas (listing, store, member, variant, inventory,
 * seller-prefs) that those factories consume. Each schema parses into a shape
 * assignable to the matching `@mercaria/shared-types` input DTO, so controllers
 * pass `req.body` straight to a service without re-shaping.
 *
 * `Money` input is `{ amount: int ≥ 0, currency: enum }`.
 */

import { z } from 'zod';
import { isLiveEntityId } from '@oxyhq/db';
import {
  ABUSE_REPORT_CATEGORIES,
  ABUSE_REPORTED_TYPES,
  ALL_CURRENCY_CODES,
  CHECKOUT_PAYMENT_METHODS,
  CHECKOUT_TEXT_LIMITS,
  CONDITION_DETAIL_KINDS,
  CONDITION_DETAIL_SEVERITIES,
  ITEM_CONDITION_KEYS,
  LEGACY_BINARY_CONDITIONS,
  MAX_MONEY_MINOR_UNITS,
  // #906's bounds, and #367 line 405's published `matrix` rules, are the SAME
  // symbols — one definition, so the served number cannot drift from this one.
  MAX_VALUES_PER_VARIANT_AXIS,
  MAX_VARIANT_AXES_PER_PRODUCT,
  type ConditionDetailKind,
  type ConditionDetailSeverity,
  type CurrencyCode,
  type ItemConditionKey,
  type LegacyBinaryCondition,
} from '@mercaria/shared-types';
import { STORE_PERMISSIONS } from '../db/schema/stores.js';

/**
 * A shared tuple, narrowed to the non-empty form `z.enum` requires.
 *
 * Reading the SAME tuples the Postgres CHECKs are rendered from is what keeps a
 * taxonomy key from being storable and unwritable; checking non-emptiness at
 * module load beats asserting it with a cast.
 */
function conditionEnumValues<T extends string>(values: readonly T[]): readonly [T, ...T[]] {
  const [first, ...rest] = values;
  if (first === undefined) {
    throw new Error('A z.enum of no values rejects every request');
  }
  return [first, ...rest];
}

const ITEM_CONDITION_KEY_VALUES = conditionEnumValues<ItemConditionKey>(ITEM_CONDITION_KEYS);
const CONDITION_DETAIL_KIND_VALUES =
  conditionEnumValues<ConditionDetailKind>(CONDITION_DETAIL_KINDS);
const CONDITION_DETAIL_SEVERITY_VALUES =
  conditionEnumValues<ConditionDetailSeverity>(CONDITION_DETAIL_SEVERITIES);
const LEGACY_BINARY_CONDITION_VALUES =
  conditionEnumValues<LegacyBinaryCondition>(LEGACY_BINARY_CONDITIONS);

/**
 * The supported currency codes as a Zod-enum tuple, derived from the single
 * shared set (`ALL_CURRENCY_CODES`) so adding a currency in `@mercaria/shared-types`
 * propagates to every schema here without editing a literal list. `z.enum` needs
 * a non-empty tuple type; the shared set is always non-empty (FAIR is always
 * present), so the assertion to a non-empty readonly tuple is sound.
 */
const CURRENCY_CODE_VALUES = ALL_CURRENCY_CODES as readonly [CurrencyCode, ...CurrencyCode[]];

/** Supported currency codes (mirrors `CurrencyCode`). */
const currencySchema = z.enum(CURRENCY_CODE_VALUES);

/**
 * `Money` input: integer minor units, non-negative, within
 * `MAX_MONEY_MINOR_UNITS`, with a supported currency.
 *
 * The ceiling is load-bearing, not decoration: `z.number().int()` accepts `1e300`
 * (it is an integer), and an amount above 2^53 − 1 stops being exactly
 * representable, so every total derived from it silently loses minor units. This
 * is the FIRST of the amount-safety boundaries and the only one that can answer
 * a client with a 400 naming the field; the pricing, FX, refund and persistence
 * layers assert the same limit on the amounts they form.
 */
const moneySchema = z.object({
  amount: z.number().int().nonnegative().max(MAX_MONEY_MINOR_UNITS),
  currency: currencySchema,
});

/** A single `{ name, value }` option assignment. */
const optionValueSchema = z.object({
  name: z.string().trim().min(1),
  value: z.string().trim().min(1),
});

/**
 * A selectable option and its allowed values.
 *
 * `values` is capped at {@link MAX_VALUES_PER_VARIANT_AXIS}, the SAME bound
 * `catalog-authoring-schemas.ts` puts on one axis's answers — see #906.
 */
const listingOptionSchema = z.object({
  name: z.string().trim().min(1),
  values: z.array(z.string().trim().min(1)).min(1).max(MAX_VALUES_PER_VARIANT_AXIS),
});

/** SEO override (title/description) shared by store products and collections. */
const seoSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(500).optional(),
});

// ---------------------------------------------------------------------------
// P2P listing
// ---------------------------------------------------------------------------


/**
 * The #90 condition statement a client may send.
 *
 * `.strict()` throughout, and the shapes are checked here as well as by the
 * CHECKs one layer down: a client gets a 400 naming the field rather than a 500
 * carrying a constraint name, and the CHECKs stay because this is not the only
 * writer.
 */
const conditionDetailSchema = z
  .object({
    kind: z.enum(CONDITION_DETAIL_KIND_VALUES),
    severity: z.enum(CONDITION_DETAIL_SEVERITY_VALUES).optional(),
    note: z.string().trim().min(1).max(1_000).optional(),
  })
  .strict();

const conditionPhotoAnnotationSchema = z
  .object({
    fileId: z.string().trim().min(1),
    showsDefect: z.boolean().optional(),
    detailIndex: z.number().int().nonnegative().optional(),
  })
  .strict();

export const listingConditionSchema = z
  .object({
    key: z.enum(ITEM_CONDITION_KEY_VALUES),
    details: z.array(conditionDetailSchema).max(50).optional(),
    photoAnnotations: z.array(conditionPhotoAnnotationSchema).max(50).optional(),
    // A boolean with NO default: a missing field is not consent (#90 policy
    // rule 2), and `.default(false)` would read as one to whoever edits this
    // next.
    defectsAcknowledged: z.boolean().optional(),
  })
  .strict();

/** Body for `POST /seller/listings` (CreateP2PListingInput). */
export const createP2PListingSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(10_000),
  price: moneySchema,
  // #90: EXACTLY one of the two spellings. `resolveConditionInput` refuses both
  // together — a 400 rather than a precedence rule nobody would remember.
  condition: z.enum(LEGACY_BINARY_CONDITION_VALUES).optional(),
  itemCondition: listingConditionSchema.optional(),
  category: z.string().trim().min(1),
  imageFileIds: z.array(z.string().trim().min(1)),
  tags: z.array(z.string().trim().min(1)).optional(),
  quantity: z.number().int().nonnegative().optional(),
});

/** Body for `PATCH /seller/listings/:id` and store `PATCH /products/:id` (UpdateListingInput). */
export const updateListingSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(10_000).optional(),
    price: moneySchema.optional(),
    condition: z.enum(LEGACY_BINARY_CONDITION_VALUES).optional(),
    itemCondition: listingConditionSchema.optional(),
    category: z.string().trim().min(1).optional(),
    imageFileIds: z.array(z.string().trim().min(1)).optional(),
    tags: z.array(z.string().trim().min(1)).optional(),
    quantity: z.number().int().nonnegative().optional(),
    status: z.enum(['draft', 'active', 'sold', 'archived']).optional(),
    vendor: z.string().trim().min(1).optional(),
    productType: z.string().trim().min(1).optional(),
    handle: z.string().trim().min(1).optional(),
    seo: seoSchema.optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, { message: 'At least one field is required' });

/**
 * `POST /admin/stores/:storeId/products/:id/pins/release` — stop holding some
 * of a connector-sourced listing's pinned fields (#427).
 *
 * `z.string()` rather than `z.enum(PINNABLE_CONNECTOR_FIELDS)`, deliberately.
 * `listings.overridden_fields` is a bare `text[]` the connector merge honours
 * whatever is in it, and `mergePins` never removes an entry — so a fixture, a
 * repair or a later issue can leave a key there that no merchant edit writes.
 * Narrowing this to the seven named keys would make exactly those permanently
 * unreleasable, which is the state #420's `unnamed` count exists to expose
 * rather than one to re-create here. Nothing is risked by the width: a release
 * is SUBTRACTIVE, so a key that is not held is removed from nothing, and no
 * spelling of this body can ADD one.
 *
 * `.strict()`, because the only thing another property could be is an attempt
 * to pin from here.
 */
export const releasePinnedFieldsSchema = z
  .object({
    fields: z.array(z.string().trim().min(1).max(64)).min(1).max(32),
  })
  .strict();

// ---------------------------------------------------------------------------
// Store product + variants
// ---------------------------------------------------------------------------

/** A variant supplied when creating a store product (CreateStoreProductVariantInput). */
const createStoreProductVariantSchema = z.object({
  optionValues: z.array(optionValueSchema).max(MAX_VARIANT_AXES_PER_PRODUCT),
  price: moneySchema,
  compareAtPrice: moneySchema.optional(),
  sku: z.string().trim().min(1).optional(),
  barcode: z.string().trim().min(1).optional(),
  inventory: z.object({
    tracked: z.boolean().optional(),
    available: z.number().int().nonnegative(),
  }),
});

/** Body for store `POST /products` (CreateStoreProductInput). */
export const createStoreProductSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(10_000),
  category: z.string().trim().min(1),
  imageFileIds: z.array(z.string().trim().min(1)),
  tags: z.array(z.string().trim().min(1)).optional(),
  options: z.array(listingOptionSchema).max(MAX_VARIANT_AXES_PER_PRODUCT),
  variants: z.array(createStoreProductVariantSchema).min(1),
  vendor: z.string().trim().min(1).optional(),
  productType: z.string().trim().min(1).optional(),
  handle: z.string().trim().min(1).optional(),
  seo: seoSchema.optional(),
});

/** Body for store `POST /products/:id/variants` (add a variant). */
export const createVariantSchema = createStoreProductVariantSchema;

/** Body for store `PATCH /products/:id/variants/:variantId` (update a variant). */
export const updateVariantSchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    sku: z.string().trim().min(1).optional(),
    barcode: z.string().trim().min(1).optional(),
    price: moneySchema.optional(),
    compareAtPrice: moneySchema.nullable().optional(),
    optionValues: z.array(optionValueSchema).max(MAX_VARIANT_AXES_PER_PRODUCT).optional(),
    inventory: z
      .object({
        tracked: z.boolean().optional(),
        available: z.number().int().nonnegative().optional(),
      })
      .optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, { message: 'At least one field is required' });

/** Body for store `PATCH /products/:id/variants/:variantId/inventory`. */
export const setInventorySchema = z.object({
  available: z.number().int().nonnegative(),
});

/** Body for store `PATCH /products/:id/variants/:variantId/levels/:locationId`. */
export const setLevelInventorySchema = z.object({
  available: z.number().int().nonnegative(),
});

// ---------------------------------------------------------------------------
// Locations (store inventory locations)
// ---------------------------------------------------------------------------

/** The kind of place a location represents (mirrors `LocationType`). */
const locationTypeSchema = z.enum(['warehouse', 'retail', 'pop_up', 'virtual']);

/** Optional physical address for a location (the whole address is optional). */
const locationAddressSchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  recipientName: z.string().trim().min(1).max(200),
  line1: z.string().trim().min(1).max(300),
  line2: z.string().trim().min(1).max(300).optional(),
  city: z.string().trim().min(1).max(150),
  region: z.string().trim().min(1).max(150).optional(),
  postalCode: z.string().trim().min(1).max(40),
  country: z.string().trim().min(2).max(2),
  phone: z.string().trim().min(1).max(40).optional(),
});

/** Body for `POST /admin/stores/:storeId/locations` (CreateLocationInput). */
export const createLocationSchema = z.object({
  name: z.string().trim().min(1).max(120),
  type: locationTypeSchema.optional(),
  address: locationAddressSchema.optional(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
  fulfillsOnlineOrders: z.boolean().optional(),
});

/** Body for `PATCH /admin/stores/:storeId/locations/:id` (UpdateLocationInput). */
export const updateLocationSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    type: locationTypeSchema.optional(),
    address: locationAddressSchema.optional(),
    isDefault: z.boolean().optional(),
    isActive: z.boolean().optional(),
    fulfillsOnlineOrders: z.boolean().optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, { message: 'At least one field is required' });

// ---------------------------------------------------------------------------
// Collections (store merchandising collections)
// ---------------------------------------------------------------------------

/** A single automated-collection rule (CollectionRule). */
const collectionRuleSchema = z.object({
  field: z.enum([
    'title',
    'productType',
    'vendor',
    'tag',
    'price',
    'categorySlug',
    'compareAtPrice',
    'inventory',
  ]),
  operator: z.enum([
    'equals',
    'not_equals',
    'contains',
    'starts_with',
    'ends_with',
    'gt',
    'lt',
    'gte',
    'lte',
  ]),
  value: z.string().trim().min(1),
});

/** The order products are returned in within a collection (CollectionSortOrder). */
const collectionSortOrderSchema = z.enum([
  'manual',
  'best_selling',
  'price_asc',
  'price_desc',
  'created_desc',
  'title_asc',
]);

/** Body for `POST /admin/stores/:storeId/collections` (CreateCollectionInput). */
export const createCollectionSchema = z.object({
  title: z.string().trim().min(1).max(200),
  handle: z.string().trim().min(1).max(120),
  description: z.string().max(5_000).optional(),
  imageFileId: z.string().trim().min(1).optional(),
  type: z.enum(['manual', 'automated']),
  productIds: z.array(z.string().trim().min(1)).optional(),
  rules: z
    .object({
      appliesDisjunctively: z.boolean().optional(),
      conditions: z.array(collectionRuleSchema),
    })
    .optional(),
  sortOrder: collectionSortOrderSchema.optional(),
  seo: seoSchema.optional(),
  isPublished: z.boolean().optional(),
});

/** Body for `PATCH /admin/stores/:storeId/collections/:id` (UpdateCollectionInput). */
export const updateCollectionSchema = createCollectionSchema
  .partial()
  .refine((obj) => Object.keys(obj).length > 0, { message: 'At least one field is required' });

/** Body for `POST /admin/stores/:storeId/collections/:id/products` (SetCollectionProductsInput). */
export const setCollectionProductsSchema = z.object({
  productIds: z.array(z.string().trim().min(1)),
});

// ---------------------------------------------------------------------------
// Discounts (store promotions)
// ---------------------------------------------------------------------------

/** The scope a discount or a buy/get leg targets. */
const discountScopeSchema = z.enum(['order', 'products', 'collections']);
/** A buy/get leg only ever targets products or collections (never the whole order). */
const discountLegScopeSchema = z.enum(['products', 'collections']);
/** Basis points, 0..10000 (10000 = 100%). */
const bpsSchema = z.number().int().min(0).max(10_000);

/** A BOGO/free-item buy or get leg (DiscountLegInput). */
const discountLegSchema = z.object({
  quantity: z.number().int().positive(),
  scope: discountLegScopeSchema,
  productIds: z.array(z.string().trim().min(1)).optional(),
  collectionIds: z.array(z.string().trim().min(1)).optional(),
  discountPercent: bpsSchema.optional(),
});

/** What a discount applies to (DiscountAppliesTo). */
const discountAppliesToSchema = z.object({
  scope: discountScopeSchema,
  productIds: z.array(z.string().trim().min(1)).optional(),
  collectionIds: z.array(z.string().trim().min(1)).optional(),
});

/**
 * A minimum requirement (DiscountMinimumRequirement). `value` is MINOR UNITS for
 * `subtotal` and a unit count for `quantity`, so it carries the same ceiling as
 * a `Money.amount` — it is compared against one.
 */
const discountMinimumRequirementSchema = z.object({
  type: z.enum(['none', 'subtotal', 'quantity']),
  value: z.number().int().nonnegative().max(MAX_MONEY_MINOR_UNITS),
});

/** Customer eligibility (DiscountCustomerEligibility). */
const discountCustomerEligibilitySchema = z.object({
  type: z.enum(['all', 'groups', 'customers']),
  customerIds: z.array(z.string().trim().min(1)).optional(),
  groupTags: z.array(z.string().trim().min(1)).optional(),
});

/** Usage limits (DiscountUsageLimits). */
const discountUsageLimitsSchema = z.object({
  totalMax: z.number().int().positive().optional(),
  perCustomerMax: z.number().int().positive().optional(),
});

/** Combinability flags (DiscountCombinesWith, all optional in input). */
const discountCombinesWithSchema = z.object({
  orderDiscounts: z.boolean().optional(),
  productDiscounts: z.boolean().optional(),
  shippingDiscounts: z.boolean().optional(),
});

/** Body for `POST /admin/stores/:storeId/discounts` (CreateDiscountInput). */
export const createDiscountSchema = z.object({
  title: z.string().trim().min(1).max(200),
  method: z.enum(['code', 'automatic']),
  codes: z.array(z.string().trim().min(1).max(60)).optional(),
  valueType: z.enum(['percentage', 'fixed_amount', 'bogo', 'free_item']),
  // Basis points for `percentage`, MINOR UNITS for `fixed_amount` — bounded as a
  // money amount, since that is what it is subtracted from.
  value: z.number().int().nonnegative().max(MAX_MONEY_MINOR_UNITS),
  appliesTo: discountAppliesToSchema,
  buy: discountLegSchema.optional(),
  get: discountLegSchema.optional(),
  minimumRequirement: discountMinimumRequirementSchema.optional(),
  customerEligibility: discountCustomerEligibilitySchema.optional(),
  usageLimits: discountUsageLimitsSchema.optional(),
  combinesWith: discountCombinesWithSchema.optional(),
  // RFC 3339 with an offset, for the reason `ingestProductSchema`'s
  // `externalUpdatedAt` states at length (#290): a bare `.datetime()` refuses a
  // valid offset timestamp, and `discount.service` reads both of these with
  // `new Date`, which converts the offset rather than reinterpreting it. A
  // zoneless value stays refused — the window a discount is live for must not
  // depend on the server's timezone.
  startsAt: z.string().datetime({ offset: true }).optional(),
  endsAt: z.string().datetime({ offset: true }).optional(),
  isActive: z.boolean().optional(),
});

/** Body for `PATCH /admin/stores/:storeId/discounts/:id` (UpdateDiscountInput). */
export const updateDiscountSchema = createDiscountSchema
  .partial()
  .refine((obj) => Object.keys(obj).length > 0, { message: 'At least one field is required' });

// ---------------------------------------------------------------------------
// Tax rates + tax settings
// ---------------------------------------------------------------------------

/** The geographic scope a tax rate applies to (TaxRegion). */
const taxRegionSchema = z.object({
  country: z.string().trim().min(2).max(2).optional(),
  region: z.string().trim().min(1).max(150).optional(),
  postalCodePattern: z.string().trim().min(1).max(200).optional(),
});

/** Body for `POST /admin/stores/:storeId/tax-rates` (CreateTaxRateInput). */
export const createTaxRateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  rateBps: bpsSchema,
  region: taxRegionSchema,
  appliesToShipping: z.boolean().optional(),
  productTypeScope: z.array(z.string().trim().min(1)).optional(),
  priority: z.number().int().optional(),
  isActive: z.boolean().optional(),
});

/** Body for `PATCH /admin/stores/:storeId/tax-rates/:id` (UpdateTaxRateInput). */
export const updateTaxRateSchema = createTaxRateSchema
  .partial()
  .refine((obj) => Object.keys(obj).length > 0, { message: 'At least one field is required' });

/** Body for `PATCH /admin/stores/:storeId/settings/tax` (UpdateTaxSettingsInput). */
export const updateTaxSettingsSchema = z
  .object({
    pricesIncludeTax: z.boolean().optional(),
    taxRegistrationId: z.string().trim().min(1).max(120).optional(),
    chargeTaxOnProducts: z.boolean().optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, { message: 'At least one field is required' });

// ---------------------------------------------------------------------------
// Store + members
// ---------------------------------------------------------------------------

/** Body for `POST /admin/stores` (CreateStoreInput). */
export const createStoreSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(5_000).optional(),
  brandColor: z.string().trim().min(1).optional(),
  logoFileId: z.string().trim().min(1).optional(),
  coverFileId: z.string().trim().min(1).optional(),
  defaultCurrency: currencySchema.optional(),
});

const storeRoleSchema = z.enum(['owner', 'admin', 'staff']);
/**
 * Read from `db/schema/stores.ts` rather than retyped.
 *
 * That tuple is what renders the CHECK on `store_members.permissions`, so a
 * hand-copied list here could accept a permission the database then refuses to
 * store — a 500 on an invite, from two lists that merely LOOKED identical. It
 * was a hand-copied list until #86 added an eighteenth permission and had to
 * edit it in three places.
 */
const storePermissionSchema = z.enum(conditionEnumValues(STORE_PERMISSIONS));

/** Partial store-policies patch (core update + settings update). */
const storePoliciesSchema = z.object({
  returnWindowDays: z.number().int().nonnegative().optional(),
  shippingNote: z.string().max(2_000).optional(),
  refundPolicy: z.string().max(20_000).optional(),
  privacyPolicy: z.string().max(20_000).optional(),
  termsOfService: z.string().max(20_000).optional(),
});

/** Partial notification-settings patch (settings update). */
const storeNotificationSettingsSchema = z.object({
  lowStockAlerts: z.boolean().optional(),
  orderEmails: z.boolean().optional(),
  lowStockThreshold: z.number().int().nonnegative().optional(),
});

/** Body for `PATCH /admin/stores/:storeId` (UpdateStoreInput). */
export const updateStoreSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().max(5_000).optional(),
    brandColor: z.string().trim().min(1).optional(),
    logoFileId: z.string().trim().min(1).optional(),
    coverFileId: z.string().trim().min(1).optional(),
    defaultCurrency: currencySchema.optional(),
    textTone: z.enum(['light', 'dark']).optional(),
    status: z.enum(['active', 'suspended', 'closed']).optional(),
    policies: storePoliciesSchema.optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, { message: 'At least one field is required' });

/** Body for `PATCH /admin/stores/:storeId/settings` (UpdateStoreSettingsInput). */
export const updateStoreSettingsSchema = z
  .object({
    policies: storePoliciesSchema.optional(),
    notificationSettings: storeNotificationSettingsSchema.optional(),
    taxSettings: z
      .object({
        pricesIncludeTax: z.boolean().optional(),
        taxRegistrationId: z.string().trim().min(1).max(120).optional(),
        chargeTaxOnProducts: z.boolean().optional(),
      })
      .optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, { message: 'At least one field is required' });

/** Body for `POST /admin/stores/:storeId/members` (InviteMemberInput). */
export const inviteMemberSchema = z.object({
  oxyUserId: z.string().trim().min(1),
  role: storeRoleSchema,
  permissions: z.array(storePermissionSchema).optional(),
});

/** Body for `PATCH /admin/stores/:storeId/members/:oxyUserId` (UpdateMemberInput). */
export const updateMemberSchema = z
  .object({
    role: storeRoleSchema.optional(),
    permissions: z.array(storePermissionSchema).optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, { message: 'At least one field is required' });

// ---------------------------------------------------------------------------
// Seller profile prefs
// ---------------------------------------------------------------------------

/** Body for `PATCH /seller/me` (shipping/return preferences). */
export const sellerPrefsSchema = z
  .object({
    shippingPrefs: z
      .object({
        note: z.string().max(2_000).optional(),
        handlingDays: z.number().int().nonnegative().optional(),
      })
      .optional(),
    returnPrefs: z
      .object({
        accepts: z.boolean().optional(),
        windowDays: z.number().int().nonnegative().optional(),
      })
      .optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, { message: 'At least one field is required' });

// ---------------------------------------------------------------------------
// Cart
// ---------------------------------------------------------------------------

/** Body for `POST /cart/items` (AddCartItemInput). */
export const addCartItemSchema = z.object({
  listingId: z.string().trim().min(1),
  variantId: z.string().trim().min(1),
  quantity: z.number().int().positive(),
});

/** Body for `PATCH /cart/items/:variantId` (UpdateCartItemInput). 0 removes the line. */
export const updateCartItemSchema = z.object({
  quantity: z.number().int().nonnegative(),
});

/** Body for `POST /cart/discount` (ApplyCartDiscountInput). */
export const applyCartDiscountSchema = z.object({
  code: z.string().trim().min(1),
});

// ---------------------------------------------------------------------------
// Address
// ---------------------------------------------------------------------------

/** Body for `POST /addresses` (CreateAddressInput). */
export const createAddressSchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  recipientName: z.string().trim().min(1).max(200),
  line1: z.string().trim().min(1).max(300),
  line2: z.string().trim().min(1).max(300).optional(),
  city: z.string().trim().min(1).max(150),
  region: z.string().trim().min(1).max(150).optional(),
  postalCode: z.string().trim().min(1).max(40),
  country: z.string().trim().min(2).max(2),
  phone: z.string().trim().min(1).max(40).optional(),
});

/** Body for `PATCH /addresses/:id` (UpdateAddressInput). */
export const updateAddressSchema = z
  .object({
    label: z.string().trim().min(1).max(120).optional(),
    recipientName: z.string().trim().min(1).max(200).optional(),
    line1: z.string().trim().min(1).max(300).optional(),
    line2: z.string().trim().min(1).max(300).optional(),
    city: z.string().trim().min(1).max(150).optional(),
    region: z.string().trim().min(1).max(150).optional(),
    postalCode: z.string().trim().min(1).max(40).optional(),
    country: z.string().trim().min(2).max(2).optional(),
    phone: z.string().trim().min(1).max(40).optional(),
    isDefault: z.boolean().optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, { message: 'At least one field is required' });

// ---------------------------------------------------------------------------
// Orders / checkout
// ---------------------------------------------------------------------------

/** A shipping method selectable at checkout. */
const shippingMethodSchema = z.enum(['standard', 'express', 'pickup']);

/** Every order status (used by status-patch + order list filters). */
const orderStatusSchema = z.enum([
  'pending_payment',
  'paid',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
  'refunded',
  'partially_refunded',
]);

/**
 * Body for `POST /checkout` (CheckoutInput).
 *
 * ## STRICT, and that is a payments requirement rather than tidiness
 *
 * Mercaria must never receive card data — PCI SAQ-A depends on it, and a field
 * that reaches this server can end up in a log, an error message or a bug
 * report. Zod's default is to STRIP unknown keys, which is already safe but
 * silent: a client sending `cardNumber` would be told nothing and would keep
 * sending it. `.strict()` refuses the request instead, so the mistake surfaces
 * on the first attempt, in development, to the person who can fix it.
 *
 * It also pins the payment surface itself: the only thing a client may say about
 * payment here is WHICH RAIL, never an amount, a token, a status or a provider
 * object. Everything else about the money is server-derived (#45 invariant 6).
 * `.strict()` is what stops a billing address arriving here too: billing
 * details belong to the Stripe element and never reach a Mercaria server
 * (ADR 0006 G6), and there is no key for one to arrive under.
 *
 * ## Shape only; the ACTOR rules live in the service
 *
 * This schema says what a well-formed body looks like. It deliberately does NOT
 * say "a guest must supply contact" or "a guest may not name a saved address":
 * those are properties of the CALLER, and the identical body is complete for an
 * authenticated buyer and incomplete for a guest. Encoding them here would put
 * half the actor rules in a schema that cannot see an actor and half in
 * `services/checkout/destination.ts`, and the half nobody remembers is the one
 * that gets it wrong.
 */
const checkoutAddressSchema = z
  .object({
    recipientName: z.string().min(1).max(CHECKOUT_TEXT_LIMITS.recipientName),
    line1: z.string().min(1).max(CHECKOUT_TEXT_LIMITS.line1),
    line2: z.string().max(CHECKOUT_TEXT_LIMITS.line2).optional(),
    city: z.string().min(1).max(CHECKOUT_TEXT_LIMITS.city),
    region: z.string().max(CHECKOUT_TEXT_LIMITS.region).optional(),
    postalCode: z.string().min(1).max(CHECKOUT_TEXT_LIMITS.postalCode),
    // Length only here. Membership of the real ISO-3166 list, the postal-code
    // format and the Unicode/control-character rules are all
    // `services/checkout/contact.ts`'s, because they are ONE policy and a
    // second copy in a schema is a second policy.
    country: z.string().length(2),
    phone: z.string().max(CHECKOUT_TEXT_LIMITS.phone).optional(),
  })
  .strict();

const checkoutContactSchema = z
  .object({
    email: z.string().min(1).max(CHECKOUT_TEXT_LIMITS.email),
    phone: z.string().max(CHECKOUT_TEXT_LIMITS.phone).optional(),
  })
  .strict();

const checkoutDestinationSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('saved_address'),
      addressId: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('inline_shipping_address'),
      address: checkoutAddressSchema,
      saveToAddressBook: z.boolean().optional(),
      saveLabel: z.string().trim().min(1).max(120).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('pickup'),
      locationId: z.string().trim().min(1),
      pickupContact: checkoutContactSchema,
    })
    .strict(),
]);

export const checkoutSchema = z
  .object({
    /** The v1 contract. See `CheckoutInput`'s docblock for why it is still here. */
    addressId: z.string().trim().min(1).optional(),
    destination: checkoutDestinationSchema.optional(),
    contact: checkoutContactSchema.optional(),
    marketingOptIn: z.boolean().optional(),
    sellerKeys: z.array(z.string().trim().min(1)).optional(),
    shippingSelections: z.record(z.string(), shippingMethodSchema).optional(),
    discountCodes: z.array(z.string().trim().min(1)).optional(),
    paymentMethod: z
      .enum(CHECKOUT_PAYMENT_METHODS as unknown as [string, ...string[]])
      .optional(),
  })
  .strict();

/**
 * Body for store `PATCH /admin/stores/:storeId/orders/:id/status`. Restricted to
 * the fulfilment subset — a store may advance an order along
 * processing/shipped/delivered or cancel it, but `paid`/`refunded` are payment
 * outcomes and MUST NOT be settable via this route.
 */
export const orderStatusPatchSchema = z.object({
  status: z.enum(['processing', 'shipped', 'delivered', 'cancelled']),
  trackingNumber: z.string().trim().min(1).optional(),
  note: z.string().trim().max(2000).optional(),
});

/** Body for seller `PATCH /seller/orders/:id/fulfill`. */
export const fulfillOrderSchema = z.object({
  status: z.enum(['processing', 'shipped', 'delivered']),
  trackingNumber: z.string().trim().min(1).optional(),
});

/** Query for order list endpoints (`page`/`limit` + optional `status` filter). */
export const orderListQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().optional(),
    status: orderStatusSchema.optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Customers (store-scoped buyer records)
// ---------------------------------------------------------------------------

/** An `AddressSnapshot` accepted on a customer/draft (mirrors `createAddressSchema`). */
const addressSnapshotSchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  recipientName: z.string().trim().min(1).max(200),
  line1: z.string().trim().min(1).max(300),
  line2: z.string().trim().min(1).max(300).optional(),
  city: z.string().trim().min(1).max(150),
  region: z.string().trim().min(1).max(150).optional(),
  postalCode: z.string().trim().min(1).max(40),
  country: z.string().trim().min(2).max(2),
  phone: z.string().trim().min(1).max(40).optional(),
});

/** Body for `POST /admin/stores/:storeId/customers` (CreateCustomerInput). */
export const createCustomerSchema = z.object({
  oxyUserId: z.string().trim().min(1).optional(),
  displayName: z.string().trim().min(1).max(200).optional(),
  email: z.string().trim().email().max(320).optional(),
  phone: z.string().trim().min(1).max(40).optional(),
  defaultAddress: addressSnapshotSchema.optional(),
  tags: z.array(z.string().trim().min(1).max(60)).optional(),
  groupTags: z.array(z.string().trim().min(1).max(60)).optional(),
  notes: z.string().trim().max(5_000).optional(),
});

/** Body for `PATCH /admin/stores/:storeId/customers/:id` (UpdateCustomerInput). */
export const updateCustomerSchema = createCustomerSchema
  .partial()
  .refine((obj) => Object.keys(obj).length > 0, { message: 'At least one field is required' });

/** Query for `GET /admin/stores/:storeId/customers` (`page`/`limit` + optional `search`). */
export const customerListQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().optional(),
    search: z.string().trim().min(1).max(200).optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Draft orders (POS)
// ---------------------------------------------------------------------------

/** Body for `POST /admin/stores/:storeId/draft-orders` (CreateDraftOrderInput). */
export const createDraftOrderSchema = z.object({
  locationId: z.string().trim().min(1).optional(),
  customerId: z.string().trim().min(1).optional(),
});

/** Body for `POST .../draft-orders/:id/lines` (AddDraftLineInput). */
export const addDraftLineSchema = z.object({
  listingId: z.string().trim().min(1),
  variantId: z.string().trim().min(1),
  quantity: z.number().int().positive(),
});

/** Body for `PATCH .../draft-orders/:id/lines/:variantId` (UpdateDraftLineInput). 0 removes. */
export const updateDraftLineSchema = z.object({
  quantity: z.number().int().nonnegative(),
});

/** Body for `POST .../draft-orders/:id/discounts` (ApplyDraftDiscountsInput). */
export const applyDraftDiscountsSchema = z.object({
  codes: z.array(z.string().trim().min(1)),
});

/** Body for `POST .../draft-orders/:id/customer` (SetDraftCustomerInput). */
export const setDraftCustomerSchema = z.object({
  customerId: z.string().trim().min(1),
});

/** Body for `PATCH /admin/stores/:storeId/draft-orders/:id` (UpdateDraftOrderInput). */
export const updateDraftOrderSchema = z
  .object({
    note: z.string().trim().max(2_000).optional(),
    shippingAddress: addressSnapshotSchema.optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, { message: 'At least one field is required' });

/** Body for `POST .../draft-orders/:id/complete` (CompleteDraftOrderInput — empty). */
export const completeDraftOrderSchema = z.object({});

/** Query for `GET /admin/stores/:storeId/draft-orders` (`page`/`limit` + optional `status`). */
export const draftOrderListQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().optional(),
    status: z.enum(['open', 'completed', 'cancelled']).optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Refunds / returns
// ---------------------------------------------------------------------------

/** A line in a `CreateRefundInput` (the server computes the refundable amount). */
export const refundLineInputSchema = z.object({
  variantId: z.string().trim().min(1),
  quantity: z.number().int().positive(),
  restock: z.boolean().optional(),
  locationId: z.string().trim().min(1).optional(),
});

/** Body for `POST /admin/stores/:storeId/orders/:id/refunds` (CreateRefundInput). */
export const createRefundSchema = z.object({
  type: z.enum(['refund', 'return']).optional(),
  reason: z.string().trim().max(2000).optional(),
  lineItems: z.array(refundLineInputSchema).min(1),
  refundShipping: z.boolean().optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
});

// ---------------------------------------------------------------------------
// Reports (store analytics)
// ---------------------------------------------------------------------------

/** Time-bucket granularity for the sales-over-time report. */
const salesReportIntervalSchema = z.enum(['day', 'week', 'month']);

/**
 * Query for `GET /admin/stores/:storeId/reports/sales`. `from`/`to` are ISO
 * datetimes (defaulted + clamped server-side); `interval` defaults to `day`.
 */
export const salesReportQuerySchema = z
  .object({
    // Offset accepted, for `externalUpdatedAt`'s reason (#290). `resolveRange`
    // reads these with `Date.parse`, which converts an offset correctly and
    // already falls back to the default window on anything unreadable — so
    // widening here only stops a valid timestamp being answered with a 400.
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    interval: salesReportIntervalSchema.optional(),
  })
  .passthrough();

/**
 * Query for `GET /admin/stores/:storeId/reports/top-products`. `from`/`to` are
 * ISO datetimes (defaulted + clamped server-side); `limit` defaults to 10.
 */
export const topProductsQuerySchema = z
  .object({
    // The same widening and the same reader as `salesReportQuerySchema` (#290).
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().positive().optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Pagination query
// ---------------------------------------------------------------------------

/** Reusable offset-pagination query (`page`/`limit`). */
export const paginationQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

/**
 * Body for `POST /reviews` (CreateReviewInput) — a SCOPED review (#76).
 *
 * `.strict()`, and that is load-bearing rather than tidy. Every field a
 * forbidden evidence source would arrive in — `email`, `phone`,
 * `guestSessionToken`, `portalToken`, `stripeCustomerId`, `paymentMethodId` —
 * is refused by the schema before any handler sees it, so the eligibility
 * service's named refusals are the second wall and not the first. A
 * `.passthrough()` here would let one of them reach a `req.body` spread.
 *
 * `targetType` is deliberately NOT accepted: it is derived server-side from the
 * scope, so a client cannot send a pair that disagrees.
 *
 * `verification`, `status` and `scope`-changing fields are absent for the same
 * reason `status` always was: a client that could set them could publish a
 * verified review it never earned, or move one out of `hidden`.
 */
export const createReviewSchema = z
  .object({
    scope: z.enum(['product', 'merchant', 'native_transaction', 'p2p_listing', 'p2p_seller']),
    canonicalProductId: z.string().trim().min(1).optional(),
    merchantId: z.string().trim().min(1).optional(),
    orderItemId: z.string().trim().min(1).optional(),
    listingId: z.string().trim().min(1).optional(),
    sellerOxyUserId: z.string().trim().min(1).optional(),
    eligibilityId: z.string().trim().min(1).optional(),
    rating: z.number().int().min(1).max(5),
    dimensions: z
      .array(
        z
          .object({
            key: z.enum([
              'quality',
              'durability',
              'value_for_money',
              'delivery_speed',
              'packaging',
              'communication',
              'order_accuracy',
              'condition_accuracy',
              'description_accuracy',
              'photo_accuracy',
              'shipping_speed',
              'reliability',
            ]),
            rating: z.number().int().min(1).max(5),
          })
          .strict(),
      )
      .max(6)
      .optional(),
    title: z.string().trim().min(1).max(200).optional(),
    body: z.string().trim().max(5000).optional(),
    // BCP-47 shape, matching `reviews_locale_shape_check` — the column would
    // reject anything else, and a 400 explains it better than a 500.
    locale: z
      .string()
      .trim()
      .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/u)
      .optional(),
    incentiveDisclosure: z
      .enum(['none', 'free_or_discounted_product', 'sweepstakes_entry', 'compensated', 'other'])
      .optional(),
  })
  .strict()
  .refine(
    (o) =>
      (o.scope === 'product' && !!o.canonicalProductId) ||
      (o.scope === 'merchant' && !!o.merchantId) ||
      (o.scope === 'native_transaction' && !!o.orderItemId) ||
      (o.scope === 'p2p_listing' && !!o.listingId) ||
      (o.scope === 'p2p_seller' && !!o.sellerOxyUserId),
    { message: 'scope requires the matching target id' },
  );

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

/** Body for `POST /feedback` (CreateFeedbackInput). Mirrors the `IFeedback` model. */
/**
 * `POST /reports` — an abuse report.
 *
 * Note what is NOT here: the reporter. It is taken from the authenticated
 * session, never from the body — a reporter id a client could set is an
 * attribution forgery, and the reporter's pseudonymous ref is what a jury's
 * one-penalty-per-incident accounting is derived from.
 */
export const abuseReportSchema = z.object({
  reportedType: z.enum(ABUSE_REPORTED_TYPES as unknown as [string, ...string[]]),
  reportedId: z.string().trim().min(1).max(128),
  categories: z
    .array(z.enum(ABUSE_REPORT_CATEGORIES as unknown as [string, ...string[]]))
    .min(1)
    .max(ABUSE_REPORT_CATEGORIES.length),
  details: z.string().trim().max(2_000).optional(),
});

export const feedbackSchema = z.object({
  type: z.enum(['bug', 'feature', 'improvement', 'other']),
  rating: z.number().int().min(1).max(5).optional(),
  message: z.string().trim().min(1).max(10_000),
  email: z.string().trim().email().max(320).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/** Query for `GET /notifications` (`page`/`limit` + optional `status`/`type` filter). */
export const notificationListQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().optional(),
    status: z.enum(['pending', 'sent', 'read', 'dismissed']).optional(),
    type: z.string().trim().min(1).optional(),
  })
  .passthrough();

/** Body for `POST /notifications/push-token` (register/update an Expo push token). */
export const pushTokenSchema = z.object({
  token: z.string().trim().min(1),
  deviceId: z.string().trim().min(1).optional(),
  platform: z.enum(['ios', 'android', 'web']).optional(),
});

/** Body for `DELETE /notifications/push-token` (deactivate an Expo push token). */
export const pushTokenDeleteSchema = z.object({
  token: z.string().trim().min(1),
});

/** Body for `POST /notifications/web-push-subscription` (save a browser subscription). */
export const webPushSubscriptionSchema = z.object({
  endpoint: z.string().trim().min(1),
  keys: z.object({
    p256dh: z.string().trim().min(1),
    auth: z.string().trim().min(1),
  }),
});

/** Body for `DELETE /notifications/web-push-subscription` (deactivate a subscription). */
export const webPushSubscriptionDeleteSchema = z.object({
  endpoint: z.string().trim().min(1),
});

// ---------------------------------------------------------------------------
// FX rates + currency preference
// ---------------------------------------------------------------------------

/** A single supported currency code (mirrors `CurrencyCode`, derived from the shared set). */
const currencyEnum = z.enum(CURRENCY_CODE_VALUES);

/**
 * Query for `GET /rates`. `base` defaults to FAIR (the display default); `quote` is an
 * optional comma list (e.g. `USD,EUR`) parsed + validated in the controller.
 */
export const ratesQuerySchema = z
  .object({
    base: currencyEnum.optional().default('FAIR'),
    quote: z.string().trim().min(1).optional(),
  })
  .passthrough();

/**
 * Body for `PUT /me/currency-preference`. Display-only preference; never affects
 * stored amounts. `secondaryCurrency` may be explicitly `null` to clear it.
 */
export const updateCurrencyPreferenceSchema = z
  .object({
    preferredCurrency: currencyEnum.nullable().optional(),
    secondaryCurrency: currencyEnum.nullable().optional(),
    dualDisplayEnabled: z.boolean().optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, { message: 'At least one field is required' });

// ---------------------------------------------------------------------------
// Connectors / channels
// ---------------------------------------------------------------------------

/** Sync direction for a single resource (mirrors `SyncResourceDirection`). */
const syncResourceDirectionSchema = z.enum(['pull', 'push', 'bidirectional', 'off']);

/**
 * Body for `POST /admin/stores/:storeId/channels/:provider/connect`. The shop
 * domain is strictly a `*.myshopify.com` host (also the SSRF host allowlist —
 * see `connectors/shopify/http.ts`).
 *
 * `onboardingSessionId` names the wizard the connect was started from, so the
 * out-of-band callback can link the connection it creates back onto it. OPTIONAL,
 * because a connect started from the plain channels screen has no wizard — and
 * shape-checked with `isLiveEntityId`, the one predicate that knows both id
 * shapes a row can hold. Whether the session exists, belongs to this store and is
 * still live is the SERVICE's question (`buildConnectAuthorizeUrl`); a schema
 * answering it would be a second authority over the same row.
 */
export const connectChannelSchema = z.object({
  shopDomain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/, 'Must be a *.myshopify.com domain'),
  onboardingSessionId: z
    .string()
    .trim()
    .refine(isLiveEntityId, 'Must be a valid onboarding session id')
    .optional(),
});

/**
 * Body for `PATCH /admin/stores/:storeId/channels/:connectionId/settings`
 * (UpdateSyncSettingsInput) — every field optional; at least one required.
 */
export const updateSyncSettingsSchema = z
  .object({
    products: syncResourceDirectionSchema.optional(),
    inventory: syncResourceDirectionSchema.optional(),
    orders: syncResourceDirectionSchema.optional(),
    autoPublish: z.boolean().optional(),
    // Shape-checked with `isLiveEntityId`, the one predicate that knows both id
    // shapes a `locations.id` can hold. A hand-written pattern here would reject
    // one of them.
    targetLocationId: z
      .string()
      .trim()
      .refine(isLiveEntityId, 'Must be a valid location id')
      .optional(),
    priceRules: z
      .object({
        markupPercent: z.number().finite().optional(),
        rounding: z.enum(['none', 'nearest', 'charm']).optional(),
      })
      .optional(),
    collectionMapping: z.record(z.string().min(1), z.string().min(1)).optional(),
    conflictPolicy: z.enum(['connector_wins', 'respect_overrides']).optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, { message: 'At least one field is required' });

// ---------------------------------------------------------------------------
// Channel ingestion (push_in)
// ---------------------------------------------------------------------------

/** Max products accepted in one products-ingest batch. */
const INGEST_PRODUCTS_MAX = 100;
/** Max items accepted in one inventory-ingest batch. */
const INGEST_INVENTORY_MAX = 500;

/**
 * Body for `POST /admin/stores/:storeId/channels/:provider/connect-push`
 * (`ConnectPushInput`). `shopDomain` is optional display metadata (the external
 * site's host) — unlike the pull `connect` flow it is NOT an SSRF host allowlist,
 * so it is a plain bounded string rather than a `*.myshopify.com` pattern.
 */
export const connectPushChannelSchema = z.object({
  shopDomain: z.string().trim().min(1).max(255).optional(),
});

/** One ingested variant (`IngestProductVariant`). */
const ingestVariantSchema = z.object({
  optionValues: z.array(optionValueSchema).max(MAX_VARIANT_AXES_PER_PRODUCT).optional(),
  price: moneySchema,
  compareAtPrice: moneySchema.optional(),
  sku: z.string().trim().min(1).max(120).optional(),
  barcode: z.string().trim().min(1).max(120).optional(),
  inventory: z.object({ available: z.number().int().nonnegative() }).optional(),
});

/** One ingested product (`IngestProduct`). */
const ingestProductSchema = z.object({
  externalId: z.string().trim().min(1).max(255),
  /**
   * The platform's own `updated_at`, as RFC 3339 — `Z` or a numeric offset.
   *
   * `{ offset: true }` is load-bearing and its absence was a total, silent
   * outage on this rail. On zod 3 a bare `.datetime()` accepts ONLY a `Z`
   * suffix, so `2026-08-15T05:38:08+00:00` — valid RFC 3339, and what PHP's
   * `DateTime::format('c')` emits, along with most date libraries by default —
   * was refused. Measured by running the WooCommerce plugin's own mapper over a
   * live 124-product catalogue against this schema: 0 of 124 products accepted
   * on plugin 1.0.0, 124 of 124 once it emitted `Z` (#290).
   *
   * What made it invisible rather than merely wrong is the INVENTORY payload,
   * which carries no timestamp and so validated under both spellings: "Test
   * connection" succeeded, the plugin reported healthy, stock flowed, and no
   * product ever arrived. Fixing the plugin removed that symptom and not this
   * defect — the next client to emit an offset hits the same wall the same way.
   *
   * A zoneless value stays REFUSED, which is the half worth keeping: RFC 3339
   * requires a zone, `new Date` reads a zoneless datetime as LOCAL time, and
   * admitting one would silently shift every stored instant by the server's
   * offset. Every shape this now accepts is one `new Date` CONVERTS to the
   * correct UTC instant — measured, including that `+02` (hour-only, which
   * `new Date` cannot parse at all) is rejected here rather than reaching the
   * column as an invalid date.
   */
  externalUpdatedAt: z.string().datetime({ offset: true }).optional(),
  title: z.string().trim().min(1).max(300),
  description: z.string().max(50_000).optional(),
  images: z
    .array(z.string().trim().url().startsWith('http', 'Must be an absolute http(s) URL'))
    .optional(),
  options: z.array(listingOptionSchema).max(MAX_VARIANT_AXES_PER_PRODUCT).optional(),
  variants: z.array(ingestVariantSchema).min(1),
  vendor: z.string().trim().min(1).max(200).optional(),
  productType: z.string().trim().min(1).max(200).optional(),
  handle: z.string().trim().min(1).max(200).optional(),
  seo: seoSchema.optional(),
});

/**
 * Body for `POST /admin/stores/:storeId/channels/:connectionId/ingest/products`
 * (`IngestProductsInput`) — a bounded batch of products to upsert.
 */
export const ingestProductsSchema = z.object({
  products: z.array(ingestProductSchema).min(1).max(INGEST_PRODUCTS_MAX),
});

/**
 * Body for `POST /admin/stores/:storeId/channels/:connectionId/ingest/inventory`
 * (`IngestInventoryInput`) — a bounded batch of absolute stock sets.
 */
export const ingestInventorySchema = z.object({
  items: z
    .array(
      z.object({
        externalId: z.string().trim().min(1).max(255),
        sku: z.string().trim().min(1).max(120).optional(),
        available: z.number().int().nonnegative(),
      }),
    )
    .min(1)
    .max(INGEST_INVENTORY_MAX),
});
