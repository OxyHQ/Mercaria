/** One of the person's Alia conversations as "Keep shopping" shows it. */
export interface RecentConversation {
  id: string;
  title: string;
  dateLabel: string;
}

/** How many of the person's conversations "Keep shopping" offers. */
export const RECENT_CONVERSATIONS = 12;

/**
 * The newest conversations across the pages Alia returned, labelled with the
 * time when they are from today and the date otherwise.
 */
export function recentConversations(
  pages: ReadonlyArray<{
    conversations: ReadonlyArray<{ id: string; title: string; updatedAt: Date }>;
  }>,
  locale: string,
  now: Date = new Date(),
): RecentConversation[] {
  return pages
    .flatMap((page) => page.conversations)
    .slice(0, RECENT_CONVERSATIONS)
    .map((conversation) => {
      const today = conversation.updatedAt.toDateString() === now.toDateString();
      return {
        id: conversation.id,
        title: conversation.title,
        dateLabel: new Intl.DateTimeFormat(
          locale,
          today ? { hour: 'numeric', minute: '2-digit' } : { month: 'long', day: 'numeric' },
        ).format(conversation.updatedAt),
      };
    });
}
