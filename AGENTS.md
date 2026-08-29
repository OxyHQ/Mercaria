# Mercaria

Mercaria is Oxy's buy/sell marketplace: users buy and sell new items (from shops)
and secondhand items (from people), eBay or Wallapop style. It is also a
comparison surface — one canonical product page carrying every seller's offer,
native and external — and, for a bounded set of goods, a retailer itself,
selling at cost with no markup. The backend is a Shopify-grade commerce platform
serving three Expo apps (storefront, dashboard, POS) and a shared UI package.

> Org-wide engineering standards (package manager, TypeScript, React, naming,
> error handling, security, testing, git and PR conventions) live in
> <https://github.com/OxyHQ/engineering>. This file carries only what is true of
> Mercaria specifically. Versions are in `package.json`, never here.

## Documentation

**Everything else is in [`docs/`](docs/) — read it before touching a domain.**
[`docs/README.md`](docs/README.md) is the index: one file per domain, plus the
ADRs that bind them. Start with `docs/architecture.md` (monorepo, backend domain
model), `docs/postgres.md` (schema, migrations, the realdb harness) and
`docs/deploy.md`.

The schema ledger is `packages/backend/src/db/schema/CONVENTIONS.md` — binding,
and read it before touching the schema. Deferred work is `HANDOFF.md`.
