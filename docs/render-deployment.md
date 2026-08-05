# Deploying QuantDesk to Render

This guide deploys the **full working stack** on [Render.com](https://render.com):
a managed PostgreSQL database, the Express API, and the Next.js web app. This is
the setup that makes the platform actually functional — live prices, signals,
auth and the dashboard all work, unlike a static GitHub Pages shell which cannot
run a backend.

## What gets created

| Resource | Purpose | Plan |
|----------|---------|------|
| `quantdesk-postgres` | Managed PostgreSQL | Free* |
| `quantdesk-api` | Express API + WebSocket | Free* |
| `quantdesk-web` | Next.js frontend | Free* |

\* Render's free web services **sleep after 15 min of inactivity** (first request
wakes them in ~30–60s), and free PostgreSQL **expires after 30 days**. For an
always-on production site, upgrade the plans.

## Step 1 — Deploy the Blueprint

1. Push this repository to GitHub (already done: `MOHAMMAD-a12/quantdesk`).
2. Go to [render.com](https://render.com) → **New +** → **Blueprint**.
3. Connect the `quantdesk` repository. Render reads the root [`render.yaml`](../render.yaml)
   and provisions the database + both services.
4. Click **Apply**. Render builds `apps/api/Dockerfile` and `apps/web/Dockerfile`
   and starts everything. The API runs database migrations automatically on boot.

## Step 2 — Rotate the secrets (required)

Because the repo is public, the placeholder secrets in `render.yaml` are public
too. In the Render dashboard, open **each service → Environment** and replace:

| Variable | Service | Value |
|----------|---------|-------|
| `JWT_ACCESS_SECRET` | `quantdesk-api` | random ≥ 32 chars |
| `JWT_REFRESH_SECRET` | `quantdesk-api` | random ≥ 32 chars |
| `ENCRYPTION_KEY` | `quantdesk-api` | `openssl rand -hex 32` |

Each change triggers a redeploy. Wait for the deploy to finish **before** running
the seed below, so the API has the right keys when it boots.

## Step 3 — Create the admin account

Run once in the API service **Shell** tab:

```bash
SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD='YourStrongPass-123' npm run seed
```

Then sign in at `https://quantdesk-web.onrender.com` with that email/password,
and use `POST /api/admin/users/:id` (or SQL) to promote additional admins.

## Step 4 — (Optional) Enable AI narration

Real Bitcoin/Ethereum prices work immediately (Binance/Bybit need no key). For
AI-written signal reasoning, news classification and chart-image analysis, set
`ANTHROPIC_API_KEY` on `quantdesk-api`. Without it the deterministic engine still
produces every number; only the prose is skipped.

## Step 5 — Verify

- **API health:** `https://quantdesk-api.onrender.com/api/health`
- **Web:** `https://quantdesk-web.onrender.com`
- The market board shows live BTC/ETH/SOL price unless a provider is down (crypto
  needs no key). Non-crypto symbols show the synthetic-data badge.

## Links & notes

- Both services are wired by name from the Blueprint:
  `NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_WS_URL` point at `quantdesk-api.onrender.com`.
  If you rename a service, update these.
- **WebSockets** work on Render web services (same HTTP port), so live quotes and
  signals stream to the dashboard.
- **Redis is optional.** The platform degrades gracefully without it (see the
  note in `render.yaml`). Add managed Redis later if you want multi-instance
  caching / cross-instance WebSocket fan-out.
- **`PORT`:** the API now falls back to Render's injected `PORT` env var when
  `API_PORT` isn't set, so Render's routing reaches it without extra config.

## Cost

The three services on free plans are $0/month but cold-start after idle and the
database expires after 30 days. A persistent hobby setup is roughly:
Postgres `basic` ($7/mo) + two web `starter` ($7/mo each) ≈ **$21/mo**. Use the
startup instruction cycle for an always-on, production-real deployment.