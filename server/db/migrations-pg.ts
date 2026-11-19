import type { DbClient } from './client'
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
/**
 * `plugin_records.data_json` used to be bound as a JSON string, which the
 * column stores as a string scalar: it reads back fine, but no `list` filter
 * can see inside it. This unwraps every such row into the object it holds.
 *
 * It must be impossible for this to fail a boot, whatever the rows hold, so
 * it is one plpgsql block that swallows every error:
 *
 *   1. Fast path, where the server has `pg_input_is_valid` (Postgres 16+):
 *      one set-based UPDATE of the rows whose string is valid JSON. Run
 *      through EXECUTE so older servers never parse the call. That function
 *      only reports "soft" errors: a string nested tens of thousands of
 *      levels deep still raises ("stack depth limit exceeded"), so the whole
 *      UPDATE sits in its own exception block.
 *   2. Row path, on servers without the function or when the fast path
 *      raised: each remaining row is cast in its own exception block; a row
 *      that cannot be cast is skipped and stays exactly as it is. The reader
 *      (`readDataJson`) still understands a string row.
 *
 * No helper function is created, so no TEMP or CREATE privilege is needed.
 * A migration of its own, so it never shares a transaction (and a table
 * lock) with an ALTER TABLE. Only strings that begin an object are touched.
 *
 * Two things plpgsql cannot swallow are handled by the runner instead:
 *
 *   - A cancel. `exception when others` skips `query_canceled`, so a database
 *     or role `statement_timeout` shorter than the rewrite would abort the
 *     migration on every boot. The migration sets `noTimeouts`. A
 *     `lock_timeout` raises a catchable error, but would leave rows behind
 *     for no good reason, so it is switched off too.
 *   - Silence. Whatever was swallowed, the migration is recorded as applied.
 *     `leftover` counts the rows still stored as strings and the runner logs
 *     it with the `[migrations]` prefix (the server's own WARNING goes to the
 *     Postgres log; the driver does not hand notices to the application).
 *
 * Exported so the row path can be exercised on a newer server in tests.
 */
export const PLUGIN_RECORDS_JSON_REPAIR_SQL = `
      do $repair$
      declare
        stored record;
        fast_path_done boolean := false;
        skipped integer := 0;
      begin
        if to_regprocedure('pg_input_is_valid(text, text)') is not null then
          begin
            execute $fast$
              update plugin_records
                 set data_json = (data_json #>> '{}')::jsonb
               where jsonb_typeof(data_json) = 'string'
                 and left(ltrim(data_json #>> '{}'), 1) = '{'
                 and pg_input_is_valid(data_json #>> '{}', 'jsonb')
            $fast$;
            fast_path_done := true;
          exception when others then
            fast_path_done := false;
          end;
        end if;

        if not fast_path_done then
          for stored in
            select id, data_json #>> '{}' as raw
              from plugin_records
             where jsonb_typeof(data_json) = 'string'
               and left(ltrim(data_json #>> '{}'), 1) = '{'
          loop
            begin
              update plugin_records set data_json = stored.raw::jsonb where id = stored.id;
            exception when others then
              skipped := skipped + 1;
            end;
          end loop;
          if skipped > 0 then
            raise warning 'plugin_records: % row(s) hold text that is not a JSON object and were left as they are', skipped;
          end if;
        end if;
      exception when others then
        raise warning 'plugin_records: the JSON repair did not run (%)', sqlerrm;
      end
      $repair$;
`

/**
 * Rows the repair left as string scalars: text that is not a JSON object, or
 * a row the repair could not cast. They still read (`readDataJson` parses a
 * string holding an object) but no `list` filter matches them until the
 * record is written again.
 */
