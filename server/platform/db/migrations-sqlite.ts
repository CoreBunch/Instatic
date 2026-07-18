import type { Migration } from '../../db/runMigrations'

export const platformSqliteMigrations: Migration[] = [
  {
    id: 'platform_001_control_plane_core',
    sql: `
      create table platform_users (
        id text primary key,
        email text not null,
        name text,
        avatar_url text,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      create unique index platform_users_email_idx
        on platform_users (email);

      create table platform_organizations (
        id text primary key,
        name text not null,
        slug text not null,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      create unique index platform_organizations_slug_idx
        on platform_organizations (slug);

      create table platform_organization_memberships (
        organization_id text not null references platform_organizations(id) on delete cascade,
        user_id text not null references platform_users(id) on delete cascade,
        role text not null,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        primary key (organization_id, user_id),
        constraint platform_organization_role_check
          check (role in ('owner', 'admin', 'member', 'guest'))
      );

      create index platform_organization_memberships_user_idx
        on platform_organization_memberships (user_id);

      create table platform_projects (
        id text primary key,
        organization_id text not null references platform_organizations(id) on delete cascade,
        name text not null,
        slug text not null,
        client_name text,
        source_mode text not null,
        workspace_state text not null default 'unprovisioned',
        created_by_user_id text not null references platform_users(id) on delete restrict,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        archived_at text,
        constraint platform_project_source_mode_check
          check (source_mode in ('instatic', 'github', 'local_bridge', 'github_bridge')),
        constraint platform_project_workspace_state_check
          check (workspace_state in ('unprovisioned', 'provisioning', 'ready', 'error'))
      );

      create unique index platform_projects_org_slug_active_idx
        on platform_projects (organization_id, slug)
        where archived_at is null;

      create index platform_projects_org_updated_idx
        on platform_projects (organization_id, updated_at);

      create table platform_project_memberships (
        project_id text not null references platform_projects(id) on delete cascade,
        user_id text not null references platform_users(id) on delete cascade,
        role text not null,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        primary key (project_id, user_id),
        constraint platform_project_role_check
          check (role in ('manager', 'designer', 'developer', 'content_editor', 'reviewer', 'publisher'))
      );

      create index platform_project_memberships_user_idx
        on platform_project_memberships (user_id);

      create table platform_project_revisions (
        id text primary key,
        project_id text not null references platform_projects(id) on delete cascade,
        sequence integer not null,
        state text not null,
        source_kind text not null,
        source_ref text,
        artifact_digest text,
        created_by_user_id text not null references platform_users(id) on delete restrict,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        constraint platform_revision_state_check
          check (state in ('created', 'imported', 'draft', 'published'))
      );

      create unique index platform_project_revisions_sequence_idx
        on platform_project_revisions (project_id, sequence);

      create table platform_project_connections (
        id text primary key,
        project_id text not null references platform_projects(id) on delete cascade,
        kind text not null,
        status text not null default 'disconnected',
        configuration_json text not null default '{}',
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        constraint platform_connection_kind_check
          check (kind in ('github', 'local_bridge', 'railway')),
        constraint platform_connection_status_check
          check (status in ('disconnected', 'connected', 'error'))
      );

      create unique index platform_project_connections_kind_idx
        on platform_project_connections (project_id, kind);

      create table platform_environments (
        id text primary key,
        project_id text not null references platform_projects(id) on delete cascade,
        kind text not null,
        provider text,
        public_url text,
        last_revision_id text references platform_project_revisions(id) on delete set null,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        constraint platform_environment_kind_check
          check (kind in ('preview', 'production'))
      );

      create unique index platform_environments_kind_idx
        on platform_environments (project_id, kind);

      create table platform_auth_attempts (
        state_hash text primary key,
        code_verifier text not null,
        expires_at text not null,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      create index platform_auth_attempts_expiry_idx
        on platform_auth_attempts (expires_at);
    `,
  },
]
