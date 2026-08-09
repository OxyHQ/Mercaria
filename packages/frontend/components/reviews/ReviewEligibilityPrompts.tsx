import { useState } from "react";
import { Pressable, View } from "react-native";
import type { ReviewEligibility, ReviewScope } from "@mercaria/shared-types";
import { Button, ReviewStars, Text, Textarea } from "@mercaria/ui";
import { REVIEW_SCOPE_LABELS, useCreateReview, useReviewEligibilities } from "@/lib/hooks/use-reviews";

/** Star buttons offered by the rating picker, low → high. */
const RATING_CHOICES = [1, 2, 3, 4, 5] as const;
/** How many prompts one order-history page shows before "and N more". */
const VISIBLE_PROMPTS = 4;
/** Star edge length (px) inside a prompt row. */
const PROMPT_STAR_SIZE = 16;

/**
 * What each scope ASKS, in the second person.
 *
 * Deliberately a different sentence per scope rather than one "Rate this":
 * a buyer being asked "how was the seller's service" and "how is the product"
 * must be able to tell which they are answering, or the two ratings they leave
 * are the same rating written twice (#76 UI rule 6, and the reason the whole
 * separation exists).
 */
const PROMPT_QUESTION: Readonly<Record<ReviewScope, string>> = Object.freeze({
  product: "How is the product itself?",
  merchant: "How was the seller's service?",
  native_transaction: "How was this purchase?",
  p2p_listing: "Did the item match its condition and description?",
  p2p_seller: "How was this seller to buy from?",
});

/** The body field for one scoped review, keyed by the scope's target. */
function targetInput(eligibility: ReviewEligibility): Record<string, string> {
  switch (eligibility.scope) {
    case "product":
      return { canonicalProductId: eligibility.targetId };
    case "merchant":
      return { merchantId: eligibility.targetId };
    case "native_transaction":
      return { orderItemId: eligibility.targetId };
    case "p2p_listing":
      return { listingId: eligibility.targetId };
    case "p2p_seller":
      return { sellerOxyUserId: eligibility.targetId };
  }
}

/**
 * One review prompt: the question its scope asks, a star picker and an optional
 * note.
 *
 * The eligibility id is sent explicitly. The server would pick the buyer's
 * oldest open grant for this target anyway, but a buyer who bought the same
 * thing twice is looking at TWO prompts, and sending the id is what makes the
 * one they tapped the one that gets spent.
 */
function ReviewPrompt({ eligibility }: { eligibility: ReviewEligibility }) {
  const [rating, setRating] = useState<number | null>(null);
  const [body, setBody] = useState("");
  const createReview = useCreateReview();

  const submit = (): void => {
    if (rating === null) return;
    createReview.mutate({
      scope: eligibility.scope,
      eligibilityId: eligibility.id,
      rating,
      ...(body.trim() ? { body: body.trim() } : {}),
      ...targetInput(eligibility),
    });
  };

  if (createReview.isSuccess) {
    return (
      <View className="rounded-2xl border border-border bg-card p-4">
        <Text className="text-sm text-muted-foreground">
          {`Thanks — your ${REVIEW_SCOPE_LABELS[eligibility.scope].toLowerCase()} review is published.`}
        </Text>
      </View>
    );
  }

  return (
    <View className="gap-3 rounded-2xl border border-border bg-card p-4">
      <View>
        <Text className="text-sm font-bold text-foreground">
          {PROMPT_QUESTION[eligibility.scope]}
        </Text>
        {/*
          The scope is named in visible copy as well as in the question, so a
          buyer scanning four prompts can see that they are four different
          questions rather than one asked four times.
        */}
        <Text className="mt-0.5 text-xs text-muted-foreground">
          {`${REVIEW_SCOPE_LABELS[eligibility.scope]} · verified purchase`}
        </Text>
      </View>

      <View className="flex-row items-center gap-2">
        {RATING_CHOICES.map((choice) => (
          <Pressable
            key={choice}
            accessibilityRole="button"
            accessibilityLabel={`${choice} of 5 — ${REVIEW_SCOPE_LABELS[eligibility.scope]}`}
            accessibilityState={{ selected: rating === choice }}
            hitSlop={6}
            onPress={() => setRating(choice)}
          >
            <ReviewStars
              rating={rating !== null && choice <= rating ? 1 : 0}
              count={1}
              size={PROMPT_STAR_SIZE}
              scopeLabel={REVIEW_SCOPE_LABELS[eligibility.scope]}
            />
          </Pressable>
        ))}
      </View>

      <Textarea
        placeholder="Add a note (optional)"
        value={body}
        onChangeText={setBody}
        accessibilityLabel={`Your ${REVIEW_SCOPE_LABELS[eligibility.scope].toLowerCase()} review`}
      />

      {createReview.isError ? (
        <Text className="text-xs text-destructive">
          {createReview.error instanceof Error
            ? createReview.error.message
            : "Could not publish that review."}
        </Text>
      ) : null}

      <Button
        size="sm"
        disabled={rating === null || createReview.isPending}
        isLoading={createReview.isPending}
        onPress={submit}
      >
        <Text className="text-sm font-medium">Publish review</Text>
      </Button>
    </View>
  );
}

/**
 * The order-history review surface (#76 UI rule 3): "an authenticated order
 * history can request a verified transaction review".
 *
 * It is driven ENTIRELY by the eligibility list, which is the server's answer to
 * "what has this account actually bought". Three consequences worth naming,
 * because each is an acceptance criterion:
 *
 *  - a signed-out visitor sees nothing, because `useReviewEligibilities` is
 *    disabled and there is nothing to ask them about;
 *  - a GUEST order produces no prompt, because an unclaimed guest purchase has
 *    no eligibility and no Oxy author (#76 acceptance 8) — and the prompt cannot
 *    be reached from an old guest link either, because it lives behind the
 *    authenticated order history (UI rule 8);
 *  - nothing here prefills sentiment or drafts text (privacy rule 6): the star
 *    picker starts empty and the note starts empty.
 */
export function ReviewEligibilityPrompts() {
  const { data, isLoading } = useReviewEligibilities();
  const eligibilities = data ?? [];

  if (isLoading || eligibilities.length === 0) return null;

  const visible = eligibilities.slice(0, VISIBLE_PROMPTS);
  const remaining = eligibilities.length - visible.length;

  return (
    <View className="gap-3 px-4 pb-6">
      <Text className="text-sm font-bold text-foreground">Rate what you bought</Text>
      {visible.map((eligibility) => (
        <ReviewPrompt key={eligibility.id} eligibility={eligibility} />
      ))}
      {remaining > 0 ? (
        <Text className="text-xs text-muted-foreground">
          {`${remaining} more purchase${remaining === 1 ? "" : "s"} to rate.`}
        </Text>
      ) : null}
    </View>
  );
}
