# Build context is the REPOSITORY ROOT (see docker-compose.yml). Build with:  docker build -f backend-node/Dockerfile .
FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app/backend-node

# Install dependencies first so this layer is cached until package files change.
COPY backend-node/package.json backend-node/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY backend-node/src ./src
COPY backend-node/migrations ./migrations
COPY backend-node/scripts ./scripts

# Local media storage defaults to ./data/media; mount a volume here (or use STORAGE_PROVIDER=s3).
RUN mkdir -p /app/backend-node/data/media && chown -R node:node /app
USER node

EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8081)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Migrations run at startup only when DATABASE_MIGRATE_ON_STARTUP=true (the default in development, off otherwise; see src/server.js).
# Otherwise run `npm run migrate` as a separate step (docker-compose does this for development).
CMD ["npm", "start"]
