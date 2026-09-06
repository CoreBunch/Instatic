import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

describe('self-host docker config', () => {
  it('defines a postgres dev service for `bun run dev` to manage', () => {
    const compose = readFileSync('docker-compose.yml', 'utf8')
    expect(compose).toContain('postgres:')
    expect(compose).toContain('postgres:16')
  })

  it('defines a persistent postgres volume in the dev compose', () => {
    const compose = readFileSync('docker-compose.yml', 'utf8')
    expect(compose).toContain('postgres_data:')
  })

  it('documents required environment variables', () => {
    const env = readFileSync('.env.example', 'utf8')
    expect(env).toContain('DATABASE_URL=')
    expect(env).toContain('UPLOADS_DIR=')
  })

  it('defines a production Docker image that builds assets before runtime startup', () => {
    const dockerfile = readFileSync('Dockerfile', 'utf8')

    expect(dockerfile).toContain('FROM oven/bun:1.3.11 AS build')
    expect(dockerfile).toContain('RUN bun run build')
    expect(dockerfile).toContain('FROM oven/bun:1.3.11 AS runtime')
    expect(dockerfile).toContain('ARG INSTATIC_VERSION=dev')
    expect(dockerfile).toContain('LABEL org.opencontainers.image.version="${INSTATIC_VERSION}"')
    expect(dockerfile).toContain('CMD ["bun", "run", "server/index.ts"]')
    expect(dockerfile).not.toContain('vite build && bun run server/index.ts')
  })

  it('keeps TypeScript path aliases available in the runtime image', () => {
    const dockerfile = readFileSync('Dockerfile', 'utf8')

    expect(dockerfile).toContain('COPY --chown=bun:bun tsconfig*.json ./')
  })

  it('installs the runtime script bundler in production dependencies', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }

    expect(pkg.dependencies?.esbuild).toBeTruthy()
    expect(pkg.devDependencies?.esbuild).toBeUndefined()
  })

  it('allows PATCH in server CORS preflight for CMS media rename', () => {
    const serverIndex = readFileSync('server/index.ts', 'utf8')

    expect(serverIndex).toContain("'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS'")
  })

  it('defines a production compose stack with health checks and persistent data', () => {
    const compose = readFileSync('compose.prod.yml', 'utf8')
    const buildOverride = readFileSync('compose.build.yml', 'utf8')

    expect(compose).toContain('ghcr.io/corebunch/instatic:latest')
    expect(compose).not.toContain('build:')
    expect(compose).toContain('restart: unless-stopped')
    expect(compose).toContain('condition: service_healthy')
    expect(compose).toContain('postgres_data:')
    expect(compose).toContain('uploads:')
    expect(buildOverride).toContain('build:')
    expect(buildOverride).toContain('dockerfile: Dockerfile')
  })

  it('lets compose.prod.yml load without an .env (so SQLite mode is zero-config) while making the Postgres password placeholder loudly unsafe', () => {
    // Why this rule exists:
    // SQLite mode (compose.sqlite.yml override) disables the postgres service
    // and replaces the app's DATABASE_URL — Postgres credentials are unused.
    // But compose's `${VAR:?error}` interpolation runs at FILE LOAD TIME,
    // before profiles or overrides are applied. A `:?` guard on POSTGRES_PASSWORD
    // forces SQLite users to invent a `.env` for a service they aren't running.
    //
    // Contract instead:
    //   1. No `:?` guard on POSTGRES_PASSWORD — file loads with empty env.
    //   2. The placeholder default value MUST be obviously unsafe (must contain
    //      the literal string CHANGEME) so a Postgres operator who forgets to
    //      override it sees the placeholder in their running container's
    //      env / logs and rotates it.
    const compose = readFileSync('compose.prod.yml', 'utf8')

    expect(compose).not.toContain('${POSTGRES_PASSWORD:?')
    expect(compose).toContain('CHANGEME')
  })

  it('defines production environment variables required by the compose stack', () => {
    const env = readFileSync('.env.production.example', 'utf8')
    const compose = readFileSync('compose.prod.yml', 'utf8')

    expect(env).toContain('POSTGRES_PASSWORD=')
    expect(env).toContain('INSTATIC_SECRET_KEY=')
    expect(env).toContain('TRUSTED_PROXY_CIDRS=')
    expect(compose).toContain('INSTATIC_SECRET_KEY:')
    expect(compose).toContain('TRUSTED_PROXY_CIDRS:')
  })
})

