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

/** Supported currency codes (mirrors `CurrencyCode`). */
const currencySchema = z.enum(['FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD']);

/** `Money` input: integer minor units, non-negative, with a supported currency. */
const moneySchema = z.object({
  amount: z.number().int().nonnegative(),
  currency: currencySchema,
});

/** A single `{ name, value }` option assignment. */
const optionValueSchema = z.object({
  name: z.string().trim().min(1),
  value: z.string().trim().min(1),
});

/** A selectable option and its allowed values. */
const listingOptionSchema = z.object({
  name: z.string().trim().min(1),
  values: z.array(z.string().trim().min(1)).min(1),
});

/** SEO override (title/description) shared by store products and collections. */
const seoSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(500).optional(),
});

// ---------------------------------------------------------------------------
// P2P listing
// ---------------------------------------------------------------------------

/** Body for `POST /seller/listings` (CreateP2PListingInput). */
export const createP2PListingSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(10_000),
  price: moneySchema,
  condition: z.enum(['new', 'used']),
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
    condition: z.enum(['new', 'used']).optional(),
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

// ---------------------------------------------------------------------------
// Store product + variants
// ---------------------------------------------------------------------------

/** A variant supplied when creating a store product (CreateStoreProductVariantInput). */
const createStoreProductVariantSchema = z.object({
  optionValues: z.array(optionValueSchema),
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
  options: z.array(listingOptionSchema),
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
    optionValues: z.array(optionValueSchema).optional(),
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

/** A minimum requirement (DiscountMinimumRequirement). */
const discountMinimumRequirementSchema = z.object({
  type: z.enum(['none', 'subtotal', 'quantity']),
  value: z.number().int().nonnegative(),
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
  value: z.number().int().nonnegative(),
  appliesTo: discountAppliesToSchema,
  buy: discountLegSchema.optional(),
  get: discountLegSchema.optional(),
  minimumRequirement: discountMinimumRequirementSchema.optional(),
  customerEligibility: discountCustomerEligibilitySchema.optional(),
  usageLimits: discountUsageLimitsSchema.optional(),
  combinesWith: discountCombinesWithSchema.optional(),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
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
const storePermissionSchema = z.enum([
  'store:manage',
  'members:manage',
  'products:read',
  'products:write',
  'inventory:write',
  'locations:write',
  'collections:write',
  'discounts:write',
  'settings:write',
  'orders:read',
  'orders:fulfill',
  'stats:read',
  'customers:read',
  'customers:write',
  'draft_orders:write',
  'refunds:write',
]);

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

/** Body for `POST /checkout` (CheckoutInput). */
export const checkoutSchema = z.object({
  addressId: z.string().trim().min(1),
  sellerKeys: z.array(z.string().trim().min(1)).optional(),
  shippingSelections: z.record(z.string(), shippingMethodSchema).optional(),
  discountCodes: z.array(z.string().trim().min(1)).optional(),
});

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
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    interval: salesReportIntervalSchema.optional(),
  })
  .passthrough();

/**
 * Query for `GET /admin/stores/:storeId/reports/top-products`. `from`/`to` are
 * ISO datetimes (defaulted + clamped server-side); `limit` defaults to 10.
 */
export const topProductsQuerySchema = z
  .object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
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

/** Body for `POST /reviews` (CreateReviewInput). The target id must match the type. */
export const createReviewSchema = z
  .object({
    targetType: z.enum(['listing', 'store', 'seller']),
    listingId: z.string().trim().min(1).optional(),
    storeId: z.string().trim().min(1).optional(),
    sellerOxyUserId: z.string().trim().min(1).optional(),
    orderId: z.string().trim().min(1).optional(),
    rating: z.number().int().min(1).max(5),
    title: z.string().trim().min(1).max(200).optional(),
    body: z.string().trim().max(5000).optional(),
  })
  .refine(
    (o) =>
      (o.targetType === 'listing' && !!o.listingId) ||
      (o.targetType === 'store' && !!o.storeId) ||
      (o.targetType === 'seller' && !!o.sellerOxyUserId),
    { message: 'targetType requires the matching target id' },
  );

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

/** Body for `POST /feedback` (CreateFeedbackInput). Mirrors the `IFeedback` model. */
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

/** A single supported currency code (mirrors `CurrencyCode`). */
const currencyEnum = z.enum(['FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD']);

/**
 * Query for `GET /rates`. `base` defaults to the canonical FAIR; `quote` is an
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
