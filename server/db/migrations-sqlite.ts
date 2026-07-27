import type { Migration } from './runMigrations'

/**
 * SQLite dialect — single consolidated baseline. Mirrors `migrations-pg.ts`
 * step-for-step (see that file's header for the consolidation rationale).
 *
 * Dialect translations applied throughout:
 *   jsonb            → text         (stored as JSON strings; the SQLite
 *                                     adapter auto-parses any `_json` column
 *                                     on read and stringifies on write)
 *   timestamptz      → text         (ISO 8601 strings)
 *   bytea            → blob
 *   bigint           → integer      (SQLite integers are 64-bit)
 *   boolean          → integer      (1 / 0; repos use Boolean(row.enabled))
 *   default now()    → default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 *   '{}'::jsonb      → '{}'         (no PG cast syntax)
 *   distinct on (…)  → window-function subquery (see repository code; the
 *                                     baseline does not need this form)
 *   pg_constraint    → not used     (SQLite FKs are declared inline; the
 *                                     baseline orders CREATE TABLEs so no
 *                                     cycle requires the PG-style guarded
 *                                     ALTER TABLE)
 *
 * Migration IDs and order are identical to `migrations-pg.ts` — enforced by
 * `src/__tests__/architecture/migration-parity.test.ts`.
 *
 * Pages and Visual Components are stored in data_tables / data_rows — the
 * same unified store as posts. The legacy "pages" and "page_versions" tables
 * have been removed from this baseline.
 */
