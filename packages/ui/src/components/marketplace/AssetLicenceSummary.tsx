import type { ReactNode } from "react";
import { View } from "react-native";
import {
  ALL_CURRENCY_CODES,
  DIGITAL_LICENCE_RIGHTS,
  type CurrencyCode,
  type DigitalLicenceAuthorship,
  type DigitalLicenceUpdatePolicy,
  type DigitalLicenceVersionTerms,
} from "@mercaria/shared-types";
import { Text } from "../ui/text";
import { useSharedUiLocale, useSharedUiTranslation } from "../../i18n/ui-translation";
import { useFormatters } from "../../lib/use-formatters";
import { formatWholeNumber } from "../../lib/plain-number";
import {
  ASSET_LICENCE_ADDITIONAL_TERMS_TITLE_KEY,
  ASSET_LICENCE_ATTRIBUTION_TITLE_KEY,
  ASSET_LICENCE_GRANTED_TITLE_KEY,
  ASSET_LICENCE_LIMITS_TITLE_KEY,
  ASSET_LICENCE_NOT_GRANTED_TITLE_KEY,
  ASSET_LICENCE_PROJECTS_KEY,
  ASSET_LICENCE_PROJECTS_UNLIMITED_KEY,
  ASSET_LICENCE_REVENUE_KEY,
  ASSET_LICENCE_REVENUE_UNLIMITED_KEY,
  ASSET_LICENCE_SEATS_KEY,
  ASSET_LICENCE_SEATS_UNLIMITED_KEY,
  ASSET_LICENCE_TITLE_KEY,
  ASSET_LICENCE_UPDATES_TITLE_KEY,
  DIGITAL_LICENCE_ATTRIBUTION_KEYS,
  DIGITAL_LICENCE_AUTHORSHIP_KEYS,
  DIGITAL_LICENCE_RIGHT_KEYS,
  DIGITAL_LICENCE_UPDATE_POLICY_KEYS,
} from "../../lib/digital-asset-labels";

/**
 * What the SELECTED offer's licence actually grants (#1015 Workstream 2,
 * ADR 0010 D3 / D4).
 *
 * ## It renders a licence VERSION's terms, because that is what a purchase pins
 *
 * `DigitalLicenceVersionTerms` is the shape an order line snapshots (#1015
 * acceptance criterion 5) and the shape a dispute is answered from, so the
 * product page renders the SAME object rather than a prose summary somebody
 * wrote beside it. ADR 0010 D3 makes the row immutable once published, which is
 * what lets a page, a receipt and a dispute quote one record instead of three.
 *
 * ## Both halves are rendered, and the ABSENT half is the subtle one
 *
 * `DIGITAL_LICENCE_RIGHTS` is a default-DENY vocabulary: #1015 W2 requirement 6
 * forbids source redistribution by default, and the way that is stated is a
 * right simply being absent from the grant list. A page that listed only the
 * grants would leave "may I resell the files?" answered by silence — which a
 * buyer reads as "probably" as often as "no". So the complement is DERIVED from
 * the shared tuple and rendered under its own heading.
 *
 * Derived, never listed: `validate:storefront-catalog-driven` wall 5 refuses a
 * client-side copy of a server vocabulary for exactly this reason — an array
 * copy is a SUBSET that goes on compiling while a ninth right silently stops
 * being mentioned, whereas a filter over the tuple gains it automatically.
 *
 * ## The creator's own wording is shown and consulted by nothing
 *
 * `additionalTerms` is bounded prose a creator may add (`DIGITAL_LICENCE_TEXT_LIMITS`)
 * and no code reads it — it may ADD obligations and may never contradict the
 * machine-readable rights above. Rendered verbatim under its own heading so a
 * reader can see which half is enumerable and which half is the seller's text.
 *
 * ## Updates are the OPTION's answer, never the platform's
 *
 * `updatePolicy` is a prop rather than something this component assumes, because
 * ADR 0010 D4 is explicit that all three policies are somebody's real commercial
 * model and that deriving one at read time would mean a buyer's rights changed
 * when Mercaria changed its mind.
 */

export interface AssetLicenceSummaryProps {
  /** The licence's own name, as the creator or Mercaria published it. */
  licenceName: string;
  /** Whose text this is — a buyer comparing two "Commercial" licences needs it. */
  authorship: DigitalLicenceAuthorship;
  /** The frozen terms of the version this offer is bound to. */
  terms: DigitalLicenceVersionTerms;
  /** What a later version of the work costs, per this licence OPTION. */
  updatePolicy: DigitalLicenceUpdatePolicy;
  /** The creator's own one-line summary, when the licence carries one. */
  summary?: string;
}

