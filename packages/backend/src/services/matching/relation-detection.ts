/**
 * Bundles, multipacks, accessories and replacement parts (#58 rule 7).
 *
 * "Bundles, multipacks, accessories and replacement parts must not match the
 * base product merely because the title contains it." That sentence names the
 * exact failure: an iPhone 15 CASE has "iPhone 15" in its title, so every
 * similarity metric ever written scores it near the phone. A threshold cannot
 * fix that — the case genuinely IS textually about the phone — so the fix is a
 * different KIND of judgement, made before scoring and applied as a hard
 * refusal.
 *
 * ## Why this is a classifier and not a penalty
 *
 * A penalty is a number somebody can tune to zero, and a tuned-down penalty
 * produces exactly the merge this rule exists to prevent. A relation MISMATCH is
 * a `MatchBlocker` instead, and blockers make an automatic outcome
 * unrepresentable at the database. The cost is honest and stated: a case whose
 * title says nothing about being a case classifies as `base` and is matched on
 * its merits, which is a miss, and a miss is a review.
 *
 * ## Spanish AND English, because the market is
 *
 * Mercaria sells in Spain. A marker list in English only would classify every
 * `funda`, `carcasa` and `protector de pantalla` as a base product, which is not
 * a slightly worse classifier — it is a classifier that does nothing at all for
 * most of the catalogue.
 *
 * ## Conservative on purpose
 *
 * Every marker here is a WORD BOUNDARY match on a normalized token stream, never
 * a substring: `pack` must not fire on `backpack`, and `set` must not fire on
 * `sunset`. Under-detecting costs a review; over-detecting costs a refusal to
 * merge two things that are the same, which is also a review. Both failure modes
 * are recoverable, which is what makes a conservative list the right trade — and
 * is why nothing here ever CREATES a match.
 */

import { foldAccents, wordTokens } from '../canonical/normalization.js';

/**
 * What the thing IS, relative to a base product.
 *
 * `base` is the ordinary case and the default: a classifier that guessed would
 * be worse than one that admits it saw no marker.
 */
export type SubjectRelation = 'base' | 'bundle' | 'multipack' | 'accessory' | 'replacement_part';

/** Multi-word markers are matched as token SEQUENCES, single words as tokens. */
type MarkerPhrase = readonly string[];

/**
 * Heterogeneous bundles — a console plus a game (ADR 0002 D15).
 *
 * `kit` and `set` are in the list and `combo` is not a Spanish word anybody
 * writes; each entry earns its place by being a word a seller uses to say "this
 * listing is more than one product", and by NOT being a word that appears in
 * ordinary product names. `pack` alone is deliberately ABSENT — it is the
 * multipack signal and it appears in `pack de 6`, which is a different fact.
 */
const BUNDLE_MARKERS: readonly MarkerPhrase[] = [
  ['bundle'],
  ['combo'],
  ['kit'],
  ['starter', 'kit'],
  ['gift', 'set'],
  ['set', 'of'],
  ['lote'],
  ['conjunto'],
  ['pack', 'ahorro'],
];

/**
 * Same-product multiples. A 6-pack has its OWN GTIN (ADR 0002 D15), so this is
 * a real variant axis and not a packaging detail.
 */
const MULTIPACK_MARKERS: readonly MarkerPhrase[] = [
  ['multipack'],
  ['multipack', 'de'],
  ['twin', 'pack'],
  ['value', 'pack'],
];

/**
 * Things bought FOR a product. The single most common false merge in any
 * marketplace catalogue, because the accessory's title is mostly the product's.
 */
const ACCESSORY_MARKERS: readonly MarkerPhrase[] = [
  ['case'],
  ['cover'],
  ['funda'],
  ['carcasa'],
  ['screen', 'protector'],
  ['protector', 'de', 'pantalla'],
  ['tempered', 'glass'],
  ['cristal', 'templado'],
  ['charger'],
  ['cargador'],
  ['charging', 'cable'],
  ['cable', 'de', 'carga'],
  ['adapter'],
  ['adaptador'],
  ['stand'],
  ['soporte'],
  ['strap'],
  ['correa'],
  ['sleeve'],
  ['pouch'],
  ['dock'],
  ['mount'],
  ['skin'],
];

