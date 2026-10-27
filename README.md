# VDX Core

VDX Core is a platform that receives data from field devices, stores it, processes it, raises
alerts and shows it to customers in a multi-tenant web console.

- **Engine** (`lib/engine/`): generic objects, metrics, events, rules and alerts; ingest with
  idempotency, a raw copy of every message, rollups and health checks.
- **Modules** (`lib/packages/`): domain knowledge on top of the engine — `lora` (greenhouse climate
  nodes), `agronomy`, `records`, plus customer-defined `custom` types.
- **Consoles** (`app/`): Terra (field operations), Research (data pipelines) and the admin area.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full walkthrough.

## Stack

Next.js 16 (App Router) · React 19 · Supabase (auth, Postgres with RLS) · Cloudflare R2 (raw
archive, S3 API) · Resend (email, optional) · Web Push · Vitest.

## Getting started

Requirements: Node 24+, Docker (for the local Supabase stack).

```bash
npm install
npx supabase start            # local Postgres + auth on 127.0.0.1:54321/54322
cp .env.example .env.local    # fill in the values printed by `supabase start`
npm run dev                   # http://localhost:3000
```

Every variable is documented in [.env.example](.env.example). R2, Resend, VAPID and firmware keys
are optional for local development.

Migrations live in `supabase/migrations-pushed/` (already applied in production, never edit) and
`supabase/migrations/` (pending). Apply them with `npx supabase db reset` locally.

## Scripts

| Command | What it does |
|---|---|
| `npm test` | Unit and database tests (Vitest) |
| `npm run lint` | ESLint |
| `npx tsx scripts/create-source.ts` | Create an ingest source and its token |
| `npx tsx scripts/simulate-lora.ts` | Push simulated LoRa node data |
| `npx tsx scripts/flush-raw.ts` | Archive `raw_inbox` to R2 |
| `npx tsx scripts/health.ts` | Run the health checks |
| `npx tsx scripts/sign-firmware.ts` | Generate keys / sign OTA firmware |

A Python client for pushing data lives in [`clients/python`](clients/python).

## Deploy

The reference deployment runs on Vercel (`vercel.json`, region `fra1`) with Supabase and R2.
Hourly maintenance runs through `GET /api/cron/engine` (`Authorization: Bearer $CRON_SECRET`)
called by any external scheduler; `/api/health` returns 503 when health is stale, for uptime
monitors.

Note: the `xlsx` dependency is installed from the SheetJS CDN, not the npm registry.

## Contributing & security

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately as described in
[SECURITY.md](SECURITY.md).

## License

[AGPL-3.0](LICENSE) © VDX Technologies
