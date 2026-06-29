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
]
