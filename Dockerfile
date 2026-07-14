# syntax=docker/dockerfile:1

FROM oven/bun:1.3.11 AS build
WORKDIR /app
# vendor/pixel-art-icons is a `file:` dep — `bun install` needs it on disk to
# resolve the dependency, so copy it alongside the manifest before installing.
COPY package.json bun.lock ./
COPY vendor ./vendor
RUN --mount=type=secret,id=bun_ca,required=false \
  if [ -s /run/secrets/bun_ca ]; then \
    bun install --frozen-lockfile --cafile /run/secrets/bun_ca; \
  else \
    bun install --frozen-lockfile; \
  fi
COPY . .
RUN bun run build

FROM oven/bun:1.3.11 AS production-deps
WORKDIR /app
COPY package.json bun.lock ./
COPY vendor ./vendor
RUN --mount=type=secret,id=bun_ca,required=false \
  if [ -s /run/secrets/bun_ca ]; then \
    bun install --frozen-lockfile --production --cafile /run/secrets/bun_ca; \
  else \
    bun install --frozen-lockfile --production; \
  fi

FROM oven/bun:1.3.11 AS runtime
WORKDIR /app

ARG INSTATIC_VERSION=dev
ARG INSTATIC_REVISION=unknown
ARG INSTATIC_CREATED=unknown
ARG INSTATIC_SOURCE=https://github.com/corebunch/instatic
ARG INSTATIC_UPSTREAM_REVISION=unknown

LABEL org.opencontainers.image.title="Instatic"
LABEL org.opencontainers.image.description="Self-hosted CMS with an integrated visual editor."
LABEL org.opencontainers.image.source="${INSTATIC_SOURCE}"
LABEL org.opencontainers.image.url="${INSTATIC_SOURCE}"
LABEL org.opencontainers.image.documentation="https://github.com/corebunch/instatic/tree/main/docs/deployment"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.version="${INSTATIC_VERSION}"
LABEL org.opencontainers.image.revision="${INSTATIC_REVISION}"
LABEL org.opencontainers.image.created="${INSTATIC_CREATED}"
LABEL io.github.dimabgtrv.instatic.upstream.revision="${INSTATIC_UPSTREAM_REVISION}"

ENV NODE_ENV=production
ENV PORT=3001
ENV STATIC_DIR=/app/dist
ENV UPLOADS_DIR=/app/uploads

COPY --from=production-deps --chown=bun:bun /app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /app/dist ./dist
COPY --chown=bun:bun package.json bun.lock ./
COPY --chown=bun:bun tsconfig*.json ./
COPY --chown=bun:bun server ./server
COPY --chown=bun:bun src ./src

RUN mkdir -p /app/uploads /app/data && chown -R bun:bun /app

USER bun
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["bun", "run", "server/healthcheck.ts"]

CMD ["bun", "run", "server/index.ts"]
