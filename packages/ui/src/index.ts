/**
 * @mercaria/ui — shared presentational UI for Mercaria.
 *
 * Consumed FROM SOURCE (no dist build): apps import directly from this barrel,
 * and the metro/tsconfig/tailwind wiring resolves `@mercaria/ui` to `src/`.
 * Everything here is presentational (DTOs in, classes out) — no app data
 * fetching, routing, or i18n.
 */

// ---------------------------------------------------------------------------
// Helpers / hooks
// ---------------------------------------------------------------------------
export { cn } from "./lib/cn";
export { useColorScheme } from "./lib/useColorScheme";
export { useSidebarCollapse } from "./lib/useSidebarCollapse";
export {
  formatMoney,
  formatReviewCount,
  formatSourceMoney,
  type ProductSummary,
} from "./lib/format";

// ---------------------------------------------------------------------------
// Item condition (#90) — the reader-facing copy for the shared taxonomy.
// The KEYS live in `@mercaria/shared-types` and are frozen; these strings are
// deliberately not, which is what "stored keys stay stable when copy changes"
// means in practice.
// ---------------------------------------------------------------------------
export {
  CONDITION_DISCLAIMER,
  CONDITION_EXPLANATIONS,
  CONDITION_GROUP_LABELS,
  CONDITION_LABELS,
  conditionExplanation,
  conditionGroupLabel,
  conditionLabel,
} from "./lib/condition";

// ---------------------------------------------------------------------------
// Offer comparison labels (#74) — the reader-facing copy for the labels and
// reason codes the ranking service emits. Same split as the condition taxonomy
// above and for the same reason: the reason CODE is what an impression and an
// operator trace carry, the sentence is what a shopper reads, and only one of
// the two is allowed to change without a contract change.
// ---------------------------------------------------------------------------
export {
  OFFER_LABEL_EXPLANATIONS,
  OFFER_LABEL_TEXT,
  explainOfferLabel,
  offerLabelText,
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
  MERCHANT_COMPETITIVENESS_TITLE,
  MERCHANT_ELIGIBILITY_LOSS_TEXT,
  PRICE_POSITION_TEXT,
  PRICE_QUALITY_CONFIDENCE_TEXT,
  PRICE_QUALITY_LABEL_TEXT,
  PRICE_SIGNAL_MEANING,
  PRICE_SIGNAL_RECOMMENDATION_TEXT,
  PRICE_SIGNAL_TITLE,
  PRICE_SIGNAL_UNMEASURED_TEXT,
  priceSignalAccessibleSummary,
  priceSignalBadgeText,
} from "./lib/price-signal-labels";

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
export { ColorPicker, COLOR_OPTIONS } from "./components/ui/color-picker";
export { SourceBadge, type SourceBadgeProps } from "./components/ui/source-badge";

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
