# Auth and the identity surfaces

Moved from the root `AGENTS.md`. Applies to middleware, `/internal/*` desks, store access and CORS.

- **One `OxyServer` (`oxyClient`); a person's calls use `oxyClient.withUser`.** No
  local service principal or verifier: Oxy's shared middleware with the canonical audience; public reads use the optional receiver
  (`docs/first-party-authority.md`), never a synthetic user. Provider webhooks
  verify their own signatures; never add unmounted auth primitives.
- **Every `/internal/*` desk is an Oxy app role** (`middleware/operator-authz.ts`)
  held by `oxy` org owners/admins via oxy's registry (oxy ADR 0056): always mounted,
  404 to non-holders, no env id lists or grants. A new surface joins the key whose
  power it shares (`docs/house-invariants.md`).
- **A store is owned by an Oxy account; Oxy decides who gets in** (ADR 0012). No
  member list: `oxyClient.accountAccessFor` (THEIR session, fail closed, fresh on
  writes) → `STORE_ROLE_PERMISSIONS` ± overrides.
  `admin` lacks only `store:manage`, which gates fee and identity routes.
- **Buyer, seller and `oxy_user_id` ids are Oxy's keys** and carry no foreign key.
- **CORS:** `packages/backend/src/lib/allowed-origins.ts` is the ONE origin authority
  (CORS and the bounded referral-cookie migration gate) and must carry `mercaria.co`, `dashboard.mercaria.co`
  and `pos.mercaria.co`. The central Oxy API's `allowedOrigins.ts` must carry
  `https://mercaria.co` and `/^https:\/\/[a-z0-9-]+\.mercaria\.co$/`, or
  `auth/refresh-all` fails with CORS from every Mercaria app.
