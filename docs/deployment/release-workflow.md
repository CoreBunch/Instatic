# Release Workflow

This maintainer guide covers publishing Instatic Docker images.

End users do not need this page to deploy Instatic. They follow [railway.md](railway.md), [render.md](render.md), [vps.md](vps.md), or [docker-image.md](docker-image.md). Maintainers use this page to keep `ghcr.io/corebunch/instatic` release tags aligned with source tags and deployment templates.

---

## TL;DR

Release image tags:

```txt
ghcr.io/corebunch/instatic:latest
ghcr.io/corebunch/instatic:<semver>
ghcr.io/corebunch/instatic:<major>.<minor>
```

Release flow:

1. Keep `main` releasable.
2. Update deployment docs that intentionally pin the semver image tag.
3. Tag a version, e.g. `v0.0.1`.
4. GitHub Actions runs `bun run build`, `bun test`, and `bun run lint`.
5. GitHub Actions builds `Dockerfile`.
6. GitHub Actions pushes the semver image, minor image, and `latest` to GHCR.
7. GitHub Actions creates the GitHub Release and uploads the release bundle.

## Pre-Tag Template Updates

Before tagging a release, update the package/changelog version and every checked-in deployment surface that intentionally pins the release image:

```txt
package.json
CHANGELOG.md
docs/deployment/README.md
docs/deployment/docker-image.md
docs/deployment/railway.md
```

The checked-in Render Blueprints use `ghcr.io/corebunch/instatic:latest` for new one-click installs. `scripts/build-release-bundle.ts` rewrites the release-bundle copies to the semver image tag automatically.

After the release image is published, copy the two Render Blueprint files into the dedicated template repositories as their root `render.yaml` files when their non-versioned template configuration changes:

```txt
corebunch/instatic-render-sqlite
corebunch/instatic-render-postgres
```

## Tag A Release

```sh
git tag v0.0.1
git push origin v0.0.1
```

The release workflow publishes:

```txt
ghcr.io/corebunch/instatic:0.0.1
ghcr.io/corebunch/instatic:0.0
ghcr.io/corebunch/instatic:latest
```

It also uploads:

```txt
instatic-0.0.1-release-bundle.tar.gz
```

Release notes should link to:

- [railway.md](railway.md)
- [render.md](render.md)
- [vps.md](vps.md)
- [docker-image.md](docker-image.md)
- [backup-restore.md](backup-restore.md)

## Operator Update Command

Image-based VPS Compose installs update the app container without touching DB/uploads volumes:

```sh
docker compose -f compose.prod.yml pull app
docker compose -f compose.prod.yml up -d
```

SQLite installs include the SQLite override when running commands:

```sh
docker compose -f compose.prod.yml -f compose.sqlite.yml pull app
docker compose -f compose.prod.yml -f compose.sqlite.yml up -d
```

Railway installs should use Docker image source and Railway Image Auto Updates rather than connecting to this GitHub repository as a service source.

Render installs use image-backed Blueprints. Operators upgrade by changing the image tag in their Render service or by redeploying from an updated template repository.

## Source Build Testing

When testing a release candidate before publishing GHCR images, build from a source checkout:

```sh
docker compose -f compose.prod.yml -f compose.build.yml up -d --build
```

Or build and tag an image manually:

```sh
docker build -t ghcr.io/corebunch/instatic:dev .
INSTATIC_IMAGE=ghcr.io/corebunch/instatic:dev docker compose -f compose.prod.yml up -d
```

## GitHub Actions Shape

The release workflow should:

- run tests and build checks
- log in to GitHub Container Registry with `GITHUB_TOKEN`
- build `Dockerfile` for `linux/amd64`
- push a semver tag for `v*` tags
- push `latest` for tagged releases
- create a release bundle with the Compose files and deployment docs
- include the Render Blueprint templates in the release bundle

The first release targets `linux/amd64` because QEMU-based arm64 publishing made the tagged workflow too slow to use as a release gate. Add arm64 as a separate native-runner build before advertising multi-arch images.

## Image Registry

GHCR (`ghcr.io/corebunch/instatic`) is the only published registry. It is produced directly by the release workflow, is public, and has no aggressive anonymous pull-rate limits — use it in every Compose file, template, and deployment guide. There is no Docker Hub mirror; if one is ever wanted, add a `Mirror To Docker Hub` job plus `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` repository secrets.

## GHCR Visibility

After the first successful tagged release, open the package page for `ghcr.io/corebunch/instatic` in GitHub Packages and set visibility to public.

Verify anonymous pulls work:

```sh
docker logout ghcr.io
docker pull ghcr.io/corebunch/instatic:latest
```

## Related

- [deployment/README.md](README.md) — deployment overview
- [docker-image.md](docker-image.md) — runtime image contract
- [render.md](render.md) — Render Blueprint contract
- `Dockerfile` — image build
- `compose.prod.yml` — production image consumer
- `docs/deployment/render/sqlite/render.yaml`, `docs/deployment/render/postgres/render.yaml` — Render Blueprint templates