async function pluginRecordsStillStoredAsText(tx: DbClient): Promise<string | null> {
  const { rows } = await tx.unsafe<{ remaining: string | number }>(
    `select count(*) as remaining from plugin_records where jsonb_typeof(data_json) = 'string'`,
  )
  const remaining = Number(rows[0]?.remaining ?? 0)
  if (remaining === 0) return null
  return `${remaining} plugin record(s) are still stored as text. They can be read where the text holds a JSON object, but list filters do not match them until each is saved again.`
}

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
        ('owner', 'owner', 'Owner', 'Permanent installation owner with full system access.', true, '["dashboard.read","site.read","site.structure.edit","site.content.edit","site.style.edit","pages.edit","pages.publish","content.create","content.edit.own","content.edit.any","content.publish.own","content.publish.any","content.manage","media.read","media.write","media.replace","media.delete","runtime.dependencies","storage.elect","storage.migrate","plugins.read","plugins.configure","plugins.install","plugins.lifecycle","users.manage","roles.manage","audit.read","data.custom.tables.read","data.custom.tables.manage","data.system.tables.read","data.system.tables.manage","data.rows.move","data.export","data.import","ai.chat","ai.tools.write","ai.providers.manage","ai.audit.read"]'::jsonb),
        ('admin', 'admin', 'Admin', 'Full admin access (cannot manage roles).', true, '["dashboard.read","site.read","site.structure.edit","site.content.edit","site.style.edit","pages.edit","pages.publish","content.create","content.edit.own","content.edit.any","content.publish.own","content.publish.any","content.manage","media.read","media.write","media.replace","media.delete","runtime.dependencies","storage.elect","storage.migrate","plugins.read","plugins.configure","plugins.install","plugins.lifecycle","users.manage","audit.read","data.custom.tables.read","data.custom.tables.manage","data.system.tables.read","data.system.tables.manage","data.rows.move","data.export","data.import","ai.chat","ai.tools.write","ai.providers.manage","ai.audit.read"]'::jsonb),
        ('client', 'client', 'Client', 'Can edit page copy (text, images, links) but not structure or styles.', true, '["dashboard.read","site.read","site.content.edit","media.read","data.custom.tables.read"]'::jsonb),
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
        capabilities_json jsonb not null default '[]'::jsonb,
        created_at timestamptz not null default current_timestamp,
        last_used_at timestamptz,
        revoked_at timestamptz,
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
      alter table ai_mcp_connectors add column expires_at timestamptz;
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
    // transaction — kept as a row, not a PG sequence, for SQLite parity).
    id: '020_site_sync_sequence',
    sql: `
      alter table data_rows add column seq bigint not null default 0;

      create index if not exists data_rows_table_seq_idx
        on data_rows (table_id, seq);

      alter table site add column seq bigint not null default 0;

      create table if not exists site_sync_state (
        id integer primary key check (id = 1),
        seq bigint not null default 0
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
        redirect_uris_json jsonb not null,
        client_id_issued_at bigint not null,
        created_at timestamptz not null default current_timestamp
      );

      create table if not exists ai_mcp_oauth_codes (
        code_hash text primary key,
        connector_id text not null references ai_mcp_connectors(id) on delete cascade,
        client_id text not null references ai_mcp_oauth_clients(client_id) on delete cascade,
        redirect_uri text not null,
        code_challenge text not null,
        scope text not null,
        resource text not null,
        created_at timestamptz not null default current_timestamp,
        expires_at timestamptz not null,
        consumed_at timestamptz
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
        created_at timestamptz not null default current_timestamp,
        expires_at timestamptz not null,
        revoked_at timestamptz,
        constraint ai_mcp_oauth_tokens_kind_check check (kind in ('access', 'refresh'))
      );

      create index if not exists ai_mcp_oauth_tokens_connector_idx
        on ai_mcp_oauth_tokens (connector_id);
    `,
  },
  {
    // Real-time co-editing (Yjs): one CRDT state blob per collab document
    // (site shell, page, component, layout — doc_id is '<kind>:<rowId>').
    // The blob is the live-editing source of truth; derived JSON keeps
    // flowing into data_rows/site for the publisher and non-editor reads.
    // `seq` counts persists (future delta APIs / diagnostics).
    id: '022_collab_documents',
    sql: `
      create table if not exists collab_documents (
        doc_id text primary key,
        state_blob bytea not null,
        seq bigint not null default 0,
        updated_at timestamptz not null default now()
      );
    `,
  },
  {
    // Per-doc CRDT lineage id. A reset deletes the blob and the doc reseeds at
    // the fixed SEED_CLIENT_ID, so the new lineage reuses the old one's struct
    // coordinates and a client that missed the reset would hand back structs
    // from a dead lineage at live coordinates. Rows written by 022 carry '' and
    // have a generation minted on their next open (see relay.openDoc).
    id: '023_collab_document_generation',
    sql: `
      alter table collab_documents add column generation text not null default '';
    `,
  },
  {
    // See migrations-sqlite.ts:024 — clears display names that are just the
    // account's email address, because author bindings render them publicly.
    id: '024_clear_email_display_names',
    sql: `
      update users set display_name = ''
       where trim(lower(display_name)) = trim(lower(email));
    `,
  },
  {
    // See migrations-sqlite.ts:025 — remove the forbidden Owner-only grant
    // from every persisted non-Owner role on existing installations.
    id: '025_remove_non_owner_role_management',
    sql: `
      update roles
         set capabilities_json = capabilities_json - 'roles.manage',
             updated_at = current_timestamp
       where id <> 'owner'
         and capabilities_json ? 'roles.manage';
    `,
  },
  {
    // Stable provenance for plugin-managed media. The mapping lets an
    // integration converge on one media asset instead of creating a duplicate
    // on every sync, and keeps replacements on the same asset id.
    id: '026_plugin_media_sources',
    sql: `
      create table if not exists plugin_media_sources (
        plugin_id text not null references installed_plugins(id) on delete cascade,
        source_key text not null,
        asset_id text not null references media_assets(id) on delete cascade,
        source_version text,
        content_hash text not null,
        created_at timestamptz not null default current_timestamp,
        updated_at timestamptz not null default current_timestamp,
        primary key (plugin_id, source_key),
        unique (asset_id)
      );

      create index if not exists plugin_media_sources_asset_idx
        on plugin_media_sources (asset_id);
    `,
  },
  {
    // See migrations-sqlite.ts:026 — site branches. Same semantic effect:
    // branch registry, `branch_id` + `logical_id` on the three branched
    // tables backfilled to main, per-branch table-slug uniqueness, collab
    // doc ids gaining a branch segment, and the base-hash + preview tables.
    id: '027_site_branches',
    sql: `
      create table if not exists site_branches (
        id text primary key,
        name text not null,
        base_branch_id text,
        created_by_user_id text references users(id) on delete set null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );

      insert into site_branches (id, name, base_branch_id)
      values ('main', 'main', null)
      on conflict (id) do nothing;

      alter table site add column branch_id text not null default 'main';
      alter table site add column logical_id text generated always as (
        case when branch_id = 'main' then id else substr(id, length(branch_id) + 2) end
      ) stored;

      create unique index if not exists site_branch_idx
        on site (branch_id);

      alter table data_tables add column branch_id text not null default 'main';
      alter table data_tables add column logical_id text generated always as (
        case when branch_id = 'main' then id else substr(id, length(branch_id) + 2) end
      ) stored;

      create index if not exists data_tables_branch_idx
        on data_tables (branch_id);

      drop index if exists data_tables_slug_active_idx;

      create unique index if not exists data_tables_branch_slug_active_idx
        on data_tables (branch_id, slug)
        where deleted_at is null;

      alter table data_rows add column branch_id text not null default 'main';
      alter table data_rows add column logical_id text generated always as (
        case when branch_id = 'main' then id else substr(id, length(branch_id) + 2) end
      ) stored;

      create index if not exists data_rows_branch_idx
        on data_rows (branch_id);

      update collab_documents
         set doc_id = 'site:main'
       where doc_id = 'site:default';

      update collab_documents
         set doc_id = 'page:main:' || substr(doc_id, 6)
       where doc_id like 'page:%'
         and doc_id not like 'page:main:%';

      update collab_documents
         set doc_id = 'component:main:' || substr(doc_id, 11)
       where doc_id like 'component:%'
         and doc_id not like 'component:main:%';

      update collab_documents
         set doc_id = 'layout:main:' || substr(doc_id, 8)
       where doc_id like 'layout:%'
         and doc_id not like 'layout:main:%';

      create table if not exists site_branch_bases (
        branch_id text not null references site_branches(id) on delete cascade,
        kind text not null,
        logical_id text not null,
        content_hash text not null,
        content_json jsonb not null default '{}'::jsonb,
        primary key (branch_id, kind, logical_id)
      );

      create table if not exists site_branch_previews (
        id text primary key,
        branch_id text not null references site_branches(id) on delete cascade,
        token_hash text not null,
        expires_at timestamptz,
        created_by_user_id text references users(id) on delete set null,
        created_at timestamptz not null default now(),
        revoked_at timestamptz
      );

      create unique index if not exists site_branch_previews_token_idx
        on site_branch_previews (token_hash);

      create index if not exists site_branch_previews_branch_idx
        on site_branch_previews (branch_id);

      update roles
         set capabilities_json = capabilities_json || '["site.branches.create"]'::jsonb,
             updated_at = current_timestamp
       where id in ('owner', 'admin')
         and not (capabilities_json ? 'site.branches.create');

      update roles
         set capabilities_json = capabilities_json || '["site.branches.manage"]'::jsonb,
             updated_at = current_timestamp
       where id in ('owner', 'admin')
         and not (capabilities_json ? 'site.branches.manage');
    `,
  },
  {
    id: '028_site_branch_reviews',
    sql: `
      create table if not exists site_branch_merge_requests (
        id text primary key,
        branch_id text not null references site_branches(id) on delete cascade,
        requested_by_user_id text references users(id) on delete set null,
        note text not null default '',
        content_hash text not null default '',
        status text not null default 'open',
        resolved_by_user_id text references users(id) on delete set null,
        resolved_at timestamptz,
        resolution_note text not null default '',
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );

      create index if not exists site_branch_merge_requests_branch_idx
        on site_branch_merge_requests (branch_id, status, created_at desc);

      create unique index if not exists site_branch_merge_requests_open_idx
        on site_branch_merge_requests (branch_id)
        where status = 'open';

      create table if not exists site_branch_review_comments (
        id text primary key,
        branch_id text not null references site_branches(id) on delete cascade,
        request_id text references site_branch_merge_requests(id) on delete set null,
        entity_key text not null default '',
        author_user_id text references users(id) on delete set null,
        body text not null,
        created_at timestamptz not null default now()
      );

      create index if not exists site_branch_review_comments_branch_idx
        on site_branch_review_comments (branch_id, created_at);
    `,
  },
  {
    id: '029_site_branch_merges',
    sql: `
      create table if not exists site_branch_merges (
        id text primary key,
        branch_id text not null references site_branches(id) on delete cascade,
        direction text not null,
        applied_by_user_id text references users(id) on delete set null,
        change_count integer not null default 0,
        entries_json jsonb not null default '[]',
        undone_at timestamptz,
        created_at timestamptz not null default now()
      );

      create index if not exists site_branch_merges_branch_idx
        on site_branch_merges (branch_id, created_at desc);
    `,
  },
  {
    // SQLite-only data migration (see migrations-sqlite.ts): `timestamptz`
    // columns already hold real timestamps, so there is nothing to rewrite.
    id: '030_iso_timestamps',
    sql: 'select 1',
  },
  {
    // Which plugin created this table via `cms.content.tables.create` (null
    // for user/import-created tables). The plugin host's `@own-created`
    // contentAccess marker resolves against this column, so a plugin keeps
    // access to tables it created at runtime — durable across restarts and
    // admin-side slug renames. Nullable, no default: purely additive.
    id: '031_data_tables_created_by_plugin',
    sql: `
      alter table data_tables add column created_by_plugin_id text;
    `,
  },
  {
    // Outgoing mail. `mail_connectors` are the accounts the server can send
    // through (SMTP, Amazon SES); each secret is encrypted with the master
    // key. `mail_settings` is one row: which connector sends, and as whom.
    // `mail_templates` holds only the templates an owner has edited; the
    // defaults live in code. `mail_outbox` is the delivery log; `body_text`
    // is filled only in development, where mail is captured instead of
    // sent, because bodies carry live sign-in and reset links.
    id: '032_mail',
    sql: `
      create table if not exists mail_connectors (
        id text primary key,
        kind text not null,
        label text not null,
        config_json jsonb not null default '{}',
        secret_ciphertext bytea,
        secret_iv bytea,
        key_fingerprint text,
        last_used_at timestamptz,
        last_error text,
        created_by_user_id text references users(id) on delete set null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );

      create table if not exists mail_settings (
        id text primary key,
        default_connector_id text references mail_connectors(id) on delete set null,
        from_address text not null default '',
        from_name text not null default '',
        reply_to text not null default '',
        updated_by_user_id text references users(id) on delete set null,
        updated_at timestamptz not null default now()
      );

      create table if not exists mail_templates (
        template_key text primary key,
        subject text not null,
        body_markdown text not null,
        updated_by_user_id text references users(id) on delete set null,
        updated_at timestamptz not null default now()
      );

      create table if not exists mail_outbox (
        id text primary key,
        kind text not null,
        to_address text not null,
        subject text not null,
        status text not null,
        connector_id text,
        connector_label text,
        error text,
        body_text text,
        provider_message_id text,
        duration_ms integer,
        created_at timestamptz not null default now()
      );

      create index if not exists mail_outbox_created_idx
        on mail_outbox (created_at desc);

      update roles
         set capabilities_json = capabilities_json || '["mail.manage"]'::jsonb,
             updated_at = now()
       where id in ('owner', 'admin')
         and not (capabilities_json ? 'mail.manage');
    `,
  },
  {
    // Site members: people who sign up and log in on the published site,
    // kept fully apart from admin `users`. Sessions and tokens store only
    // hashes. `member_tags` is keyed (member, tag, source) so a tag granted
    // by a plugin and the same tag granted by hand are separate rows.
    // `member_settings` is one installation-wide row, deliberately outside
    // the branched, exported site document. `data_tables.access_json` holds
    // a table's access rule for its entry routes (null = anyone).
    id: '033_members',
    sql: `
      create table if not exists members (
        id text primary key,
        email text not null,
        email_normalized text not null,
        password_hash text,
        status text not null default 'active',
        email_verified_at timestamptz,
        profile_json jsonb not null default '{}',
        last_login_at timestamptz,
        deleted_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );

      create unique index if not exists members_email_active_idx
        on members (email_normalized) where deleted_at is null;

      create table if not exists member_sessions (
        id_hash text primary key,
        member_id text not null references members(id) on delete cascade,
        ip_address text,
        user_agent text,
        created_at timestamptz not null default now(),
        last_seen_at timestamptz not null default now(),
        expires_at timestamptz not null,
        revoked_at timestamptz
      );

      create index if not exists member_sessions_member_idx
        on member_sessions (member_id);

      create table if not exists member_tokens (
        id_hash text primary key,
        member_id text not null references members(id) on delete cascade,
        kind text not null,
        payload_json jsonb not null default '{}',
        created_at timestamptz not null default now(),
        expires_at timestamptz not null,
        used_at timestamptz
      );

      create index if not exists member_tokens_member_kind_idx
        on member_tokens (member_id, kind);

      create table if not exists member_tags (
        member_id text not null references members(id) on delete cascade,
        tag text not null,
        source text not null,
        expires_at timestamptz,
        created_at timestamptz not null default now(),
        primary key (member_id, tag, source)
      );

      create index if not exists member_tags_tag_idx
        on member_tags (tag);

      create table if not exists member_events (
        id text primary key,
        member_id text references members(id) on delete set null,
        kind text not null,
        ip_address text,
        user_agent text,
        metadata_json jsonb not null default '{}',
        created_at timestamptz not null default now()
      );

      create index if not exists member_events_member_idx
        on member_events (member_id, created_at desc);

      create table if not exists member_settings (
        id text primary key,
        signup_mode text not null default 'closed',
        profile_fields_json jsonb not null default '[]',
        pages_json jsonb not null default '{}',
        updated_at timestamptz not null default now()
      );

      alter table data_tables add column access_json jsonb;

      -- The capability-less admin role was called "Member", which now reads
      -- as a site member. Relabel it, unless an owner already renamed it.
      update roles
         set name = 'No access',
             description = 'An admin account that can sign in but do nothing. Not a site member: those sign in on the published site.'
       where id = 'member'
         and name = 'Member'
         and description = 'Public-facing member account — no admin access by default.';

      update roles
         set capabilities_json = capabilities_json || '["members.read"]'::jsonb,
             updated_at = now()
       where id in ('owner', 'admin')
         and not (capabilities_json ? 'members.read');

      update roles
         set capabilities_json = capabilities_json || '["members.manage"]'::jsonb,
             updated_at = now()
       where id in ('owner', 'admin')
         and not (capabilities_json ? 'members.manage');
    `,
  },
  {
    // Outgoing email waits here until a connector takes it. A row holds the
    // template key and the values to fill it with, encrypted, because the
    // values carry live sign-in links; it is deleted once the email is sent
    // or given up on. `lane` 0 is the core's own mail, which always goes
    // before a plugin's. `deliver_before` is the moment after which sending
    // would be pointless (the link in it has expired). `mail_outbox` gains
    // the attempt count and the time of the next try, so the activity log
    // can say a message is waiting. `mail_connectors.delivery_paused_at` is
    // set while a connector refuses the account itself (a wrong key or
    // password): queued email is then held, and one email at a time is let
    // through as a probe, until one gets through. `accepted_at` marks a row
    // whose email the provider has taken: such a row is never sent again,
    // even if recording the outcome and deleting the row failed.
    id: '034_mail_queue',
    sql: `
      create table if not exists mail_queue (
        id text primary key,
        outbox_id text not null,
        kind text not null,
        to_address text not null,
        source text not null default 'core',
        reference text,
        lane integer not null default 0,
        payload_ciphertext bytea not null,
        payload_iv bytea not null,
        attempts integer not null default 0,
        next_attempt_at timestamptz not null,
        deliver_before timestamptz not null,
        claimed_at timestamptz,
        accepted_at timestamptz,
        suspect_at timestamptz,
        last_error text,
        created_at timestamptz not null default now()
      );

      create index if not exists mail_queue_due_idx
        on mail_queue (lane, next_attempt_at);

      create index if not exists mail_queue_source_idx
        on mail_queue (source);

      alter table mail_outbox add column attempts integer not null default 0;
      alter table mail_outbox add column next_attempt_at timestamptz;
      alter table mail_outbox add column source text not null default 'core';

      alter table mail_connectors add column delivery_paused_at timestamptz;
    `,
  },
  {
    // Email a plugin asks for. `mail_counters` holds the two limits as rows
    // that are raised by one conditional UPDATE, so no two concurrent sends,
    // on one server or several, can both take the last place: `to:<address>`
    // counts a plugin's emails to one recipient in one clock hour (`bucket`),
    // and `backlog` counts how many of a plugin's emails are waiting.
    // `mail_queue.member_id` remembers that the sender named a site member
    // rather than an address, so the outcome can be reported without ever
    // handing the member's address back. `mail_outbox.source_label` is the
    // sending plugin's name at the time, so the log still says who sent an
    // email after that plugin is gone. `installed_plugins.install_id` is a
    // random id given to an install when it first sends email, stamped on
    // each email it queues (`mail_queue.install_id`): what became of an email
    // is told only to the install that queued it, never to a later install of
    // the same plugin id.
    id: '035_plugin_mail',
    sql: `
      create table if not exists mail_counters (
        source text not null,
        scope text not null,
        bucket text not null default '',
        count integer not null default 0,
        primary key (source, scope, bucket)
      );

      alter table mail_queue add column member_id text;

      alter table mail_outbox add column source_label text;

      alter table installed_plugins add column install_id text;

      alter table mail_queue add column install_id text;
    `,
  },
  {
    // Unwrap plugin record data that was stored as a JSON string scalar.
    // SQLite has no such rows (JSON is text there), so its twin is a no-op.
    id: '036_plugin_records_json_repair',
    sql: PLUGIN_RECORDS_JSON_REPAIR_SQL,
    noTimeouts: true,
    leftover: pluginRecordsStillStoredAsText,
  },
  {
    // Plugin storage: an optional unique key per record (derived from the
    // resource's declared uniqueField) and a version counter for conditional
    // updates. Schema only. NULL keys are distinct in a unique index on both
    // dialects, so existing rows and resources without a uniqueField are
    // unaffected.
    id: '037_plugin_record_keys',
    sql: `
      alter table plugin_records add column unique_key text;

      alter table plugin_records add column version integer not null default 0;

      create unique index if not exists plugin_records_unique_key_idx
        on plugin_records (plugin_id, resource_id, unique_key);
    `,
  },
  {
    // Sign-in for apps: a site member approves an app (Instatic Desktop, a
    // premium plugin) and the app gets tokens that say who the member is.
    // Separate from the MCP OAuth tables on purpose: those belong to admin
    // users, and a member token must never be usable as an admin token.
    id: '038_member_apps',
    sql: `
      create table if not exists member_apps (
        id text primary key,
        name text not null,
        redirect_uris_json jsonb not null default '[]',
        scopes_json jsonb not null default '[]',
        created_by_user_id text references users(id) on delete set null,
        created_at timestamptz not null default now(),
        deleted_at timestamptz
      );

      -- An authorization request waiting for the member's answer on the
      -- owner's approval page. Short-lived; answered at most once, and only
      -- from the browser that opened it (browser_hash is that browser's
      -- marker cookie, hashed).
      create table if not exists member_app_requests (
        id_hash text primary key,
        app_id text not null references member_apps(id) on delete cascade,
        browser_hash text not null,
        redirect_uri text not null,
        code_challenge text not null,
        scope text not null,
        resource text not null,
        state text,
        created_at timestamptz not null default now(),
        expires_at timestamptz not null,
        decided_at timestamptz
      );

      -- One approval of one app by one member. Every code and token hangs
      -- off it, so revoking the grant ends them all.
      create table if not exists member_app_grants (
        id text primary key,
        member_id text not null references members(id) on delete cascade,
        app_id text not null references member_apps(id) on delete cascade,
        scope text not null,
        created_at timestamptz not null default now(),
        last_used_at timestamptz,
        expires_at timestamptz not null,
        revoked_at timestamptz
      );

      create index if not exists member_app_grants_member_idx
        on member_app_grants (member_id);

      create table if not exists member_app_codes (
        code_hash text primary key,
        grant_id text not null references member_app_grants(id) on delete cascade,
        app_id text not null references member_apps(id) on delete cascade,
        redirect_uri text not null,
        code_challenge text not null,
        scope text not null,
        resource text not null,
        expires_at timestamptz not null,
        consumed_at timestamptz
      );

      create table if not exists member_app_tokens (
        id text primary key,
        grant_id text not null references member_app_grants(id) on delete cascade,
        app_id text not null references member_apps(id) on delete cascade,
        kind text not null,
        token_hash text not null unique,
        scope text not null,
        resource text not null,
        created_at timestamptz not null default now(),
        expires_at timestamptz not null,
        revoked_at timestamptz
      );

      create index if not exists member_app_tokens_grant_idx
        on member_app_tokens (grant_id);
    `,
  },
  {
    id: '039_member_app_devices',
    sql: `
      -- The device an app runs on: the thumbprint of a key the app keeps and
      -- proves it holds on every refresh, and the name the app gave it.
      alter table member_app_requests add column if not exists device_jkt text;
      alter table member_app_requests add column if not exists device_name text;
      alter table member_app_grants add column if not exists device_jkt text;
      alter table member_app_grants add column if not exists device_name text;
    `,
  },
]
