# `@mercaria.co/sdk` — the public integration boundary (#1017)

`packages/sdk` publishes `@mercaria.co/sdk`: the one supported way for another
Oxy application (Mention first, via OxyHQ/Mention#951, then Goway, Nilo,
assistants and services) to read Mercaria commerce data. The consumer-facing
guide is [`packages/sdk/README.md`](../packages/sdk/README.md); this file is for
people changing the SDK or the contract behind it.

## What it is, and what it is not

- **It is** a headless TypeScript client over the public read API mounted at
  `/public/v1`: products, search, stores, collections, canonical links,
  portable refs and typed errors. It runs on Node 18+, Bun, browsers and React
  Native from one entry, and has **no runtime dependencies**.
- **It is not** a UI kit, a checkout, an admin or operator client, a supplier or
  procurement client (#1016), or a second definition of Mercaria's types.

The **contract** is `packages/shared-types/src/public-api.ts`. It is the single
definition of every ref, DTO, closed value set and error code. The backend's
public projection builds those shapes field by field; the SDK parses them field
by field again. Neither side spreads a storefront DTO, so a field added to
`Listing` reaches no foreign application unless somebody adds it to the
contract on purpose.

`@mercaria/shared-types` is private and never published, so the SDK keeps it as
a devDependency and **bundles** what it uses — values into the JavaScript,
declarations into the `.d.ts` — and re-exports the contract types. Consumers
import only `@mercaria.co/sdk`.

## Decisions a change must keep

| Decision | Why | Where |
| --- | --- | --- |
| Refs carry identity only (no title, price, handle) | a persisted ref must not snapshot mutable truth | `public-api.ts`, `src/refs.ts` |
| Parsers build fresh objects with contract keys only | a server leak cannot reach a DTO | `src/parse.ts` |
| Unknown enum values are `MALFORMED_RESPONSE` | the SDK never guesses a fact a consumer renders | `src/parse.ts` |
| One malformed row fails the whole page | dropping rows breaks pagination and hides drift | `src/parse.ts` |
| `NotFound`/`Gone` only from a Mercaria error body | a proxy 404 proves nothing; consumers may act on "gone" | `src/transport.ts` |
| Detail reads send no query parameters; `inStock=false` is never sent | the server 400s unknown detail params; `false` filters nothing, and one page must have one URL | `src/client.ts` |
| Token getter called per request, never cached | Oxy owns the session and its refresh | `src/transport.ts` |
| No service-to-service auth option | none exists yet; the SDK must not fake one | README |
| Locale is the only context dimension | public reads serve native currency and convert nothing | README |
| No retries | retryability is exposed; policy belongs to the caller | `src/errors.ts` |
| `instanceof` answers from a `Symbol.for` brand | the ESM and CJS builds are two class identities in one process | `src/errors.ts` |
| `src/` compiles with no DOM lib and no Node types | one entry must run everywhere, and its `.d.ts` must not demand a lib | `tsconfig.json` |

## Semver and release policy

The package follows semantic versioning with the **0.x rule**:

- a **patch** release (`0.1.x`) never changes the API or the contract in a way a
  consumer can observe — bug fixes, docs, internal refactors;
- a **minor** release (`0.x.0`) may break: removed or renamed exports, a
  narrowed input, a DTO field removed or retyped, a new required field;
- `1.0.0` is planned for once Mention #951 has shipped on it and the surface
  has held; until then every consumer pins a minor (`~0.1.0`).

Additive changes (a new method, a new optional DTO field the parser accepts)
are minors too while on 0.x, because a new field is only reachable after the
parser learns it.

### Closed value sets are a compatibility hazard

The parser **rejects** a value outside a closed set — a currency, a condition
key, an availability. So **widening one** is breaking for every SDK version
already installed: the day the backend emits a new currency, older SDKs fail
every response that carries it. Widening is therefore released SDK-first:

1. add the value to the shared-types tuple (the SDK's bundled copy picks it up),
2. release the SDK and let consumers upgrade,
3. only then let the public projection emit it.

A server change that would emit a new value before that is a contract break,
and the contract test (below) is where it must be caught.

### How a contract change flows

1. **`packages/shared-types/src/public-api.ts`** — change the shape, value set
   or error code. This is the only place it is defined.
2. **Backend public projection** — build the new field explicitly, route tests
   included.
3. **SDK parser** (`packages/sdk/src/parse.ts`) — read and validate the field;
   tests for the valid shape, the malformed shapes and extra-key stripping.
4. **SDK surface and docs** — client methods, README, and the consumer
   example if it changes how an integration works.
5. **`packages/sdk/CHANGELOG.md`** — an entry under the new version.
6. **Version bump** in `packages/sdk/package.json` per the rules above.
7. **Merge to `main`** — `publish-sdk.yml` publishes it (next section).

Steps 1–6 land in ONE pull request, so a published SDK never describes a
contract the backend at that commit does not serve.

## How publishing is gated

`.github/workflows/publish-sdk.yml` runs on a push to `main` touching
`packages/sdk/**`, `public-api.ts` or the workflow itself, and on
`workflow_dispatch`.

1. **`gate`** — `.github/scripts/require-ci-success.mjs`, exactly as every
   deploy uses it ([deploy.md](deploy.md) §"What gates a deploy"): the whole of
   `ci.yml` must have passed for this commit. `ci.yml`'s `Lint & Test` job lints,
   typechecks, tests, builds and smoke-tests the SDK, so the publish workflow
   runs no copy of the suite (#518).
2. **`publish`** — installs, builds, and runs `scripts/smoke.mjs --out`, which
   packs the tarball from a staging directory (a manifest with no dependencies,
   no scripts and no `workspace:`), tests the installed tarball from Node ESM
   and CJS, Bun, a browser bundle, a React Native bundle and a no-DOM
   `nodenext` type-check, fails if any shipped file names `@mercaria/`, and
   keeps that exact tarball.
3. The version is checked against the registry. **Already published → the job
   succeeds and publishes nothing**, so re-runs and doc-only changes are safe.
   A registry error other than 404 stops the job rather than being read as
   "not published".
4. `npm publish <tested tarball> --provenance --access public`, authenticated by
   the org-wide `NPM_TOKEN` secret, with `id-token: write` for provenance.

The concurrency group never cancels an in-flight publish.

`prepublishOnly` (typecheck, test, build, smoke) guards a manual
`npm publish` from `packages/sdk`, but that path publishes the unstaged
manifest; the workflow is the supported release path.

## Local commands

```bash
bun run build:sdk                                 # shared-types + SDK dist
bun run smoke:sdk                                 # build + pack + runtime smoke
bun run --filter @mercaria.co/sdk test            # vitest, no network
bun run --filter @mercaria.co/sdk typecheck
bun run --filter @mercaria.co/sdk lint
```

## Not yet done

- **Contract test against the real backend** — runs the SDK against the public
  routes so DTO or route drift fails the build. Owned by the merge of #1017's
  backend and SDK halves.
- **Authenticated buyer surfaces** (#1017 phase 2) and **seller integrations**
  (phase 3) — each needs an explicit contract and permission review first.
- **Service-to-service authority** — waits on an Oxy service-auth contract for
  the public routes.
