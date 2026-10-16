# Sara Games Platform - Standalone
FROM oven/bun:1-slim

WORKDIR /app

# Install runtime deps
COPY package.json ./
RUN bun install --production

# App files
COPY actions.js ./
COPY server.mjs ./
COPY public ./public

# Data dir (SQLite + blobs). NOTE: Render free tier has ephemeral filesystem —
# data resets on redeploy/restart. Seed catalog auto-bootstraps on startup.
RUN mkdir -p /app/data/blobs

ENV PORT=3000
EXPOSE 3000

CMD ["bun", "server.mjs"]
