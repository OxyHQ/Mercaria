/**
 * The wall around ADR 0007 D15 — Mercaria's catalogue classifies a physical
 * good, and nothing else (#367 line 144).
 *
 * `@mercaria/shared-types` `commerce-type.ts` is the decision; this is the half
 * that makes it hold. It answers two different questions and both are needed:
 *
 * 1. **Is the decision still TOTAL?** The tuples are disjoint, the disposition
 *    map covers every member and nothing else, and an exclusion still names what
 *    admitting it would cost. `tsc` holds the missing-key direction; it does not
 *    hold an orphan left behind, an empty prerequisite list, or a membership
 *    that quietly grew.
 * 2. **Has anything grown a REPRESENTATION of an excluded type?** A whole-tree,
 *    comment-stripped scan for the identifiers each excluded type would arrive
 *    under.
 *
 * ## The population is DELIBERATELY the whole tree
 *
 * `docs/isolation-gates.md` §"What does close it" is about a gate whose
 * population is one DOMAIN, where an over-broad derivation absorbs the plant and
 * the control cannot tell. That hazard does not apply here, and saying which
 * shape this is, is part of the file: there is no narrower correct population,
 * because the decision is that NO module anywhere may introduce these. The
 * failure modes that remain are a walk that reaches nothing, a walk that loses a
 * subtree, a stripper that eats everything and a detector that cannot match —
 * and each has a control below.
 *
 * ## Why the detectors are the IDENTIFIERS rather than the words
 *
 * A scan for `digital`, `service`, `subscription`, `entitlement`, `voucher` or
 * `gift card` is a scan for six words this repository legitimately uses in other
 * senses: `digital_storage` is the unit family every RAM and storage attribute
 * is measured in, `*.service.ts` is every module in `src/services/`,
 * `merchant_subscription_*` and `entitlement_grants` are #89's SaaS billing of
 * merchants, and `CHANNEL_ENTITY_POLICY.gift_cards` exists precisely to record
 * that Mercaria has no gift card. Detecting those would be a gate whose cheapest
 * green is deleting it. So each detector names the spellings a representation
 * would actually arrive under — a column, a field, a union member — and states
 * which sense it is NOT looking for, so the next reader does not widen it back.
 *
 * ## Admitting a type disarms its detector, and that is the intended shape
 *
 * The detectors are keyed on the EXCLUDED half of `COMMERCE_TYPE_DISPOSITIONS`.
 * Classify `digital_good` and its detector stops applying — which is right,
 * because the cheapest green is then the decision itself, made where a reviewer
 * sees it, beside the prerequisites it has to discharge and the exact-membership
 * assertion below that has to move with it. A gate whose cheapest green is the
 * dangerous action is worse than no gate (`~/Oxy/AGENTS.md` §Gates); this one's
 * cheapest green is an ADR amendment.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  COMMERCE_TYPE_DISPOSITIONS,
  COMMERCE_TYPE_PREREQUISITES,
  EXCLUDED_COMMERCE_TYPES,
  MERCARIA_COMMERCE_TYPES,
  PHYSICAL_GOOD_COMPOSITIONS,
  PHYSICAL_GOOD_COMPOSITION_KINDS,
  type CommerceType,
  type ExcludedCommerceType,
} from '@mercaria/shared-types';
import { assertEachOf } from './assert-each-of';
import { stripComments } from './package-barrel-symbols';
import {
  PACKAGES_ROOT,
  readPackagesDirectory,
  walkPackagesDirectory,
  type DirectoryEntry,
} from './domain-population';

/* -------------------------------------------------------------------------- */
/* The population                                                              */
/* -------------------------------------------------------------------------- */

interface ScannedRoot {
  /** Relative to `packages/`. */
  readonly root: string;
  /**
   * A floor comfortably BELOW today's count rather than equal to it.
   *
   * Equality would go red on any unrelated file deletion, and a floor that can
   * never drop makes deleting the floor the cheapest green — the failure the
   * floors exist to prevent, one level up. What a floor has to catch is
   * COLLAPSE: a walk that reaches nothing, or one that reaches a single
   * subdirectory. Measured at the commit that added this file: `backend/src`
   * 1661 modules, `shared-types/src` 125.
   */
  readonly fileFloor: number;
  /**
   * How many top-level directories the root must still have, so a walk that
   * loses a subtree is caught by something other than the file floor.
   *
   * `shared-types/src` is FLAT and its floor is 0 — stated rather than omitted,
   * because a zero that arrived by accident and a zero that is the truth about a
   * flat directory look identical.
   */
  readonly directoryFloor: number;
}

