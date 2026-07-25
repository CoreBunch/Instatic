# Publish Static Output with DeployHQ

Instatic runs the editor and content engine on your own server, but everything a
visitor sees is plain static HTML and CSS written to `published/current`. That
output is a perfect fit for a separate, fast public host: keep the CMS private
(behind auth, on a small box) and serve the published site from a CDN-backed
bucket or a hardened web server.

[DeployHQ](https://www.deployhq.com/?utm_source=instatic-docs&utm_medium=referral&utm_campaign=instatic-integration&utm_content=intro-link)
automates that last hop. It watches a Git repository, uploads only the files that
changed, and gives you [atomic, zero-downtime deployments](https://www.deployhq.com/features/zero-downtime-deployments?utm_source=instatic-docs&utm_medium=referral&utm_campaign=instatic-integration&utm_content=zero-downtime-link)
with [one-click rollback](https://www.deployhq.com/features/one-click-rollback?utm_source=instatic-docs&utm_medium=referral&utm_campaign=instatic-integration&utm_content=rollback-link)
if a publish goes wrong. This guide covers the static-output path — it does **not**
replace [vps.md](vps.md), which is how you run the CMS server itself.

## TL;DR

| Target | Use when | DeployHQ mode | Persistent storage |
|---|---|---|---|
| S3 / R2 / Spaces bucket | Public site served from a CDN, lowest ops | [Static hosting](https://www.deployhq.com/features/static-hosting?utm_source=instatic-docs&utm_medium=referral&utm_campaign=instatic-integration&utm_content=static-hosting-link) | Bucket (managed) |
| Your own web server | You already run nginx/Caddy on a VPS | [SSH/SFTP deployment](https://www.deployhq.com/features/ssh-deployment?utm_source=instatic-docs&utm_medium=referral&utm_campaign=instatic-integration&utm_content=ssh-deployment-link) | Server disk |

Both paths deploy from the same Git repository of published files and both support
post-deploy hooks (for example, purging a CDN cache).

## How it fits

```txt
Instatic (private)          Git repo                 Public host
┌──────────────────┐        ┌──────────────┐         ┌──────────────────┐
│ edit + publish   │  push  │ published    │ DeployHQ│ S3 / R2 / Spaces │
│ published/current├───────▶│ static files ├────────▶│  or  web server  │
└──────────────────┘        └──────────────┘         └──────────────────┘
```

DeployHQ deploys **from Git**, so the one piece of glue you provide is getting the
contents of `published/current` into a repository. That is a small, boring step —
see below.

## Prerequisites

- An Instatic instance that publishes to `published/current` (any of the
  [deployment](README.md) targets).
- A Git repository (GitHub, GitLab, Bitbucket, or self-hosted) to hold the
  published output. Keep it separate from your application repo.
- A DeployHQ account and one of:
  - an S3-compatible bucket (AWS S3, Cloudflare R2, DigitalOcean Spaces), or
  - a server you can reach over SSH/SFTP.

## Step 1 — Get the published output into Git

Sync `published/current` into a clean deploy repository and push. On the box that
runs Instatic (or a CI job that has access to the published volume):

```bash
# one-time
git clone git@github.com:you/your-site-published.git deploy && cd deploy

# each publish
rsync -a --delete /path/to/instatic/published/current/ ./
git add -A
git commit -m "Publish $(date -u +%FT%TZ)" || echo "nothing changed"
git push
```

Run it on a schedule, on a webhook after you publish in Instatic, or by hand — the
mechanism does not matter to DeployHQ, only that new commits land on the branch it
watches.

> Prefer to build assets on the way out (minify, fingerprint, generate a sitemap)?
> Point DeployHQ at this repo and add those steps to a
> [build pipeline](https://www.deployhq.com/features/build-pipelines?utm_source=instatic-docs&utm_medium=referral&utm_campaign=instatic-integration&utm_content=build-pipeline-link),
> which runs in an isolated container before anything is uploaded.

## Step 2 — Connect the repository to DeployHQ

1. Create a new DeployHQ project and connect the published repository.
2. Set the branch DeployHQ deploys from (for example, `main`).
3. Enable automatic deployments so every push publishes without a manual click.

## Step 3 — Choose a deployment target

**Bucket + CDN (recommended for public sites).** Configure a
[static hosting](https://www.deployhq.com/features/static-hosting?utm_source=instatic-docs&utm_medium=referral&utm_campaign=instatic-integration&utm_content=static-hosting-target)
destination pointing at your S3, R2, or Spaces bucket. DeployHQ uploads only the
changed files, so publishes stay fast even on a large site. Front it with a CDN and
point your public domain at the CDN.

**Your own web server.** Add an
[SSH/SFTP](https://www.deployhq.com/features/ssh-deployment?utm_source=instatic-docs&utm_medium=referral&utm_campaign=instatic-integration&utm_content=ssh-deployment-target)
server in DeployHQ with the deploy path your web server serves (for example,
`/var/www/site`). Deployments are atomic — the new release is assembled and swapped
in, so visitors never see a half-written directory.

## Step 4 — Post-deploy hooks (optional)

To purge a CDN cache or ping a health check after each publish, add a
[post-deploy SSH command](https://www.deployhq.com/support/ssh-commands?utm_source=instatic-docs&utm_medium=referral&utm_campaign=instatic-integration&utm_content=ssh-commands-link).
DeployHQ can run commands before files change, after upload but before the release
goes live, and after the release is live.

## Rollback

If a publish ships broken markup, use
[one-click rollback](https://www.deployhq.com/features/one-click-rollback?utm_source=instatic-docs&utm_medium=referral&utm_campaign=instatic-integration&utm_content=rollback-target)
to redeploy the previous release. Because deployments are atomic, rollback is an
instant pointer swap, not a re-upload.

## Runtime notes

- **This deploys output, not state.** Your Instatic database and uploads volume
  still live with the CMS server — back them up per [backup-restore.md](backup-restore.md).
- **The CMS host and the public host are different origins.** `PUBLIC_ORIGIN` on
  the CMS configures the origins its CSRF check trusts (where you reach the admin) —
  it is not the public URL of the static site. After the first publish, open the
  deployed site and confirm internal links, assets, and any sitemap resolve against
  your public host; fix absolute URLs at their source in Instatic, not in DeployHQ.
- **Uploaded media** under the published output ships with the static files; media
  you reference from outside `published/current` must be reachable from the public
  origin.

## Troubleshooting

| Symptom | Check |
|---|---|
| Nothing deploys after publish | The sync step in Step 1 actually committed and pushed; DeployHQ is watching that branch |
| Old pages still served | CDN cache not purged — add the post-deploy hook in Step 4 |
| Links or assets point at the wrong host | Absolute URLs in the output reference the CMS origin — correct them at the source in Instatic |
| Deploy uploads everything every time | Line-ending or timestamp churn in the deploy repo; commit only real content changes |

## Related

- [vps.md](vps.md) — run the Instatic CMS server itself
- [backup-restore.md](backup-restore.md) — protect database and uploads
- [Deploy a static site with DeployHQ](https://www.deployhq.com/guides/hugo?utm_source=instatic-docs&utm_medium=referral&utm_campaign=instatic-integration&utm_content=related-guide) — worked example (Hugo, same pattern)
- [Start deploying free](https://www.deployhq.com/signup?utm_source=instatic-docs&utm_medium=referral&utm_campaign=instatic-integration&utm_content=signup-cta) — create a DeployHQ account
