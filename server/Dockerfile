# ── builder stage ────────────────────────────────────────────────────────────
# Compiles TypeScript to dist/. Only build-time deps are installed here so
# the production image stays lean.
FROM node:20-alpine AS builder

WORKDIR /app

# Install deps first (layer-cached until package files change)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and compile
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── production stage ──────────────────────────────────────────────────────────
# Minimal image: only runtime deps + compiled JS.
FROM node:20-alpine AS production

# dumb-init reaps zombie processes and forwards signals correctly so that
# SIGTERM reaches Node's process.on('SIGTERM') handler for graceful shutdown.
RUN apk add --no-cache dumb-init

WORKDIR /app

# Install production deps only (no devDependencies)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Compiled application
COPY --from=builder /app/dist ./dist

# DB migration runner and SQL migration files
COPY scripts/ ./scripts/
COPY migrations/ ./migrations/

# Run as non-root for least-privilege; node user exists in the base image
USER node

EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
