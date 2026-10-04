/**
 * `@mercaria/contracts` — the ONE definition of Mercaria's public integration
 * API (`/public/v1`, #1017): every request schema, response shape, ref, closed
 * value set, error code and cursor kind, the route registry, and the OpenAPI
 * document generated from it. Types are `z.infer` of the schemas.
 *
 * The backend validates requests and serializes responses with these schemas;
 * `@mercaria.co/sdk` parses responses with them (and bundles this private
 * package). `docs/public-api.md` is the reference.
 */

export * from './primitives';
export * from './refs';
export * from './catalog';
export * from './pagination';
export * from './errors';
export * from './requests';
export * from './json-schema';
export * from './routes';
export * from './openapi';
