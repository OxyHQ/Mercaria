/**
 * Where a digital supply HAPPENS, and what the buyer's withdrawal rights are —
 * the two compliance prerequisites #1015 has to discharge before a paid digital
 * launch (#1015 Workstream 11, ADR 0010 D10, D11).
 *
 * ## Why a digital order cannot reuse the goods rule
 *
 * `docs/commerce-types.md` states the wall this module takes down, and states it
 * more precisely than a summary would: *"`rateMatchesRegion` reads the shipping
 * country, region and postal code and nothing else"*. That is the
 * place-of-supply rule for GOODS, and for an electronically supplied service it
 * is structurally the wrong one — the supply happens where the CONSUMER is, and a
 * digital order has no shipment whose destination could stand in for that.
 *
 * Reusing it would not fail loudly. A digital-only order carries no address
 * (ADR 0010 D8), so every region-scoped rate would simply fail to match and the
 * order would be taxed at zero — a green build, a plausible invoice and an
 * under-collection per sale.
 *
 * ## What is recorded, and the line this module will not cross
 *
 * #1015 W11 requirement 3: buyer market evidence *"only to the extent
 * legally/payment/tax required"*, and requirement 4: kept separate from general
 * profiling. So this records ONE country per order plus WHICH KIND of evidence
 * established it — nothing else. In particular:
 *
 * - **No IP address, raw, hashed or geo-derived.** `~/AGENTS.md`'s no-IP
 *   invariant holds here with no exception; `ip_geolocation` is deliberately
 *   absent from {@link DIGITAL_SUPPLY_EVIDENCE_KINDS} and a test asserts the
 *   absence, because an IP-derived country is the obvious cheap answer and it is
 *   the one piece of evidence Mercaria may not keep.
 * - **No device, browser or locale fingerprint.** A locale is a display
 *   preference, not a residence, and treating one as tax evidence would be both
 *   wrong and a profile.
 */

/* -------------------------------------------------------------------------- */
/* Place of supply                                                            */
/* -------------------------------------------------------------------------- */

/**
 * What established the consumer's country for a digital supply.
 *
 * A CLOSED set, ordered by strength. The strongest available is what gets
 * recorded, and the kind is stored alongside the country precisely so an auditor
 * can see WHAT the figure rests on rather than being asked to trust it.
 *
 * - `buyer_declared` — the buyer said so at checkout. The launch default, and
 *   legitimate: a declaration is the consumer's own statement of where they are.
 * - `billing_country` — the country on the payment instrument, where the
 *   provider returns one.
 * - `saved_address_country` — a country from the buyer's own address book, used
 *   only when the buyer selected that address for this checkout.
 * - `operator_corrected` — a support or finance correction, audited.
 */
export const DIGITAL_SUPPLY_EVIDENCE_KINDS = [
  'buyer_declared',
  'billing_country',
  'saved_address_country',
  'operator_corrected',
] as const;

/** One of {@link DIGITAL_SUPPLY_EVIDENCE_KINDS}. */
export type DigitalSupplyEvidenceKind = (typeof DIGITAL_SUPPLY_EVIDENCE_KINDS)[number];

/**
 * The evidence kinds this domain may NEVER accept, named so the absence above is
 * a decision rather than an omission.
 *
 * The `FORBIDDEN_CONDITION_PHOTO_PROVENANCES` device, one domain over: a scanned
 * gate asserts the two sets are disjoint, so adding one of these to the accepted
 * tuple turns a test red with a message naming the invariant it breaks.
 */
export const FORBIDDEN_DIGITAL_SUPPLY_EVIDENCE_KINDS: readonly string[] = [
  'ip_geolocation',
  'ip_address',
  'device_fingerprint',
  'browser_locale',
  'timezone_offset',
];

/**
 * Where one order's supply is treated as happening.
 *
 * A country and the evidence for it, and nothing else. Region and postal code
 * are deliberately ABSENT: an electronically supplied service is taxed at the
 * member-state level in the EU, and carrying a region would invite a rate scoped
 * to one that a digital supply has no evidence for.
 */
export interface DigitalPlaceOfSupply {
  /** ISO 3166-1 alpha-2, uppercased. */
  readonly country: string;
  readonly evidence: DigitalSupplyEvidenceKind;
}

/* -------------------------------------------------------------------------- */
/* Withdrawal and guarantee                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What withdrawal right applies to a digital line, and why.
 *
 * Mercaria's published goods terms run the statutory clock from the day the
 * consumer takes physical possession. A download has no possession moment, so
 * the goods clock cannot be reused — and the EU consumer-rights regime answers
 * this with an express-consent mechanism rather than with a shorter clock:
 * supply may begin immediately if the consumer consents AND acknowledges losing
 * the right to withdraw.
 *
 * - `statutory_cooling_off` — the right is intact because supply has not begun.
 *   A buyer who has not downloaded anything is here.
 * - `waived_on_immediate_supply` — the buyer gave express consent and
 *   acknowledged the loss. This is the state a normal digital purchase reaches,
 *   and `orders.digital_supply_consent_at` is the timestamp that proves it.
 * - `not_applicable_trader_buyer` — a business buyer, to whom the consumer
 *   regime does not apply.
 */
export const DIGITAL_WITHDRAWAL_BASES = [
  'statutory_cooling_off',
  'waived_on_immediate_supply',
  'not_applicable_trader_buyer',
] as const;

/** One of {@link DIGITAL_WITHDRAWAL_BASES}. */
export type DigitalWithdrawalBasis = (typeof DIGITAL_WITHDRAWAL_BASES)[number];

/**
 * The bases that require a recorded consent timestamp.
 *
 * ONE member, and the pairing is enforced by a database CHECK rather than by a
 * service remembering: a waiver with no timestamp is a waiver nobody can
 * evidence, which in a dispute is the same as no waiver at all.
 */
export const CONSENT_REQUIRING_DIGITAL_WITHDRAWAL_BASES: readonly DigitalWithdrawalBasis[] = [
  'waived_on_immediate_supply',
];

/**
 * What a digital line's conformity guarantee is.
 *
 * Stated so the absence of the GOODS conformity guarantee is explicit. A digital
 * deliverable's guarantee is that it conforms to what was described — the
 * measured metadata, the included formats, the licence — which is why #1015 W4
 * keeps measured facts and seller claims apart: the guarantee is answerable only
 * if the two provenances are distinguishable.
 */
export const DIGITAL_CONFORMITY_BASIS = 'conformity_with_described_deliverable' as const;
