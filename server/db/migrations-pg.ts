import type { Migration } from './runMigrations'

/**
 * Postgres dialect — single consolidated baseline.
 *
 * Pre-release rules (CLAUDE.md): no backward compatibility, the local dev DB
 * is disposable, and we never carry a forwarded migration trail "just in
 * case". The 19 incremental migrations that built this schema during
 * development have been collapsed into one `001_baseline` representing the
 * final state. New schema work appends a new migration in the usual way
 * (`002_<change>`, etc.); the parity test gates IDs between this file and
 * `migrations-sqlite.ts`.
 *
 * Order within the baseline is dictated by FK dependencies:
 *
 *   1. roles                    — no FKs
 *   2. users                    — FK roles; `avatar_media_id` added below
 *   3. sessions, audit_events,
 *      data_*, installed_plugins,
 *      plugin_*, published_runtime_assets,
 *      login_attempts, plugin_crash_events
 *                              — all FK users (and various siblings)
 *   4. media_assets             — FK users; needed before the users
 *                                  `avatar_media_id` self-add
 *   5. media_folders, media_*   — FK media_assets / each other
 *   6. ALTER users ADD avatar_media_id REFERENCES media_assets
 *   7. ALTER data_rows ADD active_version_id FK → data_row_versions
 *
 * `schema_migrations` is created by `runMigrations.ts` itself before any
 * migration runs, so the baseline does not re-declare it.
 *
 * Pages and Visual Components live in data_tables / data_rows — the same
 * unified store as posts. The legacy "pages" and "page_versions" tables are
 * not part of this baseline.
 */
