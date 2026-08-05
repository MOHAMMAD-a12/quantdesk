# Deploying QuantDesk to a Linux VPS with a domain

This guide runs the full stack (PostgreSQL + Redis + API + Web) on a Linux VPS
with your domain and automatic HTTPS via Caddy.

> **Not for shared hosting.** This platform needs Node.js, PostgreSQL, Redis and
> WebSockets. Shared cPanel/DirectAdmin hosting cannot run it. You need a VPS
> with SSH root access (Hetzner, DigitalOcean, Vultr, Linode, …) — roughly
> $4–6/month.

## What you end up with

| Address | Service |
|---------|---------|
| `https://your-domain.com` | Next.js web app |
| `https://api.your-domain.com` | Express API (health: `/api/health`) |
| `wss://api.your-domain.com/ws` | Live WebSocket data |

HTTPS certificates are issued automatically by Let's Encrypt through Caddy.

---

## Step 1 — Point your domain at the server

In your domain registrar's DNS panel add three **A records** (all to the server IP):

```
@     -> 1.2.3.4
www   -> 1.2.3.4
api   -> 1.2.3.4
```

Wait 5–30 minutes for propagation (verify with `dig +short your-domain.com`).

## Step 2 — SSH in and install Docker

```bash
ssh root@1.2.3.4
curl -fsSL https://get.docker.com | sh
```

## Step 3 — Get the code and configure

```bash
git clone https://github.com/MOHAMMAD-a12/quantdesk.git
cd quantdesk
cp .env.example .env
nano .env
```

Set these (replace `your-domain.com`):

```bash
DOMAIN=your-domain.com

WEB_ORIGIN=https://your-domain.com
NEXT_PUBLIC_API_URL=https://api.your-domain.com
NEXT_PUBLIC_WS_URL=wss://api.your-domain.com/ws
NEXT_PUBLIC_SITE_URL=https://your-domain.com

JWT_ACCESS_SECRET=<random >= 32 chars>
JWT_REFRESH_SECRET=<random >= 32 chars>
ENCRYPTION_KEY=<openssl rand -hex 32>

TRUST_PROXY=1
MARKET_BINANCE_ENABLED=true
MARKET_BYBIT_ENABLED=true
```

## Step 4 — Start the stack

```bash
docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml up -d --build
```

Watch logs: `docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml logs -f api`

The API runs database migrations automatically on first boot.

## Step 5 — Create the admin account

```bash
docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml exec api \
  env SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD='YourStrongPass-123' \
  npm run seed
```

## Step 6 — Verify

- `https://your-domain.com` — the dashboard
- `https://api.your-domain.com/api/health` — `{ status: "ok", ... }`
- `https://api.your-domain.com/api/markets/quotes?symbols=BTCUSDT` — live price

Bitcoin/Ethereum prices are live immediately (Binance/Bybit need no key).
Set `ANTHROPIC_API_KEY` in `.env` (then `docker compose ... up -d`) for AI
narration.

## Useful commands

```bash
# Tail all logs
docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml logs -f --tail=100

# Restart after an .env change
docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml up -d

# Update to the latest code
git pull
docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml up -d --build

# Back up the database
docker compose exec postgres pg_dump -U quantdesk quantdesk > backup.sql
```

## Firewall

Only allow 22 (SSH), 80 and 443 publicly. The API port 4000 is mapped on the
host for health checks / debugging; block it from the public internet with
`ufw` unless you need it open:

```bash
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw deny 4000/tcp
ufw enable
```

## Optional: use an email/notification channel

Set `SMTP_*`, `TELEGRAM_BOT_TOKEN` or `DISCORD_WEBHOOK_URL` in `.env` and
restart. Notifications then reach real channels.