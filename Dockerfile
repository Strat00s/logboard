# logboard — container image
#
# build:  docker build -t logboard .
# run:    docker run -d --name logboard -p 8421:8421 \
#           -v lb_data:/app/data -e LB_TOKEN=s3cret logboard
#
# Config is env-only inside the image (LB_PORT, LB_HOST, LB_DB, LB_TOKEN,
# LB_PENDING_DAYS, LB_MAX_BODY, LB_SWEEP_MINUTES, LB_RETENTION_DAYS);
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
    LB_HOST=0.0.0.0 \
    LB_PORT=8421 \
    LB_DB=/app/data/messages.db
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
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.LB_PORT||8421)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