const SCANNED_ROOTS: readonly ScannedRoot[] = [
  { root: 'backend/src', fileFloor: 1400, directoryFloor: 9 },
  { root: 'shared-types/src', fileFloor: 110, directoryFloor: 0 },
];

/** One module, with its comments removed. */
interface ScannedModule {
  /** Relative to `packages/`, e.g. `backend/src/services/cart.service.ts`. */
  readonly path: string;
  readonly lines: readonly string[];
}

const readModule = (relative: string): string =>
  readFileSync(join(PACKAGES_ROOT, relative), 'utf8');

const asModule = (relative: string, source: string): ScannedModule => ({
  path: relative,
  lines: stripComments(source).split('\n'),
});

/**
 * Every module in scope, comments removed.
 *
 * `walkPackagesDirectory` already skips `__tests__` and `node_modules`, which is
 * why this gate needs no exemption for ITSELF: a test file naming a forbidden
 * spelling — as this one does, dozens of times — is outside the population by
 * construction rather than by a line somebody remembered to write.
 */
function scanModules(): ScannedModule[] {
  return SCANNED_ROOTS.flatMap(({ root }) =>
    walkPackagesDirectory(root).map((relative) => asModule(relative, readModule(relative))),
  );
}

/* -------------------------------------------------------------------------- */
/* The detectors                                                               */
/* -------------------------------------------------------------------------- */

interface Detector {
  /** The excluded type this would be a representation OF, or the rival seam. */
  readonly type: ExcludedCommerceType | 'rival_discriminator';
  /** Case-insensitive, so a `SCREAMING_CASE` column constant is not a hole. */
  readonly pattern: RegExp;
  /** A live-code line that MUST match, so a pattern that cannot match is loud. */
  readonly positiveControl: string;
  /** What this deliberately does NOT look for, so nobody widens it back. */
  readonly notLookingFor: string;
}

const EXCLUDED_TYPE_DETECTORS: readonly Detector[] = [
  {
    type: 'digital_good',
    pattern:
      /\b(download_url|downloadUrl|licence_key|licenseKey|licence_code|redemption_code|redemptionCode|activation_code|activationCode|entitlement_delivery|entitlementDelivery|digital_delivery|digitalDelivery|is_digital|isDigital|digital_good|digitalGood)\b/i,
    positiveControl: 'downloadUrl: text().notNull(),',
    notLookingFor:
      'the bare word `digital`, which is `digital_storage`, the unit family every RAM and storage attribute is measured in; and `download`, which here is a CSV error report and a thumbnail.',
  },
  {
    type: 'stored_value',
    pattern:
      /\b(gift_card_balance|giftCardBalance|stored_value|storedValue|voucher_code|voucherCode|voucher_balance|redeem_voucher|store_credit_balance|storeCreditBalance)\b/i,
    positiveControl: 'const giftCardBalance = money(row);',
    notLookingFor:
      '`gift_cards`, which is a `CHANNEL_SYNC_ENTITIES` member whose whole purpose is to record that Mercaria models no such thing; and `redeem`, which is a discount code and a referral click.',
  },
  {
    type: 'service',
    pattern:
      /\b(booking_slot|bookingSlot|time_slot|timeSlot|appointment_at|appointmentAt|service_duration|serviceDuration|duration_minutes|durationMinutes|scheduled_start|scheduledStart|billable_hours|billableHours)\b/i,
    positiveControl: 'appointmentAt: timestamptz().notNull(),',
    notLookingFor:
      'the word `service`, which names every module in `src/services/`; `booking`, which is a Moovo courier booking and the accounting sense of booking a ledger transaction; and `reservation`, which is an inventory hold.',
  },
  {
    type: 'consumer_subscription',
    pattern:
      /\b(renews_at|renewsAt|billing_cycle_anchor|billingCycleAnchor|recurring_order|recurringOrder|subscription_order|subscriptionOrder|delivery_frequency|deliveryFrequency)\b/i,
    positiveControl: 'recurringOrder: boolean().notNull().default(false),',
    notLookingFor:
      "`subscription` and `entitlement`, which are #89's merchant plans — Mercaria billing a merchant for its own software — and webhook subscriptions.",
  },
  {
    type: 'event_admission',
    pattern:
      /\b(seat_number|seatNumber|admission_code|admissionCode|event_starts_at|eventStartsAt|ticket_holder|ticketHolder|venue_id|venueId)\b/i,
    positiveControl: 'seatNumber: text(),',
    notLookingFor:
      '`ticket`, which here is a support ticket, an Expo push receipt, a case reference, and Portuguese for average order value.',
  },
];

