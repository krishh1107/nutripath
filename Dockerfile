# NutriPath — production image (data lives in PostgreSQL via DATABASE_URL, so no volume is needed)
FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

# Install dependencies first for better layer caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js db.js initDB.js loadEnv.js auth.js mailer.js data.js schema.sql ./
COPY public ./public
COPY --chown=node:node data/nutrition_kb.json ./data/

# Run as the unprivileged "node" user that ships with the image
USER node

ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:${PORT}/api/health || exit 1

# Applies schema.sql (idempotent), then starts the server
CMD ["npm", "start"]
