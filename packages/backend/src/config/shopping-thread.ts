/** Outbound product identity only; inbound authentication remains Oxy's middleware. */
export function shoppingThreadConfig() {
  return {
    agentId: process.env.SHOPPING_THREAD_AGENT_ID?.trim() || undefined,
  };
}
