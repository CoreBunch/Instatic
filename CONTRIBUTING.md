# Contributing To Instatic

Thanks for helping improve Instatic. The project is pre-1.0, self-hosted, and intentionally moving quickly, so contributions should favor clean architecture over compatibility shims.

## Start Here

1. Read [README.md](README.md) for product context and local setup.
2. Read [docs/README.md](docs/README.md) for the documentation map.
3. Read [docs/architecture.md](docs/architecture.md) before changing cross-cutting code.
4. For deployment changes, read [docs/deployment/README.md](docs/deployment/README.md).

## Local Development

Use Bun for all project commands:

```sh
bun install
bun run dev
```

The default local database is SQLite at `.tmp/dev.db`. Postgres mode is selected by setting `DATABASE_URL`.

`bun run dev` runs `bun install --frozen-lockfile` before starting the servers, so after a `git pull` it is the only command you need.

Useful checks:

```sh
bun run build
bun test
bun run lint
```

For Docker changes:

```sh
docker build -t instatic:local .
docker compose -f compose.prod.yml -f compose.sqlite.yml -f compose.build.yml config
```

## Pull Requests

- Keep PRs focused on one problem.
- Include tests for behavior changes.
- Update docs in the same PR when behavior, configuration, public APIs, or deployment instructions change.
- Use TypeBox at untyped boundaries.
- Use existing UI primitives in `src/ui/components/` for admin UI controls.
- Do not add provider SDKs, `zod`, Tailwind, `react-router-dom`, or third-party icon packages.

## Project Conventions

Instatic is pre-release. Do not add deprecation shims or backwards-compatibility wrappers for old internal APIs. If a shape is wrong, update the source of truth and all callers in the same change.

Important rules live in:

- [docs/reference/typebox-patterns.md](docs/reference/typebox-patterns.md)
- [docs/reference/database-dialects.md](docs/reference/database-dialects.md)
- [docs/reference/page-tree.md](docs/reference/page-tree.md)
- [docs/reference/react-compiler.md](docs/reference/react-compiler.md)
- [docs/reference/ui-primitives.md](docs/reference/ui-primitives.md)

## Reporting Security Issues

Do not report vulnerabilities in public issues. Follow [SECURITY.md](SECURITY.md).
