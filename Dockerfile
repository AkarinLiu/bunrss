# syntax=docker/dockerfile:1
# oven/bun is Bun's official image (https://hub.docker.com/r/oven/bun) — there is no `bun`/`library/bun` image.
# Tag pinned to the Bun version this project is developed against; float to `1-alpine` if you prefer auto-patches.

# ---------- build: install deps + compile the frontend ----------
FROM oven/bun:1.4.2-alpine AS builder
WORKDIR /app
# `playwright` (dev dependency, used by `bun run e2e`) must not pull browsers into the image
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# ---------- runtime: production deps + built assets only ----------
FROM oven/bun:1.4.2-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY server ./server
COPY migrations ./migrations
COPY tsconfig.json ./
COPY --from=builder /app/web/dist ./web/dist

# the SQLite file lives on a volume; the bun user (uid 1000) must own it
RUN mkdir -p /data && chown -R bun:bun /data
USER bun

ENV DATABASE_URL=/data/bunrss.db
ENV PORT=3000
EXPOSE 3000
VOLUME ["/data"]

CMD ["bun", "server/index.ts"]
