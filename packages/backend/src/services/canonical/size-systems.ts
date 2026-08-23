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
 * ## The key is OPAQUE, and deliberately NOT a function of the facets
 *
 * A system's four facets are REQUIRED FIELDS on its entry. Its key is a short
 * stable name that nothing composes and nothing parses. The governing
 * precedent is `unit.gigabyte`: `catalog_external_mappings` carries
 * `target_unit_family` as its OWN column beside `target_unit_code`, so the
 * family is a field and the key does not encode it — and ADR 0007's decision
 * superseding D1's enumeration puts size system in exactly that class, as a
 * *supporting registry* rather than a concept the epic names.
 *
 * **The reason is `no_sourced_mapping`, and it is the whole point.**
 * `compareSizeDeclarations` reaches that refusal only when `domain`,
 * `audience`, `measurementBasis` and `region` are all equal and the KEY
 * differs. Were a key `f(domain, region, audience, basis)`, all four equal
 * would imply one key, two such systems could not both exist, and that branch
 * would be unreachable. It is the ONLY relation a sourced mapping can ever
 * express — two brands' "EU" conventions agreeing on all four facets and still
 * being different systems is the aliasing case — and a derived key would
 * foreclose it inside a namespace every future `size_system` mapping cites
 * forever.
 *
 * So **two entries MAY share all four facets**. {@link buildRegistry} refuses a
 * duplicate KEY and deliberately does not look at facets at all.
 *
 * **A facet change is still a different system**, enforced by freezing the
 * entry rather than by a key re-deriving: an entry whose facets were wrong is
 * superseded by a NEW entry under a NEW key, never edited in place. ADR 0007
 * D1's "deprecated and superseded, never renamed", applied to the thing the key
 * names.
 *
 * **The cost, stated rather than left to be discovered: a reader cannot see a
 * system's facets from its key.** `size.shoe_eu` does not say who it is cut for
 * or whether it measures anything. That is the trade `unit.gigabyte` already
 * makes — you look the unit up to learn its family — and the remedy is the
 * same: read the entry, which is required to state all four.
 *
 * ## Why `size.` is the first segment, and why the subject is kept
 *
 * ADR 0007 D1 documents the key namespace by example — `color.black`,
 * `unit.gigabyte` — and the illustration in `catalogExternalMappings.ts`'s own
 * `DOTTED_KEY_SHAPE` docblock is `size.eu`. A key exists so "a human-readable
 * identity survives a database restore" (D1), and an identity that names its
 * own namespace survives being read without the column it came out of. The ADR
 * rules on the SHAPE of a machine key and nothing narrower; it does not fix a
 * size-system key format, so this is the decision it left open.
 *
 * **The SUBJECT is in the key BECAUSE the facets are not.** A key must be unique
 * across every system this registry will ever hold, and it is frozen, so that
 * has to be true forever rather than true today. The facets cannot supply it —
 * they are fields precisely so two systems may share all four — so the key
 * carries enough of WHAT is sized to keep a shoe apart from a dress.
 * `size.shoe_eu`, not `size.eu`: the bare form reads fine while footwear is the
 * only vertical and collides on the first apparel EU convention, at which point
 * the remedy is the rename D1 forbids.
 *
 * `shoe` is deliberately not the spelling of the `footwear` facet value, so the
 * key resembles no facet at all — which makes "opaque, never parsed" visible
 * rather than a rule somebody has to remember. And `size.shoe_cm` rather than
 * `size.cm`, because centimetres are a UNIT and the system is a foot length
 * measured in them; the bare form would invite a reader to treat this registry
 * as a unit table, which is `size_chart_as_conversion_table` one door over.
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
} from '@mercaria/shared-types';

/**
 * The first segment of every key in this namespace.
 *
 * A constant rather than a literal spelled at each use, because it appears in
 * the entries and in the tests that pin them, and two spellings of one
 * namespace prefix is how half a namespace ends up somewhere else.
 */
export const SIZE_SYSTEM_KEY_NAMESPACE = 'size';

/**
 * The four facts a size system IS — required on every entry, and NOT its key.
 *
 * Exactly `SizeSystem` minus `key` and minus `valueShape`, which
 * `shared-types/size-system.ts` states is "not a facet of identity". Written as
 * its own interface rather than as an `Omit` so the compiler refuses a fifth
 * field slipping in unnoticed: a subtractive type admits new members by
 * default, and every member of THIS one is something
 * `compareSizeDeclarations` decides a comparison on.
 */
export interface SizeSystemIdentity {
  readonly domain: SizeDomain;
  readonly region: SizeRegion;
  readonly audience: SizeAudience;
  readonly measurementBasis: SizeMeasurementBasis;
}

/**
 * The facets an entry must declare, as data.
 *
 * Asserted against a real entry's own shape by the test, so a facet added to
 * `SizeSystemIdentity` and forgotten in an entry fails the build. `audience` is
 * the one this exists for: a system that never declared who it is cut for would
 * be comparable with everything, and making the field required is what stops an
 * entry existing without one.
 */
