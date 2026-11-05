# Deployment Guide

## Deployment topology

Deploy frontend and API as separate web services if required by hosting platform; run worker as a separate process from the same backend image. Use managed PostgreSQL. Keep API, worker and database in the same region where possible. Configure health and readiness endpoints.

## Release sequence

1. Provision PostgreSQL and secrets.
2. Deploy backend image.
3. Run migrations as a one-off release command.
4. Start API and worker.
5. Deploy frontend with public API base URL.
6. Configure PayPal Sandbox webhook URL and verify webhook ID.
7. Configure allowed origins, TLS and rate limits.
8. Run health/readiness, tenant isolation and smoke tests.
9. Run replay demo.
10. Run live LLM and PayPal Sandbox tests only when credentials and test account are available.

## Operational requirements

- TLS everywhere outside local development.
- Secrets via host secret manager.
- Database backups and tested restore before production.
- Restrict database network access.
- Apply migration before application rollout.
- Monitor dead jobs and webhook processing lag.
- Roll back application code without deleting append-only financial records.
- Never reset a database containing real transaction evidence.

## Production disclaimer

The hackathon deployment is a demonstration environment. Before production use, obtain jurisdiction-specific legal, tax, accounting, privacy, security and payment-provider review; add operational controls, incident response, backups, monitoring, data retention and provider payout implementation if required.
