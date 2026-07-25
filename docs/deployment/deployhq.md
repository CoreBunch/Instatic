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

Serving the published output from a **different origin than the CMS** works cleanly
for fully static sites, but two Instatic behaviours need attention first:

- **Dynamic "hole" nodes.** Pages that contain request-dependent nodes export as a
  shell whose runtime script fetches `/_instatic/hole/<nodeId>` **from the page's own
  origin** (`server/publish/holeRuntime.ts`). On a separate static host that endpoint
  does not exist, so the placeholder never resolves. Use this pattern only if your
  site is hole-free, **or** proxy `/_instatic/hole/*` (and `/_instatic/hole-runtime.js`)
  from the public origin back to the CMS, forwarding the request cookies the hole
  depends on.
- **Local uploads live outside the publish slot.** The slot under `published/current`
  is HTML plus generated CSS/runtime assets; media stays referenced as raw
  `/uploads/…` paths (`server/publish/mediaPrefetch.ts`). Those files are **not**
  inside `published/current`, so you must ship them too or route `/uploads/*` to the
  CMS (Step 1 and Step 3/4 below).

If your site uses external object storage for media and has no dynamic holes, both
caveats fall away.

## TL;DR

| Target | Use when | Clean-URL routing | DeployHQ mode |
|---|---|---|---|
| Your own web server | You run nginx/Caddy on a VPS; the robust default | Native (`try_files … .html`) | [SSH/SFTP deployment](https://www.deployhq.com/features/ssh-deployment?utm_source=instatic-docs&utm_medium=referral&utm_campaign=instatic-integration&utm_content=ssh-deployment-link) |
| S3 / R2 / Spaces + CDN | Lowest ops, CDN-served | Requires a CDN rewrite (below) | [Static hosting](https://www.deployhq.com/features/static-hosting?utm_source=instatic-docs&utm_medium=referral&utm_campaign=instatic-integration&utm_content=static-hosting-link) |

Both deploy from the same Git repository of published files and both support
post-deploy hooks (for example, purging a CDN cache).

## How it fits

```txt
Instatic (private)              Git repo                    Public host
┌──────────────────────┐       ┌────────────────┐          ┌────────────────────┐
│ publish →            │ push  │ published/     │ DeployHQ  │ web server (nginx) │
│   published/current  ├──────▶│ current + any  ├─────────▶│   or bucket + CDN  │
│ UPLOADS_DIR (media)  │       │ /uploads media │          │                    │
└──────────────────────┘       └────────────────┘          └────────────────────┘
```

DeployHQ deploys **from Git**, so the glue you provide is assembling the deploy
artifact — the publish slot plus the public uploads it references — into a
repository.

## Prerequisites

- An Instatic instance that publishes to `published/current` (any of the
  [deployment](README.md) targets).
- You know whether the site uses dynamic hole nodes (see Site compatibility).
- A Git repository (GitHub, GitLab, Bitbucket, or self-hosted) to hold the deploy
  artifact. Keep it separate from your application repo.
- A DeployHQ account and one of:
  - a server you can reach over SSH/SFTP, or
  - an S3-compatible bucket (AWS S3, Cloudflare R2, DigitalOcean Spaces).

## Step 1 — Assemble the deploy artifact

Sync the publish slot **and the public uploads it references** into a clean deploy
repository, then push. On the box that runs Instatic (or a CI job with access to the
CMS `UPLOADS_DIR`):

```bash
# one-time
git clone git@github.com:you/your-site-published.git deploy && cd deploy

# each publish
rsync -a --delete "$UPLOADS_DIR/published/current/" ./            # pages, CSS, runtime, 404.html
rsync -a          "$UPLOADS_DIR/uploads/"           ./uploads/    # media referenced as /uploads/...
git add -A
git commit -m "Publish $(date -u +%FT%TZ)" || echo "nothing changed"
git push
```

The exported slot includes a `404.html` (the Netlify/GitHub-Pages convention) so
hosts that fall back on 404 keep working. Adjust the `uploads/` source to wherever
your CMS stores media; the goal is that every `/uploads/…` path the pages reference
resolves at the public origin. If you'd rather not copy media at all, skip the second
`rsync` and instead route `/uploads/*` to the CMS at the public origin (Step 3/4).

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

A web server resolves Instatic's `about.html` / `posts/hello.html` layout natively.
With nginx:

```txt
location / {
    try_files $uri $uri.html $uri/index.html =404;
}
error_page 404 /404.html;

# only if you did NOT copy media in Step 1:
# location /uploads/ { proxy_pass https://cms.internal; }
```

Caddy: `try_files {path} {path}.html {path}/index.html` with `handle_errors` serving
`/404.html`.

## Step 4 — Or deploy to a bucket + CDN

Configure a
[static hosting](https://www.deployhq.com/features/static-hosting?utm_source=instatic-docs&utm_medium=referral&utm_campaign=instatic-integration&utm_content=static-hosting-target)
destination pointing at your S3, R2, or Spaces bucket, front it with a CDN, and point
your public domain at the CDN. DeployHQ uploads only the changed files.

Buckets do **exact object-key lookup**, so extensionless routes (`/about`) will not
resolve against `about.html` on their own. Add a CDN rewrite (CloudFront Function,
Cloudflare Worker, or equivalent):

- `/` and paths ending `/` → append `index.html`
- any other extensionless path → append `.html`
- unmatched → serve `404.html`

Media copied in Step 1 lands under `uploads/` in the bucket; otherwise add a CDN rule
routing `/uploads/*` to the CMS origin.

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
- **Dynamic holes and uploads** are the two things that break silently across origins
  — re-read Site compatibility if a page renders but a region stays blank or an image
  404s.

## Troubleshooting

| Symptom | Check |
|---|---|
| Nothing deploys after publish | Step 1 actually committed and pushed; DeployHQ is watching that branch |
| Pages 404 on a bucket, homepage works | Extensionless routes need the Step 4 CDN rewrite to `.html` |
| Images / fonts 404 | Public `/uploads/…` objects not shipped (Step 1) or not routed to the CMS |
| A region renders blank / stuck on placeholder | Dynamic hole node calling `/_instatic/hole/*` on an origin with no CMS — see Site compatibility |
| Old pages still served | CDN cache not purged — add the Step 5 post-deploy hook |

## Related

- [vps.md](vps.md) — run the Instatic CMS server itself
- [backup-restore.md](backup-restore.md) — protect database and uploads
- [Deploy a static site with DeployHQ](https://www.deployhq.com/guides/hugo?utm_source=instatic-docs&utm_medium=referral&utm_campaign=instatic-integration&utm_content=related-guide) — worked example (Hugo, same pattern)
- [Start deploying free](https://www.deployhq.com/signup?utm_source=instatic-docs&utm_medium=referral&utm_campaign=instatic-integration&utm_content=signup-cta) — create a DeployHQ account
