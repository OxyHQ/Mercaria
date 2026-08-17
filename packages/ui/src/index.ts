/**
 * @mercaria/ui — shared presentational UI for Mercaria.
 *
 * Consumed FROM SOURCE (no dist build): apps import directly from this barrel,
 * and the metro/tsconfig/tailwind wiring resolves `@mercaria/ui` to `src/`.
 * Everything here is presentational (DTOs in, classes out) — no app data
 * fetching and no routing.
 *
 * The one thing that is not presentational is the LOCALE REGISTRY (`./i18n`,
 * #398): which locales exist, how a device tag resolves to one, and the store
 * shape a screen reads. It lives here because three apps consume this package
 * from source and three copies of "which languages exist" is three answers that
 * drift. It carries no app STRINGS — those stay in each app's own
 * `lib/i18n/locales/*.json`.
 */

// ---------------------------------------------------------------------------
// Helpers / hooks
// ---------------------------------------------------------------------------
export { cn } from "./lib/cn";

// ---------------------------------------------------------------------------
// The locale registry (#398). ONE supported-locale tuple, ONE alias policy and
// ONE fallback chain for the storefront, the dashboard and the POS.
// ---------------------------------------------------------------------------
export {
  DEFAULT_LOCALE,
  LOCALE_ALIASES,
  LOCALE_ENDONYMS,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from "./i18n/locales";
export {
  createAppI18n,
  mergeSharedUiCopy,
  resolveDeviceLocale,
  shippedLocales,
  type AppLocaleBundles,
  type Translate,
} from "./i18n/create-app-i18n";
export {
  createI18nStore,
  type CreateI18nStoreOptions,
  type I18nStoreState,
} from "./i18n/create-i18n-store";
// ---------------------------------------------------------------------------
// This package's OWN reader-facing copy (#437). The bundles are merged into
// each app's i18n instance under the reserved `ui` namespace; the provider
// hands this package's components the app's `t`, so one locale is in force per
// app rather than a second one here that could disagree with the screen. Each
// app's root layout mounts the provider, and `validate:i18n-strings` fails the
// build if one stops.
// ---------------------------------------------------------------------------
export {
  SharedUiTranslationProvider,
  useSharedUiTranslation,
  type SharedUiTranslationProviderProps,
} from "./i18n/ui-translation";
// `./i18n/shared-copy`'s `SHARED_UI_COPY` is deliberately NOT exported here.
// It is the DATA `mergeSharedUiCopy` merges, and an app that could reach it
// could read a sentence out of it directly — which is the per-screen use that
// bypasses the app's own locale entirely. `isolateBidi`'s decision, below, for
// the same reason: an export with no consumer is an invitation.

// ---------------------------------------------------------------------------
// Layout direction (#434). Split in two on purpose: the DECISION (`isRtlLocale`)
// imports nothing, which is what lets `validate:rtl-classes` run the REAL
// function — none of these packages has a test runner, so a guard script is the
// only place a property of theirs can be asserted. The APPLICATION needs
// `I18nManager` and so cannot run outside a bundler.
//
// It reads the locales an app SHIPS, which is the same invariant #437's merge
// keeps from the other side: shared copy is intersected with what the app ships,
// never unioned, so an app can neither gain a locale it cannot mirror nor mirror
// one it does not ship.
// ---------------------------------------------------------------------------
export { isRtlLocale, languageOf, RTL_LANGUAGE_CODES } from "./i18n/rtl-locales";
export { syncLayoutDirection, type DirectionSyncResult } from "./i18n/layout-direction";
export { useColorScheme } from "./lib/useColorScheme";
export { useSidebarCollapse } from "./lib/useSidebarCollapse";
// `./lib/bidi`'s `isolateBidi` is deliberately NOT exported here. It is applied
// once, inside the four formatters below (#429 item 1), which is what makes this
// module the chokepoint rather than a utility screens remember to call. An
// export with no consumer is API surface inviting exactly the per-screen use the
// issue rules out; the first screen that genuinely needs it — a raw quantity or
// a Latin brand name in an Arabic sentence — adds the export in the diff that
// uses it.
export {
  formatDate,
  formatDateTime,
  formatDistance,
  formatMoney,
  formatRegionName,
  formatReviewCount,
  formatSourceMoney,
  type ProductSummary,
} from "./lib/format";

// ---------------------------------------------------------------------------
// Item condition (#90) — the TRANSLATION KEYS for the shared taxonomy's copy.
// The taxonomy keys live in `@mercaria/shared-types` and are frozen; the
// sentences live in `./i18n/locales/*.json` and are deliberately not, which is
// what "stored keys stay stable when copy changes" means in practice. Resolve
// one with an app's `t`, or `useSharedUiTranslation()` inside this package.
// ---------------------------------------------------------------------------
export {
  CONDITION_A11Y_LABEL_KEY,
  CONDITION_DISCLAIMER_KEY,
  CONDITION_EXPLANATION_KEYS,
  CONDITION_GROUP_LABEL_KEYS,
  CONDITION_LABEL_KEYS,
  CONDITION_NOT_STATED_KEY,
  CONDITION_SELLER_WORDING_KEY,
  conditionExplanationKey,
  conditionGroupLabelKey,
  conditionLabelKey,
} from "./lib/condition";

// ---------------------------------------------------------------------------
// Offer comparison labels (#74) — the reader-facing copy for the labels and
// reason codes the ranking service emits. Same split as the condition taxonomy
// above and for the same reason: the reason CODE is what an impression and an
// operator trace carry, the sentence is what a shopper reads, and only one of
// the two is allowed to change without a contract change.
// ---------------------------------------------------------------------------
export {
  OFFER_LABEL_A11Y_WITH_BASIS_KEY,
  OFFER_LABEL_BADGE_WITH_BASIS_KEY,
  OFFER_LABEL_DAYS_KEY,
  OFFER_LABEL_EXPLANATION_KEYS,
  OFFER_LABEL_TEXT_KEYS,
  offerLabelExplanationKey,
  offerLabelTextKey,
} from "./lib/offer-labels";

// ---------------------------------------------------------------------------
// Price signals (#82) — the reader-facing copy for the signals, the quality
// labels, the merchant competitiveness rows and the informational
// recommendations. Same split as the two above, with one addition of its own:
// there is a sentence per STATE, because "we could not tell" and "we looked and
// the condition does not hold" are different things to say and rendering one as
// the other is the dishonesty the whole domain exists to prevent.
// ---------------------------------------------------------------------------
export {
  MERCHANT_COMPETITIVENESS_TITLE_KEYS,
  MERCHANT_ELIGIBILITY_LOSS_KEYS,
  PRICE_POSITION_KEYS,
  PRICE_QUALITY_CONFIDENCE_KEYS,
  PRICE_QUALITY_LABEL_KEYS,
  PRICE_SIGNAL_DROP_BADGE_KEY,
  PRICE_SIGNAL_MEANING_KEYS,
  PRICE_SIGNAL_RECOMMENDATION_KEYS,
  PRICE_SIGNAL_TITLE_KEYS,
  PRICE_SIGNAL_UNMEASURED_KEYS,
  priceSignalAccessibleSummary,
  priceSignalBadgeTextKey,
} from "./lib/price-signal-labels";

// ---------------------------------------------------------------------------
// Saved shopping agents (#97) — the reader-facing copy for what an agent
// watches, what one look concluded, why a stored observation is still on screen
// and why somebody was or was not told. Same split as the three above; the one
// thing it adds is a sentence per SUMMARY SOURCE, because a deterministic
// summary is the normal case and a surface that only spoke up when a model had
// been involved would make the ordinary one look degraded.
// ---------------------------------------------------------------------------
export {
  SHOPPING_AGENT_CHANNEL_POLICY_LABELS,
  SHOPPING_AGENT_COMPLETENESS_LABELS,
  SHOPPING_AGENT_DELIVERY_FAILURE_TEXT,
  SHOPPING_AGENT_FRESHNESS_LABELS,
  SHOPPING_AGENT_INCOMPLETE_REASON_TEXT,
  SHOPPING_AGENT_JOB_EXPLANATIONS,
  SHOPPING_AGENT_JOB_LABELS,
  SHOPPING_AGENT_LIFECYCLE_EXPLANATIONS,
  SHOPPING_AGENT_LIFECYCLE_LABELS,
  SHOPPING_AGENT_NOTIFICATION_CHANNEL_LABELS,
  SHOPPING_AGENT_NOTIFICATION_STATE_LABELS,
  SHOPPING_AGENT_OBSERVATION_DISCLAIMER,
  SHOPPING_AGENT_OPTIMALITY_LABELS,
  SHOPPING_AGENT_OUTCOME_EXPLANATIONS,
  SHOPPING_AGENT_OUTCOME_LABELS,
  SHOPPING_AGENT_PRICE_BASIS_LABELS,
  SHOPPING_AGENT_STATE_LABELS,
  SHOPPING_AGENT_SUMMARY_SOURCE_TEXT,
  SHOPPING_AGENT_SUPPRESSION_REASON_TEXT,
  SHOPPING_AGENT_TRIGGER_SOURCE_LABELS,
  shoppingAgentJobExplanation,
  shoppingAgentJobLabel,
} from "./lib/shopping-agent-labels";

// ---------------------------------------------------------------------------
// Commercial disclosures (#129) — the reader-facing copy for who is selling,
// who is paid and what rights come with the purchase. Same split again: the
// disclosure KEY is what a placed order's role snapshot pins and what the
// server's `commercialDisclosureKeys` decides, and the sentence is what a
// shopper reads. A screen renders the list the server composed; it never
// decides a legal role for itself.
// ---------------------------------------------------------------------------
export {
  COMMERCIAL_DISCLOSURE_EXPLANATIONS,
  COMMERCIAL_DISCLOSURE_LABELS,
  RETAIL_BLOCK_REASON_EXPLANATIONS,
  RETAIL_ORDER_PROGRESS_EXPLANATIONS,
  RETAIL_ORDER_PROGRESS_LABELS,
  RETAIL_UNQUOTED_EXPLANATIONS,
  commercialDisclosureExplanation,
  commercialDisclosureLabel,
  commercialSellerLabel,
  retailOrderProgressExplanation,
  retailOrderProgressLabel,
} from "./lib/commercial-copy";

// ---------------------------------------------------------------------------
// App shell — the shared responsive layout, sidebar rail, and page mask
// ---------------------------------------------------------------------------
export { AppShell, type AppShellProps } from "./components/shell/AppShell";
export {
  AppSidebar,
  type AppSidebarProps,
  type AppSidebarItem,
} from "./components/shell/AppSidebar";
export {
  BaseSidebar,
  type BaseSidebarProps,
} from "./components/shell/BaseSidebar";
export {
  SidebarRow,
  GhostIconButton,
  useRailTooltip,
  type SidebarRowProps,
  type GhostIconButtonProps,
  type RailTooltipHandle,
} from "./components/shell/sidebar-primitives";
export {
  ScreenShell,
  type ScreenShellProps,
} from "./components/shell/ScreenShell";

// ---------------------------------------------------------------------------
// Dual-currency display
// ---------------------------------------------------------------------------
export { PriceDisplay, type PriceDisplayProps } from "./components/PriceDisplay";
export {
  FxContext,
  FxProvider,
  useFx,
  type FxContextValue,
  type FxProviderProps,
} from "./components/FxContext";

// ---------------------------------------------------------------------------
// UI primitives
// ---------------------------------------------------------------------------
export {
  Button,
  buttonTextVariants,
  buttonVariants,
  type ButtonProps,
} from "./components/ui/button";
export { Text, TextClassContext, type TextProps } from "./components/ui/text";
export {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./components/ui/card";
export { Input } from "./components/ui/input";
export { Textarea, type TextareaProps } from "./components/ui/textarea";
export { Avatar, AvatarFallback, AvatarImage } from "./components/ui/avatar";
export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./components/ui/dialog";
export {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "./components/ui/sheet";
export * as DropdownMenu from "./components/ui/dropdown-menu";
export { Skeleton } from "./components/ui/skeleton";
export { Separator } from "./components/ui/separator";
export { Icon } from "./components/ui/icon";
export { Label } from "./components/ui/label";
export { default as H1 } from "./components/ui/h1";
export { Kbd, KbdGroup } from "./components/ui/kbd";
export { ScrollArea, ScrollBar } from "./components/ui/scroll-area";
export { Switch, type SwitchProps } from "./components/ui/switch";
export { ToggleGroup, ToggleGroupItem } from "./components/ui/toggle-group";
export {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./components/ui/collapsible";
export { Panel } from "./components/ui/panel";
// The `side` both `Panel` and `SheetContent` take. LOGICAL (`start` / `end`), so
// a sliding surface mirrors with the rest of the layout; the physical
// `left` / `right` spelling is gone rather than aliased (#429). Exported because
// it is in those two public prop signatures — a screen holding a side in a
// variable has to be able to name its type.
export type { LogicalSide } from "./lib/logical-side";
export { ColorPicker, COLOR_OPTIONS } from "./components/ui/color-picker";
export { SourceBadge, type SourceBadgeProps } from "./components/ui/source-badge";
// Connector provenance's other half (#420): which fields a merchant's own edits
// pinned against a later sync, and what that means while the channel's
// "Keep my local edits" switch is where it is. Read-only by design — see the
// component's note on why there is no unpin control here.
export {
  ConnectorPinNotice,
  type ConnectorPinNoticeProps,
} from "./components/ui/connector-pin-notice";
export {
  CONNECTOR_PIN_EFFECT_KEYS,
  CONNECTOR_PIN_LABEL_KEYS,
  CONNECTOR_PIN_RELEASE_KEY,
  CONNECTOR_PIN_TITLE_KEY,
  CONNECTOR_PIN_UNNAMED_KEY,
  CONNECTOR_PROVIDER_LABEL_KEYS,
  CONNECTOR_SYNCED_FROM_KEY,
  type ConnectorPinEffect,
} from "./lib/connector-labels";

// ---------------------------------------------------------------------------
// Marketplace presentational components
// ---------------------------------------------------------------------------
export { ProductCard, type ProductCardProps } from "./components/marketplace/ProductCard";
export { Carousel, type CarouselProps } from "./components/marketplace/Carousel";
export { ReviewStars, type ReviewStarsProps } from "./components/marketplace/ReviewStars";
export {
  ProductCarousel,
  type ProductCarouselProps,
} from "./components/marketplace/ProductCarousel";
export { ProductShelf, type ProductShelfProps } from "./components/marketplace/ProductShelf";
export { CategoryCard, type CategoryCardProps } from "./components/marketplace/CategoryCard";
export {
  CategoryCarousel,
  type CategoryCarouselProps,
} from "./components/marketplace/CategoryCarousel";
export { CategoryPills, type CategoryPillsProps } from "./components/marketplace/CategoryPills";
export { MerchantCard, type MerchantCardProps } from "./components/marketplace/MerchantCard";
export {
  MerchantCarousel,
  type MerchantCarouselProps,
} from "./components/marketplace/MerchantCarousel";
export {
  SectionHeader,
  type SectionHeaderProps,
} from "./components/marketplace/SectionHeader";
export {
  QuantityStepper,
  type QuantityStepperProps,
} from "./components/marketplace/QuantityStepper";
export {
  CartLineItem,
  type CartLineItemProps,
} from "./components/marketplace/CartLineItem";
export {
  MerchantCartCard,
  type MerchantCartCardProps,
} from "./components/marketplace/MerchantCartCard";
export { CartShelf, type CartShelfProps } from "./components/marketplace/CartShelf";

// ---------------------------------------------------------------------------
// Product detail page (PDP) presentational components
// ---------------------------------------------------------------------------
export { IncentiveHalo, type IncentiveHaloProps } from "./components/marketplace/IncentiveHalo";
export {
  MerchantHeader,
  type MerchantHeaderProps,
} from "./components/marketplace/MerchantHeader";
export { DemandPill, type DemandPillProps } from "./components/marketplace/DemandPill";
export { OfferCard, type OfferCardProps } from "./components/marketplace/OfferCard";
export { RatingLine, type RatingLineProps } from "./components/marketplace/RatingLine";
// One row of the saved list (#80) — a canonical PRODUCT save or an exact
// LISTING save, rendered as visibly different things because they are.
export {
  SavedItemCard,
  type SavedItemCardProps,
} from "./components/marketplace/SavedItemCard";
export {
  PriceAlertCard,
  type PriceAlertCardProps,
} from "./components/marketplace/PriceAlertCard";
// One saved shopping agent (#97) and one of its appended observations. Two
// components rather than one, because a superseded finding is still rendered
// under an agent that has since moved on — the card says what is being watched,
// the finding card says what was seen and when it stopped being true.
export {
  ShoppingAgentCard,
  type ShoppingAgentCardProps,
} from "./components/marketplace/ShoppingAgentCard";
export {
  ShoppingAgentFindingCard,
  type ShoppingAgentFindingCardProps,
} from "./components/marketplace/ShoppingAgentFindingCard";
export {
  ProductGallery,
  type ProductGalleryImage,
  type ProductGalleryProps,
} from "./components/marketplace/ProductGallery";
export {
  VariantSwatches,
  type VariantSwatchImage,
  type VariantSwatchesProps,
} from "./components/marketplace/VariantSwatches";
export {
  PurchaseOptions,
  type PurchaseOptionsProps,
} from "./components/marketplace/PurchaseOptions";
export { ReviewCard, type ReviewCardProps } from "./components/marketplace/ReviewCard";
export {
  ReviewSummaryCard,
  type RatingDistribution,
  type ReviewSummaryCardProps,
} from "./components/marketplace/ReviewSummaryCard";
export {
  ConditionBadge,
  type ConditionBadgeProps,
} from "./components/marketplace/ConditionBadge";
// An OFFER's condition, which may be `unknown` — a different type and a
// different sentence from a listing's, because most external feeds publish no
// condition at all and "New" is what a shared fallback would render for them.
export {
  OfferConditionBadge,
  type OfferConditionBadgeProps,
} from "./components/marketplace/OfferConditionBadge";
// One #74 comparison label, rendered from the award that earned it. Here rather
// than in an app because the COPY it reads already lives here (`offer-labels`),
// and a badge whose words and whose component sit in different packages is a
// copy change that ships without the thing it describes.
export {
  OfferLabelBadge,
  type OfferLabelBadgeProps,
} from "./components/marketplace/OfferLabelBadge";

// ---------------------------------------------------------------------------
// Natural-language search interpretation (#95). Presentational only: the three
// ORIGIN voices are rendered distinctly, because "never pretend a model
// inference was explicitly stated by the user" is a rendering decision as much
// as a data one — and removing a chip is a CALLBACK, so whether it re-parses,
// re-searches or both stays the app's decision.
// ---------------------------------------------------------------------------
export {
  SearchClarification,
  SearchInterpretation,
  type InterpretationChip,
  type InterpretationGap,
  type InterpretationOrigin,
  type SearchClarificationProps,
  type SearchInterpretationProps,
} from "./components/marketplace/SearchInterpretation";

// #96's grounded comparison and basket surfaces. Here rather than in an app
// because the COPY they read (`comparison-labels`) lives here, and because all
// three apps eventually render a comparison — a component whose words and whose
// markup sit in different packages is a copy change that ships without the
// thing it describes.
export {
  ComparisonTableView,
  type ComparisonTableViewProps,
} from "./components/marketplace/ComparisonTableView";
export {
  ComparisonExplanationBlock,
  type ComparisonExplanationBlockProps,
} from "./components/marketplace/ComparisonExplanationBlock";
export {
  BasketPlanCard,
  type BasketPlanCardProps,
} from "./components/marketplace/BasketPlanCard";
export {
  BASKET_OPTIMALITY_APPROXIMATE_KEY,
  BASKET_OPTIMALITY_PROVEN_KEY,
  COMPARISON_CELL_A11Y_KEY,
  COMPARISON_CELL_INFERRED_A11Y_KEY,
  COMPARISON_CELL_INFERRED_NOTE_KEY,
  COMPARISON_EXPLANATION_FALLBACK_NOTICE_KEY,
  COMPARISON_LIST_SEPARATOR_KEY,
  basketApproximationTextKey,
  basketReasonTextKey,
  basketResultDefinitionKey,
  basketResultTextKey,
  comparisonNotApplicableTextKey,
  comparisonUnavailableTextKey,
  comparisonUnknownTextKey,
  explanationRejectionTextKey,
} from "./lib/comparison-labels";
// ---------------------------------------------------------------------------
// Brand and product-family pages (#72) — a CANONICAL product card and the
// verified-relationship badge. Separate from `ProductCard`, which renders one
// seller's LISTING: this one renders a product the marketplace as a whole
// sells, so it carries a representative price and an offer count rather than a
// price and a save affordance.
// ---------------------------------------------------------------------------
export {
  CanonicalProductCard,
  type CanonicalProductCardProps,
} from "./components/marketplace/CanonicalProductCard";
export {
  OfficialChannelBadge,
  type OfficialChannelBadgeProps,
} from "./components/marketplace/OfficialChannelBadge";

// ---------------------------------------------------------------------------
// Commercial disclosures (#129) — the disclosure list a screen renders
// exactly as the server composed it. Here rather than in an app because the
// COPY it reads (`commercial-copy`) lives here, and because all three apps
// eventually render a disclosure — a component whose words and whose markup
// sit in different packages is a copy change that ships without the thing it
// describes.
// ---------------------------------------------------------------------------
export {
  CommercialDisclosure,
  type CommercialDisclosureProps,
} from "./components/marketplace/CommercialDisclosure";

// ---------------------------------------------------------------------------
// Location publication, nearby discovery and collection (#93) — the copy and
// the two renderers all three apps could need.
//
// Same split as every taxonomy above: the KEYS are `@mercaria/shared-types`
// unions that columns, CHECKs and wire contracts carry, and the sentences are
// here so a wording change touches no stored value. Every map is exhaustive
// over its union, so a member added to `pickup.ts` fails THIS package's
// typecheck rather than rendering a blank chip at a collection counter.
//
// `PICKUP_BLOCK_REASON_TEXT` is the one export here a storefront must not
// render: it is merchant-facing, and `describeBuyerPickupBlock` beside it is
// what a buyer-facing surface calls instead (`docs/pickup.md` §2).
// ---------------------------------------------------------------------------
export {
  LOCATION_AVAILABILITY_EXPLANATIONS,
  LOCATION_AVAILABILITY_TEXT,
  ORDER_PICKUP_STATE_EXPLANATIONS,
  ORDER_PICKUP_STATE_TEXT,
  PICKUP_BLOCK_REASON_TEXT,
  PICKUP_DISTANCE_BAND_TEXT,
  PICKUP_IDENTITY_REQUIREMENT_TEXT,
  PICKUP_PAYMENT_REQUIREMENT_TEXT,
  describeBuyerPickupBlock,
  describeOpenState,
  describeStockConfirmed,
  formatOpeningMinute,
  formatPublicAddress,
  formatWeekday,
  type BuyerPickupBlockCopy,
} from "./lib/pickup-labels";
// The referral partner dashboard's reader-facing copy (#147). Labels and
// sentences only — no colour map, because #147 accessibility rule 2 asks that
// a financial state not depend on one, and a surface wanting colour writes it
// beside the label so a reviewer can see the label carries the meaning alone.
export {
  REFERRAL_OUTSTANDING_LABELS,
  REFERRAL_PAYOUT_STATUS_LABELS,
  REFERRAL_REWARD_STATE_EXPLANATIONS,
  REFERRAL_REWARD_STATE_LABELS,
  describeMetric,
  describeRewardBasis,
  describeWithheldRows,
} from "./lib/referral-labels";
export {
  NearbyLocationCard,
  type NearbyLocationCardProps,
} from "./components/marketplace/NearbyLocationCard";
export {
  PickupCollectionPanel,
  type PickupCollectionPanelProps,
} from "./components/marketplace/PickupCollectionPanel";
