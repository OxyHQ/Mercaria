# `@mercaria.co/sdk` — the public integration boundary (#1017)

`packages/sdk` publishes `@mercaria.co/sdk`: the one supported way for another
Oxy application (Mention first, via OxyHQ/Mention#951, then Goway, Nilo,
assistants and services) to read Mercaria commerce data. The consumer-facing
guide is [`packages/sdk/README.md`](../packages/sdk/README.md); this file is for
people changing the SDK or the contract behind it.

## What it is, and what it is not

- **It is** a headless TypeScript client over the public read API mounted at
  `/public/v1`: products, search, stores, collections, a store's locations
  and what is on their shelves, canonical links, portable refs and typed
  errors. It runs on Node 18+, Bun, browsers and React
  Native from one entry, and has **one runtime dependency, `zod`**.
- **It is not** a UI kit, a checkout, an admin or operator client, a supplier or
  procurement client (#1016), or a second definition of Mercaria's types.

The **contract** is `packages/contracts` (`@mercaria/contracts`, zod 4). It is
the single definition of every ref, DTO, request query, closed value set, error
code and cursor kind, plus the route registry the backend router and the
OpenAPI document are built from; every type is `z.infer` of a schema. The
backend's public projection builds those shapes field by field and parses each
body with the route's schema before sending it; the SDK parses each response
with the same schema, and runs each query it sends through the same query
schema the server validates with. Neither side spreads a storefront DTO, so a
field added to `Listing` reaches no foreign application unless somebody adds it
to the contract on purpose. `docs/public-api.md` describes the package.

`@mercaria/contracts` and the `@mercaria/shared-types` vocabularies it names are
private and never published, so the SDK keeps them as devDependencies and
**bundles** what it uses — schemas and values into the JavaScript, declarations
into the `.d.ts` — and re-exports the contract types. `zod` stays external: it
is the SDK's one `dependency`. Consumers import only `@mercaria.co/sdk`.

## Decisions a change must keep

| Decision | Why | Where |
| --- | --- | --- |
| Refs carry identity only (no title, price, handle) | a persisted ref must not snapshot mutable truth | `contracts/src/refs.ts`, `src/refs.ts` |
| Responses parse with the contract's zod schemas: fresh objects, contract keys only | a server leak cannot reach a DTO, and there is no second parser to drift | `src/transport.ts` |
| Unknown enum values are `malformed_response` | the SDK never guesses a fact a consumer renders | the contract's closed `z.enum`s |
| One malformed row fails the whole page | dropping rows breaks pagination and hides drift | `src/transport.ts` |
| Queries are checked by the server's own query schema before sending | a request the server would refuse is refused with the same class and `details.field`, and no request is sent | `src/client.ts` |
| An error class per contract error code | a code without a class is a compile error (`ERROR_CLASS_BY_CODE`) | `src/transport.ts` |
| `NotFound`/`Gone` only from a Mercaria error body | a proxy 404 proves nothing; consumers may act on "gone" | `src/transport.ts` |
| Detail reads send no query parameters; `inStock=false` is never sent | the server refuses unknown detail params; `false` filters nothing, and one page must have one URL | `src/client.ts` |
| A location carries no place fact; `goWayPlaceId` is how a consumer reads them | the place is GoWay's (ADR 0013); a copy here would be a second answer to "when does this shop open" | the contract's `locations.ts` |
| `service_unavailable` on a location read is `MercariaUnavailableError`, never gone | Mercaria could not ask GoWay; a consumer must not drop a good ref for an outage | `src/transport.ts` |
| Token getter called per request, never cached | Oxy owns the session and its refresh | `src/transport.ts` |
| No service-to-service auth option | none exists yet; the SDK must not fake one | README |
| Locale is the only context dimension | public reads serve native currency and convert nothing | README |
| No retries | retryability is exposed; policy belongs to the caller | `src/errors.ts` |
| `instanceof` answers from a `Symbol.for` brand | the ESM and CJS builds are two class identities in one process | `src/errors.ts` |
| `src/` compiles with no DOM lib and no Node types | one entry must run everywhere | `tsconfig.json` |
| The `.d.ts` asks only what `zod`'s does: a `URL` global (DOM or `@types/node`) | zod's declarations name `URL`; the smoke test type-checks a Node and a browser consumer with `skipLibCheck` off | `scripts/smoke.mjs` |

## Semver and release policy

The package follows semantic versioning with the **0.x rule**:

- a **patch** release (`0.1.x`) never changes the API or the contract in a way a
  consumer can observe — bug fixes, docs, internal refactors;
- a **minor** release (`0.x.0`) may break: removed or renamed exports, a
  narrowed input, a DTO field removed or retyped, a new required field;
- `1.0.0` is planned for once Mention #951 has shipped on it and the surface
  has held; until then every consumer pins a minor (`~0.2.0`).

Additive changes (a new method, a new optional DTO field the parser accepts)
are minors too while on 0.x, because a new field is only reachable after the
parser learns it.

### Closed value sets are a compatibility hazard

The parser **rejects** a value outside a closed set — a currency, a condition
key, an availability. So **widening one** is breaking for every SDK version
already installed: the day the backend emits a new currency, older SDKs fail
every response that carries it. Widening is therefore released SDK-first:

1. add the value to the shared-types tuple (the contract's schema, and so the
   SDK's bundled copy, picks it up),
2. release the SDK and let consumers upgrade,
3. only then let the public projection emit it.

A server change that would emit a new value before that is a contract break,
and the contract test ([below](#the-contract-test-against-the-real-backend))
is where it must be caught.

### How a contract change flows

1. **`packages/contracts`** — change the schema, value set, error code or
   route registry entry. This is the only place any of it is defined; the SDK
   parses with it unchanged. Then `bun run openapi:generate` and commit
   `packages/contracts/openapi.json` (`validate:openapi` fails otherwise).
2. **Backend public projection** — build the new field explicitly, route tests
   included; a new route is a handler keyed by its `operationId` in the
   controller, or the backend does not compile.
3. **SDK surface and docs** — client methods, error classes for a new code,
   README, and the consumer example if it changes how an integration works;
   tests for the valid shape, the malformed shapes and extra-key stripping
   (`test/parse.test.ts`).
4. **`packages/sdk/CHANGELOG.md`** — an entry under the new version.
5. **Version bump** in `packages/sdk/package.json` per the rules above.
6. **Merge to `main`** — `publish-sdk.yml` publishes it (next section).

Steps 1–5 land in ONE pull request, so a published SDK never describes a
contract the backend at that commit does not serve.

## How publishing is gated

`.github/workflows/publish-sdk.yml` runs on a push to `main` touching
`packages/sdk/**`, `packages/contracts/src/**` or the workflow itself, and on
`workflow_dispatch`.

1. **`gate`** — `.github/scripts/require-ci-success.mjs`, exactly as every
   deploy uses it ([deploy.md](deploy.md) §"What gates a deploy"): the whole of
   `ci.yml` must have passed for this commit. `ci.yml`'s `Lint & Test` job lints,
   typechecks, tests, builds and smoke-tests the SDK, so the publish workflow
   runs no copy of the suite (#518).
2. **`publish`** — installs, builds, and runs `scripts/smoke.mjs --out`, which
   packs the tarball from a staging directory (a manifest whose only dependency
   is `zod`, no scripts and no `workspace:`), tests the installed tarball from
   Node ESM and CJS, Bun, a browser bundle, a React Native bundle and a
   `nodenext` type-check as a Node and as a browser consumer, fails if any
   shipped file names `@mercaria/`, and keeps that exact tarball.
3. The version is checked against the registry. **Already published → the job
   succeeds and publishes nothing**, so re-runs and doc-only changes are safe.
   A registry error other than 404 stops the job rather than being read as
   "not published".
4. `npm publish ./<tested tarball> --provenance --access public`, with
   `id-token: write`. The `./` is load-bearing: npm reads a bare
   `sdk-release/x.tgz` as the GitHub shorthand `owner/repo` (#1021).

The concurrency group never cancels an in-flight publish.

### Authentication

**0.1.0 was published by hand** (2026-09-13), from the exact tarball
`smoke.mjs --out` produced at `main` `5547181e` — the way the other Oxy SDKs
are released. The workflow could not: the org-wide `NPM_TOKEN` has no write
access to the `@mercaria.co` scope, and the registry answers that with
`404 PUT`, not `403` — the same 404 a missing scope gives, so read it as "no
permission" first.

For the workflow to publish, `NPM_TOKEN` needs write access to `@mercaria.co`.
Until then a release is a manual `npm publish ./<tarball> --access public` of
the tarball `bun run smoke:sdk -- --out <dir>` keeps. npm now warns that tokens
which bypass 2FA are being restricted for direct publishing; if that lands,
this section is where the replacement gets written down.

`prepublishOnly` (typecheck, test, build, smoke) guards a manual
`npm publish` from `packages/sdk`, but that path publishes the unstaged
manifest; the workflow is the supported release path.

## The contract test against the real backend

`packages/backend/src/routes/__tests__/public-api-sdk-contract.realdb.test.ts`
boots the real `createApp()` over the real test database and reads every public
route EXCLUSIVELY through `createMercariaClient` — the SDK's serialiser,
transport, error mapping and parser, from source. It runs in the API test job,
so route or DTO drift between the backend and the SDK fails `ci.yml`. It proves:

- every result parses and its key set EQUALS the contract's, recursively, and no
  seeded private value (SKU, barcode, connector id, tags, a non-active manual
  member id, …) appears in any result;
- cursor pagination (`iterateMercariaPages` and a hand loop) walks every page
  with no duplicate and no gap;
- `MercariaNotFoundError`, `MercariaGoneError`, a sold product (a successful
  read with `availability: 'sold'`) and `MercariaNetworkError` for a base URL
  nothing listens on are distinguishable, a route the server does not serve
  is a `MercariaUnknownRouteError` (`unknown_route`), never `NotFound`, and a
  cursor from another list is a `MercariaBadRequestError` naming `cursor`;
- `getAccessToken` is forwarded as `Authorization: Bearer`, making
  `viewer.saved` true for the user who saved the product and `viewer` null
  anonymously;
- `links.product`, `links.store`, `links.collection` and `links.location`
  rebuild exactly the `url` the server serves;
- the location reads, against a fake GoWay behind the GoWay SDK's own `fetch`
  seam (`services/goway/__tests__/fake-goway.ts`): a place's location listed,
  read by id and by ref to the same value, a store's locations and a location's
  products walked with `iterateMercariaPages`, bounded availability and an exact
  count only where disclosed, and never-published, gone and GoWay-unreachable
  told apart (`MercariaNotFoundError`, `MercariaGoneError`,
  `MercariaUnavailableError`).

The SDK resolves from `packages/sdk/src/index.ts` through the backend's
`tsconfig.json` `paths` (which `vitest.config.ts` reads as its alias), not from
`dist/`. The consequence for SDK authors: `src/` must also type-check inside the
backend's `strict: false` program — where `z.infer` makes EVERY key optional — so
a type the SDK spells by hand must be derived from the contract's (`Pick<…>`,
`MercariaPage<T>`) rather than restate a required key. It shares its fixture world and key-set table
with the wire suite, `public-api.realdb.test.ts`, through
`routes/__tests__/public-api-fixtures.ts`.

## Local commands

```bash
bun run build:sdk                                 # shared-types + contracts + SDK dist
bun run smoke:sdk                                 # build + pack + runtime smoke
bun run --filter @mercaria.co/sdk test            # vitest, no network
bun run --filter @mercaria.co/sdk typecheck
bun run --filter @mercaria.co/sdk lint
# the contract test (Postgres up; see docs/postgres-testing-and-migrations.md)
bun run --cwd packages/backend test -- src/routes/__tests__/public-api-sdk-contract.realdb.test.ts
```

## Not yet done

- **Authenticated buyer surfaces** (#1017 phase 2) and **seller integrations**
  (phase 3) — each needs an explicit contract and permission review first.
- **Service-to-service authority** — waits on an Oxy service-auth contract for
  the public routes.