/**
 * The sixth detector, which belongs to no single type: a rival answer to "what
 * kind of commerce thing is this".
 *
 * ADR 0007 D15 refuses this discriminator, and the ABSENCE is the enforcement —
 * a column with one legal value is already in place to receive a second, and
 * widening a CHECK reads as ordinary schema work rather than as an ADR
 * amendment. Kept apart from the list above because it is not the representation
 * of any one excluded type; it is the seam through which every one of them would
 * arrive at once.
 */
const RIVAL_DISCRIMINATOR: Detector = {
  type: 'rival_discriminator',
  pattern:
    /\b(commerce_type|commerceType|product_kind|productKind|goods_type|goodsType|listing_kind|listingKind|item_nature|itemNature)\b/i,
  positiveControl: "productKind: text({ enum: ['physical', 'digital'] }),",
  notLookingFor:
    "`product_type`, which is #367's versioned authoring schema and a different question entirely; and `OfferKind`, which is a SOURCING taxonomy (native, external, affiliate, informational) and says nothing about what the thing is.",
};

const ALL_DETECTORS: readonly Detector[] = [...EXCLUDED_TYPE_DETECTORS, RIVAL_DISCRIMINATOR];

/**
 * Modules permitted to carry a forbidden spelling, with the reason.
 *
 * EXACT paths, never a prefix — a directory-shaped exemption excuses the module
 * somebody adds there tomorrow. Each is asserted to EXIST and to actually MATCH,
 * because an exemption that can no longer match is not merely stale: it reads as
 * a wall doing work while excusing nothing.
 */
const EXEMPTIONS: readonly { readonly path: string; readonly reason: string }[] = [
  {
    path: 'shared-types/src/commerce-type.ts',
    reason:
      'The decision itself. It names every excluded type as a VALUE, which is the whole mechanism — a prohibition stated as data can be enumerated, and one stated only in prose cannot.',
  },
];

const EXEMPT_PATHS = new Set(EXEMPTIONS.map((exemption) => exemption.path));

interface Finding {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

function findingsIn(modules: readonly ScannedModule[], detector: Detector): Finding[] {
  const found: Finding[] = [];
  for (const module of modules) {
    if (EXEMPT_PATHS.has(module.path)) continue;
    module.lines.forEach((text, index) => {
      if (detector.pattern.test(text)) {
        found.push({ path: module.path, line: index + 1, text: text.trim() });
      }
    });
  }
  return found;
}

const report = (detector: Detector, findings: readonly Finding[]): string =>
  findings.map((f) => `[${detector.type}] ${f.path}:${f.line} ${f.text}`).join('\n');

/** What admitting a type would take, for the failure message. */
function costOfAdmitting(type: Detector['type']): string {
  if (type === 'rival_discriminator') return 'an ADR 0007 D15 amendment';
  const disposition = COMMERCE_TYPE_DISPOSITIONS[type];
  return disposition.verdict === 'excluded'
    ? disposition.prerequisites.join(', ')
    : 'nothing — it is now classified, so this detector should have been removed with it';
}

/* -------------------------------------------------------------------------- */
/* The victims: one per scanned DIRECTORY, not one per gate                    */
/* -------------------------------------------------------------------------- */

/**
 * A UNIT is a top-level directory of a scanned root, plus the root itself when
 * it holds modules directly.
 *
 * `docs/isolation-gates.md` §"Seed a mutation victim per SCANNED DIRECTORY":
 * one synthetic probe proves the DETECTOR matches and proves nothing about the
 * POPULATION. Measured elsewhere in this repository, a narrowing mutation turned
 * exactly one test red because the single victim sat in the surviving half.
 *
 * Both roots are also units of the second kind — `backend/src` holds `app.ts`
 * and `index.ts` directly, and `shared-types/src` is entirely flat — so omitting
 * them would leave 125 modules self-tested by nothing.
 */
function scannedUnits(): string[] {
  const units: string[] = [];
  for (const { root } of SCANNED_ROOTS) {
    const entries: DirectoryEntry[] = readPackagesDirectory(root);
    if (entries.some((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))) units.push(root);
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== '__tests__' && entry.name !== 'node_modules') {
        units.push(`${root}/${entry.name}`);
      }
    }
  }
  return units;
}

