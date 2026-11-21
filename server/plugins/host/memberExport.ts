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
 * An installed plugin granted `members.read` whose stored manifest no longer
 * reads is listed too, since nothing says it keeps no member data.
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
  const installed = await listInstalledPlugins(db)
  const declaring = installed.flatMap((result) =>
    result.kind === 'ok' &&
    result.plugin.manifest.memberDataExport === true &&
    result.plugin.grantedPermissions.includes('members.read')
      ? [result.plugin]
      : [],
  )
  // A plugin whose stored manifest no longer reads may still hold member data.
  const unreadable: PluginMemberExportSection[] = installed.flatMap((result) =>
    result.kind === 'broken' && result.grantedPermissions.includes('members.read')
      ? [{ plugin: result.id, name: result.name, included: false as const, reason: 'Could not be included: its manifest could not be read' }]
      : [],
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<'timed out'>((resolve) => {
    timer = setTimeout(() => resolve('timed out'), deadlineMs)
  })
  try {
    const asked = await Promise.all(
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
    return [...asked, ...unreadable]
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
 * the exact UTF-8 size of its JSON (counted as it goes, stopping as soon as
 * it is too large) and its nesting depth. True, or the reason it does not
 * fit. The value came from the plugin's worker as JSON, so it holds only
 * JSON values.
 */
export function fitsJson(value: unknown, maxBytes: number = MAX_SECTION_BYTES): true | string {
  let bytes = 0
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  while (stack.length > 0) {
    const next = stack.pop()
    if (!next) break
    const { value: current, depth } = next
    if (depth > MAX_SECTION_DEPTH) return `the plugin's section is nested more than ${MAX_SECTION_DEPTH} levels deep`
    if (typeof current === 'string') bytes += jsonStringBytes(current)
    else if (typeof current === 'number') bytes += Number.isFinite(current) ? String(current).length : 4
    else if (typeof current === 'boolean') bytes += current ? 4 : 5
    else if (current === null || typeof current !== 'object') bytes += 4
    else if (Array.isArray(current)) {
      // Brackets, and a comma between items.
      bytes += 2 + Math.max(0, current.length - 1)
      for (const item of current) stack.push({ value: item, depth: depth + 1 })
    } else {
      const entries = Object.entries(current)
      // Braces, a comma between members, and a colon in each.
      bytes += 2 + Math.max(0, entries.length - 1) + entries.length
      for (const [key, child] of entries) {
        bytes += jsonStringBytes(key)
        stack.push({ value: child, depth: depth + 1 })
      }
    }
    if (bytes > maxBytes) return `the plugin's section is larger than ${maxBytes / 1024 / 1024} MiB`
  }
  return true
}

/** UTF-8 bytes of a string as `JSON.stringify` writes it, quotes included. */
function jsonStringBytes(text: string): number {
  let bytes = 2
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i)
    if (unit === 0x22 || unit === 0x5c) bytes += 2 // \" and \\
    else if (unit === 0x08 || unit === 0x09 || unit === 0x0a || unit === 0x0c || unit === 0x0d) bytes += 2 // \b \t \n \f \r
    else if (unit < 0x20) bytes += 6 // \u00XX
    else if (unit < 0x80) bytes += 1
    else if (unit < 0x800) bytes += 2
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = text.charCodeAt(i + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4 // a surrogate pair: one code point above U+FFFF
        i++
      } else bytes += 6 // a lone surrogate is escaped
    } else if (unit >= 0xdc00 && unit <= 0xdfff) bytes += 6
    else bytes += 3
  }
  return bytes
}
