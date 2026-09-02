# Build stage: compile TypeScript.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime stage: production deps + built output + shipped data bundles.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    OPENDOTA_TRANSPORT=http \
    PORT=8787 \
    TMPDIR=/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# constants-bundle seeds the cache (0-request cold start); locales carry the
# 28-language name tables; skill/ keeps `install-skill` usable from the image.
COPY constants-bundle ./constants-bundle
COPY locales ./locales
COPY skill ./skill
# Writable /data for the disk cache (mount a volume to persist across restarts).
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "dist/index.js"]
