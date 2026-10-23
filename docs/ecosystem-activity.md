# Ecosystem activity

The backend publishes aggregate traffic and its infrastructure heartbeat to the
Oxy API, which broadcasts changes to the website dashboard. Collection runs in
the service process regardless of whether somebody opens the dashboard.

Enable with `OXY_ECOSYSTEM_ACTIVITY_ENABLED=true`, `AWS_REGION`, and an Oxy
identity. On ECS that is the task role: `oxy-mercaria-task` is bound to the
Mercaria application with an administratively bound environment (Oxy ADR 0049).
The shared publisher attests it; customer key pairs do not select own authority.
Local development needs a registered workload identity to publish.
An invalid activation value or missing required configuration fails at boot.
Disabled collection emits a warning; it must not be interpreted as zero traffic.

HTTP middleware is mounted before body parsers and routers, including public
routes, webhooks, failures and authenticated internal calls. Outgoing fetch and
Node HTTP requests are observed by the shared SDK, including requests made by
background workers. Socket.IO message sends and receives are observed where
this service exposes Socket.IO. Internal/external scope is independent of
inbound/outbound direction; media is a separate activity category.

Only bounded aggregate fields leave the service. No bodies, message contents,
user identifiers, tokens or IP addresses are added to activity events. Visitor
origins represent the Cloudflare edge PoP, not an IP-derived country. Infrastructure
location follows `AWS_REGION`; registration and graceful removal update the
shared inventory, and crashed instances expire through the API registry.

The publisher does not observe database wire traffic, raw TCP, HTTP/2, WebRTC,
or a separate process that has not installed the collector. These transports
must not be represented by fabricated lines.

## Cloudflare web traffic

The storefront, dashboard and POS Workers run no activity code and hold no Oxy
activity secret. Oxy measures their web traffic keylessly from Cloudflare's own
analytics (see OxyHQ/oxy `docs/operations/cloudflare-web-activity.md`). The
`OXY_EDGE_ACTIVITY_*` bindings were never provisioned and nothing reads them; if
one is ever found on a deployment, delete it.