export function AssetLicenceSummary({
  licenceName,
  authorship,
  terms,
  updatePolicy,
  summary,
}: AssetLicenceSummaryProps) {
  const t = useSharedUiTranslation();
  const locale = useSharedUiLocale();
  const { formatMoney } = useFormatters();

  const granted = terms.rights;
  const withheld = DIGITAL_LICENCE_RIGHTS.filter((right) => !granted.includes(right));

  /*
   * The revenue ceiling is minor units plus a currency the contract types as a
   * plain `string` — so it may name a code this client does not model. Resolving
   * it through `ALL_CURRENCY_CODES` rather than casting means an unmodelled code
   * renders NOTHING instead of a figure whose precision `formatMoney` would have
   * guessed at; a ceiling shown with the wrong number of decimals is worse than
   * one not shown, because the first is a number somebody will rely on.
   */
  const revenueCurrency =
    terms.revenueLimitCurrency === null
      ? undefined
      : currencyCodeOf(terms.revenueLimitCurrency);
  const revenueLimit =
    terms.revenueLimitAmount !== null && revenueCurrency !== undefined
      ? formatMoney({ amount: terms.revenueLimitAmount, currency: revenueCurrency })
      : undefined;

  return (
    <View className="gap-space-16">
      <View className="gap-space-4">
        <Text className="text-captionBold text-text" accessibilityRole="header">
          {t(ASSET_LICENCE_TITLE_KEY)}
        </Text>
        {/* The licence's own NAME is the creator's, shown verbatim. */}
        <Text className="text-bodyTitleSmall text-text">{licenceName}</Text>
        <Text className="text-caption text-text-tertiary">
          {t(DIGITAL_LICENCE_AUTHORSHIP_KEYS[authorship])}
        </Text>
        {summary === undefined ? null : (
          <Text className="text-bodySmall text-text-secondary">{summary}</Text>
        )}
      </View>

      <TermsBlock title={t(ASSET_LICENCE_GRANTED_TITLE_KEY)}>
        {granted.map((right) => (
          <Text key={`granted:${right}`} className="text-bodySmall text-text">
            {t(DIGITAL_LICENCE_RIGHT_KEYS[right])}
          </Text>
        ))}
      </TermsBlock>

      {withheld.length === 0 ? null : (
        <TermsBlock title={t(ASSET_LICENCE_NOT_GRANTED_TITLE_KEY)}>
          {withheld.map((right) => (
            <Text key={`withheld:${right}`} className="text-bodySmall text-text-secondary">
              {t(DIGITAL_LICENCE_RIGHT_KEYS[right])}
            </Text>
          ))}
        </TermsBlock>
      )}

      <TermsBlock title={t(ASSET_LICENCE_ATTRIBUTION_TITLE_KEY)}>
        <Text className="text-bodySmall text-text">
          {t(DIGITAL_LICENCE_ATTRIBUTION_KEYS[terms.attribution])}
        </Text>
      </TermsBlock>

      <TermsBlock title={t(ASSET_LICENCE_UPDATES_TITLE_KEY)}>
        <Text className="text-bodySmall text-text">
          {t(DIGITAL_LICENCE_UPDATE_POLICY_KEYS[updatePolicy])}
        </Text>
      </TermsBlock>

      {/*
        Every limit states its UNBOUNDED case out loud. ADR 0010 notes `null` is
        the ordinary answer for all three — which is exactly why "no limit" has
        to be written: an omitted row reads as a limit nobody has told you yet.
      */}
      <TermsBlock title={t(ASSET_LICENCE_LIMITS_TITLE_KEY)}>
        <Text className="text-bodySmall text-text">
          {terms.seatLimit === null
            ? t(ASSET_LICENCE_SEATS_UNLIMITED_KEY)
            : t(ASSET_LICENCE_SEATS_KEY, { seats: formatWholeNumber(terms.seatLimit, locale) })}
        </Text>
        <Text className="text-bodySmall text-text">
          {terms.projectLimit === null
            ? t(ASSET_LICENCE_PROJECTS_UNLIMITED_KEY)
            : t(ASSET_LICENCE_PROJECTS_KEY, { projects: formatWholeNumber(terms.projectLimit, locale) })}
        </Text>
        <Text className="text-bodySmall text-text">
          {revenueLimit === undefined
            ? t(ASSET_LICENCE_REVENUE_UNLIMITED_KEY)
            : t(ASSET_LICENCE_REVENUE_KEY, { amount: revenueLimit })}
        </Text>
      </TermsBlock>

      {terms.additionalTerms === null ? null : (
        <TermsBlock title={t(ASSET_LICENCE_ADDITIONAL_TERMS_TITLE_KEY)}>
          {/* Verbatim. No truncation and no parsing: it is the seller's text. */}
          <Text className="text-bodySmall text-text-secondary">{terms.additionalTerms}</Text>
        </TermsBlock>
      )}
    </View>
  );
}

/**
 * The currency code `code` names, or `undefined` when this client does not model
 * it. A `find` over the shared tuple rather than a cast, so an unknown code is a
 * VALUE this component can branch on instead of a lie the type system accepted.
 */
function currencyCodeOf(code: string): CurrencyCode | undefined {
  return ALL_CURRENCY_CODES.find((known) => known === code);
}

/** One headed group of terms. A heading role, so the page is navigable by them. */
function TermsBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View className="gap-space-4">
      <Text className="text-captionBold text-text-secondary" accessibilityRole="header">
        {title}
      </Text>
      {children}
    </View>
  );
}
