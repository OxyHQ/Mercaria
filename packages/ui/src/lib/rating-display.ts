import { useCallback } from "react";
import type { RatingProps } from "@oxy.so/bloom/rating";
import { useSharedUiTranslation } from "../i18n/ui-translation";
import {
  REVIEW_NONE_KEY,
  REVIEW_STARS_A11Y_KEY,
  REVIEW_STARS_SCOPED_A11Y_KEY,
} from "./marketplace-labels";
import { useFormatters } from "./use-formatters";

export interface RatingDisplayInput {
  /** The rating, 0–5. */
  rating: number;
  /**
   * How many reviews it is the average of. Omit for ONE review's own rating,
   * which draws no count. `0` means nothing is rated yet.
   */
  reviews?: number;
  /**
   * What the rating is ABOUT, in the reader's words ("Product reviews", "Seller
   * service") — #76 UI rule 6: a page carrying several ratings must name each
   * one's scope, and an unscoped "Average rating: 4.2" cannot.
   */
  subject?: string;
  /**
   * `stars` when the result feeds `<Rating variant="stars">`. The drawn value
   * stays the localised `formatRating` string, and the row's fill comes from
   * `fillValue` — the NUMBER — because that string is bidi-isolated (FSI…PDI)
   * and need not parse. Default `compact`, which draws no fill.
   */
  variant?: "compact" | "stars";
}

/** One decimal, the precision `formatRating` draws. */
const RATING_DECIMALS = 10;

/** The part of Bloom's `Rating` props that carries a value and its copy. */
export type RatingDisplay = Required<
  Pick<RatingProps, "value" | "newLabel" | "accessibilityLabel">
> &
  Pick<RatingProps, "count" | "fillValue">;

/**
 * Turns a rating into the props `@oxy.so/bloom/rating`'s `Rating` needs, in the
 * viewer's language: `<Rating {...display({ rating, reviews })} />`.
 *
 * Bloom draws a number with `.` and an English accessible name ("Rated 4.92 out
 * of 5, 128 reviews"), so both come from here instead:
 *
 * - **`value` and `count` are pre-formatted strings** — `formatRating` /
 *   `formatReviewCount`, localised and bidi-isolated like every other figure —
 *   which Bloom draws as given.
 * - **`accessibilityLabel` is the translated, scoped sentence** the old
 *   hand-drawn `ReviewStars` announced.
 * - **`variant: "stars"` adds `fillValue`**, the number the five-star row
 *   fills to — see {@link RatingDisplayInput.variant}.
 * - **Nothing rated yet** (`reviews: 0`) draws `newLabel` — "No reviews yet",
 *   never Bloom's default "New", which on a marketplace reads as an item's
 *   condition.
 */
export function useRatingDisplay(): (input: RatingDisplayInput) => RatingDisplay {
  const t = useSharedUiTranslation();
  const { formatRating, formatReviewCount } = useFormatters();
  return useCallback(
    ({ rating, reviews, subject, variant }: RatingDisplayInput): RatingDisplay => {
      const none = t(REVIEW_NONE_KEY);
      if (reviews === 0) {
        return { value: null, newLabel: none, accessibilityLabel: none };
      }
      const figures = { rating: formatRating(rating), reviews: reviews ?? 1 };
      return {
        value: figures.rating,
        ...(variant === "stars"
          ? { fillValue: Math.round(rating * RATING_DECIMALS) / RATING_DECIMALS }
          : {}),
        ...(reviews === undefined ? {} : { count: formatReviewCount(reviews) }),
        newLabel: none,
        accessibilityLabel: subject
          ? t(REVIEW_STARS_SCOPED_A11Y_KEY, { subject, ...figures })
          : t(REVIEW_STARS_A11Y_KEY, figures),
      };
    },
    [formatRating, formatReviewCount, t],
  );
}
