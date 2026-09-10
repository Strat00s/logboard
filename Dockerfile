# message_viewer — container image
#
# build:  docker build -t message_viewer .
# run:    docker run -d --name message_viewer -p 8421:8421 \
#           -v mv_data:/app/data -e MV_TOKEN=s3cret message_viewer
#
# Config is env-only inside the image (MV_PORT, MV_HOST, MV_DB, MV_TOKEN,
# MV_PENDING_DAYS, MV_MAX_BODY, MV_SWEEP_MINUTES, MV_RETENTION_DAYS);
# command-line flags still work if you override the CMD.

# ---- deps: install production node_modules (native better-sqlite3 included) ----
# node:20-slim is glibc Debian, where better-sqlite3 ships prebuilt binaries:
# npm ci downloads one, no compiler toolchain needed.
FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
ENV NODE_ENV=production
RUN npm ci --omit=dev && npm cache clean --force

# ---- runtime: app code + the installed node_modules, nothing else ----
FROM node:20-slim
ENV NODE_ENV=production \
    MV_HOST=0.0.0.0 \
    MV_PORT=8421 \
    MV_DB=/app/data/messages.db
WORKDIR /app

# the stock image ships an unprivileged "node" (1000:1000) user — use it
COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public

# the sqlite file lives here; mount a volume (or bind dir owned by uid 1000)
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME /app/data
USER node

EXPOSE 8421
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MV_PORT||8421)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
