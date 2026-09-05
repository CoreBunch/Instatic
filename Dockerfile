# syntax=docker/dockerfile:1

# The one place the Bun version lives for the image; CI reads it from
# package.json "packageManager" instead, so bumping Bun is two lines.
ARG BUN_VERSION=1.4.2

FROM oven/bun:${BUN_VERSION} AS build
WORKDIR /app
# vendor/pixel-art-icons is a `file:` dep — `bun install` needs it on disk to
# resolve the dependency, so copy it alongside the manifest before installing.
COPY package.json bun.lock ./
COPY vendor ./vendor
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:${BUN_VERSION} AS production-deps
WORKDIR /app
COPY package.json bun.lock ./
COPY vendor ./vendor
RUN bun install --frozen-lockfile --production

FROM oven/bun:${BUN_VERSION} AS runtime
WORKDIR /app

ARG INSTATIC_VERSION=dev
ARG INSTATIC_REVISION=unknown
ARG INSTATIC_CREATED=unknown

LABEL org.opencontainers.image.title="Instatic"
LABEL org.opencontainers.image.description="Self-hosted CMS with an integrated visual editor."
LABEL org.opencontainers.image.source="https://github.com/corebunch/instatic"
LABEL org.opencontainers.image.url="https://github.com/corebunch/instatic"
LABEL org.opencontainers.image.documentation="https://github.com/corebunch/instatic/tree/main/docs/deployment"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.version="${INSTATIC_VERSION}"
LABEL org.opencontainers.image.revision="${INSTATIC_REVISION}"
LABEL org.opencontainers.image.created="${INSTATIC_CREATED}"

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
