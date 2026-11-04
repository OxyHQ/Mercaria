/** Mercaria's immutable application registration in Oxy. */
export const MERCARIA_OXY_APP = '6a37d0cc5d4b5f15482a9340';
export const MERCARIA_SERVICE_AUDIENCE = `oxy-service:${MERCARIA_OXY_APP}` as const;

/**
 * The Oxy API this process talks to — read ONCE, here. The shared `OxyServer`,
 * the capability-ticket issuer and the MCP authorization server all name this
 * value; a second read of the variable is a second answer that can disagree.
 */
export const OXY_API_URL = (process.env.OXY_API_URL || 'https://api.oxy.so').replace(/\/+$/, '');
