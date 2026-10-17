import { describe, expect, it } from 'vitest';
import { RECENT_CONVERSATIONS, recentConversations } from '../recent-conversations';

const now = new Date('2026-10-17T15:00:00Z');

describe('recentConversations', () => {
  it('keeps Alia’s order across pages and labels today by time, earlier days by date', () => {
    const rows = recentConversations(
      [
        {
          conversations: [
            { id: 'a', title: 'Dinner party gifts', updatedAt: new Date('2026-10-17T10:05:00Z') },
          ],
        },
        {
          conversations: [
            { id: 'b', title: 'Rain jacket', updatedAt: new Date('2026-10-02T09:00:00Z') },
          ],
        },
      ],
      'en-US',
      now,
    );
    expect(rows.map((row) => row.id)).toEqual(['a', 'b']);
    expect(rows[0]?.dateLabel).toMatch(/\d{1,2}:\d{2}/);
    expect(rows[1]?.dateLabel).toBe('October 2');
  });

  it(`offers at most ${RECENT_CONVERSATIONS}`, () => {
    const conversations = Array.from({ length: RECENT_CONVERSATIONS + 5 }, (_, index) => ({
      id: String(index),
      title: `Conversation ${index}`,
      updatedAt: now,
    }));
    expect(recentConversations([{ conversations }], 'en-US', now)).toHaveLength(
      RECENT_CONVERSATIONS,
    );
  });

  it('has nothing to offer signed out', () => {
    expect(recentConversations([], 'en-US', now)).toEqual([]);
  });
});
