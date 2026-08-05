# ---------------------------------------------------------------------------
# QuantDesk API — multi-stage build
#
# Stage 1 ("deps")   installs production dependencies only.
# Stage 2 ("builder") compiles TypeScript.
# Stage 3 ("runner")  is the minimal production image.
# ---------------------------------------------------------------------------

# ========================= builder =========================================
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/

RUN npm install --workspace=@quantdesk/api --workspace=@quantdesk/shared --ignore-scripts

COPY tsconfig.base.json ./
COPY packages/shared/ ./packages/shared/
COPY apps/api/ ./apps/api/

RUN npm run build --workspace=@quantdesk/shared && npm run build --workspace=@quantdesk/api

# ========================= runner ==========================================
FROM node:20-alpine AS runner

RUN apk add --no-cache tini
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/

RUN npm install --omit=dev --workspace=@quantdesk/api --workspace=@quantdesk/shared

COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/apps/api/dist ./apps/api/dist

RUN mkdir -p /app/storage/uploads && chown -R node:node /app

USER node
ENTRYPOINT ["tini", "--"]
CMD ["node", "apps/api/dist/server.js"]
