# Hochstaett deployment fork

This fork preserves the locally tested CMS customizations used by the Hochstaett site.

- Fork: https://github.com/Hubertoink/Instatic
- Upstream: https://github.com/CoreBunch/Instatic
- Initial integration branch: `feat/hochstaett-deployment-baseline`
- Upstream base: `f92e8dc1` (0.0.20)

## Source and runtime data

Git contains application code, tests and documentation. Website content lives in
the CMS database and uploads volume. Database files, uploaded media, backups,
environment files and secret keys are not deployment source and must be
transferred separately through a private backup/restore process.

The integration branch includes relation/repeater loops, preview improvements,
publication-date handling, animation presets, and content image sizing,
lightbox and link insertion. Review these local changes through the fork's draft
pull request before merging; the integration branch is not a production release.

## Git remotes

`origin` points to this fork; `upstream` points to CoreBunch. Feature branches
and pull requests belong to the fork unless a contribution to CoreBunch is
explicitly intended.

```sh
git clone https://github.com/Hubertoink/Instatic.git
cd Instatic
git remote add upstream https://github.com/CoreBunch/Instatic.git
git switch --track origin/feat/hochstaett-deployment-baseline
```

Fetch upstream updates and integrate them on a separate review branch. Do not
reset the fork to upstream when preserving these customizations.

## Container handoff

Build the image from the reviewed fork commit:

```sh
docker build -t instatic-hochstaett:staging .
```

The fork image workflow, `.github/workflows/fork-image.yml`, builds Linux amd64
images on pushes to `main` and `chore/mittwald-staging`, and supports manual
dispatch after merging. Images are tagged
`ghcr.io/hubertoink/instatic:staging-<full-commit-sha>`. The Docker build runs
TypeScript checking and the production frontend build. It does not run tests
or lint; those remain separate verification steps.

The upstream release workflow still targets `ghcr.io/corebunch/instatic`;
do not create release tags to publish fork images. The fork workflow only
publishes images and does not change a running Mittwald container.

Mittwald needs an image available in a registry, persistent storage, HTTPS
routing and the application environment described in [docker-image.md](docker-image.md).
For a copy of the existing SQLite installation, preserve the data and uploads
volumes and its secret encryption key using [backup-restore.md](backup-restore.md).

Publishing inside a local CMS instance does not deploy that instance to Mittwald.
An online staging instance publishes to its own staging site.

## Validation at initial handoff

The production Docker build (TypeScript and Vite), ESLint, targeted content tests,
and desktop/mobile lightbox checks passed locally. The full Windows test run
was not green; unrelated architecture, platform and UI failures remain for
review. Consult the draft pull request for the handoff results.
