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

    expect(dockerfile).toContain('ARG BUN_VERSION=1.4.2')
    expect(dockerfile).toContain('FROM oven/bun:${BUN_VERSION} AS build')
    expect(dockerfile).toContain('RUN bun run build')
    expect(dockerfile).toContain('FROM oven/bun:${BUN_VERSION} AS runtime')
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
