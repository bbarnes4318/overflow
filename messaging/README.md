# Overflow Calls Messaging

SMS gateway and conversation dashboard for Overflow Calls. Node/Express with a
SQLite store, a per-DID paced send queue, and optional LLM message variation.

## Setup

```bash
npm ci
cp .env.example .env   # then fill in the blanks
npm start
```

The server listens on `PORT` (default `3100`) and creates `database.sqlite` on
first run. Visit `/login`; the first visit prompts you to create the
administrator account.

## Configuration

All values in `.env.example` ship blank. `BULKVS_USERNAME`, `BULKVS_TOKEN` and
`SENDER_NUMBER` seed the `settings` table on first run only — after that the
values stored in `settings` win, and are edited from Gateway Settings in the UI.
`ANTHROPIC_API_KEY` is optional; message variation stays off until it is
enabled in Gateway Settings.

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
| `content_lint.js` | Outbound content checks |
| `timezones.js` | Area-code to timezone mapping |
| `public/` | Dashboard and login front end |
