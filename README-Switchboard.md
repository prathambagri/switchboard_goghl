# Switchboard

Switchboard is a shared team inbox for the simulated Pigeon messaging provider. Support agents sign in through the supplied OpenID Connect (OIDC) identity provider, work with conversations in their own workspace, reply to customers, and leave private internal notes.

## Features

- OIDC authorization-code login with PKCE.
- Workspace-scoped inbox and conversation access.
- Pigeon inbound webhook handling with signature/timestamp validation and event deduplication.
- Outbound replies queued through a durable outbox, using Pigeon's idempotency key.
- Reply status tracking (`queued`, `sent`, `delivered`, `failed`).
- Conversation claiming, closing, and reopening.
- Workspace-private internal notes.
- WebSocket updates with persisted workspace sequence numbers and reconnect replay.
- Redis-backed coordination for rate limiting and cross-instance event fan-out.

## Tech stack

- Frontend: React and Vite
- Backend: Node.js, Express, TypeScript
- Database: MongoDB
- Coordination and pub/sub: Redis
- Messaging simulator: Pigeon
- Authentication simulator: OpenID Connect mock IdP

## Requirements

- Node.js 22 or later
- npm
- Docker Desktop with Docker Compose (recommended)
- Ports `27017`, `6379`, `4010`, `4020`, `4030`, `4000`, and `5173` available

MongoDB and Redis are real services. Pigeon, the mock identity provider, and Paybox are supplied simulators. Elasticsearch is optional for the bonus/search track.

## Setup

Run these commands from the repository root (the directory containing the root `package.json`):

```bash
cp .env.example .env
npm run up
npm run doctor
npm run scaffold:install
```

On Windows PowerShell, use this instead of `cp` if needed:

```powershell
Copy-Item .env.example .env
```

The defaults in `.env.example` are intended for the supplied local services. Keep `.env` local and do not commit it.

### Start the application

Open two terminals in the repository root.

Terminal 1 — backend:

```bash
npm run scaffold:server
```

Terminal 2 — frontend:

```bash
npm run scaffold:web
```

Open <http://localhost:5173> in your browser. The Vite development server proxies `/api`, `/auth`, `/healthz`, and `/ws` to the backend on port `4000`.

## Test accounts

The mock identity provider has no passwords. Select a user on the IdP page:

| Name | User ID | Workspace access |
|---|---|---|
| Asha Rao | `u_asha` | `ws_acme` (admin) |
| Ben Ortiz | `u_ben` | `ws_acme` (agent) |
| Chloe Martin | `u_chloe` | `ws_globex` (admin) |
| Dev Patel | `u_dev` | `ws_globex` (agent) |
| Eli Novak | `u_eli` | `ws_acme` and `ws_globex` (agent) |

## Useful commands

```bash
npm run inbound       # ask Pigeon to send an inbound customer message
npm run quiet         # stop Pigeon's automatic message trickle
npm run drizzle       # resume the message trickle
npm run chaos         # run Pigeon's chaos traffic profile
npm run report        # inspect Pigeon's report
npm run doctor        # check service availability
```

If Docker is unavailable, `npm run mocks` starts the supplied simulators with plain Node. You still need MongoDB and Redis available and must set `MONGO_URL` and `REDIS_URL` to their connection URLs.

## Verification

Stop any manually started backend before running the automated harness. The harness starts the server itself and clears application data.

```bash
npm run check
npm run check:full
npm run check -- --levels 5
```

`npm run check:full` runs the locally available full check levels and writes `CHECK_REPORT.json`. Run it with Node 22 and the required services running. Commit the generated report from your final run. Do not claim a check passed unless the report confirms it.

## Main application endpoints

- `GET /healthz` — readiness check
- `GET /auth/login` and `GET /auth/callback` — OIDC login
- `GET /api/me` — current user and workspace memberships
- `GET /api/conversations?workspace=<workspace-id>` — workspace inbox
- `GET /api/conversations/:contact/messages?workspace=<workspace-id>` — conversation messages
- `POST /api/reply` — queue an outbound reply
- `POST /api/conversations/:contact/claim` — claim a conversation
- `POST /api/conversations/:contact/close` — close a conversation
- `POST /api/conversations/:contact/reopen` — reopen a conversation
- `GET /api/conversations/:contact/notes` and `POST /api/conversations/:contact/notes` — private workspace notes
- `POST /webhooks/pigeon` — Pigeon webhook receiver
- `GET /ws?workspace=<workspace-id>&after=<sequence>` — authenticated live event stream with replay

Grader-only endpoints and their contract are described in `BRIEF.md`.

## Scope and known limitations

The implementation prioritizes the core shared inbox and reliability path. The optional Paybox billing track and Elasticsearch search are not implemented. Internal notes are private to authenticated members of the relevant workspace, but they are **not end-to-end encrypted**. No `PROTOCOL.md` is included because encrypted notes were not attempted.

Before submission, run the checks on the target machine and update `DECISIONS.md` with the actual results and any remaining known issues. This README describes the intended setup and implemented scope; it is not a claim that the final automated checks have passed.

## ai-logs/