/** The lexically first real module directly under `unit`, or `null`. */
function victimIn(unit: string): string | null {
  const modules = walkPackagesDirectory(unit)
    .filter((path) => !EXEMPT_PATHS.has(path) && !path.endsWith('.d.ts'))
    .sort();
  return modules[0] ?? null;
}

/**
 * The population with ONE module's source replaced.
 *
 * The plant is applied to the module's SOURCE and re-stripped, so a plant hidden
 * in a comment is stripped exactly as a real one would be — which is what makes
 * the comment control below a test of the pipeline rather than of a regex.
 *
 * Substituting into an already-swept population rather than re-walking is
 * deliberate: re-walking 1786 modules once per (detector × unit) is 139,000 file
 * reads, and the population claim is asserted directly instead — the victim's
 * presence in `MODULES` IS the statement that the walk reached its directory.
 */
function withPlant(
  modules: readonly ScannedModule[],
  victim: string,
  plantedSource: string,
): ScannedModule[] {
  return modules.map((module) =>
    module.path === victim ? asModule(module.path, plantedSource) : module,
  );
}

/* -------------------------------------------------------------------------- */
/* The decision is still total                                                 */
/* -------------------------------------------------------------------------- */

describe('the commerce-type decision (ADR 0007 D15)', () => {
  it('classifies exactly one commerce type, asserted rather than floored', () => {
    // EXACT, not containment. A list that can only grow is the
    // `WOOCOMMERCE_OPEN_DEFECTS` failure: admitting a second type has to move
    // this line, in the diff that admits it, where a reviewer sees it.
    expect([...MERCARIA_COMMERCE_TYPES]).toEqual(['physical_good']);
  });

  it('keeps the admitted and excluded tuples DISJOINT', () => {
    const admitted = new Set<string>(MERCARIA_COMMERCE_TYPES);
    expect(
      EXCLUDED_COMMERCE_TYPES.filter((type) => admitted.has(type)),
      'a commerce type cannot be both classified and excluded',
    ).toEqual([]);
    // The vacuity floor for the clause above: over an empty excluded tuple the
    // filter returns `[]` for a reason that has nothing to do with disjointness.
    expect(EXCLUDED_COMMERCE_TYPES.length).toBeGreaterThanOrEqual(5);
  });

  it('has a disposition for every declared type, and no orphan', () => {
    const declared = [...MERCARIA_COMMERCE_TYPES, ...EXCLUDED_COMMERCE_TYPES].sort();
    const disposed = (Object.keys(COMMERCE_TYPE_DISPOSITIONS) as CommerceType[]).sort();
    // Both directions. `tsc` catches a missing key; nothing catches a key whose
    // type was removed from the tuples and left behind here.
    expect(disposed).toEqual(declared);
  });

  it('gives every excluded type a stated cost, drawn from the closed vocabulary', () => {
    assertEachOf(EXCLUDED_COMMERCE_TYPES, 5, (type) => {
      const disposition = COMMERCE_TYPE_DISPOSITIONS[type];
      expect(disposition.verdict, `${type} is in the excluded tuple`).toBe('excluded');
      if (disposition.verdict !== 'excluded') return;
      expect(
        disposition.prerequisites.length,
        `${type} is excluded for no stated cost, so nothing says what admitting it would take`,
      ).toBeGreaterThanOrEqual(1);
      for (const prerequisite of disposition.prerequisites) {
        expect(
          COMMERCE_TYPE_PREREQUISITES,
          `${type} names a prerequisite outside the closed vocabulary, which is how a type ` +
            'gets admitted by inventing a reason it needs nothing',
        ).toContain(prerequisite);
      }
      expect(
        disposition.evidence.length,
        `${type} cites no evidence, so the exclusion announces a new state instead of ` +
          'recording one this repository is already in',
      ).toBeGreaterThan(40);
    });
  });

  it('states a mechanism for the one admitted type', () => {
    const disposition = COMMERCE_TYPE_DISPOSITIONS.physical_good;
    expect(disposition.verdict).toBe('classified');
    if (disposition.verdict !== 'classified') return;
    expect(disposition.mechanism.length).toBeGreaterThan(40);
  });

  it('carries a mechanism for every physical-good composition, none needing its own product type', () => {
    assertEachOf(PHYSICAL_GOOD_COMPOSITION_KINDS, 3, (kind) => {
      const rule = PHYSICAL_GOOD_COMPOSITIONS[kind];
      expect(rule, `${kind} has no rule`).toBeDefined();
      expect(rule.mechanism.length, `${kind} states no mechanism`).toBeGreaterThan(40);
      expect(rule.citation.length, `${kind} cites nothing`).toBeGreaterThan(5);
      // The answer to #367 line 144's first clause, as an assertion. If a
      // composition ever DOES need its own product type, this moves and ADR 0007
      // D15 moves with it.
      expect(
        rule.needsOwnProductType,
        `${kind} now claims to need its own product type, which contradicts ADR 0007 D15`,
      ).toBe(false);
    });
    expect(Object.keys(PHYSICAL_GOOD_COMPOSITIONS).sort()).toEqual(
      [...PHYSICAL_GOOD_COMPOSITION_KINDS].sort(),
    );
  });

  it('offers a bounded admission procedure rather than an extension point', () => {
    // The closed prerequisite vocabulary IS the answer to "non-standard future
    // commerce types". An open string here would be the `metadata` bag this
    // repository refuses everywhere else.
    expect(COMMERCE_TYPE_PREREQUISITES.length).toBeGreaterThanOrEqual(9);
    expect(new Set(COMMERCE_TYPE_PREREQUISITES).size).toBe(COMMERCE_TYPE_PREREQUISITES.length);
  });
});

