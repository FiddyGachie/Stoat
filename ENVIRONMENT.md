# Environment and Local Development

## Required services

- Node.js LTS compatible with repository toolchain.
- pnpm.
- Docker and Docker Compose.
- PostgreSQL (Compose service).
- LLM provider API credentials for live mode.
- PayPal Developer Sandbox REST app and buyer account for payment demo.

## Environment variables

```dotenv
NODE_ENV=development
APP_BASE_URL=http://localhost:3000
API_BASE_URL=http://localhost:4000
DATABASE_URL=postgresql://stoat:stoat@localhost:5432/stoat
JWT_ISSUER=stoat-local
JWT_AUDIENCE=stoat-api
JWT_PRIVATE_KEY=
PAYPAL_CLIENT_ID=
PAYPAL_CLIENT_SECRET=
PAYPAL_BASE_URL=https://api-m.sandbox.paypal.com
PAYPAL_WEBHOOK_ID=
PAYPAL_RETURN_URL=http://localhost:3000/paypal/return
PAYPAL_CANCEL_URL=http://localhost:3000/paypal/cancel
LLM_PROVIDER=anthropic
LLM_API_KEY=
LLM_MODEL_AGENT=
LLM_MODEL_FAST=
LLM_MODE=replay
AGENT_MAX_STEPS=12
AGENT_MAX_SECONDS=90
AGENT_MAX_COST_USD=0.25
DEMO_MODE=true
LOG_LEVEL=info
```

Do not commit actual values. `LLM_MODE` is `live`, `record` or `replay`. `REDIS_URL` is intentionally absent.

## Startup contract

The repository README must provide exact commands for:
1. install dependencies;
2. start PostgreSQL;
3. apply migrations;
4. seed clearly labelled demo fixtures;
5. start API and worker;
6. start frontend;
7. run unit/integration/contract tests;
8. run full replay demo;
9. run live LLM smoke test;
10. run PayPal Sandbox smoke test;
11. generate evidence.

The coding agent must verify the actual commands and update this file to match the repository scripts.
