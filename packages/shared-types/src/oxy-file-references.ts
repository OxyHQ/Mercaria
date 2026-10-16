/**
 * Oxy Files usage registration (Oxy ADR 0041 D4/D6/D9).
 *
 * Every Mercaria row that holds an Oxy file id tells Oxy so, as a reference
 * `(fileId, entityType, entityId)` owned by the Mercaria application. Oxy keeps
 * an application-owned file only while something references it, so a usage that
 * is never registered reads as unused and is collected.
 *
 * `entityType` is part of a contract with ANOTHER service (Oxy stores it, and
 * reconciliation is per entity type), so these names are stable: renaming one
 * strands every reference Oxy holds under the old name until the next
 * reconciliation of the old name removes them — and nothing would run it. Add a
 * name; never rename one. `docs/catalog-media.md` documents, per name, the row
 * whose id is the `entityId` and who owns the file.
 */
export const OXY_FILE_REFERENCE_ENTITY_TYPES = [
  // Seller and store catalogue media.
  'listing_image',
  'listing_description_image',
  'condition_photo',
  'store_logo',
  'store_cover',
  'store_policy_image',
  'collection_image',
  'seller_draft_image',
  'authoring_draft_image',
  // Content no account owns — files owned by the Mercaria application.
  'canonical_image',
  'canonical_description_image',
  'category_image',
  'brand_logo',
  'organization_archive_logo',
  // Buyer content and evidence: ownership unchanged, usage registered.
  'review_media',
  'return_request_evidence',
  'retail_service_request_evidence',
  'supplier_agreement_evidence',
  'retail_resale_evidence',
  'retail_compliance_evidence',
  'merchant_claim_evidence',
  'relationship_evidence',
  // History and private deliverables.
  'order_item_image',
  'digital_asset_file',
] as const;
export type OxyFileReferenceEntityType = (typeof OXY_FILE_REFERENCE_ENTITY_TYPES)[number];

/**
 * Who owns the bytes an entity type holds (ADR 0041 D1). `account` is a person or
 * an organization — a store's media belongs to `stores.oxy_account_id`, a P2P
 * listing's to its seller; `application` is the Mercaria application itself.
 */
export const OXY_FILE_OWNER_KINDS = ['account', 'application'] as const;
export type OxyFileOwnerKind = (typeof OXY_FILE_OWNER_KINDS)[number];

/** The file events Oxy sends an application holding a reference (ADR 0041 D9). */
export const OXY_FILE_EVENT_TYPES = [
  'file.deleted',
  'file.trashed',
  'file.restored',
  'file.visibility_changed',
  'file.blocked',
  'file.unblocked',
] as const;
export type OxyFileEventType = (typeof OXY_FILE_EVENT_TYPES)[number];

/**
 * The events after which Mercaria stops SHOWING the file: Oxy no longer serves
 * it, and a takedown has to leave the page, not just break an image. `trashed`
 * is deliberately absent — an account's owner may restore what they trashed, and
 * removing it from a gallery would be a decision nobody can undo.
 */
export const OXY_FILE_DETACHING_EVENT_TYPES = [
  'file.deleted',
  'file.blocked',
] as const satisfies readonly OxyFileEventType[];

/**
 * What handling a file event did to one holding row — the audit vocabulary.
 *
 * - `removed`: the row, the column value or the `<img>` element is gone.
 * - `suppressed`: the row stays, in a state that no longer shows the file
 *   (a canonical image `suppressed`, a condition photo `rejected`/`withdrawn`).
 * - `retained`: recorded and deliberately left as it is — evidence, an order
 *   snapshot or a private deliverable is history, never rewritten.
 */
export const OXY_FILE_EVENT_ACTIONS = ['removed', 'suppressed', 'retained'] as const;
export type OxyFileEventAction = (typeof OXY_FILE_EVENT_ACTIONS)[number];
