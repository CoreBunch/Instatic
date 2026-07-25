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
`404.html`). Two things it references still resolve **against the CMS origin**, so
serving the slot from a different origin needs a plan for them:

- **Media / uploads.** With the default local adapter, media is served at
  `/uploads/<path>` from the CMS `UPLOADS_DIR` (`server/router.ts` strips `/uploads`
  and resolves against that dir), and plugin bundles live under `/uploads/plugins/…`.
  Object-storage adapters that use `servingMode: 'signed-redirect'` instead serve
  `/_instatic/media/<adapterId>/<path>` via CMS-generated signed redirects. In both
  cases those URLs 404 on a separate origin unless you **route them to the CMS**
  (Step 3/4). Only a `public-url` object-storage adapter — whose media already lives
  on its own public CDN URL — removes this entirely.
- **Dynamic "hole" nodes.** Pages with request-dependent nodes export as a shell
  whose runtime fetches `/_instatic/hole/<nodeId>` **from the page's own origin**
  (`server/publish/holeRuntime.ts`). On a separate static host that endpoint does not
  exist, so the placeholder never resolves. Use this pattern only if your site is
  hole-free, **or** proxy `/_instatic/hole/*` (and `/_instatic/hole-runtime.js`) from
  the public origin to the CMS, forwarding the request cookies the hole depends on.

## TL;DR

| Target | Use when | Clean-URL routing | DeployHQ mode |
|---|---|---|---|
| Your own web server | You run nginx/Caddy on a VPS; the robust default | Native (`try_files … .html`) | [SSH/SFTP deployment](https://www.deployhq.com/features/ssh-deployment?utm_source=instatic-docs&utm_medium=referral&utm_campaign=instatic-integration&utm_content=ssh-deployment-link) |
| S3 / R2 / Spaces + CDN | Lowest ops, CDN-served | Requires a CDN rewrite (below) | [Static hosting](https://www.deployhq.com/features/static-hosting?utm_source=instatic-docs&utm_medium=referral&utm_campaign=instatic-integration&utm_content=static-hosting-link) |

Both deploy the `published/current` slot from a Git repository, route media to the
CMS, and support post-deploy hooks (for example, purging a CDN cache).

## How it fits

```txt
Instatic (private CMS)            Git repo             Public host
┌────────────────────┐   push    ┌────────────┐ DeployHQ ┌──────────────────────┐
│ published/current  ├──────────▶│ deploy repo├─────────▶│ web server / bucket  │
│ UPLOADS_DIR media  │           └────────────┘          │  + CDN               │
└─────────┬──────────┘                                   └───────────┬──────────┘
          │              /uploads/* and /_instatic/media/*           │
          └───────────────────  routed back to CMS  ◀────────────────┘
```

DeployHQ deploys the publish slot; media stays on the CMS and is reached by routing
`/uploads/*` (and `/_instatic/media/*` for signed-redirect adapters) at the public
origin.

## Prerequisites

- An Instatic instance that publishes to `published/current` (any of the
  [deployment](README.md) targets).
- You know whether the site uses dynamic hole nodes, and which media adapter it uses
  (see Site compatibility).
- A Git repository (GitHub, GitLab, Bitbucket, or self-hosted) to hold the publish
  slot. Keep it separate from your application repo.
- A DeployHQ account and one of:
  - a server you can reach over SSH/SFTP, or
  - an S3-compatible bucket (AWS S3, Cloudflare R2, DigitalOcean Spaces).

## Step 1 — Push the publish slot to Git

Sync the slot into a clean deploy repository and push. Exclude `.git` so the
`--delete` pass does not wipe the repository's own metadata. On the box that runs
Instatic (or a CI job with access to the CMS `UPLOADS_DIR`):

```bash
# one-time
git clone git@github.com:you/your-site-published.git deploy && cd deploy

# each publish
rsync -a --delete --exclude='.git' "$UPLOADS_DIR/published/current/" ./
git add -A
git commit -m "Publish $(date -u +%FT%TZ)" || echo "nothing changed"
git push
```

The slot includes a `404.html` (the Netlify/GitHub-Pages convention) so hosts that
fall back on 404 keep working. Media is **not** copied here — it is served from the
CMS via routing (Step 3/4), which avoids shipping non-public objects from
`UPLOADS_DIR`.

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
and can proxy media to the CMS. With nginx:

```txt
location / {
    try_files $uri $uri.html $uri/index.html =404;
}
error_page 404 /404.html;

# route media to the CMS (skip if you use a public-url object-storage adapter)
location /uploads/         { proxy_pass https://cms.internal; }
location /_instatic/media/ { proxy_pass https://cms.internal; }   # signed-redirect adapters
```

Caddy: `try_files {path} {path}.html {path}/index.html` with `handle_errors` serving
`/404.html`, plus `reverse_proxy /uploads/* /_instatic/media/* https://cms.internal`.

## Step 4 — Or deploy to a bucket + CDN

Configure a
[static hosting](https://www.deployhq.com/features/static-hosting?utm_source=instatic-docs&utm_medium=referral&utm_campaign=instatic-integration&utm_content=static-hosting-target)
destination pointing at your S3, R2, or Spaces bucket, front it with a CDN, and point
your public domain at the CDN. DeployHQ uploads only the changed files.

Buckets do **exact object-key lookup**, so add a CDN rewrite (CloudFront Function,
Cloudflare Worker, or equivalent):

- `/` and paths ending `/` → append `index.html`
- any other extensionless path → append `.html`
- unmatched → serve `404.html`
- `/uploads/*` and `/_instatic/media/*` → route to the CMS origin (skip only for a
  `public-url` object-storage adapter, whose media is already on a public URL)

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

## Runtime notes

- **This deploys output, not state.** Your Instatic database and uploads volume still
  live with the CMS server — back them up per [backup-restore.md](backup-restore.md).
- **The CMS host and the public host are different origins.** `PUBLIC_ORIGIN` on the
  CMS configures the origins its CSRF check trusts (where you reach the admin) — it is
  not the public URL of the static site. After the first publish, open the deployed
  site and confirm links, images, and any sitemap resolve against the public host.
- **Media and dynamic holes** are what break silently across origins — re-read Site
  compatibility if an image 404s or a region stays blank.

## Troubleshooting

| Symptom | Check |
|---|---|
| Nothing deploys after publish | Step 1 actually committed and pushed; DeployHQ is watching that branch |
| Pages 404 on a bucket, homepage works | Extensionless routes need the Step 4 CDN rewrite to `.html` |
| Images / fonts / plugin assets 404 | `/uploads/*` (and `/_instatic/media/*` for signed-redirect) not routed to the CMS |
| A region renders blank / stuck on placeholder | Dynamic hole node calling `/_instatic/hole/*` on an origin with no CMS — see Site compatibility |
| Old pages still served | CDN cache not purged — add the Step 5 post-deploy hook |

## Related

- [vps.md](vps.md) — run the Instatic CMS server itself
- [backup-restore.md](backup-restore.md) — protect database and uploads
- [Deploy a static site with DeployHQ](https://www.deployhq.com/guides/hugo?utm_source=instatic-docs&utm_medium=referral&utm_campaign=instatic-integration&utm_content=related-guide) — worked example (Hugo, same pattern)
- [Start deploying free](https://www.deployhq.com/signup?utm_source=instatic-docs&utm_medium=referral&utm_campaign=instatic-integration&utm_content=signup-cta) — create a DeployHQ account
