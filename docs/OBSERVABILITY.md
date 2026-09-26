# Observability

tdoc does not run client-side usage telemetry and never asks for analytics
consent during skill onboarding. The former Supabase sender and its persistent
installation/session identifiers were removed after that backend was retired.

Hosted operations are observed where they actually happen: the tdoc.dev
Cloudflare Worker. Workers Logs is enabled for production and PR previews,
and the Worker emits a small structured onboarding funnel to both logs and a
Workers Analytics Engine dataset:

| Event | Meaning |
|---|---|
| `onboarding_started` | the CLI successfully created a pairing flow |
| `onboarding_approved` | the signed-in user approved that CLI |
| `token_minted` | the provider issued an account-scoped publish token |
| `publish_succeeded` | a hosted upload committed successfully |

These product events contain only the event name and bounded operational
dimensions such as auth path, first-publish boolean, and validated client
version. They deliberately exclude document content, prompts, slug, account,
login, email, IP, cookies, tokens, session IDs, and installation IDs. Normal
provider request logs remain subject to the hosting provider’s logging and
retention controls.

The production dataset is `tdoc_product_events` (previews use a separate
`tdoc_preview_product_events` dataset). Its ordered columns are `blob1` event,
`blob2` auth path, `blob3` client version, `double1` count, and `double2`
first-publish count. For example, this Analytics Engine SQL query gives the
last seven days of aggregate funnel counts:

```sql
SELECT blob1 AS event, SUM(_sample_interval * double1) AS events
FROM tdoc_product_events
WHERE timestamp > NOW() - INTERVAL '7' DAY
GROUP BY event
ORDER BY events DESC
```

This supports a Cloudflare/Grafana dashboard without manufacturing a GA4
`client_id` or adding an analytics prompt to CLI onboarding. Public-site
traffic and acquisition analytics are a separate concern and may use a web
analytics tag without joining browser identity to these provider counters.

BYOK deployments receive the same Worker logging configuration in their own
Cloudflare account. Purely local skill operations are not tracked.
