/**
 * The size-system code registry (#367 Workstream 11).
 *
 * `services/canonical/units.ts` one concept over: a small, deterministic table
 * of Mercaria-side concepts, resolved by KEY, holding no database and answering
 * one question. `concept-registry.port.ts` names both in the same sentence —
 * `unit` resolves "against `services/canonical/units.ts`", and `size_system`
 * against nothing at all — and this file is the second half of that sentence.
 *
 * ## What this does, in one sentence, and what it must never become
 *
 * It IDENTIFIES: given a key, it says whether Mercaria has a size system under
 * that name. It does not relate two size systems, it does not convert a size,
 * it does not rank them and it holds no chart. `units.ts` legitimately converts
 * because a millimetre and an inch are two names for one physical length;
 * `SIZE_SYSTEM_FORBIDDEN_OPERATIONS` exists because an EU 42 and a US 9 are
 * not, and `size-system-non-equivalence.test.ts` scans the whole backend —
 * this file included — for the shapes such a conversion would take.
 *
 * ## The key is GENERATED from the facets and is never parsed
 *
 * `shared-types/size-system.ts` states the failure this whole vocabulary
 * exists against: the four facts a size system consists of were "encoded in
 * the SPELLING of the key", and "a spelling is not a model". So the four
 * facets are the authority here and {@link sizeSystemKey} derives the key from
 * them — the `endpoint_key` / `commercial_key` device, a generated composite
 * rather than a parsed one. There is deliberately no inverse function, and
 * adding one would make the derivation a second authority: at that moment a
 * reader could split a key on dots and get facets that disagree with the row.
 *
 * Two consequences worth stating rather than discovering:
 *
 * - **A key cannot disagree with its own metadata**, which is the property a
 *   short opaque key (`size.eu`) cannot have. That spelling names a region and
 *   is silent about domain, audience and measurement basis — and audience is
 *   the facet that costs a full size when it is dropped.
 * - **Correcting a facet mints a DIFFERENT key**, which is exactly ADR 0007
 *   D1's rule ("a concept whose key was wrong is deprecated and superseded,
 *   never renamed") arriving for free. If a system's facets change it IS a
 *   different system, and the derived key says so out loud.
 *
 * ## Why `size.` is the first segment
 *
 * ADR 0007 D1 documents the key namespace by example — `color.black`,
 * `unit.gigabyte` — and the illustration in `catalogExternalMappings.ts`'s own
 * `DOTTED_KEY_SHAPE` docblock is `size.eu`. A key exists so "a human-readable
 * identity survives a database restore" (D1), and an identity that names its
 * own namespace survives being read without the column it came out of. The ADR
 * rules on the SHAPE of a machine key and on nothing narrower; it does not fix
 * a size-system key format, so this is the decision it left open and this file
 * is where it is made.
 *
 * ## The members are the systems Mercaria's catalogue actually declares
 *
 * Five, all footwear, because the footwear vertical is the only sizing
 * Mercaria publishes today. Seeding an apparel or ring system nothing sells in
 * would make a `size_system` mapping RESOLVE against a convention no listing
 * can express — the "registry that answers yes to everything" failure in
 * miniature, and worse than the unregistered seam it replaces, because the
 * seam at least failed visibly.
 *
 * ## This file relates NOTHING to an attribute key
 *
 * `scripts/seed-verticals/footwear.ts` declares those same five conventions as
 * ATTRIBUTE definitions, and the facets below were read off it rather than
 * invented. That correspondence is prose and stays prose: no value here is an
 * attribute key, no function maps one to the other, and
 * `size-system-registry.test.ts` fails the build on a comment-stripped source
 * carrying one. Relating the two namespaces is the value-level mapping this
 * epic re-scoped to an ADR amendment, and it would arrive here disguised as a
 * convenience.
 */

import type {
  SizeAudience,
  SizeDomain,
  SizeMeasurementBasis,
  SizeRegion,
  SizeSystem,
  SizeValueShape,
} from '@mercaria/shared-types';

