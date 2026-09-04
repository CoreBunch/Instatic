import type { DbClient } from '../db/client'
import { placeholder } from '../db/client'

export interface PluginRemoteMediaSource {
  pluginId: string
  sourceKey: string
  assetId: string
  sourceVersion: string | null
  contentHash: string
}

interface PluginRemoteMediaSourceRow {
  plugin_id: string
  source_key: string
  asset_id: string
  source_version: string | null
  content_hash: string
}

function mapRow(row: PluginRemoteMediaSourceRow): PluginRemoteMediaSource {
  return {
    pluginId: row.plugin_id,
    sourceKey: row.source_key,
    assetId: row.asset_id,
    sourceVersion: row.source_version,
    contentHash: row.content_hash,
  }
}

export async function getPluginRemoteMediaSource(
  db: DbClient,
  pluginId: string,
  sourceKey: string,
): Promise<PluginRemoteMediaSource | null> {
  const p = (index: number) => placeholder(db.dialect, index)
  const { rows } = await db.unsafe<PluginRemoteMediaSourceRow>(
    `select plugin_id, source_key, asset_id, source_version, content_hash
       from plugin_remote_media_sources
      where plugin_id = ${p(1)} and source_key = ${p(2)}`,
    [pluginId, sourceKey],
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export async function savePluginRemoteMediaSource(
  db: DbClient,
  source: PluginRemoteMediaSource,
): Promise<void> {
  const nowIso = new Date().toISOString()
  const p = (index: number) => placeholder(db.dialect, index)
  await db.unsafe(
    `insert into plugin_remote_media_sources (
       plugin_id, source_key, asset_id, source_version,
       content_hash, created_at, updated_at
     ) values (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)})
     on conflict (plugin_id, source_key) do update set
       asset_id = excluded.asset_id,
       source_version = excluded.source_version,
       content_hash = excluded.content_hash,
       updated_at = excluded.updated_at`,
    [
      source.pluginId,
      source.sourceKey,
      source.assetId,
      source.sourceVersion,
      source.contentHash,
      nowIso,
      nowIso,
    ],
  )
}
