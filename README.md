# Switchboard

A shared team inbox for the simulated Pigeon messaging provider. The app includes OIDC login with PKCE, workspace-scoped conversations, inbound webhook verification and deduplication, a durable reply outbox, conversation claims, private workspace notes, and live WebSocket updates with replay.

## Requirements

- Node.js 22+
- Docker Desktop with Docker Compose
- Ports `27017`, `6379`, `4010`, `4020`, `4030`, `4000`, and `5173` available

MongoDB and Redis are real services. Pigeon, the mock identity provider, and Paybox are simulators.

## Setup

From the repository root:

```bash
cp .env.example .env
npm run up
npm run doctor
npm run scaffold:install
```

The defaults in `.env.example` match the local services. `.env` is optional; do not commit it.

Start the server and web app in separate terminals:

```bash
npm run scaffold:server
```

```bash
npm run scaffold:web
```

Open <http://localhost:5173>. Choose a test user on the mock identity-provider page:

- `u_asha` — admin in `ws_acme`
- `u_ben` — agent in `ws_acme`
- `u_chloe` — admin in `ws_globex`
- `u_dev` — agent in `ws_globex`
- `u_eli` — agent in both workspaces

The frontend proxies API and WebSocket traffic to the server on port 4000. The server reads its port and all service URLs/secrets from environment variables.

## Useful development commands

```bash
npm run inbound       # simulate one inbound customer message
npm run quiet         # stop Pigeon's automatic trickle
npm run drizzle       # resume the trickle
npm run chaos         # run Pigeon's chaos traffic profile
npm run report        # inspect Pigeon's report
npm run doctor        # check local services
```

If Docker is unavailable, `npm run mocks` starts the three simulators with plain Node. You must still provide your own MongoDB and Redis and set `MONGO_URL` and `REDIS_URL` accordingly.

## Checks

Stop the manually started server before running the harness. The harness starts one or more server instances itself and clears application data.

```bash
npm run check
npm run check:full
npm run check -- --levels 5
```

`npm run check:full` writes `CHECK_REPORT.json`. The check requires MongoDB, Redis, Pigeon, and the mock IdP to be running.

## Main routes

- `GET /auth/login`, `GET /auth/callback`
- `GET /api/me`
- `GET /api/conversations?workspace=<workspace-id>`
- `GET /api/conversations/:contact/messages?workspace=<workspace-id>`
- `POST /api/reply`
- `POST /api/conversations/:contact/claim`
- `POST /api/conversations/:contact/close`
- `POST /api/conversations/:contact/reopen`
- `GET/POST /api/conversations/:contact/notes`
- `POST /webhooks/pigeon`
- `GET /ws?workspace=<workspace-id>&after=<sequence>`
- Grader routes documented in `BRIEF.md`

## Scope

The optional Paybox billing track, Elasticsearch search, and end-to-end encrypted notes were not implemented. The app's private notes are restricted to authenticated members of their workspace but are stored as ordinary application data, not end-to-end encrypted.