/**
 * The first segment of every key this registry mints.
 *
 * A constant rather than a literal spelled at each use, because it appears in
 * the derivation and in the tests that pin the derivation, and two spellings of
 * one namespace prefix is how half a namespace ends up somewhere else.
 */
export const SIZE_SYSTEM_KEY_NAMESPACE = 'size';

/**
 * The four facts a size system IS.
 *
 * Exactly `SizeSystem` minus `key` (derived from these) and minus `valueShape`,
 * which `shared-types/size-system.ts` states is "not a facet of identity". The
 * type is written as its own interface rather than as an `Omit` so the compiler
 * refuses a fifth field silently joining the key: a subtractive type admits new
 * members by default, and every member of THIS one changes what a key is
 * forever.
 */
export interface SizeSystemIdentity {
  readonly domain: SizeDomain;
  readonly region: SizeRegion;
  readonly audience: SizeAudience;
  readonly measurementBasis: SizeMeasurementBasis;
}

/**
 * The facet ORDER the key is built in, as data.
 *
 * Read by {@link sizeSystemKey} and asserted against `SizeSystemIdentity`'s own
 * shape by the test, so a facet added to the interface and forgotten here fails
 * the build rather than quietly leaving two systems sharing one key.
 */
export const SIZE_SYSTEM_IDENTITY_FACETS = [
  'domain',
  'region',
  'audience',
  'measurementBasis',
] as const satisfies readonly (keyof SizeSystemIdentity)[];

/**
 * The key for one identity. The ONE derivation, and there is no inverse.
 *
 * Total over the four closed tuples, and the claim that every key it can
 * produce satisfies `catalog_external_mappings_size_system_key_shape_check` is
 * proved in TWO halves, because neither instrument can make it alone:
 *
 * - Every tuple member is a legal SEGMENT (`[a-z][a-z0-9_]*`) — asserted over
 *   all four vocabularies in `size-system-registry.test.ts`.
 * - A key composed of such segments is actually ACCEPTED by that CHECK —
 *   asserted against a real PostgreSQL server in
 *   `size-system-registry.realdb.test.ts`, because a regex re-implemented here
 *   would be a test of the re-implementation.
 *
 * The realdb half covers the keys that EXIST; the tuple half is what extends it
 * to the ones a future declaration could mint. Stated as two because the realdb
 * suite alone would leave a member like `us-west` breaking the namespace with
 * nothing red until somebody declared a system using it.
 */
export function sizeSystemKey(identity: SizeSystemIdentity): string {
  return [
    SIZE_SYSTEM_KEY_NAMESPACE,
    identity.domain,
    identity.region,
    identity.audience,
    identity.measurementBasis,
  ].join('.');
}

/** One declared system: its identity, plus the shape of the values it carries. */
interface DeclaredSizeSystem extends SizeSystemIdentity {
  readonly valueShape: SizeValueShape;
}

/**
 * Mercaria's size systems, as facets.
 *
 * Every entry is a convention the footwear vertical really publishes. The
 * audiences are its category SCOPES — the US definitions are scoped to the
 * men's and women's nodes and the EU, UK and centimetre ones to `shoes`, which
 * is what makes the first two gendered and the last three unisex. `unisex` is
 * a declared audience and is deliberately not `unspecified`: the catalogue has
 * stated who these scales are cut for.
 *
 * The centimetre entry is the one to read. It is a foot LENGTH — a real
 * physical quantity in the `length` unit family — where the other four are
 * tokens printed on a box whose relationship to a foot is each manufacturer's
 * own. That difference is a facet, which is why no arithmetic anywhere relates
 * them, and why its region is `international` rather than a market: a
 * centimetre names no country.
 */