export const sqliteMigrations: Migration[] = [
  {
    id: '001_baseline',
    sql: `
      -- ─── Roles + Users ─────────────────────────────────────────────────────

      create table if not exists roles (
        id text primary key,
        slug text not null unique,
        name text not null,
        description text not null default '',
        is_system integer not null default 0,
        capabilities_json text not null default '[]',
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      -- Built-in roles seed. Owner AND Admin rows are force-resynced from
      -- code on every server boot (see syncSystemRoles in
      -- server/repositories/roles.ts), so adding new capabilities to code
      -- automatically propagates to both without a migration. The seeded
      -- capability lists below are the initial snapshot — the boot-time
      -- sync immediately overrides them with whatever the SYSTEM_ROLES
      -- arrays in server/auth/capabilities.ts declare. Client and Member
      -- are inserted on first boot only; subsequent edits via the admin
      -- UI are preserved.
      insert into roles (id, slug, name, description, is_system, capabilities_json)
      values
        ('owner', 'owner', 'Owner', 'Permanent installation owner with full system access.', 1, '["dashboard.read","site.read","site.structure.edit","site.content.edit","site.style.edit","pages.edit","pages.publish","content.create","content.edit.own","content.edit.any","content.publish.own","content.publish.any","content.manage","media.read","media.write","media.replace","media.delete","runtime.dependencies","storage.elect","storage.migrate","plugins.read","plugins.configure","plugins.install","plugins.lifecycle","users.manage","roles.manage","audit.read","data.custom.tables.read","data.custom.tables.manage","data.system.tables.read","data.system.tables.manage","data.rows.move","data.export","data.import","ai.chat","ai.tools.write","ai.providers.manage","ai.audit.read"]'),
        ('admin', 'admin', 'Admin', 'Full admin access (cannot manage roles).', 1, '["dashboard.read","site.read","site.structure.edit","site.content.edit","site.style.edit","pages.edit","pages.publish","content.create","content.edit.own","content.edit.any","content.publish.own","content.publish.any","content.manage","media.read","media.write","media.replace","media.delete","runtime.dependencies","storage.elect","storage.migrate","plugins.read","plugins.configure","plugins.install","plugins.lifecycle","users.manage","audit.read","data.custom.tables.read","data.custom.tables.manage","data.system.tables.read","data.system.tables.manage","data.rows.move","data.export","data.import","ai.chat","ai.tools.write","ai.providers.manage","ai.audit.read"]'),
        ('client', 'client', 'Client', 'Can edit page copy (text, images, links) but not structure or styles.', 1, '["dashboard.read","site.read","site.content.edit","media.read","data.custom.tables.read"]'),
        ('member', 'member', 'Member', 'Public-facing member account — no admin access by default.', 1, '[]')
      on conflict (id) do update
        set slug = excluded.slug,
            name = excluded.name,
            description = excluded.description,
            is_system = excluded.is_system,
            capabilities_json = excluded.capabilities_json,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now');

      -- avatar_media_id is added via ALTER at the bottom (after media_assets
      -- exists) to mirror the PG dialect, which needs the deferred FK.
      create table if not exists users (
        id text primary key,
        email text not null,
        email_normalized text not null,
        display_name text not null,
        password_hash text not null,
        status text not null default 'active',
        role_id text not null references roles(id) on delete restrict,
        last_login_at text,
        failed_login_count integer not null default 0,
        locked_until text,
        password_updated_at text,
        mfa_enabled integer not null default 0,
        mfa_enabled_at text,
        mfa_totp_secret_ciphertext blob,
        mfa_totp_secret_iv blob,
        mfa_totp_secret_key_fingerprint text,
        mfa_recovery_code_hashes_json text not null default '[]',
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        deleted_at text,
        constraint users_status_check check (status in ('active', 'suspended'))
      );

      create unique index if not exists users_email_normalized_active_idx
        on users (email_normalized)
        where deleted_at is null;

      create unique index if not exists users_single_active_owner_idx
        on users (role_id)
        where role_id = 'owner' and status = 'active' and deleted_at is null;

      -- ─── Site ──────────────────────────────────────────────────────────────

      create table if not exists site (
        id text primary key default 'default',
        name text not null,
        settings_json text not null default '{}',
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      -- ─── Sessions + Audit ──────────────────────────────────────────────────

      create table if not exists sessions (
        id_hash text primary key,
        user_id text not null references users(id) on delete cascade,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        last_seen_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        expires_at text not null,
        revoked_at text,
        ip_address text,
        user_agent text,
        device_label text not null default '',
        mfa_passed_at text,
        step_up_expires_at text
      );

      create index if not exists sessions_user_idx
        on sessions (user_id, last_seen_at desc);

      create index if not exists sessions_user_active_idx
        on sessions (user_id, expires_at)
        where revoked_at is null;

      -- ─── User Preferences ─────────────────────────────────────────────────
      -- Mirror of the PG user_preferences table — see migrations-pg.ts for
      -- the full rationale. value_json is text here (parsed by the SQLite
      -- adapter on read thanks to the _json suffix); updated_at is an ISO
      -- string filled by the ISO-8601 strftime default. The composite primary key gives
      -- us (user_id, key) uniqueness AND the user_id-prefix lookup index in
      -- one declaration.
      create table if not exists user_preferences (
        user_id    text not null references users(id) on delete cascade,
        key        text not null,
        value_json text not null,
        updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        primary key (user_id, key)
      );

      create table if not exists audit_events (
        id text primary key,
        actor_user_id text references users(id) on delete set null,
        action text not null,
        target_type text,
        target_id text,
        metadata_json text not null default '{}',
        ip_address text,
        user_agent text,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      create index if not exists audit_events_created_idx
        on audit_events (created_at desc);

      -- Login-attempts audit. user_agent is captured so the Account →
      -- Sign-in history tab can derive a friendly "Browser on Platform"
      -- label per row.
      create table if not exists login_attempts (
        id text primary key,
        attempted_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        email_norm text,
        ip_address text,
        user_agent text,
        user_id text references users(id) on delete set null,
        result text not null
          constraint login_attempts_result_check
          check (result in ('success', 'bad_password', 'no_user', 'account_disabled', 'locked', 'rate_limited', 'mfa_failed'))
      );

      create index if not exists login_attempts_ip_idx
        on login_attempts (ip_address, attempted_at desc);

      create index if not exists login_attempts_email_idx
        on login_attempts (email_norm, attempted_at desc)
        where email_norm is not null;

      -- ─── Data tables (unified content schema) ─────────────────────────────
      --
      -- Pages and Visual Components are stored here alongside posts. The
      -- legacy "pages" and "page_versions" tables have been removed; all
      -- content now lives in data_rows keyed by table_id.

      create table if not exists data_tables (
        id text primary key,
        name text not null,
        slug text not null,
        kind text not null default 'data',
        route_base text not null default '',
        singular_label text not null,
        plural_label text not null,
        primary_field_id text not null default 'title',
        fields_json text not null default '[]',
        system integer not null default 0,
        created_by_user_id text references users(id) on delete set null,
        updated_by_user_id text references users(id) on delete set null,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        deleted_at text,
        constraint data_tables_kind_check check (kind in ('postType', 'data', 'page', 'component'))
      );

      create unique index if not exists data_tables_slug_active_idx
        on data_tables (slug)
        where deleted_at is null;

      -- ─── System table seeds ────────────────────────────────────────────────
      --
      -- Three system tables are seeded at boot. They are protected from rename
      -- and delete (system = 1). Users can add custom fields to them.

      insert into data_tables (id, name, slug, kind, route_base, singular_label, plural_label, primary_field_id, system, fields_json)
      values ('posts', 'Posts', 'posts', 'postType', '/posts', 'Post', 'Posts', 'title', 1,
        '[{"type":"text","id":"title","label":"Title","required":true,"builtIn":true},{"type":"text","id":"slug","label":"Slug","required":true,"builtIn":true},{"type":"richText","id":"body","label":"Body","format":"markdown","builtIn":true},{"type":"media","id":"featuredMedia","label":"Featured media","mediaKind":"image","builtIn":true},{"type":"text","id":"seoTitle","label":"SEO title","builtIn":true},{"type":"longText","id":"seoDescription","label":"SEO description","builtIn":true}]')
      on conflict (id) do update
        set name = excluded.name,
            slug = excluded.slug,
            kind = excluded.kind,
            route_base = excluded.route_base,
            singular_label = excluded.singular_label,
            plural_label = excluded.plural_label,
            primary_field_id = excluded.primary_field_id,
            system = excluded.system,
            fields_json = excluded.fields_json,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            deleted_at = null;

      insert into data_tables (id, name, slug, kind, route_base, singular_label, plural_label, primary_field_id, system, fields_json)
      values ('pages', 'Pages', 'pages', 'page', '', 'Page', 'Pages', 'title', 1,
        '[{"type":"text","id":"title","label":"Title","required":true,"builtIn":true},{"type":"text","id":"slug","label":"Slug","required":true,"builtIn":true},{"type":"pageTree","id":"body","label":"Body","required":true,"builtIn":true},{"type":"text","id":"seoTitle","label":"SEO title","builtIn":true},{"type":"longText","id":"seoDescription","label":"SEO description","builtIn":true},{"type":"boolean","id":"templateEnabled","label":"Template","builtIn":true},{"type":"longText","id":"templateTarget","label":"Template target","builtIn":true},{"type":"number","id":"templatePriority","label":"Template priority","integer":true,"builtIn":true}]')
      on conflict (id) do update
        set name = excluded.name,
            slug = excluded.slug,
            kind = excluded.kind,
            route_base = excluded.route_base,
            singular_label = excluded.singular_label,
            plural_label = excluded.plural_label,
            primary_field_id = excluded.primary_field_id,
            system = excluded.system,
            fields_json = excluded.fields_json,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            deleted_at = null;

      insert into data_tables (id, name, slug, kind, route_base, singular_label, plural_label, primary_field_id, system, fields_json)
      values ('components', 'Components', 'components', 'component', '', 'Component', 'Components', 'name', 1,
        '[{"type":"text","id":"name","label":"Name","required":true,"builtIn":true},{"type":"text","id":"slug","label":"Slug","required":true,"builtIn":true},{"type":"pageTree","id":"body","label":"Body","required":true,"builtIn":true},{"type":"fieldSchema","id":"params","label":"Params","builtIn":true},{"type":"longText","id":"classIds","label":"Classes","builtIn":true}]')
      on conflict (id) do update
        set name = excluded.name,
            slug = excluded.slug,
            kind = excluded.kind,
            route_base = excluded.route_base,
            singular_label = excluded.singular_label,
            plural_label = excluded.plural_label,
            primary_field_id = excluded.primary_field_id,
            system = excluded.system,
            fields_json = excluded.fields_json,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            deleted_at = null;

      -- SQLite tolerates forward FK references when both tables are
      -- created in the same script, so data_rows.active_version_id can
      -- declare its FK inline (unlike the PG dialect which adds it after).
      create table if not exists data_rows (
        id text primary key,
        table_id text not null references data_tables(id) on delete restrict,
        cells_json text not null default '{}',
        slug text not null default '',
        status text not null default 'draft',
        active_version_id text references data_row_versions(id) on delete set null,
        author_user_id text references users(id) on delete set null,
        created_by_user_id text references users(id) on delete set null,
        updated_by_user_id text references users(id) on delete set null,
        published_by_user_id text references users(id) on delete set null,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        published_at text,
        deleted_at text,
        constraint data_rows_status_check check (status in ('draft', 'published', 'unpublished'))
      );

      create unique index if not exists data_rows_table_slug_active_idx
        on data_rows (table_id, slug)
        where deleted_at is null and slug <> '';

      create index if not exists data_rows_table_idx
        on data_rows (table_id, updated_at desc)
        where deleted_at is null;

      create index if not exists data_rows_table_status_idx
        on data_rows (table_id, status, updated_at desc)
        where deleted_at is null;

      create index if not exists data_rows_table_author_idx
        on data_rows (table_id, author_user_id, updated_at desc)
        where deleted_at is null;

      create table if not exists data_row_versions (
        id text primary key,
        row_id text not null references data_rows(id) on delete cascade,
        version_number integer not null,
        cells_json text not null default '{}',
        slug text not null default '',
        published_by_user_id text references users(id) on delete set null,
        published_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        unique (row_id, version_number)
      );

      create index if not exists data_row_versions_row_latest_idx
        on data_row_versions (row_id, version_number desc);

      create table if not exists data_row_redirects (
        id text primary key,
        table_id text not null references data_tables(id) on delete cascade,
        from_route_base text not null,
        from_slug text not null,
        target_row_id text not null references data_rows(id) on delete cascade,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      create unique index if not exists data_row_redirects_source_idx
        on data_row_redirects (from_route_base, from_slug);

      create index if not exists data_row_redirects_target_idx
        on data_row_redirects (target_row_id, created_at desc);

      -- ─── Plugins ──────────────────────────────────────────────────────────

      create table if not exists installed_plugins (
        id text primary key,
        name text not null,
        version text not null,
        enabled integer not null default 1,
        granted_permissions_json text not null default '[]',
        manifest_json text not null,
        lifecycle_status text not null default 'installed',
        last_error text,
        settings_json text not null default '{}',
        installed_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      create index if not exists installed_plugins_enabled_idx
        on installed_plugins (enabled, installed_at desc);

      create table if not exists plugin_records (
        id text primary key,
        plugin_id text not null references installed_plugins(id) on delete cascade,
        resource_id text not null,
        data_json text not null,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      create index if not exists plugin_records_resource_idx
        on plugin_records (plugin_id, resource_id, created_at desc);

      create table if not exists plugin_crash_events (
        id text primary key,
        plugin_id text not null,
        occurred_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        reason text not null,
        stack text
      );

      create index if not exists plugin_crash_events_plugin_idx
        on plugin_crash_events (plugin_id, occurred_at desc);

      -- ─── Media ────────────────────────────────────────────────────────────

      create table if not exists media_assets (
        id text primary key,
        filename text not null,
        mime_type text not null,
        size_bytes integer not null,
        storage_path text not null,
        public_path text not null unique,
        uploaded_by_user_id text references users(id) on delete set null,
        alt_text text not null default '',
        caption text not null default '',
        title text not null default '',
        tags_json text not null default '[]',
        width integer,
        height integer,
        duration_ms integer,
        dominant_color text,
        blur_hash text,
        variants_json text not null default '[]',
        poster_path text,
        deleted_at text,
        replaced_at text,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      create index if not exists media_assets_deleted_idx
        on media_assets (deleted_at);

      create table if not exists media_folders (
        id text primary key,
        parent_id text references media_folders(id) on delete cascade,
        name text not null,
        slug text not null,
        sort_order integer not null default 0,
        created_by_user_id text references users(id) on delete set null,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      create unique index if not exists media_folders_parent_slug_idx
        on media_folders (coalesce(parent_id, ''), slug);

      create table if not exists media_asset_folders (
        asset_id text not null references media_assets(id) on delete cascade,
        folder_id text not null references media_folders(id) on delete cascade,
        primary key (asset_id, folder_id)
      );

      create index if not exists media_asset_folders_folder_idx
        on media_asset_folders (folder_id);

      create table if not exists media_smart_folders (
        id text primary key,
        name text not null,
        query_json text not null,
        created_by_user_id text references users(id) on delete set null,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      create table if not exists media_usage_refs (
        asset_id text not null references media_assets(id) on delete cascade,
        ref_kind text not null,
        ref_id text not null,
        ref_path text not null default '',
        computed_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        primary key (asset_id, ref_kind, ref_id, ref_path)
      );

      create index if not exists media_usage_refs_asset_idx
        on media_usage_refs (asset_id);

      create table if not exists published_runtime_assets (
        id text primary key,
        data_row_version_id text not null references data_row_versions(id) on delete cascade,
        asset_path text not null,
        public_path text not null unique,
        content_type text not null,
        content_bytes blob not null,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      create index if not exists published_runtime_assets_data_row_version_idx
        on published_runtime_assets (data_row_version_id);

      -- ─── Cross-FK fixups ──────────────────────────────────────────────────
      --
      -- users.avatar_media_id → media_assets. SQLite ≤ 3.37 lacks
      -- ADD COLUMN IF NOT EXISTS; the migration tracker guarantees this
      -- block runs exactly once, so the bare ALTER is safe.

      alter table users
        add column avatar_media_id text references media_assets(id) on delete set null;
    `,
  },
  {
    id: '002_plugin_schedules',
    sql: `
      -- ─── Plugin scheduled jobs ────────────────────────────────────────────
      --
      -- SQLite mirror of the Postgres schema with dialect-translated types
      -- (text instead of jsonb / timestamptz, integer instead of boolean —
      -- the adapter handles JSON encode/decode for the *_json column-suffix
      -- convention enforced by the db-json-column architecture gate).

      create table if not exists plugin_schedules (
        plugin_id text not null references installed_plugins(id) on delete cascade,
        schedule_id text not null,
        cadence_json text not null,
        overlap text not null default 'skip',
        max_duration_ms integer not null default 5000,
        enabled integer not null default 1,
        paused integer not null default 0,
        consecutive_failures integer not null default 0,
        last_run_at text,
        last_finished_at text,
        last_status text,
        last_error text,
        last_duration_ms integer,
        next_run_at text not null,
        running_token text,
        lock_until text,
        claimed_at text,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        primary key (plugin_id, schedule_id)
      );

      create index if not exists plugin_schedules_due_idx
        on plugin_schedules (enabled, paused, next_run_at);

      create table if not exists plugin_schedule_runs (
        id text primary key,
        plugin_id text not null,
        schedule_id text not null,
        started_at text not null,
        finished_at text,
        status text not null,
        error text,
        duration_ms integer,
        triggered_by text not null default 'tick'
      );

      create index if not exists plugin_schedule_runs_lookup_idx
        on plugin_schedule_runs (plugin_id, schedule_id, started_at desc);
    `,
  },
  {
    id: '003_published_site_snapshots',
    sql: `
      -- One published SiteDocument per publish, shared by every page version
      -- created in that publish. Page versions reference it via
      -- site_snapshot_id instead of each carrying a full copy of the site —
      -- publishing N pages stores the site document once, not N times.
      -- SQLite mirror of the Postgres migration.
      --
      -- content_hash is the SHA-256 of the canonical-JSON serialisation of
      -- site_json, stamped at publish time so the publish-status check can
      -- compare draft vs published without parsing any snapshot.
      --
      -- importmap_body is the pre-serialised runtime package importmap (exact
      -- bytes the CSP hash was computed over) — TEXT, never re-encoded.
      create table if not exists site_snapshots (
        id text primary key,
        site_json text not null,
        content_hash text not null,
        importmap_body text,
        importmap_sha256 text,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      alter table data_row_versions add column site_snapshot_id text references site_snapshots(id) on delete set null;

      -- Per-page runtime script manifest (page-scoped, unlike the shared site
      -- document), parsed automatically via the *_json naming convention.
      alter table data_row_versions add column runtime_assets_json text;

      -- Published row-route lookup (route_base + version slug): without these
      -- two indexes the planner enumerates every published row of the table
      -- and PK-probes its active version per visitor request.
      create index if not exists data_row_versions_slug_idx
        on data_row_versions (slug);

      create index if not exists data_rows_active_version_idx
        on data_rows (active_version_id);
    `,
  },
  {
    id: '004_media_storage_adapters',
    sql: `
      -- ─── Media storage adapter election (per-role) ────────────────────────
      --
      -- SQLite mirror of the Postgres migration. See migrations-pg.ts for
      -- the full design rationale.

      create table if not exists active_media_storage_adapter (
        role text primary key,
        adapter_id text not null default '',
        elected_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        elected_by_user_id text references users(id) on delete set null
      );

      -- Per-asset adapter pinning. SQLite < 3.37 lacks ADD COLUMN IF NOT
      -- EXISTS; the migration tracker guarantees this block runs exactly
      -- once, so the bare ALTER is safe (mirrors the avatar_media_id
      -- pattern in the baseline migration).
      alter table media_assets add column storage_adapter_id text not null default '';

      -- 'externally_hosted' is stored as integer 1/0; repository code reads
      -- it via Boolean(row.externally_hosted) — same convention as the
      -- rest of the SQLite schema (see CLAUDE.md "Database dialect rules").
      alter table media_assets add column externally_hosted integer not null default 0;
    `,
  },
  {
    id: '005_media_variant_delegate',
    sql: `
      -- ─── Variant delegate election (singleton) ────────────────────────────
      --
      -- SQLite mirror of the Postgres migration. See migrations-pg.ts for
      -- the full design rationale. JSON columns end in '_json' so the
      -- SQLite adapter auto-parses on read and stringifies on write (see
      -- CLAUDE.md "Database dialect rules").

      create table if not exists active_media_variant_delegate (
        singleton integer primary key default 1 check (singleton = 1),
        delegate_id text not null,
        variant_url_template text not null,
        widths_json text not null,
        formats_json text not null,
        elected_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        elected_by_user_id text references users(id) on delete set null
      );
    `,
  },
  {
    id: '006_data_rows_scheduled_publish',
    sql: `
      -- ─── Scheduled publish — SQLite mirror of migrations-pg.ts 006.
      --
      -- We can't ALTER TABLE DROP CONSTRAINT in SQLite, so the only way to
      -- relax the data_rows status check (to allow 'scheduled') AND add
      -- the new scheduled_publish_at column on an existing DB is the
      -- standard table-rebuild dance:
      --
      --   1. defer FK enforcement to the end of the transaction so we
      --      can drop+recreate data_rows without temporarily orphaning
      --      data_row_versions.row_id references
      --   2. CREATE a new data_rows with the desired final schema
      --   3. INSERT existing rows into the new table (scheduled_publish_at
      --      defaults to NULL — we don't list the column so the SELECT
      --      works whether the old table has it or not)
      --   4. DROP old, RENAME new → old's place
      --   5. Re-create every index that used to live on data_rows
      --
      -- On COMMIT the deferred FK check passes because the new table
      -- contains the same row ids as the old one. Foreign keys are
      -- always re-enabled at COMMIT by SQLite itself — the pragma is
      -- transaction-scoped.
      --
      -- Safe to run on a fresh install too: the table already has the
      -- new schema from the rewritten baseline (migration 001), so the
      -- rebuild produces a structurally identical table. No data loss
      -- either way.

      pragma defer_foreign_keys = on;

      create table data_rows__migr006 (
        id text primary key,
        table_id text not null references data_tables(id) on delete restrict,
        cells_json text not null default '{}',
        slug text not null default '',
        status text not null default 'draft',
        active_version_id text references data_row_versions(id) on delete set null,
        author_user_id text references users(id) on delete set null,
        created_by_user_id text references users(id) on delete set null,
        updated_by_user_id text references users(id) on delete set null,
        published_by_user_id text references users(id) on delete set null,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        published_at text,
        scheduled_publish_at text,
        deleted_at text,
        constraint data_rows_status_check check (status in ('draft', 'published', 'unpublished', 'scheduled'))
      );

      insert into data_rows__migr006 (
        id, table_id, cells_json, slug, status, active_version_id,
        author_user_id, created_by_user_id, updated_by_user_id, published_by_user_id,
        created_at, updated_at, published_at, deleted_at
      )
      select
        id, table_id, cells_json, slug, status, active_version_id,
        author_user_id, created_by_user_id, updated_by_user_id, published_by_user_id,
        created_at, updated_at, published_at, deleted_at
      from data_rows;

      drop table data_rows;
      alter table data_rows__migr006 rename to data_rows;

      create unique index if not exists data_rows_table_slug_active_idx
        on data_rows (table_id, slug)
        where deleted_at is null and slug <> '';

      create index if not exists data_rows_table_idx
        on data_rows (table_id, updated_at desc)
        where deleted_at is null;

      create index if not exists data_rows_table_status_idx
        on data_rows (table_id, status, updated_at desc)
        where deleted_at is null;

      create index if not exists data_rows_table_author_idx
        on data_rows (table_id, author_user_id, updated_at desc)
        where deleted_at is null;

      create index if not exists data_rows_scheduled_publish_idx
        on data_rows (scheduled_publish_at)
        where status = 'scheduled' and deleted_at is null;

      -- Re-create the published-route join index from migration 003 — the
      -- drop+rename rebuild above takes every data_rows index with it, so
      -- ALL of them must be re-created here.
      create index if not exists data_rows_active_version_idx
        on data_rows (active_version_id);
    `,
  },
  {
    id: '007_ai_runtime',
    sql: `
      -- ─── AI runtime: providers, credentials, defaults, conversations ──────
      --
      -- Phase 1 of docs/plans/2026-05-26-ai-runtime-rewrite.md.
      --
      -- Dialect translations from the PG version:
      --   bytea            → blob
      --   timestamptz      → text   (ISO 8601)
      --   default now()    → default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      --   bigint           → integer  (SQLite ints are 64-bit)
      --   numeric(10, 6)   → real
      --
      -- Constraint check on auth-mode column shape is identical (SQLite
      -- supports CHECK constraints inline the same way PG does).

      create table if not exists ai_provider_credentials (
        id text primary key,
        user_id text not null references users(id) on delete cascade,
        provider_id text not null,
        auth_mode text not null,
        display_label text not null,
        ciphertext blob,
        iv blob,
        base_url text,
        key_fingerprint text,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        last_used_at text,
        -- provider_id is validated at the application boundary by the TypeBox
        -- ProviderId union (server/ai/handlers/credentials.ts). A DB enum that
        -- duplicates that list would force a destructive migration on every new
        -- provider, so it lives at the boundary, not here.
        constraint ai_creds_authmode_check
          check (auth_mode in ('apiKey', 'baseUrl')),
        constraint ai_creds_apikey_shape_check
          check (
            (auth_mode = 'apiKey'  and ciphertext is not null and iv is not null and base_url is null) or
            (auth_mode = 'baseUrl' and base_url is not null)
          )
      );

      create unique index if not exists ai_creds_user_label_idx
        on ai_provider_credentials (user_id, provider_id, display_label);

      create table if not exists ai_defaults (
        scope text primary key,
        credential_id text not null references ai_provider_credentials(id) on delete restrict,
        model_id text not null,
        updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_by text references users(id) on delete set null,
        constraint ai_defaults_scope_check
          check (scope in ('site', 'content', 'data', 'plugin'))
      );

      create table if not exists ai_conversations (
        id text primary key,
        user_id text not null references users(id) on delete cascade,
        scope text not null,
        title text not null,
        credential_id text references ai_provider_credentials(id) on delete set null,
        model_id text not null,
        prompt_tokens_total integer not null default 0,
        completion_tokens_total integer not null default 0,
        cost_usd_total real not null default 0,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        deleted_at text,
        constraint ai_conv_scope_check
          check (scope in ('site', 'content', 'data', 'plugin'))
      );

      create index if not exists ai_conv_user_scope_idx
        on ai_conversations (user_id, scope, updated_at desc)
        where deleted_at is null;

      create index if not exists ai_conv_deleted_idx
        on ai_conversations (deleted_at)
        where deleted_at is not null;

      create table if not exists ai_messages (
        id text primary key,
        conversation_id text not null references ai_conversations(id) on delete cascade,
        position integer not null,
        role text not null,
        content_json text not null,
        tool_call_id text,
        tool_name text,
        prompt_tokens integer not null default 0,
        completion_tokens integer not null default 0,
        cost_usd real not null default 0,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        constraint ai_msg_role_check
          check (role in ('user', 'assistant', 'tool'))
      );

      create unique index if not exists ai_msg_conv_position_idx
        on ai_messages (conversation_id, position);
    `,
  },
  {
    id: '008_ai_drop_ambient_credentials',
    sql: `
      -- Credentials whose auth_mode is no longer supported are pruned so the
      -- credentials list endpoint can parse the wire shape (the client now
      -- expects only 'apiKey' or 'baseUrl').
      delete from ai_provider_credentials
      where auth_mode = 'ambient';
    `,
  },
  {
    id: '009_ai_cache_tokens',
    sql: `
      -- Anthropic prompt-cache visibility. See PG migration 009 for the
      -- rationale. SQLite splits the ALTERs into separate statements (no
      -- multi-column ALTER syntax) but the schema is the same.
      alter table ai_messages add column cache_read_tokens integer not null default 0;
      alter table ai_messages add column cache_creation_tokens integer not null default 0;
      alter table ai_conversations add column cache_read_tokens_total integer not null default 0;
      alter table ai_conversations add column cache_creation_tokens_total integer not null default 0;
    `,
  },
  {
    id: '010_data_rows_plugin_actor',
    sql: `
      -- ─── Plugin actor attribution ─────────────────────────────────────────
      --
      -- See PG migration 010 for the rationale. SQLite has no
      -- "add column if not exists" — but the table only exists in fresh
      -- installs (which already include the column via baseline diff in
      -- future revs) or in upgraded installs that run this migration
      -- exactly once, gated by schema_migrations. Plain ALTER suffices.
      alter table data_rows add column plugin_actor_id text;
    `,
  },
  {
    id: '011_user_step_up_policy',
    sql: `
      -- ─── Per-user step-up policy ─────────────────────────────────────────
      --
      -- Account -> Security can disable step-up for sensitive actions or
      -- choose how long a successful password re-entry stays fresh.
      alter table users
        add column step_up_auth_mode text not null default 'required'
          check (step_up_auth_mode in ('required', 'disabled'));
      alter table users
        add column step_up_window_minutes integer not null default 15
          check (step_up_window_minutes in (5, 15, 30, 60));
    `,
  },
  {
    id: '012_ai_drop_provider_check',
    sql: `
      -- ─── Drop the provider_id enum constraint — SQLite mirror of PG 012 ───
      --
      -- provider_id is validated at the application boundary by the TypeBox
      -- ProviderId union (server/ai/handlers/credentials.ts). The original
      -- DB-level enum check duplicated that list, so adding a provider
      -- (e.g. OpenRouter) on an existing DB silently failed the insert with a
      -- CHECK violation surfaced as a generic 500.
      --
      -- SQLite can't ALTER TABLE DROP CONSTRAINT, so we rebuild the table
      -- without the provider check (same dance as migration 006): defer FK
      -- enforcement so ai_defaults / ai_conversations references survive the
      -- drop+recreate, copy rows across, swap, then re-create the index.
      -- Safe on a fresh install too — migration 007 already builds the table
      -- without the provider check, so this produces an identical table.

      pragma defer_foreign_keys = on;

      create table ai_provider_credentials__migr012 (
        id text primary key,
        user_id text not null references users(id) on delete cascade,
        provider_id text not null,
        auth_mode text not null,
        display_label text not null,
        ciphertext blob,
        iv blob,
        base_url text,
        key_fingerprint text,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        last_used_at text,
        constraint ai_creds_authmode_check
          check (auth_mode in ('apiKey', 'baseUrl')),
        constraint ai_creds_apikey_shape_check
          check (
            (auth_mode = 'apiKey'  and ciphertext is not null and iv is not null and base_url is null) or
            (auth_mode = 'baseUrl' and base_url is not null)
          )
      );

      insert into ai_provider_credentials__migr012 (
        id, user_id, provider_id, auth_mode, display_label,
        ciphertext, iv, base_url, key_fingerprint,
        created_at, updated_at, last_used_at
      )
      select
        id, user_id, provider_id, auth_mode, display_label,
        ciphertext, iv, base_url, key_fingerprint,
        created_at, updated_at, last_used_at
      from ai_provider_credentials;

      drop table ai_provider_credentials;
      alter table ai_provider_credentials__migr012 rename to ai_provider_credentials;

      create unique index if not exists ai_creds_user_label_idx
        on ai_provider_credentials (user_id, provider_id, display_label);
    `,
  },
  {
    id: '013_ai_model_pricing',
    sql: `
      -- ─── Live model-pricing cache — SQLite mirror of PG 013 ──────────────
      --
      -- Per-million-token prices for (provider, model) pairs, mirrored from
      -- OpenRouter's public catalogue (the only source that publishes list
      -- prices for Anthropic + OpenAI models). There is no hand-maintained
      -- price table any more: the runtime refreshes this cache from OpenRouter
      -- and prices each turn from it. Rows are keyed by a normalised
      -- pricing_key (see server/ai/pricing/openrouterCatalogue.ts) so a native
      -- provider model id (dated/dotted) resolves to the OpenRouter slug.
      --
      -- The context_window column is added by migration 015 (kept separate so
      -- it applies on databases that already ran this one).
      -- refreshed_at is for inspection only; freshness is governed by the
      -- in-memory TTL in server/ai/pricing/index.ts.
      create table if not exists ai_model_pricing (
        pricing_key text primary key,
        input_per_mtok real not null,
        output_per_mtok real not null,
        cache_read_per_mtok real,
        cache_write_per_mtok real,
        refreshed_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `,
  },
  {
    id: '014_ai_conversation_context_tokens',
    sql: `
      -- ─── Current-context snapshot — SQLite mirror of PG 014 ──────────────
      --
      -- The provider-normalised total input tokens the model processed on the
      -- LATEST turn (see server/ai/contextTokens.ts). Overwritten each turn —
      -- it is a snapshot of "how full the context is now", NOT a running total.
      -- Lets the composer's context meter survive a conversation reload.
      alter table ai_conversations
        add column context_tokens integer not null default 0;
    `,
  },
  {
    id: '015_ai_pricing_context_window',
    sql: `
      -- ─── Model context window — SQLite mirror of PG 015 ──────────────────
      --
      -- Added separately from the 013 table create so it lands on databases
      -- that already ran 013. The model's max total tokens, mirrored from
      -- OpenRouter's catalogue (null when unpublished). Feeds the model
      -- picker's inline context badge and the composer context meter.
      alter table ai_model_pricing
        add column context_window integer;
    `,
  },
  {
    id: '016_plugin_secrets',
    sql: `
      -- ─── Encrypted plugin secret settings — SQLite mirror of PG 016 ──────
      --
      -- Plugin settings declared \`secret: true\` (third-party API keys etc.)
      -- are encrypted at rest with the same AES-256-GCM master key used for
      -- AI provider credentials (server/secrets/). They live in their own
      -- table instead of installed_plugins.settings_json so the plaintext
      -- can never ride a settings read onto a browser-bound payload.
      --
      -- key_fingerprint mirrors ai_provider_credentials: it records which
      -- master key encrypted the row so a key rotation is detected and
      -- surfaced as "re-enter this secret" instead of a decrypt failure.
      --
      -- Dialect translations from the PG version:
      --   bytea            → blob
      --   timestamptz      → text   (ISO 8601)
      --   default now()    → default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      create table if not exists plugin_secrets (
        plugin_id text not null references installed_plugins(id) on delete cascade,
        setting_id text not null,
        ciphertext blob not null,
        iv blob not null,
        key_fingerprint text not null,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        primary key (plugin_id, setting_id)
      );
    `,
  },
  {
    id: '017_layouts_system_table',
    // FK enforcement must be off for this rebuild: data_rows.table_id is
    // ON DELETE RESTRICT, which fires immediately even under
    // defer_foreign_keys, so the populated parent can't be dropped. See the
    // runner's `Migration.disableForeignKeys` doc for the full story; the
    // runner verifies `pragma foreign_key_check` before re-enabling
    // enforcement.
    disableForeignKeys: true,
    sql: `
      -- ─── Saved layouts: fourth system table — SQLite mirror of PG 017 ────
      --
      -- Adds 'layout' to the data_tables.kind enum and seeds the locked
      -- 'layouts' system table (snapshot rows live in data_rows like every
      -- other collection).
      --
      -- SQLite can't ALTER a CHECK constraint, so the kind enum is widened by
      -- rebuilding data_tables (same dance as migration 012): copy rows into
      -- a widened twin, drop the original, rename the twin into place, then
      -- re-create the index. Runs with foreign_keys OFF (see
      -- disableForeignKeys above) because data_rows.table_id RESTRICTs the
      -- drop; data_rows itself is never touched, and the runner integrity-
      -- checks before re-enabling enforcement. Safe on a fresh install too —
      -- the rebuild reproduces the baseline table plus the widened check.

      create table data_tables__migr017 (
        id text primary key,
        name text not null,
        slug text not null,
        kind text not null default 'data',
        route_base text not null default '',
        singular_label text not null,
        plural_label text not null,
        primary_field_id text not null default 'title',
        fields_json text not null default '[]',
        system integer not null default 0,
        created_by_user_id text references users(id) on delete set null,
        updated_by_user_id text references users(id) on delete set null,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        deleted_at text,
        constraint data_tables_kind_check check (kind in ('postType', 'data', 'page', 'component', 'layout'))
      );

      insert into data_tables__migr017 (
        id, name, slug, kind, route_base, singular_label, plural_label,
        primary_field_id, fields_json, system,
        created_by_user_id, updated_by_user_id, created_at, updated_at, deleted_at
      )
      select
        id, name, slug, kind, route_base, singular_label, plural_label,
        primary_field_id, fields_json, system,
        created_by_user_id, updated_by_user_id, created_at, updated_at, deleted_at
      from data_tables;

      drop table data_tables;
      alter table data_tables__migr017 rename to data_tables;

      create unique index if not exists data_tables_slug_active_idx
        on data_tables (slug)
        where deleted_at is null;

      insert into data_tables (id, name, slug, kind, route_base, singular_label, plural_label, primary_field_id, system, fields_json)
      values ('layouts', 'Layouts', 'layouts', 'layout', '', 'Layout', 'Layouts', 'name', 1,
        '[{"type":"text","id":"name","label":"Name","required":true,"builtIn":true},{"type":"text","id":"slug","label":"Slug","required":true,"builtIn":true},{"type":"pageTree","id":"body","label":"Body","required":true,"builtIn":true},{"type":"longText","id":"classes","label":"Classes","builtIn":true}]')
      on conflict (id) do update
        set name = excluded.name,
            slug = excluded.slug,
            kind = excluded.kind,
            route_base = excluded.route_base,
            singular_label = excluded.singular_label,
            plural_label = excluded.plural_label,
            primary_field_id = excluded.primary_field_id,
            system = excluded.system,
            fields_json = excluded.fields_json,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            deleted_at = null;
    `,
  },
  {
    id: '018_ai_mcp_connectors',
    sql: `
      create table if not exists ai_mcp_connectors (
        id text primary key,
        user_id text not null references users(id) on delete cascade,
        label text not null,
        type text not null,
        auth_mode text not null default 'bearer',
        token_hash text,
        capabilities_json text not null default '[]',
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        last_used_at text,
        revoked_at text,
        constraint ai_mcp_connectors_type_check check (type in ('local', 'remote')),
        constraint ai_mcp_connectors_auth_mode_check check (auth_mode in ('bearer', 'oauth'))
      );

      create index if not exists ai_mcp_connectors_user_idx
        on ai_mcp_connectors (user_id);
      create unique index if not exists ai_mcp_connectors_token_hash_idx
        on ai_mcp_connectors (token_hash)
        where token_hash is not null;
    `,
  },
  {
    id: '019_mcp_connector_token_expiry',
    sql: `
      alter table ai_mcp_connectors add column expires_at text;
    `,
  },
  {
    // Multi-admin sync substrate: every row written or soft-deleted by the
    // transactional site-document save is stamped with a site-global,
    // monotonically increasing sequence number. One column serves conflict
    // detection (stored seq > client base seq), O(delta) reconnect
    // reconciliation (rows where seq > cursor), and event ordering.
    // `site_sync_state` is the single-row counter (dialect-neutral: a plain
    // row bumped with `set seq = seq + 1 returning seq` inside the save
    // transaction — SQLite has no sequence objects).
    id: '020_site_sync_sequence',
    sql: `
      alter table data_rows add column seq integer not null default 0;

      create index if not exists data_rows_table_seq_idx
        on data_rows (table_id, seq);

      alter table site add column seq integer not null default 0;

      create table if not exists site_sync_state (
        id integer primary key check (id = 1),
        seq integer not null default 0
      );

      insert into site_sync_state (id, seq) values (1, 0);
    `,
  },
  {
    // OAuth 2.1 authorization-code + PKCE support for hosted MCP clients.
    // Connector rows remain the user/capability grant; these tables hold the
    // dynamically registered public client, one-time authorization codes, and
    // opaque access/refresh credentials for that grant.
    id: '021_mcp_oauth',
    sql: `
      create table if not exists ai_mcp_oauth_clients (
        client_id text primary key,
        client_name text not null,
        redirect_uris_json text not null,
        client_id_issued_at integer not null,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      create table if not exists ai_mcp_oauth_codes (
        code_hash text primary key,
        connector_id text not null references ai_mcp_connectors(id) on delete cascade,
        client_id text not null references ai_mcp_oauth_clients(client_id) on delete cascade,
        redirect_uri text not null,
        code_challenge text not null,
        scope text not null,
        resource text not null,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        expires_at text not null,
        consumed_at text
      );

      create index if not exists ai_mcp_oauth_codes_connector_idx
        on ai_mcp_oauth_codes (connector_id);

      create table if not exists ai_mcp_oauth_tokens (
        id text primary key,
        connector_id text not null references ai_mcp_connectors(id) on delete cascade,
        client_id text not null references ai_mcp_oauth_clients(client_id) on delete cascade,
        kind text not null,
        token_hash text not null unique,
        scope text not null,
        resource text not null,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        expires_at text not null,
        revoked_at text,
        constraint ai_mcp_oauth_tokens_kind_check check (kind in ('access', 'refresh'))
      );

      create index if not exists ai_mcp_oauth_tokens_connector_idx
        on ai_mcp_oauth_tokens (connector_id);
    `,
  },
  {
    // Visitor authentication & member areas (Phase 1 of docs/PRD.md §4).
    // Five tables, fully decoupled from the admin auth tables: separate
    // cookie name (`instatic_visitor_session`), separate middleware, separate
    // repositories. Order is dictated by FK dependencies:
    //   1. visitor_roles          — no FKs; seeded with two system rows
    //   2. visitor_users          — FK visitor_roles (on delete restrict)
    //   3. visitor_sessions       — FK visitor_users (on delete cascade)
    //   4. visitor_login_attempts — FK visitor_users (on delete set null)
    //   5. visitor_auth_config    — single-row config, no FKs
    //
    // D12 (docs/ARCHITECTURE.md): the unique constraint on a visitor's
    // ACTIVE email is a SEPARATE `CREATE UNIQUE INDEX ... WHERE deleted_at
    // IS NULL` rather than a table-level UNIQUE — partial unique
    // constraints cannot be declared as table constraints on SQLite, so
    // both dialects emit the identical statement (see migrations-pg.ts).
    //
    // visitor_auth_config replaces PRD §4.6's proposal to store `visitorAuth`
    // inside site.settings_json: SiteSettingsSchema is a closed Type.Object
    // whose parse silently drops unknown keys, so a visitorAuth key would not
    // survive a publish/parse round-trip. A dedicated single-row config
    // table is fully testable and keeps the core settings type untouched.
    //
    // SQLite dialect translations (mirror migrations-pg.ts):
    //   jsonb            → text  (auto-parsed on read via the _json suffix)
    //   timestamptz      → text  (ISO 8601)
    //   boolean          → integer  (0/1; repos use Boolean(row.enabled))
    //   default now()    → default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    id: '022_visitor_auth',
    sql: `
      -- ─── visitor_roles ────────────────────────────────────────────────

      create table if not exists visitor_roles (
        id text primary key,
        name text not null unique,
        capabilities_json text not null default '[]',
        is_system integer not null default 0,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      -- First-boot seed only: ON CONFLICT (id) DO NOTHING preserves any
      -- operator edits made via the admin UI on later boots (the migration
      -- runner never re-runs a recorded migration; the guard keeps the seed
      -- idempotent if it ever is). Fixed string ids ('member'/'admin') so
      -- the defaultRole / repository code can reference them by id.
      insert into visitor_roles (id, name, capabilities_json, is_system)
      values
        ('member', 'member', '[]', 1),
        ('admin', 'admin', '["content.read","content.write"]', 1)
      on conflict (id) do nothing;

      -- ─── visitor_users ────────────────────────────────────────────────

      create table if not exists visitor_users (
        id text primary key,
        email text not null,
        email_normalized text not null,
        password_hash text not null,
        display_name text not null default '',
        role_id text not null references visitor_roles(id) on delete restrict,
        status text not null default 'active',
        failed_login_count integer not null default 0,
        locked_until text,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        deleted_at text,
        constraint visitor_users_display_name_check check (length(display_name) <= 200),
        constraint visitor_users_status_check check (status in ('active', 'suspended'))
      );

      -- D12: partial unique index as a separate CREATE statement (SQLite
      -- cannot declare a partial UNIQUE as a table constraint). A soft-
      -- deleted visitor can re-register with the same email.
      create unique index if not exists visitor_users_email_active_idx
        on visitor_users (email_normalized)
        where deleted_at is null;

      -- ─── visitor_sessions ─────────────────────────────────────────────

      create table if not exists visitor_sessions (
        id_hash text primary key,
        user_id text not null references visitor_users(id) on delete cascade,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        last_seen_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        expires_at text not null,
        revoked_at text,
        ip_address text,
        user_agent text,
        device_label text not null default ''
      );

      create index if not exists visitor_sessions_user_idx
        on visitor_sessions (user_id, last_seen_at desc);

      -- ─── visitor_login_attempts ───────────────────────────────────────

      create table if not exists visitor_login_attempts (
        id text primary key,
        attempted_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        email_normalized text,
        ip_address text,
        user_agent text,
        user_id text references visitor_users(id) on delete set null,
        result text not null
          constraint visitor_login_attempts_result_check
          check (result in ('success', 'bad_password', 'no_user', 'locked', 'rate_limited', 'account_disabled'))
      );

      create index if not exists visitor_login_attempts_ip_idx
        on visitor_login_attempts (ip_address);

      create index if not exists visitor_login_attempts_email_idx
        on visitor_login_attempts (email_normalized);

      -- ─── visitor_auth_config (single-row config table) ────────────────

      create table if not exists visitor_auth_config (
        id text primary key default 'default',
        enabled integer not null default 0,
        protected_prefixes_json text not null default '[]',
        login_path text not null default '/login',
        registration_open integer not null default 1,
        default_role text not null default 'member',
        updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      -- Seed the single default-config row on first boot. ON CONFLICT (id)
      -- DO NOTHING preserves operator edits on later boots.
      insert into visitor_auth_config (
        id, enabled, protected_prefixes_json, login_path,
        registration_open, default_role, updated_at
      )
      values ('default', 0, '[]', '/login', 1, 'member', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      on conflict (id) do nothing;
    `,
  },
  {
    id: '023_visitor_password_reset',
    sql: `
      -- ─── visitor_password_reset_tokens ────────────────────────────────
      --
      -- One-shot password-reset tokens. The raw token is generated in JS
      -- (randomBytes(32) base64url) and handed to the email transport; the
      -- DB only ever holds the SHA-256 hex of it (token_hash). A token is
      -- consumed exactly once: consumePasswordResetToken sets used_at, and
      -- the unique hash index keeps the lookup O(log n). expires_at is an
      -- ISO 8601 string with a 1-hour TTL (VISITOR_PASSWORD_RESET_TTL_MS).

      create table if not exists visitor_password_reset_tokens (
        id text primary key,
        user_id text not null references visitor_users(id) on delete cascade,
        token_hash text not null,
        expires_at text not null,
        used_at text,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      create unique index if not exists visitor_password_reset_tokens_hash_idx
        on visitor_password_reset_tokens (token_hash);

      create index if not exists visitor_password_reset_tokens_user_idx
        on visitor_password_reset_tokens (user_id, created_at desc);
    `,
  },
  {
    id: '024_member_groups',
    sql: `
      -- ─── Member groups (Phase 3 — D13/D14/D15) ─────────────────────────
      --
      -- A group is a content-segmentation segment used for page-level access
      -- (D14) and login-redirect landing resolution (D15). Orthogonal to
      -- visitor_roles (D13): a role answers "what can a member DO"; a group
      -- answers "what can a member SEE / where do they land". A visitor
      -- belongs to 0..N groups via visitor_user_groups, with one designated
      -- primary group (visitor_users.primary_group_id, added below).
      --
      -- No seed rows: admins create groups. SQLite mirror of PG 023:
      --   jsonb → n/a (no json columns here)
      --   timestamptz → text (ISO 8601)
      --   boolean → integer (1/0)
      --   default now() → default (strftime(...))

      create table if not exists visitor_groups (
        id            text primary key,
        name          text not null unique,
        slug          text not null,
        landing_path  text not null default '/',
        description   text not null default '',
        is_system     integer not null default 0,
        created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      create index if not exists visitor_groups_slug_idx
        on visitor_groups (slug);

      create table if not exists visitor_user_groups (
        id          text primary key,
        user_id     text not null references visitor_users(id) on delete cascade,
        group_id    text not null references visitor_groups(id) on delete cascade,
        created_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        unique (user_id, group_id)
      );

      create index if not exists visitor_user_groups_user_idx
        on visitor_user_groups (user_id);

      create index if not exists visitor_user_groups_group_idx
        on visitor_user_groups (group_id);

      -- D15 primary group (nullable). ON DELETE SET NULL so deleting a
      -- visitor's primary group simply clears the pointer (the visitor then
      -- falls back to the configured default landing path on login) rather
      -- than cascading the delete onto the user row.
      alter table visitor_users
        add column primary_group_id text references visitor_groups(id) on delete set null;
    `,
  },
  {
    id: '025_page_access',
    sql: `
      -- ─── Retire protected-prefixes; add default landing path (Phase 3) ────
      --
      -- Page access now lives on the Page object (a Page.access field in
      -- cells_json, tolerant-parsed → public by default), so NO schema change
      -- is needed for the access field itself. This migration:
      --   1. ADDs visitor_auth_config.default_landing_path (D15 fallback).
      --   2. Best-effort backfills the old Phase-1/2 protected-prefix config
      --      onto matching pages as per-page access against a single
      --      synthesized 'members' group (mirrors the Phase-1 "protected =
      --      logged-in member" intent). A page is matched when its slug equals
      --      the prefix (sans leading '/') or sits beneath it (prefix/...).
      --   3. DROPs the now-dead protected_prefixes_json column.
      --
      -- The backfill updates BOTH the draft data_rows.cells_json AND the
      -- published site_snapshots.site_json so the middleware gates correctly
      -- immediately after upgrade (without waiting for a re-publish). Both use
      -- SQLite json_* functions (the migration tracker guarantees this runs
      -- exactly once; the _json-suffix adapter auto-parse does NOT apply inside
      -- raw migration SQL, so protected_prefixes_json / site_json are treated
      -- as raw text and parsed explicitly via json_each / json_extract).
      -- Pages that fail to parse are skipped (best-effort; logged nowhere —
      -- the migration runs once and a re-publish will heal any miss).

      alter table visitor_auth_config
        add column default_landing_path text not null default '/';

      -- ─── Backfill (only when prefixes were configured) ──────────────────
      --
      -- Read the single 'default' config row's protected_prefixes_json. When
      -- it is a non-empty array, synthesize one 'members' group and stamp
      -- access onto every prefix-matching page (draft + published). The group
      -- id is the fixed VISITOR_BACKFILL_MEMBERS_GROUP_ID constant.

      -- 1. Create the synthesized 'members' group when there is at least one
      --    prefix. ON CONFLICT (id) DO NOTHING keeps the insert a no-op if a
      --    group with this fixed id somehow already exists.
      insert into visitor_groups (id, name, slug, landing_path, description, is_system)
      select
        'vis_group_members_backfill', 'members', 'members', '/',
        'Synthesized from protected-prefix config during the Phase-3 migration.', 0
      from visitor_auth_config
      where id = 'default'
        and json_array_length(
          case
            when json_valid(protected_prefixes_json) then protected_prefixes_json
            else '[]'
          end
        ) > 0
      on conflict (id) do nothing;

      -- 2. Stamp access onto draft pages (data_rows.cells_json) whose slug
      --    matches any configured prefix. The page access cell is a JSON
      --    object {level:'groups', groups:[<members group id>]}. A page's slug
      --    matches prefix P when slug = P (sans leading '/') or slug LIKE P/%%
      --    (the same semantics the old prefix middleware used, minus the
      --    leading slash the slug never carries).
      update data_rows
        set cells_json = json_set(
          cells_json,
          '$.access',
          json('{"level":"groups","groups":["vis_group_members_backfill"]}')
        )
        where table_id = 'pages'
          and deleted_at is null
          and exists (
            select 1
            from visitor_auth_config c, json_each(
              case when json_valid(c.protected_prefixes_json) then c.protected_prefixes_json else '[]' end
            ) as prefix
            where c.id = 'default'
              and (
                data_rows.slug = substr(prefix.value, 2)
                or data_rows.slug like substr(prefix.value, 2) || '/%'
              )
          );

      -- 3. Stamp access onto published pages inside every site snapshot
      --    (site_snapshots.site_json). Rebuild the $.pages array, setting
      --    $.pages[i].access on every page whose slug matches a prefix. Only
      --    snapshots that actually contain a matching page are touched. The
      --    correlated json_group_array walks every page in the snapshot so
      --    non-matching pages pass through unchanged.
      update site_snapshots
        set site_json = (
          select json_set(
            site_snapshots.site_json,
            '$.pages',
            json_group_array(
              case
                when exists (
                  select 1
                  from visitor_auth_config c, json_each(
                    case when json_valid(c.protected_prefixes_json) then c.protected_prefixes_json else '[]' end
                  ) as prefix
                  where c.id = 'default'
                    and (
                      json_extract(page.value, '$.slug') = substr(prefix.value, 2)
                      or json_extract(page.value, '$.slug') like substr(prefix.value, 2) || '/%'
                    )
                )
                then json_set(
                  page.value,
                  '$.access',
                  json('{"level":"groups","groups":["vis_group_members_backfill"]}')
                )
                else page.value
              end
            )
          )
          from json_each(site_snapshots.site_json, '$.pages') as page
        )
        where exists (
          select 1
          from visitor_auth_config c,
               json_each(site_snapshots.site_json, '$.pages') as p,
               json_each(
                 case when json_valid(c.protected_prefixes_json) then c.protected_prefixes_json else '[]' end
               ) as prefix
          where c.id = 'default'
            and (
              json_extract(p.value, '$.slug') = substr(prefix.value, 2)
              or json_extract(p.value, '$.slug') like substr(prefix.value, 2) || '/%'
            )
        );

      -- 4. Drop the now-dead column. SQLite >= 3.35 supports ALTER TABLE
      --    DROP COLUMN; the baseline targets a recent SQLite, and the
      --    migration-parity test only checks ids (the SQL may differ between
      --    dialects). If a future older engine lacks DROP COLUMN this ALTER is
      --    the one statement to special-case; the column is read nowhere after
      --    this migration, so leaving it would be a harmless dead column.
      alter table visitor_auth_config
        drop column protected_prefixes_json;
    `,
  },
  {
    id: '026_visitor_profile_fields',
    sql: `
      -- ─── Visitor custom profile fields (per-visitor-data framework) ────
      --
      -- Adds a JSON column to visitor_users storing the VALUES of site-
      -- builder-defined custom profile fields (e.g. schoolName), keyed by
      -- field id. The field DEFINITIONS live in visitor_auth_config
      -- (profile_fields_json, added below) and mirror the DataField[] shape
      -- used by data_tables.fields_json. This mirrors how data_tables stores
      -- field definitions (fields_json) — same pattern, smaller surface.
      --
      -- Values default to '{}' so every visitor row is valid immediately.
      -- Extraction at read time uses the json_extract() helpers; the
      -- _json-suffix adapter auto-parses the column into an object on read.

      alter table visitor_users
        add column profile_fields_json text not null default '{}';

      -- Store the site-builder-configured profile field DEFINITIONS on the
      -- single visitor_auth_config row. A DataField[] JSON array; default
      -- '[]' = no custom profile fields (the pre-framework behaviour).
      alter table visitor_auth_config
        add column profile_fields_json text not null default '[]';
    `,
  },
  {
    id: '027_visitor_owned_data',
    sql: `
      -- ─── Per-visitor owned data (visitor-data framework, Pillar 3) ────────
      --
      -- Links a data row to the visitor who owns it (e.g. a tender they
      -- submitted). FK visitor_users with ON DELETE SET NULL so deleting a
      -- visitor account retains the row for audit but unlinks it. Indexed
      -- for efficient per-visitor queries. data_tables.captures_visitor_owner
      -- is a per-table opt-in flag (0/1) — the form handler stamps
      -- visitor_user_id only when the target table opts in, so unrelated
      -- tables are untouched.

      alter table data_rows
        add column visitor_user_id text references visitor_users(id) on delete set null;

      create index if not exists data_rows_table_visitor_idx
        on data_rows (table_id, visitor_user_id, updated_at desc);

      alter table data_tables
        add column captures_visitor_owner integer not null default 0;
    `,
  },
]
