# --- deps ---------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

# --- build --------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

# --- runtime ------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache tini curl && addgroup -S unichat && adduser -S unichat -G unichat

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./package.json

RUN mkdir -p /app/uploads && chown -R unichat:unichat /app
USER unichat

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:4000/health || exit 1

# tini reaps zombies so SIGTERM reaches Node for a clean shutdown.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
