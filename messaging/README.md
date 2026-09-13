# NetEnroll Messaging

SMS gateway and conversation dashboard for NetEnroll. Node/Express with a
SQLite store, a per-DID paced send queue, and optional LLM message variation.

## Setup

```bash
npm ci
cp .env.example .env   # then fill in the blanks
npm start
```

The server listens on `PORT` (default `3100`) and creates `database.sqlite` on
first run. On that first start it seeds a platform **superadmin** and prints the
generated password once to the log (set `SUPERADMIN_PASSWORD` to choose your
own). Sign in at `/login` as that user — there is no self-service signup.

## Multi-tenancy

The app is multi-tenant. A **tenant** is one agency: its own contacts,
conversations, messages, notes, users and phone numbers. Nothing is shared
between tenants except the carrier account and the global do-not-contact list.

**Number ownership is the routing key.** `tenant_dids` maps each DID to exactly
one tenant, enforced by its primary key. That single fact drives everything
else: an inbound reply is routed by the number it was sent to, the per-DID pacer
becomes a per-tenant pacer for free, and no number can ever send or receive on
behalf of two tenants.

Getting started as superadmin:

```bash
# 1. create a tenant
curl -X POST localhost:3100/api/tenants -d '{"name":"Acme Insurance"}'
# 2. give it a number
curl -X POST localhost:3100/api/tenants/1/dids -d '{"did":"5555550100"}'
# 3. create its first user
curl -X POST localhost:3100/api/tenants/1/users   -d '{"username":"alice","password":"...","role":"owner"}'
```

Roles are `superadmin` (no tenant, may act as any, switches with
`POST /api/tenants/switch`), `owner` and `agent` (pinned to their own tenant).

Every database function that touches tenant-owned data takes `tenant_id` as a
required first argument and throws without one — it is never defaulted or
inferred. A by-id request for another tenant's row returns **404**, never 403,
so ids cannot be enumerated. `tests/integration/isolation.test.js` is the
acceptance suite for all of this; `tests/unit/tenant_scoping.test.js` statically
guards every prepared statement against a missing scope.

## Configuration

All values in `.env.example` ship blank.

Carrier credentials (`BULKVS_*`, `fractel_*`) and `ANTHROPIC_API_KEY` are
**global** — one carrier account serves the whole platform, and only a
superadmin can change them. Pacing overrides, keyword lists and sender defaults
are **per tenant**, stored in `tenant_settings`, and fall back to the global
default when a tenant has no row for a key.

`BULKVS_USERNAME`, `BULKVS_TOKEN` and `SENDER_NUMBER` seed the `settings` table
on first run only — after that the stored values win, and are edited from
Gateway Settings in the UI. Message variation stays off until it is enabled
there.

`RECRUITING_INQUIRY_EMAIL` and the `SMTP_*` values serve the public form on
netenroll.com/aca-agent-recruiting, which nginx proxies to
`POST /api/recruiting-inquiry` here. Every inquiry is stored in
`recruiting_inquiries` before the email is attempted, so a mail outage never
loses one; with no address set they are stored and not sent.

## Tests

```bash
npm test
```

`npm run test:unit` and `npm run test:integration` run the suites separately.
`npm run lint` syntax-checks the entry points; `npm run check` does both.
End-to-end Playwright specs run with `npm run test:e2e` against a live server.

## Layout

| Path | Purpose |
| --- | --- |
| `server.js` | HTTP API, auth, static hosting, webhooks |
| `database.js` | Schema, migrations, queries |
| `queue.js` | Outbound send worker |
| `pacing.js` | Per-DID rate limiting and warmup |
| `variation.js` | LLM message variation |
| `tenant_dids` | The source of truth for which tenant owns which number |
| `content_lint.js` | Outbound content checks |
| `timezones.js` | Area-code to timezone mapping |
| `public/` | Dashboard and login front end |
