/**
 * Plugins' sections of a member's data export.
 *
 * Every installed plugin that declares `memberDataExport` in its manifest
 * and was granted `members.read` has a place in the export. A running one is
 * asked through its export provider; all are asked at once (each plugin has
 * its own worker) under one deadline for the whole export. A plugin whose
 * section cannot be had (not running, no provider registered, the provider
 * threw, ran past the deadline, or returned something unusable or too large)
 * is still listed, as not included with the reason, so the export never
 * leaves a plugin out silently and one plugin never fails the whole export.
 *
 * Exports of one member run one at a time: a second request while one is in
 * flight gets the same result.
 */
import { nanoid } from 'nanoid'
import type { DbClient } from '../../db/client'
import { getErrorMessage } from '@core/utils/errorMessage'
import { Type, safeParseValue } from '@core/utils/typeboxHelpers'
import { exportMemberData } from '../../members/service'
import type { MemberRecord } from '../../members/repository'
import { listInstalledPlugins } from '../../repositories/plugins'
import { hostPlugins } from './registry'
import { requestFromWorker } from './workerPool'

/** Largest section one plugin may add, as JSON. */
const MAX_SECTION_BYTES = 1024 * 1024
/** Deepest nesting a section may have. */
const MAX_SECTION_DEPTH = 64
/** How long the whole export waits for plugins. */
const EXPORT_DEADLINE_MS = 20_000

const SectionSchema = Type.Object(
  {
    title: Type.Optional(Type.String({ maxLength: 200 })),
    data: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
)

export type PluginMemberExportSection =
  | { plugin: string; name: string; included: true; title: string; data: unknown }
  | { plugin: string; name: string; included: false; reason: string }

const inFlight = new Map<string, Promise<Record<string, unknown>>>()

/**
 * Everything the site holds about a member: core's export
 * (`exportMemberData`) plus each plugin's section under `plugins`. The one
 * export both the member's own download and the admin's use.
 */
export function exportMemberDataWithPlugins(
  db: DbClient,
  member: MemberRecord,
  deadlineMs: number = EXPORT_DEADLINE_MS,
): Promise<Record<string, unknown>> {
  const running = inFlight.get(member.id)
  if (running) return running
  const build = (async () => ({
    ...(await exportMemberData(db, member)),
    plugins: await collectPluginSections(db, member.id, deadlineMs),
  }))().finally(() => inFlight.delete(member.id))
  inFlight.set(member.id, build)
  return build
}

async function collectPluginSections(
  db: DbClient,
  memberId: string,
  deadlineMs: number,
): Promise<PluginMemberExportSection[]> {
  const declaring = (await listInstalledPlugins(db)).flatMap((result) =>
    result.kind === 'ok' &&
    result.plugin.manifest.memberDataExport === true &&
    result.plugin.grantedPermissions.includes('members.read')
      ? [result.plugin]
      : [],
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<'timed out'>((resolve) => {
    timer = setTimeout(() => resolve('timed out'), deadlineMs)
  })
  try {
    return await Promise.all(
      declaring.map(async (plugin): Promise<PluginMemberExportSection> => {
        const notIncluded = (reason: string): PluginMemberExportSection => ({
          plugin: plugin.id,
          name: plugin.name,
          included: false,
          reason: `Could not be included: ${reason}`,
        })
        const entry = hostPlugins.get(plugin.id)
        if (!entry) return notIncluded('the plugin is not running')
        const filterId = entry.memberExportFilterId
        if (filterId === null) return notIncluded('the plugin is running but did not offer its section')
        const answer = await Promise.race([askPlugin(plugin.id, filterId, memberId), deadline])
        if (answer === 'timed out') return notIncluded('timed out')
        if (!answer.ok) return notIncluded(answer.reason)
        return section(plugin.id, plugin.name, answer.value, notIncluded)
      }),
    )
  } finally {
    clearTimeout(timer)
  }
}

async function askPlugin(
  pluginId: string,
  filterId: string,
  memberId: string,
): Promise<{ ok: true; value: unknown } | { ok: false; reason: string }> {
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
    if (result.ok) return { ok: true, value: result.value }
    console.error(`[plugin:${pluginId}] member export failed:`, result.error)
    return { ok: false, reason: 'the plugin reported an error' }
  } catch (err) {
    console.error(`[plugin:${pluginId}] member export failed:`, getErrorMessage(err, 'no answer'))
    return { ok: false, reason: 'the plugin did not answer' }
  }
}

function section(
  pluginId: string,
  name: string,
  value: unknown,
  notIncluded: (reason: string) => PluginMemberExportSection,
): PluginMemberExportSection {
  try {
    const parsed = safeParseValue(SectionSchema, value)
    if (!parsed.ok) return notIncluded('the plugin returned something other than { title, data }')
    const data = parsed.value.data ?? null
    const fits = fitsJson(data)
    if (fits !== true) return notIncluded(fits)
    return { plugin: pluginId, name, included: true, title: parsed.value.title ?? name, data }
  } catch (err) {
    console.error(`[plugin:${pluginId}] member export section could not be read:`, err)
    return notIncluded('the section could not be read')
  }
}

/**
 * Whether a value fits the section limits, walked without serialising it:
 * its JSON size (counted as it goes, stopping as soon as it is too large)
 * and its nesting depth. True, or the reason it does not fit.
 */
function fitsJson(value: unknown): true | string {
  let bytes = 0
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  while (stack.length > 0) {
    const next = stack.pop()
    if (!next) break
    const { value: current, depth } = next
    if (depth > MAX_SECTION_DEPTH) return `the plugin's section is nested more than ${MAX_SECTION_DEPTH} levels deep`
    if (typeof current === 'string') bytes += current.length * 3 + 2
    else if (current === null || typeof current !== 'object') bytes += 24
    else {
      bytes += 2
      for (const [key, child] of Object.entries(current)) {
        bytes += key.length * 3 + 4
        stack.push({ value: child, depth: depth + 1 })
      }
    }
    if (bytes > MAX_SECTION_BYTES) return `the plugin's section is larger than ${MAX_SECTION_BYTES / 1024 / 1024} MiB`
  }
  return true
}