export const pgMigrations: Migration[] = [
  {
    id: '001_baseline',
    sql: `
      -- ─── Roles + Users ─────────────────────────────────────────────────────

      create table if not exists roles (
        id text primary key,
        slug text not null unique,
        name text not null,
        description text not null default '',
        is_system boolean not null default false,
        capabilities_json jsonb not null default '[]'::jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
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
        ('owner', 'owner', 'Owner', 'Permanent installation owner with full system access.', true, '["dashboard.read","site.read","site.structure.edit","site.content.edit","site.style.edit","pages.edit","pages.publish","content.create","content.edit.own","content.edit.any","content.publish.own","content.publish.any","content.manage","media.read","media.write","media.replace","media.delete","runtime.dependencies","storage.elect","storage.migrate","plugins.read","plugins.configure","plugins.install","plugins.lifecycle","users.manage","roles.manage","audit.read","data.tables.read","data.tables.manage","data.rows.move","data.export","data.import","ai.chat","ai.tools.write","ai.providers.manage","ai.audit.read"]'::jsonb),
        ('admin', 'admin', 'Admin', 'Full admin access (cannot manage roles).', true, '["dashboard.read","site.read","site.structure.edit","site.content.edit","site.style.edit","pages.edit","pages.publish","content.create","content.edit.own","content.edit.any","content.publish.own","content.publish.any","content.manage","media.read","media.write","media.replace","media.delete","runtime.dependencies","storage.elect","storage.migrate","plugins.read","plugins.configure","plugins.install","plugins.lifecycle","users.manage","audit.read","data.tables.read","data.tables.manage","data.rows.move","data.export","data.import","ai.chat","ai.tools.write","ai.providers.manage","ai.audit.read"]'::jsonb),
        ('client', 'client', 'Client', 'Can edit page copy (text, images, links) but not structure or styles.', true, '["dashboard.read","site.read","site.content.edit","media.read","data.tables.read"]'::jsonb),
        ('member', 'member', 'Member', 'Public-facing member account — no admin access by default.', true, '[]'::jsonb)
      on conflict (id) do update
        set slug = excluded.slug,
            name = excluded.name,
            description = excluded.description,
            is_system = excluded.is_system,
            capabilities_json = excluded.capabilities_json,
            updated_at = current_timestamp;

      -- avatar_media_id is added after media_assets exists (see below).
      create table if not exists users (
        id text primary key,
        email text not null,
        email_normalized text not null,
        display_name text not null,
        password_hash text not null,
        status text not null default 'active',
        role_id text not null references roles(id) on delete restrict,
        last_login_at timestamptz,
        failed_login_count integer not null default 0,
        locked_until timestamptz,
        password_updated_at timestamptz,
        mfa_enabled boolean not null default false,
        mfa_enabled_at timestamptz,
        mfa_totp_secret_ciphertext bytea,
        mfa_totp_secret_iv bytea,
        mfa_totp_secret_key_fingerprint text,
        mfa_recovery_code_hashes_json jsonb not null default '[]'::jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        deleted_at timestamptz,
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
        settings_json jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );

      -- ─── Sessions + Audit ──────────────────────────────────────────────────

      create table if not exists sessions (
        id_hash text primary key,
        user_id text not null references users(id) on delete cascade,
        created_at timestamptz not null default now(),
        last_seen_at timestamptz not null default now(),
        expires_at timestamptz not null,
        revoked_at timestamptz,
        ip_address text,
        user_agent text,
        device_label text not null default '',
        mfa_passed_at timestamptz,
        step_up_expires_at timestamptz
      );

      create index if not exists sessions_user_idx
        on sessions (user_id, last_seen_at desc);

      create index if not exists sessions_user_active_idx
        on sessions (user_id, expires_at)
        where revoked_at is null;

      -- ─── User Preferences ─────────────────────────────────────────────────
      --
      -- Per-user, per-key JSON blob — the canonical home for any setting that
      -- belongs to one admin and would otherwise live in localStorage
      -- (dashboard layout, theme, default breakpoint, sidebar-collapsed state,
      -- etc.).
      --
      -- Why a (user_id, key) table rather than a JSON column on users:
      --   1. The users row is hot — every authenticated request joins it.
      --      Dragging a fat preferences blob along on every auth lookup is
      --      wasteful when most callers do not need it.
      --   2. New preferences are added by code change only; the wire-level
      --      key is type-narrowed by a TS whitelist (see
      --      src/core/persistence/userPreferences.ts). The DB intentionally
      --      accepts any string so that adding a key does not require a
      --      migration — the server handler is the enforcement boundary.
      --   3. on delete cascade so removing a user (admin housekeeping)
      --      drops their preferences atomically.
      --
      -- value_json is opaque to this layer; the server per-key TypeBox
      -- schemas validate shape at the HTTP boundary (read AND write paths).
      create table if not exists user_preferences (
        user_id    text not null references users(id) on delete cascade,
        key        text not null,
        value_json jsonb not null,
        updated_at timestamptz not null default now(),
        primary key (user_id, key)
      );

      create table if not exists audit_events (
        id text primary key,
        actor_user_id text references users(id) on delete set null,
        action text not null,
        target_type text,
        target_id text,
        metadata_json jsonb not null default '{}'::jsonb,
        ip_address text,
        user_agent text,
        created_at timestamptz not null default now()
      );

      create index if not exists audit_events_created_idx
        on audit_events (created_at desc);

      -- Login-attempts audit. Append-only forensic trail of every login
      -- attempt: successes, wrong passwords, no-user, suspensions, locks,
      -- rate-limits, MFA failures. user_agent is captured so the Account →
      -- Sign-in history tab can derive a friendly "Browser on Platform"
      -- label per row.
      create table if not exists login_attempts (
        id text primary key,
        attempted_at timestamptz not null default now(),
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
        fields_json jsonb not null default '[]'::jsonb,
        system boolean not null default false,
        created_by_user_id text references users(id) on delete set null,
        updated_by_user_id text references users(id) on delete set null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        deleted_at timestamptz,
        constraint data_tables_kind_check check (kind in ('postType', 'data', 'page', 'component'))
      );

      create unique index if not exists data_tables_slug_active_idx
        on data_tables (slug)
        where deleted_at is null;

      -- ─── System table seeds ────────────────────────────────────────────────
      --
      -- Three system tables are seeded at boot. They are protected from rename
      -- and delete (system = true). Users can add custom fields to them.

      insert into data_tables (id, name, slug, kind, route_base, singular_label, plural_label, primary_field_id, system, fields_json)
      values ('posts', 'Posts', 'posts', 'postType', '/posts', 'Post', 'Posts', 'title', true,
        '[{"type":"text","id":"title","label":"Title","required":true,"builtIn":true},{"type":"text","id":"slug","label":"Slug","required":true,"builtIn":true},{"type":"richText","id":"body","label":"Body","format":"markdown","builtIn":true},{"type":"media","id":"featuredMedia","label":"Featured media","mediaKind":"image","builtIn":true},{"type":"text","id":"seoTitle","label":"SEO title","builtIn":true},{"type":"longText","id":"seoDescription","label":"SEO description","builtIn":true}]'::jsonb)
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
            updated_at = current_timestamp,
            deleted_at = null;

      insert into data_tables (id, name, slug, kind, route_base, singular_label, plural_label, primary_field_id, system, fields_json)
      values ('pages', 'Pages', 'pages', 'page', '', 'Page', 'Pages', 'title', true,
        '[{"type":"text","id":"title","label":"Title","required":true,"builtIn":true},{"type":"text","id":"slug","label":"Slug","required":true,"builtIn":true},{"type":"pageTree","id":"body","label":"Body","required":true,"builtIn":true},{"type":"text","id":"seoTitle","label":"SEO title","builtIn":true},{"type":"longText","id":"seoDescription","label":"SEO description","builtIn":true},{"type":"boolean","id":"templateEnabled","label":"Template","builtIn":true},{"type":"longText","id":"templateTarget","label":"Template target","builtIn":true},{"type":"number","id":"templatePriority","label":"Template priority","integer":true,"builtIn":true}]'::jsonb)
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
            updated_at = current_timestamp,
            deleted_at = null;

      insert into data_tables (id, name, slug, kind, route_base, singular_label, plural_label, primary_field_id, system, fields_json)
      values ('components', 'Components', 'components', 'component', '', 'Component', 'Components', 'name', true,
        '[{"type":"text","id":"name","label":"Name","required":true,"builtIn":true},{"type":"text","id":"slug","label":"Slug","required":true,"builtIn":true},{"type":"pageTree","id":"body","label":"Body","required":true,"builtIn":true},{"type":"fieldSchema","id":"params","label":"Params","builtIn":true},{"type":"longText","id":"classIds","label":"Classes","builtIn":true}]'::jsonb)
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
            updated_at = current_timestamp,
            deleted_at = null;

      -- data_rows ↔ data_row_versions form a cycle (rows.active_version_id
      -- → versions.id, versions.row_id → rows.id). Create rows without the
      -- active-version FK first, then versions, then attach the FK via
      -- ALTER TABLE at the bottom of the baseline.
      create table if not exists data_rows (
        id text primary key,
        table_id text not null references data_tables(id) on delete restrict,
        cells_json jsonb not null default '{}'::jsonb,
        slug text not null default '',
        status text not null default 'draft',
        active_version_id text,
        author_user_id text references users(id) on delete set null,
        created_by_user_id text references users(id) on delete set null,
        updated_by_user_id text references users(id) on delete set null,
        published_by_user_id text references users(id) on delete set null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        published_at timestamptz,
        deleted_at timestamptz,
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
        cells_json jsonb not null default '{}'::jsonb,
        slug text not null default '',
        published_by_user_id text references users(id) on delete set null,
        published_at timestamptz not null default now(),
        created_at timestamptz not null default now(),
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
        created_at timestamptz not null default now()
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
        enabled boolean not null default true,
        granted_permissions_json jsonb not null default '[]'::jsonb,
        manifest_json jsonb not null,
        lifecycle_status text not null default 'installed',
        last_error text,
        settings_json jsonb not null default '{}'::jsonb,
        installed_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );

      create index if not exists installed_plugins_enabled_idx
        on installed_plugins (enabled, installed_at desc);

      create table if not exists plugin_records (
        id text primary key,
        plugin_id text not null references installed_plugins(id) on delete cascade,
        resource_id text not null,
        data_json jsonb not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );

      create index if not exists plugin_records_resource_idx
        on plugin_records (plugin_id, resource_id, created_at desc);

      create table if not exists plugin_crash_events (
        id text primary key,
        plugin_id text not null,
        occurred_at timestamptz not null default now(),
        reason text not null,
        stack text
      );

      create index if not exists plugin_crash_events_plugin_idx
        on plugin_crash_events (plugin_id, occurred_at desc);

      -- ─── Media ────────────────────────────────────────────────────────────
      --
      -- Media inspector metadata (alt/caption/title/tags/dominant_color/
      -- deleted/replaced), responsive pipeline outputs (blur_hash, variants,
      -- poster), and intrinsic dimensions (width/height/duration_ms) are
      -- inline. Folders are many-to-many (HappyFiles-style). Smart folders
      -- run a TypeBox-validated query at list time. Usage refs are a reverse
      -- index populated by the publish pipeline.

      create table if not exists media_assets (
        id text primary key,
        filename text not null,
        mime_type text not null,
        size_bytes bigint not null,
        storage_path text not null,
        public_path text not null unique,
        uploaded_by_user_id text references users(id) on delete set null,
        alt_text text not null default '',
        caption text not null default '',
        title text not null default '',
        tags_json jsonb not null default '[]'::jsonb,
        width integer,
        height integer,
        duration_ms integer,
        dominant_color text,
        blur_hash text,
        variants_json jsonb not null default '[]'::jsonb,
        poster_path text,
        deleted_at timestamptz,
        replaced_at timestamptz,
        created_at timestamptz not null default now()
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
        created_at timestamptz not null default now()
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
        query_json jsonb not null,
        created_by_user_id text references users(id) on delete set null,
        created_at timestamptz not null default now()
      );

      create table if not exists media_usage_refs (
        asset_id text not null references media_assets(id) on delete cascade,
        ref_kind text not null,
        ref_id text not null,
        ref_path text not null default '',
        computed_at timestamptz not null default now(),
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
        content_bytes bytea not null,
        created_at timestamptz not null default now()
      );

      create index if not exists published_runtime_assets_data_row_version_idx
        on published_runtime_assets (data_row_version_id);

      -- ─── Cross-FK fixups ──────────────────────────────────────────────────

      -- users.avatar_media_id → media_assets. Added now that media_assets
      -- exists (users itself had to exist first because most other tables
      -- FK it).
      alter table users
        add column if not exists avatar_media_id text references media_assets(id) on delete set null;

      -- data_rows.active_version_id → data_row_versions. The DO block guards
      -- against re-applying the constraint when the migration is replayed.
      do $$ begin
        if not exists (
          select 1 from pg_constraint where conname = 'data_rows_active_version_fk'
        ) then
          alter table data_rows
            add constraint data_rows_active_version_fk
            foreign key (active_version_id) references data_row_versions(id) on delete set null;
        end if;
      end $$;
    `,
  },
  {
    id: '002_plugin_schedules',
    sql: `
      -- ─── Plugin scheduled jobs ────────────────────────────────────────────
      --
      -- One row per (plugin_id, schedule_id) registered via
      -- api.cms.schedule.register(...). The cadence is stored as a JSON
      -- payload (interval kind + parameters) — the host computes next_run_at
      -- after each fire. running_token + lock_until coordinate a single
      -- active run per schedule, even across HA host instances (Postgres
      -- advisory locks gate which instance ticks; row-level locks gate which
      -- schedule fires next).
      --
      -- Two independent state flags:
      --   enabled — registration state. Set true by register, false by
      --             cancel and by the post-activation ghost sweep.
      --   paused  — operator/failure intervention. Set by the admin pause
      --             endpoint and the consecutive-failure auto-pause;
      --             cleared by admin resume. Registration never touches it,
      --             so a pause survives server restarts.
      --
      -- claimed_at marks the most recent register() call for the row — the
      -- ghost sweep disables rows whose claimed_at predates the plugin's
      -- latest activate() pass.

      create table if not exists plugin_schedules (
        plugin_id text not null references installed_plugins(id) on delete cascade,
        schedule_id text not null,
        cadence_json jsonb not null,
        overlap text not null default 'skip',
        max_duration_ms integer not null default 5000,
        enabled boolean not null default true,
        paused boolean not null default false,
        consecutive_failures integer not null default 0,
        last_run_at timestamptz,
        last_finished_at timestamptz,
        last_status text,
        last_error text,
        last_duration_ms integer,
        next_run_at timestamptz not null,
        running_token text,
        lock_until timestamptz,
        claimed_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        primary key (plugin_id, schedule_id)
      );

      create index if not exists plugin_schedules_due_idx
        on plugin_schedules (enabled, paused, next_run_at);

      -- History — bounded growth via app-level rolling delete in the
      -- scheduler tick. Each tick keeps the latest 200 rows per (plugin_id,
      -- schedule_id) so an admin "Recent runs" list always has data
      -- without unbounded storage.

      create table if not exists plugin_schedule_runs (
        id text primary key,
        plugin_id text not null,
        schedule_id text not null,
        started_at timestamptz not null,
        finished_at timestamptz,
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
      --
      -- content_hash is the SHA-256 of the canonical-JSON serialisation of
      -- site_json, stamped at publish time so the publish-status check can
      -- compare draft vs published without parsing any snapshot.
      --
      -- importmap_body is the pre-serialised runtime package importmap (exact
      -- bytes the CSP hash was computed over) — TEXT, never re-encoded.
      create table if not exists site_snapshots (
        id text primary key,
        site_json jsonb not null,
        content_hash text not null,
        importmap_body text,
        importmap_sha256 text,
        created_at timestamptz not null default now()
      );

      alter table data_row_versions
        add column if not exists site_snapshot_id text references site_snapshots(id) on delete set null;

      -- Per-page runtime script manifest (page-scoped, unlike the shared site
      -- document).
      alter table data_row_versions
        add column if not exists runtime_assets_json jsonb;

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
      -- One row per asset role ('original', 'variant', 'avatar', 'font',
      -- 'plugin-pack'). 'adapter_id' is the namespaced id of a plugin
      -- adapter (e.g. 'acme.s3.adapter') OR the empty string for the
      -- built-in local-disk adapter. Missing rows default to local-disk.
      --
      -- The row's primary key on 'role' enforces the "exactly one elected
      -- adapter per role" invariant at the DB level.

      create table if not exists active_media_storage_adapter (
        role text primary key,
        adapter_id text not null default '',
        elected_at timestamptz not null default now(),
        elected_by_user_id text references users(id) on delete set null
      );

      -- ─── Per-asset adapter pinning ───────────────────────────────────────
      --
      -- Each media asset remembers which adapter wrote it. Reads dispatch
      -- through THIS column, not the currently-elected one, so a
      -- post-election adapter swap doesn't strand existing rows. Empty
      -- string = built-in local-disk adapter (matches the historical
      -- behaviour for pre-existing rows).

      alter table media_assets
        add column if not exists storage_adapter_id text not null default '';

      -- ─── Externally-hosted flag ──────────────────────────────────────────
      --
      -- True when the asset's bytes live outside the host's uploads dir
      -- (i.e. the adapter's servingMode is 'public-url'). The hard-delete
      -- path uses this to skip the local 'rm' and call the adapter's
      -- delete() instead.

      alter table media_assets
        add column if not exists externally_hosted boolean not null default false;
    `,
  },
  {
    id: '005_media_variant_delegate',
    sql: `
      -- ─── Variant delegate election (singleton) ────────────────────────────
      --
      -- Tier 3 of the media plugin surface: when an image-transform CDN
      -- plugin (Cloudflare Images, Imgix, Bunny Optimizer) is elected,
      -- the host SKIPS local variant generation and instead emits URLs
      -- derived from the delegate's URL template.
      --
      -- Singleton table — at most ONE delegate is active per host. The
      -- 'singleton = 1 CHECK' is the DB-level guarantee; missing row
      -- means "no delegate elected → fall back to local sharp ladder".

      create table if not exists active_media_variant_delegate (
        singleton integer primary key default 1 check (singleton = 1),
        delegate_id text not null,
        variant_url_template text not null,
        widths_json jsonb not null,
        formats_json jsonb not null,
        elected_at timestamptz not null default now(),
        elected_by_user_id text references users(id) on delete set null
      );
    `,
  },
  {
    id: '006_data_rows_scheduled_publish',
    sql: `
      -- ─── Scheduled publish — bring existing data_rows up to the new schema.
      --
      -- The baseline migration was rewritten in this revision to include
      -- the 'scheduled' status + the scheduled_publish_at column for fresh
      -- installs. This migration brings ALREADY-INSTALLED databases up
      -- to the same shape so the publish-scheduler tick + the dashboard
      -- stats endpoint can read/write the new columns without crashing.
      --
      -- Idempotent: every step uses 'if not exists' / 'if exists' so a
      -- fresh install that already matches the new baseline runs this
      -- as a no-op.

      alter table data_rows
        add column if not exists scheduled_publish_at timestamptz;

      alter table data_rows
        drop constraint if exists data_rows_status_check;

      alter table data_rows
        add constraint data_rows_status_check
        check (status in ('draft', 'published', 'unpublished', 'scheduled'));

      create index if not exists data_rows_scheduled_publish_idx
        on data_rows (scheduled_publish_at)
        where status = 'scheduled' and deleted_at is null;
    `,
  },
  {
    id: '007_ai_runtime',
    sql: `
      -- ─── AI runtime: providers, credentials, defaults, conversations ──────
      --
      -- Phase 1 of docs/plans/2026-05-26-ai-runtime-rewrite.md.
      --
      -- One driver per provider; each provider supports multiple auth modes
      -- (ambient = no key, apiKey = encrypted user key, baseUrl = endpoint
      -- override). The auth_mode check + ai_creds_apikey_shape_check enforce
      -- column-shape consistency at the DB layer so repository code can trust
      -- the row shape.

      create table if not exists ai_provider_credentials (
        id text primary key,
        user_id text not null references users(id) on delete cascade,
        provider_id text not null,
        auth_mode text not null,
        display_label text not null,
        ciphertext bytea,
        iv bytea,
        base_url text,
        key_fingerprint text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        last_used_at timestamptz,
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

      -- Per-scope site-wide default credential + model. credential_id is
      -- restricted-on-delete: the UI nudges users to reassign before removing
      -- a credential that's the current default for any scope.
      create table if not exists ai_defaults (
        scope text primary key,
        credential_id text not null references ai_provider_credentials(id) on delete restrict,
        model_id text not null,
        updated_at timestamptz not null default now(),
        updated_by text references users(id) on delete set null,
        constraint ai_defaults_scope_check
          check (scope in ('site', 'content', 'data', 'plugin'))
      );

      -- Persistent conversations per (user, scope).
      create table if not exists ai_conversations (
        id text primary key,
        user_id text not null references users(id) on delete cascade,
        scope text not null,
        title text not null,
        credential_id text references ai_provider_credentials(id) on delete set null,
        model_id text not null,
        prompt_tokens_total bigint not null default 0,
        completion_tokens_total bigint not null default 0,
        cost_usd_total numeric(10, 6) not null default 0,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        deleted_at timestamptz,
        constraint ai_conv_scope_check
          check (scope in ('site', 'content', 'data', 'plugin'))
      );

      -- "My recent chats" query path. Partial index — soft-deleted rows drop
      -- out automatically.
      create index if not exists ai_conv_user_scope_idx
        on ai_conversations (user_id, scope, updated_at desc)
        where deleted_at is null;

      -- Hard-purge driver: the nightly job picks rows older than 30 days.
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
        cost_usd numeric(10, 6) not null default 0,
        created_at timestamptz not null default now(),
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
      -- Anthropic prompt-cache visibility. The driver already reads
      -- cache_read_input_tokens + cache_creation_input_tokens off the SDK
      -- usage block; persisting them lets the audit page show whether
      -- caching is actually firing (cache reads dominate after the first
      -- turn in a healthy chat).
      --
      -- Per-message + denormalised conversation totals — same shape as the
      -- existing prompt_tokens / completion_tokens pair so the rollups can
      -- aggregate uniformly.
      alter table ai_messages
        add column cache_read_tokens integer not null default 0,
        add column cache_creation_tokens integer not null default 0;

      alter table ai_conversations
        add column cache_read_tokens_total bigint not null default 0,
        add column cache_creation_tokens_total bigint not null default 0;
    `,
  },
  {
    id: '010_data_rows_plugin_actor',
    sql: `
      -- ─── Plugin actor attribution ─────────────────────────────────────────
      --
      -- Plugins can now read/write CMS content via api.cms.content.* (see
      -- docs/features/plugin-system.md). Each write records which plugin
      -- originated the mutation alongside the regular updated_by_user_id —
      -- so a route-bound call records both the user AND the plugin acting
      -- on their behalf. Null for editor writes / system actors.
      --
      -- Plain text column — no FK to installed_plugins because the column
      -- must survive plugin uninstall for audit history.
      alter table data_rows
        add column if not exists plugin_actor_id text;
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
        add column step_up_auth_mode text not null default 'required',
        add column step_up_window_minutes integer not null default 15,
        add constraint users_step_up_auth_mode_check
          check (step_up_auth_mode in ('required', 'disabled')),
        add constraint users_step_up_window_minutes_check
          check (step_up_window_minutes in (5, 15, 30, 60));
    `,
  },
  {
    id: '012_ai_drop_provider_check',
    sql: `
      -- ─── Drop the provider_id enum constraint ────────────────────────────
      --
      -- provider_id is validated at the application boundary by the TypeBox
      -- ProviderId union (server/ai/handlers/credentials.ts). The original
      -- DB-level enum check duplicated that list, so adding a provider
      -- (e.g. OpenRouter) on an existing DB silently failed the insert with a
      -- CHECK violation surfaced as a generic 500. Drop it — the boundary is
      -- the single source of truth for valid providers.
      alter table ai_provider_credentials
        drop constraint if exists ai_creds_provider_check;
    `,
  },
  {
    id: '013_ai_model_pricing',
    sql: `
      -- ─── Live model-pricing cache ────────────────────────────────────────
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
        input_per_mtok numeric(12, 4) not null,
        output_per_mtok numeric(12, 4) not null,
        cache_read_per_mtok numeric(12, 4),
        cache_write_per_mtok numeric(12, 4),
        refreshed_at timestamptz not null default now()
      );
    `,
  },
  {
    id: '014_ai_conversation_context_tokens',
    sql: `
      -- ─── Current-context snapshot ────────────────────────────────────────
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
      -- ─── Model context window ────────────────────────────────────────────
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
      -- ─── Encrypted plugin secret settings ────────────────────────────────
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
      create table if not exists plugin_secrets (
        plugin_id text not null references installed_plugins(id) on delete cascade,
        setting_id text not null,
        ciphertext bytea not null,
        iv bytea not null,
        key_fingerprint text not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        primary key (plugin_id, setting_id)
      );
    `,
  },
  {
    id: '017_layouts_system_table',
    sql: `
      -- ─── Saved layouts: fourth system table ──────────────────────────────
      --
      -- Adds 'layout' to the data_tables.kind enum and seeds the locked
      -- 'layouts' system table (snapshot rows live in data_rows like every
      -- other collection). The constraint swap is idempotent on fresh
      -- installs — it recreates the baseline check plus the new kind.

      alter table data_tables drop constraint data_tables_kind_check;
      alter table data_tables add constraint data_tables_kind_check
        check (kind in ('postType', 'data', 'page', 'component', 'layout'));

      insert into data_tables (id, name, slug, kind, route_base, singular_label, plural_label, primary_field_id, system, fields_json)
      values ('layouts', 'Layouts', 'layouts', 'layout', '', 'Layout', 'Layouts', 'name', true,
        '[{"type":"text","id":"name","label":"Name","required":true,"builtIn":true},{"type":"text","id":"slug","label":"Slug","required":true,"builtIn":true},{"type":"pageTree","id":"body","label":"Body","required":true,"builtIn":true},{"type":"longText","id":"classes","label":"Classes","builtIn":true}]'::jsonb)
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
            updated_at = current_timestamp,
            deleted_at = null;
    `,
  },
]
