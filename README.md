# QuantDesk — AI Trading Analysis Platform

Real-time market intelligence, deterministic SMC/ICT technical analysis, AI signal generation, portfolio journaling, risk management and live WebSocket delivery. Built as an npm-workspaces monorepo with a Next.js 15 web console and a Node.js + Express API backed by PostgreSQL and Redis.

> **Analysis only.** This platform is market intelligence software, not financial advice. Every signal, analysis and chart displayed to the user is labelled accordingly.

---

## Architecture

```
┌──────────────┐     REST / WS     ┌──────────────┐     SQL     ┌──────────────┐
│  Next.js 15  │ ◄───────────────► │  Express API │ ◄─────────► │  PostgreSQL  │
│  apps/web    │   INTERNAL_API_   │  apps/api    │             │  16          │
│  port 3000   │   URL in Compose  │  port 4000   │             └──────────────┘
└──────────────┘                   │              │     Redis     ┌──────────────┐
                                   │  Scheduler   │ ◄───────────► │  Redis 7     │
                                   │  WS Hub      │               │  Cache/PubSub│
                                   │  Providers   │               └──────────────┘
                                   └──────────────┘
```

### Workspace layout

| Workspace | Package | Purpose |
|-----------|---------|---------|
| `packages/shared` | `@quantdesk/shared` | Zod schemas, domain types, wire contracts, constants, pure helpers |
| `apps/api` | `@quantdesk/api` | Express REST + WebSocket server, scheduler, providers, auth |
| `apps/web` | `@quantdesk/web` | Next.js 15 app router console, React Query, Tailwind CSS |

### Key design decisions

- **No mock data unless nothing is configured.** A `synthetic` flag is attached to every price, candle and signal produced without a live provider. The UI badges this explicitly.
- **Deterministic engine first, LLM second.** Every number in a `Signal` is computed by the engine. The LLM writes the narrative and a single conviction score.
- **Auth-as-a-message.** WebSocket authentication happens in the first frame, never in the URL query string.
- **Origin-tagged fan-out.** The Redis pub/sub envelope carries the sending instance's id; local delivery happens immediately, cross-instance delivery survives a Redis outage.
- **Scheduler with distributed locks.** Each background job takes a Redis lock before running. An idle deployment spends zero provider rate limit.

---

## Quick start (Docker Compose)

```bash
# 1. Clone and configure
cp .env.example .env
# Edit .env — at minimum set DATABASE_URL secrets and JWT secrets

# 2. Start everything
docker compose up --build

# 3. Run migrations and seed the admin account
docker compose exec api npx tsx src/db/migrate.ts
SEED_ADMIN_EMAIL=admin@example.com SEED_ADMIN_PASSWORD=change-me-please-123 \
  docker compose exec api npx tsx src/db/seed.ts

# 4. Open
#   Web:  http://localhost:3000
#   API:  http://localhost:4000/api/health
```

---

## Local development

```bash
# Install dependencies
npm install

# Build shared types first (API and web depend on them)
npm run build --workspace=@quantdesk/shared

# Start API (requires PostgreSQL + Redis — use Docker Compose for them)
npm run dev:api

# Start web
npm run dev:web

# Or both concurrently
npm run dev
```

### Type checking

```bash
npm run typecheck        # All workspaces
```

---

## Market data providers

The platform uses an interchangeable adapter pattern. Providers are registered automatically based on environment variables. **No provider is required** — the platform falls back to a clearly-labelled synthetic feed.

| Provider | Env var | API key needed | Asset classes |
|----------|---------|---------------|---------------|
| Binance | `MARKET_BINANCE_ENABLED=true` | No | Crypto |
| Bybit | `MARKET_BYBIT_ENABLED=true` | No | Crypto |
| Coinbase | `MARKET_COINBASE_ENABLED=true` | No | Crypto |
| Twelve Data | `MARKET_TWELVEDATA_API_KEY` | Yes | Forex, Stocks, Commodities |
| Finnhub | `MARKET_FINNHUB_API_KEY` | Yes | Stocks, Indices |
| Polygon | `MARKET_POLYGON_API_KEY` | Yes | Stocks, Forex, Crypto |
| Alpha Vantage | `MARKET_ALPHAVANTAGE_API_KEY` | Yes | Stocks, Forex |

---

## AI providers

Configurable at runtime from the Admin Panel. The `ai_settings` database record wins; environment variables are bootstrap defaults.

| Provider | Env var | Model |
|----------|---------|-------|
| Anthropic | `ANTHROPIC_API_KEY` | `claude-opus-5` |
| OpenAI | `OPENAI_API_KEY` | `gpt-4.1` |
| Gemini | `GEMINI_API_KEY` | `gemini-2.0-flash` |
| Local LLM | `LOCAL_LLM_BASE_URL` | Any OpenAI-compatible endpoint |

---

## User roles

| Role | Access |
|------|--------|
| **Free** | Dashboard, markets, news, analysis, portfolio journal, risk tools |
| **Premium** | + On-demand signal generation, priority scan results |
| **Admin** | + Admin panel: users, markets, AI settings, scheduler, audit log |

---

## Security

- JWT access tokens (in-memory only) + refresh tokens (httpOnly cookie via Next route handler)
- CSRF protection via origin verification
- Rate limiting per identity and per endpoint bucket
- Parameterised SQL queries (no string interpolation)
- Helmet security headers
- Multer memory-only uploads (raw bytes never touch disk; only re-encoded output)
- Image serving with `X-Content-Type-Options: nosniff` and restrictive CSP
- Audit logging for all administrative mutations

---

## WebSocket protocol

Connection at `ws://host:4000/ws`. Authentication is the first message:

```json
{ "type": "auth", "token": "<accessToken>" }
```

Subscribe to channels:

```json
{ "type": "subscribe", "channels": ["quotes", "quote:BTCUSDT", "signals", "user:<userId>"] }
```

Live data channels: `quotes`, `quote:SYMBOL`, `candle:SYMBOL:TIMEFRAME`, `signals`, `signals:SYMBOL`, `fear_greed`, `derivatives:SYMBOL`, `user:UUID`.

---

## Environment variables

See [`.env.example`](.env.example) for the full reference. Required variables:

- `DATABASE_URL` — PostgreSQL connection string
- `JWT_ACCESS_SECRET` — ≥ 32 chars
- `JWT_REFRESH_SECRET` — ≥ 32 chars
- `ENCRYPTION_KEY` — 64 hex chars (32 bytes)

All other variables have sensible defaults for local development.

---

## License

Private. All rights reserved.