const DECLARED_SIZE_SYSTEMS: readonly DeclaredSizeSystem[] = Object.freeze([
  {
    domain: 'footwear',
    region: 'eu',
    audience: 'unisex',
    measurementBasis: 'manufacturer_label',
    valueShape: 'numeric',
  },
  {
    domain: 'footwear',
    region: 'uk',
    audience: 'unisex',
    measurementBasis: 'manufacturer_label',
    valueShape: 'numeric',
  },
  {
    domain: 'footwear',
    region: 'us',
    audience: 'mens',
    measurementBasis: 'manufacturer_label',
    valueShape: 'numeric',
  },
  {
    domain: 'footwear',
    region: 'us',
    audience: 'womens',
    measurementBasis: 'manufacturer_label',
    valueShape: 'numeric',
  },
  {
    domain: 'footwear',
    region: 'international',
    audience: 'unisex',
    measurementBasis: 'foot_length',
    valueShape: 'measurement',
  },
]);

/**
 * Build the table, refusing two declarations that derive one key.
 *
 * A collision is possible in principle — `valueShape` is not part of the key,
 * and `shared-types/size-system.ts` says two systems differing only in shape
 * are still two systems — so the collapse is made LOUD rather than left to
 * whoever notices that one of their two conventions stopped resolving. It
 * throws at import, which is the same posture `registerCatalogConceptRegistry`
 * takes toward two readers for one dimension: the input is a code constant, so
 * a throw here is a build failure and never a runtime one.
 */
function buildRegistry(
  declared: readonly DeclaredSizeSystem[],
): ReadonlyMap<string, SizeSystem> {
  const byKey = new Map<string, SizeSystem>();
  for (const entry of declared) {
    const key = sizeSystemKey(entry);
    if (byKey.has(key)) {
      throw new Error(
        `Two size systems derive the key '${key}'. The four identity facets are the key, so ` +
          'two declarations sharing them are one system — or one of them names its facets wrongly.',
      );
    }
    byKey.set(key, Object.freeze({ key, ...entry }));
  }
  return byKey;
}

/**
 * The lookup table.
 *
 * A `Map` rather than an object literal, and the difference is a security
 * property rather than a taste: an object lookup answers `__proto__`,
 * `constructor` and `toString` from the prototype chain, so a registry built on
 * one would report `present` for three keys it does not have and one of them
 * would come back as a function. A `Map` has no prototype chain to walk.
 */
const SIZE_SYSTEMS_BY_KEY: ReadonlyMap<string, SizeSystem> =
  buildRegistry(DECLARED_SIZE_SYSTEMS);

/**
 * Every size system Mercaria has, in declaration order.
 *
 * Enumeration only. `conceptExists` is a question about ONE key and the
 * external-mapping port deliberately offers no "list every key" — an operator
 * tool reads this, a resolution never does.
 */
export const SIZE_SYSTEM_DEFINITIONS: readonly SizeSystem[] = Object.freeze([
  ...SIZE_SYSTEMS_BY_KEY.values(),
]);

/** Every minted key, in declaration order. */
export function sizeSystemKeys(): readonly string[] {
  return SIZE_SYSTEM_DEFINITIONS.map((system) => system.key);
}

/**
 * Resolve a key to the system it names, or `null`.
 *
 * EXACT match, with no trim and no case fold — the one place this deliberately
 * differs from `units.ts`'s `resolveUnit`, which does both.
 * `resolveUnit` reads a SOURCE's own spelling, where `GB`, `gb` and `gigabyte`
 * are three ways somebody wrote one unit. This reads a Mercaria KEY, which is
 * one spelling by construction: `target_size_system_key` is CHECK-restricted to
 * `^[a-z]...`, so a key that also resolved under ` Size.EU ` would be a second
 * name for one concept and the two would index differently.
 *
 * Never throws, for any input. A key this table does not hold is `null`, which
 * the registry reports as `absent` and the resolver turns into a blocking
 * `target_unresolvable`.
 */
export function resolveSizeSystem(key: string): SizeSystem | null {
  if (typeof key !== 'string') return null;
  return SIZE_SYSTEMS_BY_KEY.get(key) ?? null;
}
