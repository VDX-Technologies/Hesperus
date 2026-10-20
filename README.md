This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Weather warnings

Weather warnings come from **MeteoAlarm via MeteoGate**, which aggregates official national meteorological service warnings. The feed can be delayed by about 10 minutes. The admin geocodes a site's address with OpenStreetMap Nominatim; if coordinates are adjusted manually, the country is resolved from the pin so the matching warning feed stays correct.

Weather matching uses the geocoded map point. A locality or regional result can be approximate, so an administrator should review the pin before relying on a warning match for that site. The public OpenStreetMap tile service is the default basemap and is subject to its usage policy; before commercial or high-volume rollout, configure a tile provider with a service-level agreement and set `NEXT_PUBLIC_WEATHER_TILE_URL`, `NEXT_PUBLIC_WEATHER_TILE_ATTRIBUTION`, and `NEXT_PUBLIC_WEATHER_TILE_ATTRIBUTION_URL` before building the app (Next.js embeds `NEXT_PUBLIC_*` values into the client bundle). The URL must use HTTPS and include `{z}`, `{x}`, and `{y}` on one host. Keep the provider's required attribution intact. Nominatim is also a public geocoder with usage limits; high-volume deployments should use a contracted geocoding provider or a managed instance.

### Supabase migrations

At the time of this change, the local Supabase migration history is applied only through `20261018000000`, while files from `20261019000000` onward are pending, including the weather and hardening migrations. That explains missing weather tables and newer columns in this local database. Review the pending list with `npx supabase migration list --local`, then apply it with `npx supabase migration up --local` when the local data is ready for those schema changes. Avoid `supabase db reset` on a database containing local data; it recreates the database rather than reconciling only pending migrations.

Apply the Supabase migration before using the weather page. For scheduled production syncs, configure these GitHub Actions repository secrets:

- `DATABASE_URL`: a direct Postgres connection for the scheduled job.
- `METEOGATE_API_KEY`: recommended to use a dedicated MeteoGate quota.
- `RESEND_API_KEY`: optional; enables email delivery for orange and red warnings.

Set `alerts.email_from` in the platform settings when email delivery is enabled. The web app also needs `METEOGATE_API_KEY` and, if manual refresh should send mail, `RESEND_API_KEY`; GitHub Actions secrets are separate from the web app's runtime environment. For local development, copy the relevant variables into `.env.local`; `npm run weather:sync` runs a one-off sync. The GitHub Actions workflow checks for updates every 10 minutes. Set `WEATHER_GEOCODER_CONTACT` in the web app environment to provide a contact in Nominatim's User-Agent.

The current weather center covers official warnings and their mapped warning areas. Forecast charts and radar layers are not part of this release.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
