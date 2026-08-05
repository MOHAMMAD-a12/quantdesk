# ---------------------------------------------------------------------------
# QuantDesk Web — multi-stage Next.js build
#
# NEXT_PUBLIC_* are baked at build time. INTERNAL_API_URL stays runtime so
# Compose can route server-side calls directly to the api service.
# ---------------------------------------------------------------------------

# ========================= builder =========================================
FROM node:20-alpine AS builder

ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ARG NEXT_PUBLIC_WS_URL=ws://localhost:4000/ws
ARG NEXT_PUBLIC_SITE_URL=http://localhost:3000
ARG NEXT_PUBLIC_VAPID_PUBLIC_KEY=

ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
ENV NEXT_PUBLIC_VAPID_PUBLIC_KEY=$NEXT_PUBLIC_VAPID_PUBLIC_KEY
ENV NEXT_TELEMETRY_DISABLED=1

WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/web/package.json ./apps/web/

RUN npm install --workspace=@quantdesk/web --workspace=@quantdesk/shared --ignore-scripts

COPY tsconfig.base.json ./
COPY packages/shared/ ./packages/shared/
COPY apps/web/ ./apps/web/

RUN npm run build --workspace=@quantdesk/shared && npm run build --workspace=@quantdesk/web

# ========================= runner ==========================================
FROM node:20-alpine AS runner

RUN apk add --no-cache tini
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY package.json package-lock.json* ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/web/package.json ./apps/web/

RUN npm install --omit=dev --workspace=@quantdesk/web --workspace=@quantdesk/shared

COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public

USER node
ENTRYPOINT ["tini", "--"]
CMD ["node", "apps/web/server.js"]
