# syntax=docker/dockerfile:1

FROM oven/bun:1.2.22 AS builder
WORKDIR /app

COPY package.json bun.lock tsconfig.json astro.config.mjs ./
COPY scripts ./scripts
COPY src ./src
COPY public ./public

RUN bun install --frozen-lockfile
RUN bun run build:frontend

FROM nginx:alpine AS runner
WORKDIR /app

COPY --from=builder /app/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/entrypoint-config.sh /docker-entrypoint.d/99-config.sh
RUN chmod +x /docker-entrypoint.d/99-config.sh

ENV PORT=3132
EXPOSE 3132
