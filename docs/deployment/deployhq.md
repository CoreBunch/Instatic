# Publish Static Output with DeployHQ

Instatic runs the editor and content engine on your own server, but the public site
is plain static HTML and CSS written to `published/current`. That output is a good
fit for a separate, fast public host: keep the CMS private (behind auth, on a small
box) and serve the published site from a hardened web server or a CDN-backed bucket.

[DeployHQ](https://www.deployhq.com/?utm_source=instatic-docs&utm_medium=referral&utm_campaign=instatic-integration&utm_content=intro-link)
automates that last hop. It watches a Git repository, uploads only the files that
changed, and gives you [atomic, zero-downtime deployments](https://www.deployhq.com/features/zero-downtime-deployments?utm_source=instatic-docs&utm_medium=referral&utm_campaign=instatic-integration&utm_content=zero-downtime-link)
with [one-click rollback](https://www.deployhq.com/features/one-click-rollback?utm_source=instatic-docs&utm_medium=referral&utm_campaign=instatic-integration&utm_content=rollback-link).
This guide covers the static-output path — it does **not** replace [vps.md](vps.md),
which is how you run the CMS server itself.

## Site compatibility — read first

The `published/current` slot is self-contained HTML, CSS, and runtime assets (plus a
`404.html` when a not-found template is published), but exported pages call
**CMS-backed endpoints at runtime**. Served from
a different origin than the CMS, those requests 404 unless you route them back.

- **Best case — fully static.** A site with no forms, no dynamic "hole" nodes, no
  load-more loops, no dynamic modules, and `public-url` object-storage media deploys
  with **zero proxying**. This is the clean path.
- **Anything dynamic must be routed to the CMS.** Exported pages reference these
  CMS-backed routes:
  - **Media** — `/uploads/*` (default local adapter; `server/router.ts` strips
    `/uploads` and resolves against `UPLOADS_DIR`), or `/_instatic/media/*` for
    object-storage adapters using `servingMode: 'signed-redirect'`.
  - **Runtime endpoints under `/_instatic/*`** — holes (`/_instatic/hole/*` +
    `/_instatic/hole-runtime.js`), forms (`/_instatic/form/*`), load-more loops
    (`/_instatic/loop/*`), dynamic module JS (`/_instatic/module-js/*`), and shared
    `/_instatic/runtime|css|assets/*`.
  - **Holes additionally** need the request cookies forwarded, since the response is
    request-dependent.
- **Never expose the editor/admin surface** on the public origin — keep `/admin/*`
  and the MCP editor bridge `/_instatic/mcp` private (Step 3/4 block them).

If your site leans heavily on these dynamic features, note that every one erodes the
"static site, private CMS" split — the more you must proxy, the more running behind
the CMS (or the [vps.md](vps.md) setup) may be simpler.

## TL;DR

| Target | Use when | Clean-URL routing | DeployHQ mode |
|---|---|---|---|
| Your own web server | You run nginx/Caddy on a VPS; the robust default | Native (`try_files … .html`) | [SSH/SFTP deployment](https://www.deployhq.com/features/ssh-deployment?utm_source=instatic-docs&utm_medium=referral&utm_campaign=instatic-integration&utm_content=ssh-deployment-link) |
| S3 / R2 / Spaces + CDN | Lowest ops, CDN-served | Requires a CDN rewrite (below) | [Static hosting](https://www.deployhq.com/features/static-hosting?utm_source=instatic-docs&utm_medium=referral&utm_campaign=instatic-integration&utm_content=static-hosting-link) |

Both deploy the `published/current` slot from a Git repository, route any dynamic
endpoints to the CMS, and support post-deploy hooks (for example, purging a CDN
cache).

## How it fits

```txt
Instatic (private CMS)            Git repo             Public host
┌────────────────────┐   push    ┌────────────┐ DeployHQ ┌──────────────────────┐
│ published/current  ├──────────▶│ deploy repo├─────────▶│ web server / bucket  │
│ dynamic endpoints  │           └────────────┘          │  + CDN               │
└─────────┬──────────┘                                   └───────────┬──────────┘
          │        /uploads/* and public /_instatic/* routed         │
          └────────────────────  back to CMS  ◀─────────────────────-┘
```

DeployHQ deploys the publish slot; anything dynamic stays on the CMS and is reached
by routing the relevant endpoints at the public origin.

## Prerequisites

- An Instatic instance that publishes to `published/current` (any of the
  [deployment](README.md) targets).
- You know which dynamic features the site uses (forms, holes, loops, dynamic
  modules) and which media adapter it uses (see Site compatibility).
- A Git repository (GitHub, GitLab, Bitbucket, or self-hosted) to hold the publish
  slot. Keep it separate from your application repo.
- A DeployHQ account and one of:
  - a server you can reach over SSH/SFTP, or
  - an S3-compatible bucket (AWS S3, Cloudflare R2, DigitalOcean Spaces).

## Step 1 — Push the publish slot to Git

Sync the slot into a clean deploy repository and push. Exclude `.git` so the
`--delete` pass does not wipe the repository's own metadata, and let real commit
failures abort the job instead of silently deploying the previous release. On the box
that runs Instatic (or a CI job with access to the CMS `UPLOADS_DIR`):

```bash
# one-time
git clone git@github.com:you/your-site-published.git deploy && cd deploy

# each publish
set -euo pipefail
rsync -a --delete --exclude='.git' "$UPLOADS_DIR/published/current/" ./
git add -A
if git diff --cached --quiet; then
  echo "nothing to publish"
else
  git commit -m "Publish $(date -u +%FT%TZ)"
  git push
fi
```

The slot includes a `404.html` **only if you have published a not-found template**
(`publishSite` skips it otherwise) — so if you rely on the 404 fallback in Step 3/4,
create and publish a not-found template first. Dynamic endpoints are **not** copied
here — they are served from the CMS via routing (Step 3/4).

> Want to build assets on the way out (minify, fingerprint, generate a sitemap)?
> Add those steps to a
> [build pipeline](https://www.deployhq.com/features/build-pipelines?utm_source=instatic-docs&utm_medium=referral&utm_campaign=instatic-integration&utm_content=build-pipeline-link),
> which runs in an isolated container before anything is uploaded.

## Step 2 — Connect the repository to DeployHQ

1. Create a new DeployHQ project and connect the deploy repository.
2. Set the branch DeployHQ deploys from (for example, `main`).
3. Enable automatic deployments so every push publishes without a manual click.

## Step 3 — Deploy to your own web server (recommended)

Add an
[SSH/SFTP](https://www.deployhq.com/features/ssh-deployment?utm_source=instatic-docs&utm_medium=referral&utm_campaign=instatic-integration&utm_content=ssh-deployment-target)
server in DeployHQ with the deploy path your web server serves (for example
`/var/www/site`). Deployments are atomic — the new release is assembled and swapped
in, so visitors never see a half-written directory.

A web server resolves Instatic's `about.html` / `posts/hello.html` layout natively
and can proxy the dynamic endpoints to the CMS. With nginx:

```txt
location / {
    try_files $uri $uri.html $uri/index.html =404;
}
error_page 404 /404.html;   # requires a published not-found template (see Step 1)

# non-root trailing slash → canonical path (pages are baked as <path>.html)
location ~ ^(.+)/$ { return 301 $1$is_args$args; }

# keep the editor/admin surface private (^~ so the redirect regex above can't intercept)
location = /_instatic/mcp { return 404; }
location ^~ /admin/       { return 404; }

# route dynamic endpoints to the CMS
# (skip /uploads if you use a public-url object-storage adapter,
#  and skip /_instatic entirely if the site is fully static)
location ^~ /uploads/   { proxy_pass https://cms.internal; }
location ^~ /_instatic/ { proxy_pass https://cms.internal; }
```

Caddy is equivalent: `try_files {path} {path}.html {path}/index.html`, `handle_errors`
serving `/404.html`, `respond /_instatic/mcp* 404`, and
`reverse_proxy /uploads/* /_instatic/* https://cms.internal`.

## Step 4 — Or deploy to a bucket + CDN

Configure a
[static hosting](https://www.deployhq.com/features/static-hosting?utm_source=instatic-docs&utm_medium=referral&utm_campaign=instatic-integration&utm_content=static-hosting-target)
destination pointing at your S3, R2, or Spaces bucket, front it with a CDN, and point
your public domain at the CDN. DeployHQ uploads only the changed files.

Buckets do **exact object-key lookup**, so add a CDN rewrite (CloudFront Function,
Cloudflare Worker, or equivalent):

- root `/` → serve `index.html`
- non-root path ending `/` → 301 to the same path without the trailing slash (pages
  are baked as `<path>.html`, not `<path>/index.html`)
- any other extensionless path → serve `<path>.html`, falling back to
  `<path>/index.html` for real directory pages
- unmatched → serve `404.html` (only if a not-found template was published; see Step 1)
- `/uploads/*` and the public `/_instatic/*` runtime routes → route to the CMS origin
  (skip `/uploads` for a `public-url` adapter; skip `/_instatic` for a fully static
  site). **Do not** route `/admin/*` or `/_instatic/mcp` to the public CDN.

## Step 5 — Post-deploy hooks (optional)

To purge a CDN cache or ping a health check after each publish, add a
[post-deploy SSH command](https://www.deployhq.com/support/ssh-commands?utm_source=instatic-docs&utm_medium=referral&utm_campaign=instatic-integration&utm_content=ssh-commands-link).
DeployHQ can run commands before files change, after upload but before the release
goes live, and after the release is live.

## Rollback

If a publish ships broken markup, use
[one-click rollback](https://www.deployhq.com/features/one-click-rollback?utm_source=instatic-docs&utm_medium=referral&utm_campaign=instatic-integration&utm_content=rollback-target)
to redeploy the previous release. Because deployments are atomic, rollback is an
instant pointer swap, not a re-upload.

Rollback restores the deployed **files** only. For a fully static site that is a
complete recovery. If the site uses dynamic endpoints, the CMS's published snapshot
and `publishVersion` are unchanged, so a rolled-back shell can go stale — holes serve
sentinels for an obsolete `?v=`, while forms and module JS resolve against the latest
CMS snapshot. Pair a rollback of a dynamic site with a coordinated CMS rollback.

## Runtime notes

- **This deploys output, not state.** Your Instatic database and uploads volume still
  live with the CMS server — back them up per [backup-restore.md](backup-restore.md).
- **`PUBLIC_ORIGIN` and proxied forms.** `PUBLIC_ORIGIN` is the CMS's comma-separated
  list of CSRF-trusted origins — it is not by itself the public URL of the static
  site. But if you proxy CSRF-checked endpoints (forms) from the public origin to the
  CMS, you **must add the deployed public origin to `PUBLIC_ORIGIN`** alongside the
  admin origin, or proxied form challenge/submit requests return 403. After the first
  publish, open the deployed site and confirm links, images, forms, and any sitemap
  resolve against the public host.
- **Dynamic endpoints are what break silently across origins** — re-read Site
  compatibility if an image 404s, a form fails to submit, or a region stays blank.

## Troubleshooting

| Symptom | Check |
|---|---|
| Nothing deploys after publish | Step 1 actually committed and pushed; DeployHQ is watching that branch |
| Pages 404 on a bucket, homepage works | Extensionless routes need the Step 4 CDN rewrite to `.html` |
| Images / fonts / plugin assets 404 | `/uploads/*` (or `/_instatic/media/*` for signed-redirect) not routed to the CMS |
| Forms don't submit / load-more does nothing | `/_instatic/form/*` and `/_instatic/loop/*` not routed to the CMS |
| Forms return 403 | The deployed public origin isn't in the CMS `PUBLIC_ORIGIN` list — add it (comma-separated) |
| A region renders blank / stuck on placeholder | Dynamic hole node calling `/_instatic/hole/*` on an origin with no CMS — see Site compatibility |
| Old pages still served | CDN cache not purged — add the Step 5 post-deploy hook |

## Related

- [vps.md](vps.md) — run the Instatic CMS server itself
- [backup-restore.md](backup-restore.md) — protect database and uploads
- [Deploy a static site with DeployHQ](https://www.deployhq.com/guides/hugo?utm_source=instatic-docs&utm_medium=referral&utm_campaign=instatic-integration&utm_content=related-guide) — worked example (Hugo, same pattern)
- [Start deploying free](https://www.deployhq.com/signup?utm_source=instatic-docs&utm_medium=referral&utm_campaign=instatic-integration&utm_content=signup-cta) — create a DeployHQ account
