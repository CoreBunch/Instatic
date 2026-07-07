/**
 * Site shell repository — read/write the site-level settings row.
 *
 * Pages are stored in `data_rows` (table_id = 'pages').
 * Visual Components are stored in `data_rows` (table_id = 'components').
 * Neither is managed here. The shell contains everything except pages and VCs:
 * id, name, breakpoints, settings, styleRules, files, packageJson, runtime,
 * Site Explorer organization, createdAt, updatedAt.
 *
 * Storage format inside `settings_json`:
 *   { cmsSiteSchemaVersion: 1, site: <SiteShell without name> }
 * The `name` is stored in the dedicated `site.name` column.
 */
import type { SiteShell } from '@core/page-tree'
import {
  DEFAULT_BREAKPOINTS,
  DEFAULT_SITE_SETTINGS,
  parseConditions,
  parseSiteExplorerOrganization,
} from '@core/page-tree'
import { validateSite } from '@core/persistence/validate'
import { normalizeSitePackageJson } from '@core/site-dependencies/manifest'
import { normalizeSiteRuntimeConfig } from '@core/site-runtime'
import type { DbClient } from '../db/client'
import type { SiteRow } from '../types'

const CMS_SITE_SCHEMA_VERSION = 1

interface StoredSitePayload {
  cmsSiteSchemaVersion: 1
  site: Omit<SiteShell, 'name'>
}

function shellToStorage(shell: SiteShell): StoredSitePayload {
  const { name: _name, ...rest } = shell
  return {
    cmsSiteSchemaVersion: CMS_SITE_SCHEMA_VERSION,
    site: rest,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readStoredShell(row: SiteRow): SiteShell {
  const stored = row.settings_json
  const site: Record<string, unknown> = isRecord(stored?.site) ? stored.site as Record<string, unknown> : {}
  const conditions = parseConditions(site.conditions)
  return {
    id: typeof site.id === 'string' ? site.id : 'default',
    name: typeof row.name === 'string' ? row.name : '',
    files: Array.isArray(site.files) ? site.files as SiteShell['files'] : [],
    packageJson: normalizeSitePackageJson(site.packageJson),
    runtime: normalizeSiteRuntimeConfig(site.runtime),
    breakpoints: Array.isArray(site.breakpoints)
      ? site.breakpoints as SiteShell['breakpoints']
      : DEFAULT_BREAKPOINTS,
    ...(conditions.length > 0 ? { conditions } : {}),
    settings: isRecord(site.settings)
      ? site.settings as unknown as SiteShell['settings']
      : DEFAULT_SITE_SETTINGS,
    styleRules: isRecord(site.styleRules) ? site.styleRules as SiteShell['styleRules'] : {},
    explorer: parseSiteExplorerOrganization(site.explorer),
    createdAt: typeof site.createdAt === 'number' ? site.createdAt : Date.parse(String(row.created_at)),
    updatedAt: typeof site.updatedAt === 'number' ? site.updatedAt : Date.parse(String(row.updated_at)),
  }
}

export async function getDraftSite(db: DbClient): Promise<SiteShell | null> {
  const { rows } = await db<SiteRow>`
    select id, name, settings_json, created_at, updated_at
    from site
    where id = 'default'
    limit 1
  `
  const row = rows[0]
  if (!row) return null

  const rawShell = readStoredShell(row)
  return validateSite(rawShell)
}

export async function saveDraftSite(
  db: DbClient,
  shell: SiteShell,
  _actorUserId: string | null = null,
): Promise<void> {
  await db`
    insert into site (id, name, settings_json)
    values ('default', ${shell.name}, ${shellToStorage(shell)})
    on conflict (id) do update
      set name = excluded.name,
          settings_json = excluded.settings_json,
          updated_at = current_timestamp
  `
}

/**
 * Stamp the site-global sync seq on the draft-site row. The transactional
 * site-document save calls this right after `saveDraftSite` inside the same
 * transaction, so shell changes participate in delta reconciliation exactly
 * like row changes (see repositories/syncSequence.ts).
 */
export async function stampDraftSiteSeq(db: DbClient, seq: number): Promise<void> {
  await db`
    update site
    set seq = ${seq}
    where id = 'default'
  `
}