export const SIZE_SYSTEM_IDENTITY_FACETS = [
  'domain',
  'region',
  'audience',
  'measurementBasis',
] as const satisfies readonly (keyof SizeSystemIdentity)[];

/**
 * Mercaria's size systems: a key, its four facets, and the shape of its values.
 *
 * Every entry is a convention the footwear vertical really publishes. The
 * audiences are its category SCOPES — the US definitions are scoped to the
 * men's and women's nodes and the EU, UK and centimetre ones to `shoes`, which
 * is what makes the first two gendered and the last three unisex. `unisex` is a
 * declared audience and deliberately not `unspecified`: the catalogue has
 * stated who these scales are cut for.
 *
 * The centimetre entry is the one to read. It is a foot LENGTH — a real
 * physical quantity in the `length` unit family — where the other four are
 * tokens printed on a box whose relationship to a foot is each manufacturer's
 * own. That difference is a facet, which is why no arithmetic anywhere relates
 * them, and why its region is `international` rather than a market: a
 * centimetre names no country.
 *
 * Two entries here happen to differ in more than one facet. Nothing requires
 * that: the table admits two keys agreeing on all four, which is the aliasing
 * case the module docblock explains.
 */
const DECLARED_SIZE_SYSTEMS: readonly SizeSystem[] = Object.freeze([
  {
    key: 'size.shoe_eu',
    domain: 'footwear',
    region: 'eu',
    audience: 'unisex',
    measurementBasis: 'manufacturer_label',
    valueShape: 'numeric',
  },
  {
    key: 'size.shoe_uk',
    domain: 'footwear',
    region: 'uk',
    audience: 'unisex',
    measurementBasis: 'manufacturer_label',
    valueShape: 'numeric',
  },
  {
    key: 'size.shoe_us_mens',
    domain: 'footwear',
    region: 'us',
    audience: 'mens',
    measurementBasis: 'manufacturer_label',
    valueShape: 'numeric',
  },
  {
    key: 'size.shoe_us_womens',
    domain: 'footwear',
    region: 'us',
    audience: 'womens',
    measurementBasis: 'manufacturer_label',
    valueShape: 'numeric',
  },
  {
    key: 'size.shoe_cm',
    domain: 'footwear',
    region: 'international',
    audience: 'unisex',
    measurementBasis: 'foot_length',
    valueShape: 'measurement',
  },
]);

/**
 * Build the table, refusing two entries under one key.
 *
 * **It looks at the KEY and at nothing else, and the absence of a facet check
 * is deliberate rather than missing.** Two entries sharing all four facets are
 * legitimate and MUST be admitted — that admission IS the relation
 * `no_sourced_mapping` exists to express. Adding a "two entries have identical
 * facets" check here for safety would reinstate the derived-key collapse under
 * a different mechanism: the systems this domain must be able to hold would
 * become a build error. So the only thing that can be wrong here is one key
 * naming two systems, which a `Map` would otherwise resolve silently by keeping
 * the last.
 *
 * It throws at import, the posture `registerCatalogConceptRegistry` takes
 * toward two readers for one dimension. The input is a code constant, so this
 * is a build failure and never a runtime one; the test asserting the keys are
 * distinct is what measures it, and this is what makes a mistake loud at boot
 * rather than at somebody's first insert.
 */
function buildRegistry(declared: readonly SizeSystem[]): ReadonlyMap<string, SizeSystem> {
  const byKey = new Map<string, SizeSystem>();
  for (const entry of declared) {
    if (byKey.has(entry.key)) {
      throw new Error(
        `Two size systems are declared under the key '${entry.key}'. A key is an identity; ` +
          'two systems that are genuinely different need two keys, and one of these is a typo.',
      );
    }
    byKey.set(entry.key, Object.freeze({ ...entry }));
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
const SIZE_SYSTEMS_BY_KEY: ReadonlyMap<string, SizeSystem> = buildRegistry(DECLARED_SIZE_SYSTEMS);

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

/** Every key in the namespace, in declaration order. */
export function sizeSystemKeys(): readonly string[] {
  return SIZE_SYSTEM_DEFINITIONS.map((system) => system.key);
}

/**
 * Resolve a key to the system it names, or `null`.
 *
 * EXACT match, with no trim and no case fold — the one place this deliberately
 * differs from `units.ts`'s `resolveUnit`, which does both. `resolveUnit` reads
 * a SOURCE's own spelling, where `GB`, `gb` and `gigabyte` are three ways
 * somebody wrote one unit. This reads a Mercaria KEY, which is one spelling by
 * construction: `target_size_system_key` is CHECK-restricted to `^[a-z]...`, so
 * a key that also resolved under ` Size.Shoe_EU ` would be a second name for
 * one concept and the two would index differently.
 *
 * Never throws, for any input. A key this table does not hold is `null`, which
 * the registry reports as `absent` and the resolver turns into a blocking
 * `target_unresolvable`.
 */
export function resolveSizeSystem(key: string): SizeSystem | null {
  if (typeof key !== 'string') return null;
  return SIZE_SYSTEMS_BY_KEY.get(key) ?? null;
}
