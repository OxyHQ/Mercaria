# Mercaria and Moovo logistics (#156)

> The dated survey with citations is
> `docs/moovo/2026-08-16-moovo-service-client-survey.md`. It describes a client
> that has since been DELETED; read it as history.

**There is no Moovo logistics client in this repository, and nothing is
registered on any deployment.** #126 published `MoovoLogisticsPort`
(`services/retail-fulfilment/moovo.port.ts`) as a fail-closed seam, and the port
is what remains: its default refuses every call, `isMoovoBookingAvailable()` is
`false`, and `chooseFulfilmentMode` falls back to Mode B — a supplier booking its
own carrier, which #126 calls a complete fulfilment path.

The scaffolding that once stood beside the port — `services/moovo/` (a client,
an outcome classifier, a transport contract, an unregistered transport and a
registration step) and its `config.moovo` block with the `MOOVO_ENABLED`,
`MOOVO_BASE_URL`, `MOOVO_RESOURCE_APPLICATION_ID`, `MOOVO_ENVIRONMENT`,
`MOOVO_SCOPES`, `MOOVO_TIMEOUT_MS`, `MOOVO_MAX_ATTEMPTS` and `MOOVO_RETRY_*`
variables — was removed because no transport ever existed for it to drive: it
was code that ran on no deployment and could not be exercised. Moovo owns
logistics entirely, and its service API (`OxyHQ/Moovo#27`/`#28`) does not exist
yet.

`MOOVO_API_URL` is unrelated and stays: it is where the donated-materials
transport link (`services/materials/transport.service.ts`) reads a transport
AS the person, through `moovoForOxy(oxyClient.withUser(…))`.

## When Moovo's service API exists

Build the client against it then, and keep these rules — each was learned the
hard way and is recorded in the survey:

- **One Oxy client.** Mercaria reaches Moovo as its own workload through
  `oxyClient.createServiceClient({ baseURL, audience: 'oxy-service:<moovoAppId>' })`
  or Moovo's own `*ForOxyService(oxy)` SDK — never a second `OxyServer`, a
  token cache, or a credential variable.
- **Never forward a buyer's bearer** to book on their behalf; that is
  impersonation (#156 acceptance 3).
- **Register the port only when a transport exists.** A port that refuses every
  call would make Mode A the CHOSEN mode and strand paid orders that would
  otherwise fall back to Mode B; the fail-closed state is no port at all.
- **Ambiguity outranks the failure class.** A 500 on a booking may have booked a
  parcel; retrying it can turn one order into two. Reconcile, never retry, a
  write whose outcome is unknown.
- **A provider's free text is unrepresentable.** Keep a status and a redacted
  code, never a message — a street and a person are ordinary letters, and no
  character scrubber removes them.
- **The idempotency key derives from #126's `sourceReference`** and is never
  logged.

Seams: **`OxyHQ/Moovo#27`/`#28`** (the principal and the API), **#157** (the
aggregate and projection), **#158** (the event inbox), **#159** (quotes,
bookings, labels, return transport).
