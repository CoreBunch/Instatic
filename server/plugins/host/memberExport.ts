/**
 * Plugins' sections of a member's data export. Every plugin that holds
 * `members.read` and registered `api.cms.members.exportProvider` is asked,
 * one at a time, for what it keeps about the member.
 *
 * A section that cannot be had (the provider threw, ran past its call
 * budget, returned nothing usable or too much) is still listed, as not
 * included, so the export never silently leaves a plugin out and one
 * plugin never fails the whole export.
 */
import { nanoid } from 'nanoid'
import type { DbClient } from '../../db/client'
import { exportMemberData } from '../../members/service'
import type { MemberRecord } from '../../members/repository'
import { getErrorMessage } from '@core/utils/errorMessage'
import { Type, safeParseValue } from '@core/utils/typeboxHelpers'
import { hostPluginHasPermission, hostPlugins } from './registry'
import { requestFromWorker } from './workerPool'

/** Largest section one plugin may add, as JSON. */
const MAX_SECTION_BYTES = 1024 * 1024

const SectionSchema = Type.Object(
  {
    title: Type.Optional(Type.String({ maxLength: 200 })),
    data: Type.Unknown(),
  },
  { additionalProperties: false },
)

export type PluginMemberExportSection =
  | { plugin: string; name: string; included: true; title: string; data: unknown }
  | { plugin: string; name: string; included: false; reason: string }

async function collectPluginMemberExports(memberId: string): Promise<PluginMemberExportSection[]> {
  const sections: PluginMemberExportSection[] = []
  for (const [pluginId, entry] of hostPlugins) {
    const filterId = entry.memberExportFilterId
    if (filterId === null || !hostPluginHasPermission(pluginId, 'members.read')) continue
    const name = entry.manifest.name
    const notIncluded = (reason: string): void => {
      sections.push({ plugin: pluginId, name, included: false, reason: `Could not be included: ${reason}` })
    }
    let value: unknown
    try {
      const result = await requestFromWorker(
        pluginId,
        {
          kind: 'run-hook-filter',
          correlationId: nanoid(),
          pluginId,
          filterId,
          name: 'member.export',
          value: null,
          context: { memberId },
        },
        'hook-filter-result',
      )
      if (!result.ok) {
        console.error(`[plugin:${pluginId}] member export failed:`, result.error)
        notIncluded('the plugin reported an error')
        continue
      }
      value = result.value
    } catch (err) {
      console.error(`[plugin:${pluginId}] member export failed:`, getErrorMessage(err, 'no answer'))
      notIncluded('the plugin did not answer')
      continue
    }
    const parsed = safeParseValue(SectionSchema, value)
    if (!parsed.ok) {
      notIncluded('the plugin returned something other than { title, data }')
      continue
    }
    const size = new TextEncoder().encode(JSON.stringify(parsed.value.data ?? null)).length
    if (size > MAX_SECTION_BYTES) {
      notIncluded(`the plugin's section is larger than ${MAX_SECTION_BYTES / 1024 / 1024} MiB`)
      continue
    }
    sections.push({ plugin: pluginId, name, included: true, title: parsed.value.title ?? name, data: parsed.value.data ?? null })
  }
  return sections
}

/**
 * Everything the site holds about a member: core's export
 * (`exportMemberData`) plus each plugin's section under `plugins`. The one
 * export both the member's own download and the admin's use.
 */
export async function exportMemberDataWithPlugins(db: DbClient, member: MemberRecord): Promise<Record<string, unknown>> {
  return { ...(await exportMemberData(db, member)), plugins: await collectPluginMemberExports(member.id) }
}
