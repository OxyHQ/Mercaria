/**
 * Portable references — what another application PERSISTS.
 *
 * A ref carries exactly the stable id needed to resolve the entity and nothing
 * that can change: no title, no image, no price, no availability, and no store
 * HANDLE (a merchant can rename one). A consumer stores the ref and hydrates
 * current facts through the SDK every time it renders them.
 *
 * A ref inside a RESPONSE is open like every response object (an added key is
 * dropped, never fatal to an older parser); {@link MercariaRefSchema} — the
 * schema for a ref read back from a consumer's own storage — is STRICT, because
 * a persisted ref with a second field is a snapshot pretending to be identity.
 * Every ref parses to a frozen value.
 *
 * The product grain is the SELLABLE product: the thing a store or a person puts
 * up for sale, with its own purchase options, price and stock. Its id is
 * globally unique, so a product ref does not name its store. The multi-seller
 * canonical catalogue identity (ADR 0002) is a different grain and is not part
 * of this contract.
 */

import { z } from 'zod';
import { MercariaIdSchema } from './primitives';

/** The entity kinds a portable reference can name. */
export const MERCARIA_REF_KINDS = ['product', 'variant', 'store', 'collection'] as const;
export type MercariaRefKind = (typeof MERCARIA_REF_KINDS)[number];

/** A sellable product, by its globally unique id. */
const productRef = z.object({ kind: z.literal('product'), id: MercariaIdSchema });
export const MercariaProductRefSchema = productRef.readonly();
export type MercariaProductRef = z.infer<typeof MercariaProductRefSchema>;

/**
 * One purchase option of a product. Carries the product id as well as the
 * variant id because a variant is resolved THROUGH its product — there is no
 * public read of a lone variant.
 */
const variantRef = z.object({ kind: z.literal('variant'), productId: MercariaIdSchema, variantId: MercariaIdSchema });
export const MercariaVariantRefSchema = variantRef.readonly();
export type MercariaVariantRef = z.infer<typeof MercariaVariantRefSchema>;

/** A store, by id — never by handle, which the merchant can change. */
const storeRef = z.object({ kind: z.literal('store'), id: MercariaIdSchema });
export const MercariaStoreRefSchema = storeRef.readonly();
export type MercariaStoreRef = z.infer<typeof MercariaStoreRefSchema>;

/** A store's curated collection, by its globally unique id. */
const collectionRef = z.object({ kind: z.literal('collection'), id: MercariaIdSchema });
export const MercariaCollectionRefSchema = collectionRef.readonly();
export type MercariaCollectionRef = z.infer<typeof MercariaCollectionRefSchema>;

/** Any portable Mercaria reference, as a consumer persisted it: exactly the contract's keys. */
export const MercariaRefSchema = z.discriminatedUnion('kind', [
  productRef.strict().readonly(),
  variantRef.strict().readonly(),
  storeRef.strict().readonly(),
  collectionRef.strict().readonly(),
]);
export type MercariaRef = z.infer<typeof MercariaRefSchema>;
