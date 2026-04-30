# Page Builder

A React-based website and web app builder with an editor workspace, project-level database workspace, resource management screens, and managed publishing.

## Development

```bash
bun install
bun run dev
```

The Vite dev server also serves the MVP publishing API at `/api/publish`.

## Managed Publishing

Publishing is server-side and uses:

- Vercel for generated React/Vite frontends.
- Convex for managed backend tables when a project has data tables.

Create `.env.local` from `.env.example` and set:

- `VERCEL_TOKEN`: Vercel API token used to create projects and deployments.
- `VERCEL_TEAM_ID`: optional Vercel team id or slug.
- `CONVEX_DEPLOY_KEY`: Convex deploy key for non-interactive backend deploys.
- `CONVEX_URL`: optional fixed Convex deployment URL. If omitted, the publish service captures the URL from `convex deploy --cmd`.
- `CONVEX_PREVIEW_DEPLOYMENTS`: set to `true` to create named Convex preview deployments per project.

The publish workflow compiles the editor project into a temporary React/Vite bundle, deploys Convex first when needed, writes the public `VITE_CONVEX_URL` into the frontend bundle, and then deploys the frontend through the Vercel REST API.

## Verification

```bash
bun run build
bun test
```
