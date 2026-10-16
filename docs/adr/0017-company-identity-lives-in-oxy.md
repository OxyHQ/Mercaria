# 0017 — Company identity lives in Oxy

Status: accepted implementation; deployment requires the organizations SDK/API release.

## Decision

Oxy owns the identity of a legal company or organization: account ID, current and
former names, logo, legal name, website, country, claim state and verified domains.
Mercaria reads those facts through `OxyServices.organizations`. There is no local
editable copy, name matching, fallback to archived names, or dual write.

Mercaria's `organizations` table retains a commerce reference ID, historical slug,
Oxy account ID, lifecycle and merge target. This preserves existing supplier and
commerce-relationship foreign keys and incoming URLs. Several historical references
can resolve to one Oxy company. Brands remain consumer marks; merchants,
storefronts and stores retain their separate commerce roles.

Public reads batch unique canonical IDs in groups of at most 100 across the whole
request. Missing and suppressed companies are withheld; directory failures return
an explicit service-unavailable error. A company rename becomes visible from Oxy.
Local graph merges require Oxy to resolve both references to the same account.
They do not authorize an identity merge in Oxy.

## Migration evidence

`organization_identity_archives` is immutable typed evidence from the frozen
source, never an identity read model. Its foreign key remains on the original
reference even after a graph merge. Historical aliases and source links retain
their provenance role; Oxy aliases drive public identity presentation.

The backfill groups only existing redirect chains or explicitly reviewed account
mappings. Equal company names are not evidence. Each legacy ID becomes an
idempotent `mercaria` external source key in Oxy. Remote imports complete before
the atomic local mapping transaction; retry after interruption reuses source keys.

Legacy verified domains remain in the archive. Their verification does not
transfer: Oxy requires its own DNS/well-known proof. Applying a plan containing
such domains requires explicit acknowledgment of re-verification. Nonactive source
companies require reviewed canonical mappings so import cannot publish them.
Existing mapped companies are never overwritten by import facts. Oxy validates
any imported logo as an active public image asset.

See [the cutover runbook](../central-organizations.md) for ordered deployment and
verification. Financial snapshots and immutable money history are unaffected.
