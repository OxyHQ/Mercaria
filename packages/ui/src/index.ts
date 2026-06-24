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
export {
  formatMoney,
  formatReviewCount,
  type ProductSummary,
} from "./lib/format";

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