/**
 * Spare parts. Distinct from an accessory: a replacement battery IS part of the
 * product, which makes the title overlap even higher and the merge even worse.
 */
const REPLACEMENT_PART_MARKERS: readonly MarkerPhrase[] = [
  ['replacement'],
  ['repuesto'],
  ['recambio'],
  ['spare', 'part'],
  ['spare', 'parts'],
  ['pieza', 'de', 'repuesto'],
  ['screen', 'assembly'],
  ['lcd', 'assembly'],
  ['repair', 'part'],
];

/**
 * "For", "compatible with" and their Spanish forms.
 *
 * These do not name a relation on their own — "compatible con iPhone 15" could
 * be a case or a charger — but they are the strongest available signal that the
 * listing is ABOUT another product rather than being it. They promote an
 * otherwise-unmarked listing to `accessory`, which is the conservative answer
 * when a title is explicitly written as a compatibility claim.
 */
const COMPATIBILITY_MARKERS: readonly MarkerPhrase[] = [
  ['compatible', 'with'],
  ['compatible', 'con'],
  ['compatible', 'para'],
  ['fits'],
  ['apto', 'para'],
  ['valido', 'para'],
];

/** What a classification saw, so a decision can explain itself. */
export interface RelationDetection {
  readonly relation: SubjectRelation;
  /**
   * The multiple, when the text states one. `null` for a single item AND for a
   * multipack whose count nobody wrote — the "unknown is never zero" rule: two
   * multipacks of unstated size are not thereby the same size.
   */
  readonly packCount: number | null;
  /** The markers that fired, normalized, for the operator trace. */
  readonly markers: readonly string[];
}

/**
 * Split text into the token stream every marker is matched against.
 *
 * Accent-folded and lowercased so `plástico` and `plastico` tokenize the same,
 * and split on everything that is not a letter or a digit — which is what makes
 * `6-pack`, `6 pack` and `6pack`… no: `6pack` stays one token deliberately, and
 * the numeric patterns below handle it. Splitting inside an alphanumeric run
 * would break model numbers like `A2848`, which are the most discriminating
 * tokens a title has.
 *
 * Tokenization is {@link wordTokens}, shared with the canonical name fold. It
 * was a local copy of the same `[^\p{L}\p{N}]` split #830 fixed in three other
 * files. Adopting it here changes NO marker match and is not part of that fix:
 * every marker below is Latin (English and Spanish), and Latin text tokenizes
 * identically either way — measured. What it removes is a fourth copy of a
 * character class that decides identity, which is the way #830 comes back.
 */
export function relationTokens(text: string): string[] {
  return wordTokens(foldAccents(text).toLowerCase());
}