describe('coolify docker config', () => {
  // Coolify reads the Compose file as prose-free YAML, but these files carry
  // heavy explanatory comments — several of which quote the very keys asserted
  // absent below ("No `networks:`", "No `ports:`"). Strip comment lines so the
  // assertions describe the effective stack, not the documentation around it.
  function effectiveYaml(path: string): string {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n')
  }

  const COOLIFY_COMPOSE_FILES = [
    'docker-compose.coolify.yml',
    'docker-compose.coolify.sqlite.yml',
  ]

  it.each(COOLIFY_COMPOSE_FILES)('leaves proxy and lifecycle concerns to Coolify in %s', (path) => {
    // Why this rule exists:
    // Coolify owns the reverse proxy and the container lifecycle. Each of these
    // keys silently takes something back from it:
    //   networks:        puts containers on two networks at once, which makes
    //                    Traefik route non-deterministically — Coolify documents
    //                    this as a cause of intermittent HTTPS outages.
    //   ports:           publishes on the host, bypassing the proxy entirely and
    //                    exposing Postgres and the app directly on the VPS.
    //   container_name:  collides with the UUID-suffixed name Coolify assigns.
    //   restart:         Coolify sets its own restart policy.
    // None of these fail loudly, so they need a gate rather than a review.
    const compose = effectiveYaml(path)

    expect(compose).not.toContain('networks:')
    expect(compose).not.toContain('ports:')
    expect(compose).not.toContain('container_name:')
    expect(compose).not.toContain('restart:')
  })

  it.each(COOLIFY_COMPOSE_FILES)('pulls the published image rather than building in %s', (path) => {
    const compose = effectiveYaml(path)

    expect(compose).toContain('ghcr.io/corebunch/instatic:latest')
    expect(compose).not.toContain('build:')
  })

  it.each(COOLIFY_COMPOSE_FILES)('wires the public origin to the Coolify-assigned domain in %s', (path) => {
    // Why this rule exists:
    // Coolify's Traefik terminates TLS and forwards plain HTTP, and
    // server/auth/security.ts deliberately never trusts X-Forwarded-Proto/Host.
    // resolvePublicOrigins() in server/config.ts auto-detects Render and Railway
    // but has no Coolify branch, so PUBLIC_ORIGIN must be set explicitly or the
    // server believes it is http:// and four things degrade — only one loudly:
    //   - the session cookie silently loses its Secure flag
    //   - the CSRF check compares against the wrong expected origin
    //   - the collab WebSocket upgrade is rejected by that same origin guard
    //   - MCP connector URLs resolve local-only instead of public-https
    // SERVICE_URL_INSTATIC_3001 declares the route and assigns the domain;
    // ${SERVICE_URL_INSTATIC} reads it back with the scheme included, so a
    // custom domain set later in the Coolify UI carries through automatically.
    const compose = effectiveYaml(path)

    expect(compose).toContain('SERVICE_URL_INSTATIC_3001')
    expect(compose).toContain('PUBLIC_ORIGIN=${SERVICE_URL_INSTATIC}')
  })

  it.each(COOLIFY_COMPOSE_FILES)('generates a master key of the shape the server validates in %s', (path) => {
    // The image runs NODE_ENV=production, where server/secrets/masterKey.ts
    // throws MasterKeyConfigurationError at boot unless INSTATIC_SECRET_KEY
    // decodes to exactly REQUIRED_KEY_BYTES (32). Coolify's REALBASE64_32
    // emits base64 of 32 random bytes; the similarly-named BASE64_32 emits a
    // bare 32-character string that is NOT base64 and would fail validation.
    const compose = effectiveYaml(path)

    expect(compose).toContain('INSTATIC_SECRET_KEY=${SERVICE_REALBASE64_32_INSTATIC}')
  })

  it.each(COOLIFY_COMPOSE_FILES)('health-checks the app so Traefik only routes to a ready container in %s', (path) => {
    const compose = effectiveYaml(path)

    expect(compose).toContain('healthcheck:')
    expect(compose).toContain('server/healthcheck.ts')
  })

  it('bundles Postgres with a readiness gate and persistent volumes', () => {
    const compose = effectiveYaml('docker-compose.coolify.yml')

    expect(compose).toContain('image: postgres:16')
    expect(compose).toContain('condition: service_healthy')
    expect(compose).toContain('instatic-uploads:')
    expect(compose).toContain('instatic-postgres-data:')
  })

  it('mounts the SQLite stack where the image already prepared the directories', () => {
    // Why this rule exists:
    // The image runs as the non-root `bun` user. The Dockerfile creates
    // /app/uploads and /app/data and chowns them to bun BEFORE `USER bun`, so a
    // named volume mounted at either path inherits that ownership. A volume
    // mounted at a path the image does not contain — notably the single
    // /app/storage root the Railway and Render templates use — is created
    // root-owned and every write fails with EACCES. Railway works around that
    // with RAILWAY_RUN_UID=0; there is no such escape hatch here.
    const compose = effectiveYaml('docker-compose.coolify.sqlite.yml')

    expect(compose).toContain('DATABASE_URL=sqlite:/app/data/cms.db')
    expect(compose).toContain('instatic-uploads:/app/uploads')
    expect(compose).toContain('instatic-data:/app/data')
    expect(compose).not.toContain('/app/storage')
    expect(compose).not.toContain('postgres')
  })
})
