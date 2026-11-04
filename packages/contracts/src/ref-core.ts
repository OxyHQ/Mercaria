/** Portable identity rules shared by schema validators and lightweight consumers. */
export const MERCARIA_ID_PATTERN = /\S/;
export const MERCARIA_REF_KINDS = [
  'product',
  'variant',
  'store',
  'collection',
  'location',
  'catalog_product',
] as const;
export type MercariaRefKind = (typeof MERCARIA_REF_KINDS)[number];

/** The one field definition used to construct both schemas and portable parsers. */
export const MERCARIA_REF_ID_FIELDS = {
  product: ['id'],
  variant: ['productId', 'variantId'],
  store: ['id'],
  collection: ['id'],
  location: ['id'],
  catalog_product: ['id'],
} as const satisfies Record<MercariaRefKind, readonly string[]>;
export type MercariaRefFor<K extends MercariaRefKind> = Readonly<
  { kind: K } & Record<(typeof MERCARIA_REF_ID_FIELDS)[K][number], string>
>;
export type MercariaRef = { [K in MercariaRefKind]: MercariaRefFor<K> }[MercariaRefKind];

function isRefKind(value: unknown): value is MercariaRefKind {
  return typeof value === 'string' && Object.hasOwn(MERCARIA_REF_ID_FIELDS, value);
}

/** Exact persisted fields, plain data, opaque nonblank IDs, fresh frozen output. */
export function parsePortableMercariaRef(value: unknown): MercariaRef | null {
  if (typeof value !== 'object' || value === null) return null;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  if (!('kind' in value)) return null;
  const kind = value.kind;
  if (!isRefKind(kind)) return null;
  const fields = MERCARIA_REF_ID_FIELDS[kind];
  const keys = Object.keys(value);
  if (keys.length !== fields.length + 1 || !keys.includes('kind')) return null;
  const result: Record<string, string> = { kind };
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) return null;
    const id: unknown = Reflect.get(value, field);
    if (typeof id !== 'string' || !MERCARIA_ID_PATTERN.test(id)) return null;
    result[field] = id;
  }
  // Every field and discriminant was validated against the canonical definition.
  return Object.freeze(result) as MercariaRef;
}
