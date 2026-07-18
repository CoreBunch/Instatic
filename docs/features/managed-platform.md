# Managed Platform

The managed platform is Instatic's agency-facing control plane. It gives one
account a list of client projects without distributing the builder source. A
customer can export and host the website produced by a project, while the
editor, CMS APIs, WorkOS integration, AI providers, and provisioning logic stay
inside the private Instatic service.

This is the Webflow-like ownership model: the customer owns the site output and
can deploy it elsewhere; access to that output does not grant access to the
software that produced it.

---

## Boundaries

```text
Instatic managed service
  /app     agency control plane
           accounts, organizations, project catalog, permissions,
           source connections, environments, revision metadata

  /admin   private builder workspace
           visual editor, CMS APIs, site database, plugins, AI tools

Customer-owned website deployment
  artifact/routes/**
  artifact/assets/**
  artifact/media/**
  artifact/.instatic/site-artifact.json
  site-runtime/**
```

The managed platform and builder can initially run in one Bun process, but they
are separate modules, databases, routes, and Vite entries. That is a migration
shape, not the final hosting constraint. A later deployment can move builder
workspaces to isolated workers without changing the `/app` contract.

The exported website is already a physical deployment boundary. `bun run
site:export` produces a database-free Docker context. Architecture tests reject
platform, builder, database, auth, and provider imports from `site-runtime/`.

---

## Current Milestone

Implemented now:

- `/app` agency dashboard with project search and project creation
- separate Vite entry (`platform.html`) and separate API namespace
- independent control-plane database and migration history
- WorkOS AuthKit PKCE sign-in with sealed, HTTP-only sessions
- WorkOS organization synchronization and first-member ownership
- local development identity with no external authentication dependency
- organization and project roles
- initial project revision plus preview and production environment records
- source intent for Instatic-managed, GitHub, local bridge, and GitHub bridge
- production configuration that fails closed when WorkOS is incomplete

Not implemented yet:

- GitHub App installation and repository selection
- local bridge daemon, pairing, and file synchronization
- workspace provisioning or process isolation
- opening a project in an assigned builder workspace
- artifact upload, deployment jobs, custom domains, or Railway API calls
- organization switcher, invitations, and project member management UI

The source selector therefore records how a project will be connected; it does
not claim the connection is active. New projects remain `unprovisioned` until a
future provisioner assigns a workspace.

---

## Request Flow

The platform owns two exclusive namespaces:

| Route | Purpose |
|---|---|
| `GET /app/auth/login` | Start WorkOS AuthKit PKCE login |
| `GET /app/auth/callback` | Consume one-time state, exchange code, seal session |
| `GET /app/api/session` | Synchronize user and active organization |
| `POST /app/api/logout` | Clear the session and return the provider logout URL |
| `POST /app/api/organizations` | Create the first WorkOS organization |
| `GET /app/api/projects` | List projects visible to the active user |
| `POST /app/api/projects` | Create a project, revision, and environments |
| `GET /app/*` | Serve the project-dashboard SPA |

State-changing routes use the same origin defense as the CMS. Production
sessions are WorkOS sealed sessions in `instatic_platform_session`, scoped to
`Path=/app`, `HttpOnly`, `SameSite=Lax`, and `Secure` for HTTPS callbacks. Login
state and PKCE verifiers are stored server-side as short-lived, one-time
records; only a SHA-256 digest of the opaque state is persisted.

The existing CMS session remains scoped to `/admin`. A platform login is not a
CMS owner login and does not expose `/admin/api/*`.

---

## Data Model

Control-plane tables use the `platform_` prefix and live in the database chosen
by `CONTROL_PLANE_DATABASE_URL`:

| Table | Responsibility |
|---|---|
| `platform_users` | WorkOS or local identities |
| `platform_organizations` | Agency account mirror |
| `platform_organization_memberships` | owner/admin/member/guest access |
| `platform_projects` | client project catalog and workspace state |
| `platform_project_memberships` | per-project operational role |
| `platform_project_revisions` | immutable project-source/artifact timeline |
| `platform_project_connections` | GitHub, local bridge, and Railway metadata |
| `platform_environments` | preview and production deployment targets |
| `platform_auth_attempts` | short-lived WorkOS PKCE verifier storage |

Organization owners and admins can list all projects in their organization.
Members see only projects with an explicit project membership. Guests cannot
create projects. A creator becomes project `manager`.

Connection secrets must not be stored directly in
`platform_project_connections.configuration_json`. Future connectors should
store provider references or encrypted secret IDs there and keep tokens in a
dedicated encrypted secret service.

---

## Configuration

Local development needs no environment variables:

```sh
bun run dev
```

Open `http://localhost:5173/app`. It uses
`sqlite:./.tmp/control-plane.db` and the local agency identity. Disable the
surface with `CONTROL_PLANE_ENABLED=false`.

Production requires a separate database and WorkOS:

```dotenv
CONTROL_PLANE_ENABLED=true
CONTROL_PLANE_DATABASE_URL=postgres://...
CONTROL_PLANE_AUTH_MODE=workos
CONTROL_PLANE_APP_URL=https://app.example.com
WORKOS_API_KEY=sk_...
WORKOS_CLIENT_ID=client_...
WORKOS_COOKIE_PASSWORD=at-least-32-random-characters
WORKOS_REDIRECT_URI=https://app.example.com/app/auth/callback
```

Register the redirect URI in WorkOS AuthKit. Production refuses development
authentication, a missing database, incomplete WorkOS credentials, or a cookie
password shorter than 32 characters.

---

## Planned Connection Architecture

The next implementation layer should treat every project source as an adapter
behind one contract:

```ts
interface ProjectSourceAdapter {
  connect(projectId: string): Promise<ConnectionState>
  importRevision(projectId: string): Promise<ProjectRevision>
  exportRevision(projectId: string, revisionId: string): Promise<void>
  watch?(projectId: string): AsyncIterable<SourceChange>
}
```

The adapters have different transport, but the same revision boundary:

1. **Managed** stores project state in an isolated builder workspace.
2. **GitHub** imports and exports through a GitHub App installation and branch.
3. **Local bridge** pairs a short-lived local daemon over an outbound secure
   connection; the browser never receives arbitrary filesystem access.
4. **GitHub bridge** uses Git as the durable source while a local daemon gives
   immediate edit/preview feedback.

Every import creates an immutable revision. Every publish points an environment
at a revision and emits the same site artifact. This keeps GitHub, local work,
managed hosting, Railway, and manual export from becoming separate publishing
systems.

For workspace isolation, the control plane should enqueue a provisioning job;
a worker then starts or resumes a builder runtime with one project volume and
short-lived credentials. The browser receives a signed, expiring workspace URL.
No project container needs the control-plane database or WorkOS API key.

---

## Source of Truth

- Shared contracts: `src/core/platform/schemas.ts`
- Browser API client: `src/core/platform/api.ts`
- Platform UI: `src/platform/`
- Configuration: `server/platform/config.ts`
- WorkOS and development auth: `server/platform/auth.ts`
- API routing: `server/platform/handler.ts`
- Persistence: `server/platform/repository.ts`
- Dialect migrations: `server/platform/db/`
- Website boundary: [`site-artifacts.md`](site-artifacts.md)
