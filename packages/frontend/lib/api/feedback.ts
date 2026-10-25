import type { OxyServices } from '@oxy.so/core';

export interface FeedbackInput {
  type: 'bug' | 'feature' | 'improvement' | 'other';
  message: string;
  rating: number | null;
  metadata: { platform: string; appVersion: string };
}

/** Consume the response before releasing the shared request's session binding. */
export async function submitFeedback(oxy: OxyServices, baseURL: string, input: FeedbackInput) {
  const linked = oxy.createLinkedClient({ baseURL });
  try {
    const response = await linked.fetchOptional('/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (response.ok) {
      await response.body?.cancel();
      return { ok: true as const };
    }
    const body: unknown = await response.json();
    return {
      ok: false as const,
      error:
        typeof body === 'object' &&
        body !== null &&
        'error' in body &&
        typeof body.error === 'string'
          ? body.error
          : undefined,
    };
  } finally {
    linked.dispose();
  }
}