/** Does `phrase` appear as a contiguous token run in `tokens`? */
function containsPhrase(tokens: readonly string[], phrase: MarkerPhrase): boolean {
  if (phrase.length === 0) return false;
  for (let start = 0; start + phrase.length <= tokens.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < phrase.length; offset += 1) {
      if (tokens[start + offset] !== phrase[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

function firstMatchingMarker(
  tokens: readonly string[],
  markers: readonly MarkerPhrase[],
): string | null {
  for (const phrase of markers) {
    if (containsPhrase(tokens, phrase)) return phrase.join(' ');
  }
  return null;
}

/** A count that is a plausible retail multiple. Anything else is a model number. */
const MAX_PACK_COUNT = 999;

/**
 * Read a stated multiple out of a token stream.
 *
 * Four shapes, all of them real: `pack of 6`, `6 pack`, `pack de 6`,
 * `6 unidades`, plus the `6x`/`x6` forms. A bare number is deliberately NOT a
 * pack count — "iPhone 15" would otherwise be a 15-pack.
 *
 * @returns The count, or `null` when the text states none.
 */
export function detectPackCount(tokens: readonly string[]): number | null {
  const numberAt = (index: number): number | null => {
    const token = tokens[index];
    if (token === undefined || !/^[0-9]{1,3}$/u.test(token)) return null;
    const value = Number.parseInt(token, 10);
    return value >= 2 && value <= MAX_PACK_COUNT ? value : null;
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;

    // `pack of 6` / `pack de 6` / `paquete de 6`
    if ((token === 'pack' || token === 'paquete') && index + 2 < tokens.length) {
      const joiner = tokens[index + 1];
      if (joiner === 'of' || joiner === 'de') {
        const value = numberAt(index + 2);
        if (value !== null) return value;
      }
    }
    // `6 pack` / `6 unidades` / `6 uds`
    const trailing = tokens[index + 1];
    if (
      trailing === 'pack' ||
      trailing === 'unidades' ||
      trailing === 'uds' ||
      trailing === 'units'
    ) {
      const value = numberAt(index);
      if (value !== null) return value;
    }
    // `x6` and `6x`, the two spellings a feed uses interchangeably.
    const compact = /^x([0-9]{1,3})$/u.exec(token) ?? /^([0-9]{1,3})x$/u.exec(token);
    if (compact) {
      const value = Number.parseInt(compact[1] ?? '', 10);
      if (value >= 2 && value <= MAX_PACK_COUNT) return value;
    }
  }
  return null;
}

/**
 * Classify a title (optionally with a variant's own words) into a relation.
 *
 * Precedence is the order of the checks and it is deliberate: a REPLACEMENT PART
 * beats an accessory (a "replacement charging cable" is a part, and reading it
 * as an accessory would still refuse the base product, but would name the wrong
 * reason to an operator); an accessory beats a bundle (a "case and screen
 * protector kit" is accessories, and calling it a bundle would invite a
 * comparison against a component that does not exist); a stated multiple beats
 * an unmarked base.
 *
 * A compatibility claim promotes an otherwise-unclassified title to `accessory`
 * only when it did NOT already classify — "iPhone 15 compatible con MagSafe" is
 * a phone, and reading its compatibility claim as a relation would refuse the
 * correct merge. The claim has to be the ONLY signal for it to mean anything.
 */
export function detectRelation(input: {
  readonly title: string;
  readonly variantText?: string;
  /** An explicit pack-count axis beats anything read out of prose. */
  readonly declaredPackCount?: number | null;
  /** A canonical variant with component rows IS a bundle, whatever it is called. */
  readonly hasBundleComponents?: boolean;
}): RelationDetection {
  const tokens = relationTokens(
    input.variantText === undefined ? input.title : `${input.title} ${input.variantText}`,
  );
  const markers: string[] = [];

  if (input.hasBundleComponents === true) {
    return { relation: 'bundle', packCount: null, markers: ['bundle_components'] };
  }

  const part = firstMatchingMarker(tokens, REPLACEMENT_PART_MARKERS);
  if (part !== null) return { relation: 'replacement_part', packCount: null, markers: [part] };

  const accessory = firstMatchingMarker(tokens, ACCESSORY_MARKERS);
  if (accessory !== null) return { relation: 'accessory', packCount: null, markers: [accessory] };

  const bundle = firstMatchingMarker(tokens, BUNDLE_MARKERS);
  if (bundle !== null) return { relation: 'bundle', packCount: null, markers: [bundle] };

  const declared =
    input.declaredPackCount !== undefined && input.declaredPackCount !== null
      ? input.declaredPackCount
      : null;
  const spoken = detectPackCount(tokens);
  const multipackMarker = firstMatchingMarker(tokens, MULTIPACK_MARKERS);
  const packCount = declared !== null && declared > 1 ? declared : spoken;
  if (packCount !== null && packCount > 1) {
    if (declared !== null && declared > 1) markers.push('pack_count_attribute');
    if (spoken !== null) markers.push(`pack_count:${String(spoken)}`);
    if (multipackMarker !== null) markers.push(multipackMarker);
    return { relation: 'multipack', packCount, markers };
  }
  if (multipackMarker !== null) {
    return { relation: 'multipack', packCount: null, markers: [multipackMarker] };
  }

  const compatibility = firstMatchingMarker(tokens, COMPATIBILITY_MARKERS);
  if (compatibility !== null) {
    return { relation: 'accessory', packCount: null, markers: [compatibility] };
  }

  return { relation: 'base', packCount: null, markers: [] };
}