/* -------------------------------------------------------------------------- */
/* Nothing has grown a representation                                          */
/* -------------------------------------------------------------------------- */

const MODULES = scanModules();

describe('no module represents an excluded commerce type', () => {
  it('swept a population that did not collapse', () => {
    assertEachOf(SCANNED_ROOTS, 2, ({ root, fileFloor, directoryFloor }) => {
      const swept = MODULES.filter((module) => module.path.startsWith(`${root}/`));
      expect(
        swept.length,
        `${root} produced ${swept.length} modules and needs at least ${fileFloor}; the walk ` +
          'reached less than the tree, so every absence below is vacuous',
      ).toBeGreaterThanOrEqual(fileFloor);
      const directories = readPackagesDirectory(root).filter(
        (entry) => entry.isDirectory() && entry.name !== '__tests__',
      );
      expect(
        directories.length,
        `${root} now has ${directories.length} top-level directories and needs at least ` +
          `${directoryFloor}; a lost subtree does not always move the file floor`,
      ).toBeGreaterThanOrEqual(directoryFloor);
      expect(statSync(join(PACKAGES_ROOT, root)).isDirectory()).toBe(true);
    });
  });

  it('read real source rather than empty strings', () => {
    // The floor above counts MODULES. A reader handing back `''` for each of
    // them produces the same count and no line to match, so it is counted
    // separately — this is the "stripper ate everything" direction.
    const nonEmpty = MODULES.filter((module) => module.lines.some((line) => line.trim() !== ''));
    expect(nonEmpty.length).toBeGreaterThanOrEqual(1400);
  });

  assertEachOf(ALL_DETECTORS, 6, (detector) => {
    it(`finds no ${detector.type} representation`, () => {
      const findings = findingsIn(MODULES, detector);
      expect(
        report(detector, findings),
        `a module now carries a ${detector.type} representation. ADR 0007 D15 excludes it; ` +
          `admitting it means discharging: ${costOfAdmitting(detector.type)}. This detector ` +
          `deliberately does not look for ${detector.notLookingFor}`,
      ).toBe('');
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Controls: what would this report if the subject were PRESENT?               */
/* -------------------------------------------------------------------------- */

const UNITS = scannedUnits();

describe('the scan can see a violation', () => {
  it('derives a unit for every scanned root and every one of its subtrees', () => {
    // ABSOLUTE, not derived from the list it defends: narrowing `SCANNED_ROOTS`
    // to one root has to fail here rather than lower the bar it is measured
    // against.
    expect(UNITS.length, `only ${UNITS.length} scanned units: ${UNITS.join(', ')}`)
      .toBeGreaterThanOrEqual(11);
    for (const expected of ['backend/src', 'shared-types/src', 'backend/src/db', 'backend/src/services']) {
      expect(UNITS).toContain(expected);
    }
  });

  // Every detector, in every unit, SEPARATELY — `~/Oxy/AGENTS.md`: mutate each
  // detector on its own, or you have measured one of them.
  assertEachOf(ALL_DETECTORS, 6, (detector) => {
    describe(`the ${detector.type} detector`, () => {
      assertEachOf(UNITS, 11, (unit) => {
        it(`fires on a violation planted in ${unit}`, () => {
          const victim = victimIn(unit);
          expect(
            victim,
            `${unit} holds no module to plant a violation in, so nothing in it is self-tested`,
          ).not.toBeNull();
          if (victim === null) return;

          // The POPULATION claim: this unit's module is in what was swept. A
          // directory that dropped out of the walk fails here, which is the half
          // a synthetic probe can never test.
          expect(
            MODULES.map((module) => module.path),
            `${victim} is not in the swept population, so ${unit} is scanned by nothing`,
          ).toContain(victim);

          const original = readModule(victim);
          // The premise: the victim is clean BEFORE the plant, so the assertion
          // below measures the plant and not something already there.
          expect(
            findingsIn([asModule(victim, original)], detector),
            `${victim} already matches ${detector.type}, so planting into it proves nothing`,
          ).toEqual([]);

          const planted = withPlant(MODULES, victim, `${original}\n${detector.positiveControl}\n`);
          expect(
            findingsIn(planted, detector).map((finding) => finding.path),
            `the ${detector.type} detector did not see a violation planted in ${victim}`,
          ).toContain(victim);
        });
      });
    });
  });

  assertEachOf(ALL_DETECTORS, 6, (detector) => {
    it(`ignores a ${detector.type} spelling that is only in a COMMENT`, () => {
      const victim = victimIn('shared-types/src');
      expect(victim).not.toBeNull();
      if (victim === null) return;
      const original = readModule(victim);
      const planted = withPlant(MODULES, victim, `${original}\n// ${detector.positiveControl}\n`);
      expect(
        report(detector, findingsIn(planted, detector)),
        'a docblock naming what a module refuses to do is exactly how this repository documents ' +
          'a prohibition, so a scan that kept comments would report every wall as a breach of ' +
          'itself',
      ).toBe('');
    });
  });
});

describe('the comment stripper', () => {
  // A stripper that ate too much would make every absence above pass vacuously,
  // which is the failure mode with no symptom.
  it('keeps live code', () => {
    expect(stripComments('const downloadUrl = 1;\n')).toContain('downloadUrl');
  });

  it('drops a line comment and a block comment', () => {
    expect(stripComments('// downloadUrl\n')).not.toContain('downloadUrl');
    expect(stripComments('/* downloadUrl */\n')).not.toContain('downloadUrl');
  });

  it('keeps `//` inside a string, so a URL does not swallow the rest of a file', () => {
    expect(stripComments("const u = 'https://x.test/a';\nconst seatNumber = 2;\n")).toContain(
      'seatNumber',
    );
  });
});

describe('every exemption is real and still load-bearing', () => {
  assertEachOf(EXEMPTIONS, 1, (exemption) => {
    it(`${exemption.path} exists`, () => {
      expect(
        statSync(join(PACKAGES_ROOT, exemption.path)).isFile(),
        `${exemption.path} no longer exists, so exempting it proves nothing`,
      ).toBe(true);
    });

    it(`${exemption.path} would otherwise be reported`, () => {
      // An exemption that can no longer MATCH is not merely stale: it reads as a
      // wall doing work while excusing nothing, and the next reader trusts it.
      const probe = asModule('unexempt/probe.ts', readModule(exemption.path));
      const matched = ALL_DETECTORS.filter(
        (detector) => findingsIn([probe], detector).length > 0,
      );
      expect(
        matched.map((detector) => detector.type),
        `${exemption.path} matches no detector, so its exemption excuses nothing`,
      ).not.toEqual([]);
    });
  });
});
