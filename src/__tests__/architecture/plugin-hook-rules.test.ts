/**
 * Architecture gate — every host event and filter has a rule, and every send
 * that carries guarded data says who may receive it.
 *
 * `cms.hooks` opens the hook bus; it is not a licence to see what another
 * permission guards. `server/plugins/protocol/hookRules.ts` is the one table
 * of what each host event and filter needs. `tsc` already refuses a host
 * event or filter name with no rule (the tables are keyed by the bus's name
 * unions). This gate covers what types cannot:
 *
 *   - a name passed as a string literal to `hookBus.emit` / `applyFilter`
 *     appears in the table;
 *   - a literal name whose rule is per table or per permission is passed
 *     with a recipient check (third argument of `emit`, fourth of
 *     `applyFilter`), and so is every `emit` whose name is not a literal
 *     (the member events), except the handler for plugin-emitted events;
 *   - per-table names are sent only from `server/publish/contentEvents.ts`;
 *   - `hookBus.filter(...)`, which registers a handler with no rule check,
 *     is called only by the two registration handlers that do the check.
 *
 * It reads source text for calls written as `hookBus.<method>(`. A bus
 * reached through another variable name is outside it; that case is closed
 * by the bus's own overloads, which require the recipient argument for
 * guarded names however the bus is reached (checked by `tsc`, not here).
 */
import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { CONTENT_ACCESS_MODE_PERMISSIONS } from '@core/plugin-sdk/contentSchemas'
import {
  GUARDED_EVENTS_MATCH_THEIR_RULES,
  HOST_EVENT_RULES,
  HOST_FILTER_RULES,
  permissionsForModes,
} from '../../../server/plugins/protocol/hookRules'

const REPO_ROOT = join(import.meta.dir, '../../../')

function listSources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry !== '__tests__' && entry !== 'generated') out.push(...listSources(full))
    } else if (extname(full) === '.ts' && !full.endsWith('.test.ts')) out.push(full)
  }
  return out
}

function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const SERVER_SOURCES = listSources(join(REPO_ROOT, 'server')).map((file) => ({
  rel: relative(REPO_ROOT, file).replaceAll('\\', '/'),
  code: withoutComments(readFileSync(file, 'utf8')),
}))

/** `(file, name)` for every string-literal first argument of a bus method. */
function literalCalls(method: 'emit' | 'applyFilter'): Array<{ rel: string; name: string }> {
  const pattern = new RegExp(`hookBus\\s*\\.\\s*${method}(?:<[^>]*>)?\\(\\s*['"\`]([^'"\`]+)['"\`]`, 'g')
  return SERVER_SOURCES.flatMap(({ rel, code }) =>
    [...code.matchAll(pattern)].map((match) => ({ rel, name: match[1]! })),
  )
}

const CONTENT_EVENTS = 'server/publish/contentEvents.ts'
const PLUGIN_EMIT_HANDLER = 'server/plugins/host/handlers/hooks.ts'

/** Every `hookBus.<method>(…)` call in a source, with its top-level arguments. */
function busCalls(method: 'emit' | 'applyFilter'): Array<{ rel: string; args: string[] }> {
  const start = new RegExp(`hookBus\\s*\\.\\s*${method}(?:<[^>(]*>)?\\(`, 'g')
  const calls: Array<{ rel: string; args: string[] }> = []
  for (const { rel, code } of SERVER_SOURCES) {
    for (const match of code.matchAll(start)) {
      const args: string[] = []
      let depth = 0
      let current = ''
      let quote: string | null = null
      for (let i = match.index + match[0].length; i < code.length; i++) {
        const ch = code[i]!
        if (quote) {
          current += ch
          if (ch === '\\') current += code[++i] ?? ''
          else if (ch === quote) quote = null
          continue
        }
        if (ch === "'" || ch === '"' || ch === '`') quote = ch
        if (ch === '(' || ch === '[' || ch === '{') depth++
        if (ch === ')' || ch === ']' || ch === '}') {
          if (depth === 0) break
          depth--
        }
        if (ch === ',' && depth === 0) {
          args.push(current.trim())
          current = ''
          continue
        }
        current += ch
      }
      if (current.trim()) args.push(current.trim())
      calls.push({ rel, args })
    }
  }
  return calls
}

function literalName(arg: string | undefined): string | null {
  const match = /^['"`]([^'"`]+)['"`]$/.exec(arg ?? '')
  return match ? match[1]! : null
}

function isGuarded(rule: { needs: string } | undefined): boolean {
  return rule?.needs === 'table' || rule?.needs === 'permission'
}

describe('plugin hook rules gate', () => {
  it('every filter the host applies has a rule', () => {
    const applied = literalCalls('applyFilter')
    expect(applied.length).toBeGreaterThan(0)
    expect(applied.filter(({ name }) => !(name in HOST_FILTER_RULES))).toEqual([])
    // And the table lists nothing the host does not apply.
    const names = new Set(applied.map(({ name }) => name))
    expect(Object.keys(HOST_FILTER_RULES).filter((name) => !names.has(name))).toEqual([])
  })

  it('every event the host emits by name has a rule', () => {
    const emitted = literalCalls('emit')
    expect(emitted.length).toBeGreaterThan(0)
    expect(emitted.filter(({ name }) => !(name in HOST_EVENT_RULES))).toEqual([])
  })

  it('a per-table event or filter is only sent from contentEvents.ts, which checks the recipient', () => {
    const perTable = new Set(
      [...Object.entries(HOST_EVENT_RULES), ...Object.entries(HOST_FILTER_RULES)]
        .filter(([, rule]) => rule.needs === 'table')
        .map(([name]) => name),
    )
    expect(perTable.size).toBeGreaterThan(0)
    const sends = [...literalCalls('emit'), ...literalCalls('applyFilter')].filter(({ name }) => perTable.has(name))
    expect(sends.filter(({ rel }) => rel !== CONTENT_EVENTS)).toEqual([])
    expect(new Set(sends.map(({ name }) => name))).toEqual(perTable)

    const code = SERVER_SOURCES.find(({ rel }) => rel === CONTENT_EVENTS)!.code
    // Each such call names its recipients: one recipient helper per send.
    const recipientChecks = code.match(/entry(?:Event|CellsFilter)Recipients\(/g) ?? []
    expect(recipientChecks.length).toBe(sends.length)
  })

  it('a guarded event or filter value is never sent without a recipient check', () => {
    const unguarded: string[] = []
    for (const { rel, args } of busCalls('emit')) {
      const name = literalName(args[0])
      const needsCheck = name === null
        ? rel !== PLUGIN_EMIT_HANDLER
        : isGuarded((HOST_EVENT_RULES as Record<string, { needs: string }>)[name])
      if (needsCheck && args.length < 3) unguarded.push(`${rel} → emit(${args[0]})`)
    }
    for (const { rel, args } of busCalls('applyFilter')) {
      const name = literalName(args[0])
      const needsCheck = name === null || isGuarded((HOST_FILTER_RULES as Record<string, { needs: string }>)[name])
      if (needsCheck && args.length < 4) unguarded.push(`${rel} → applyFilter(${args[0]})`)
    }
    expect(unguarded).toEqual([])
    // The scan sees the calls it is about.
    expect(busCalls('emit').length).toBeGreaterThanOrEqual(6)
    expect(busCalls('applyFilter').length).toBeGreaterThanOrEqual(3)
  })

  it('handlers are put on a filter pipeline only where the rule is checked first', () => {
    const registering = SERVER_SOURCES.filter(({ code }) => /hookBus\s*\.\s*filter\(/.test(code)).map(({ rel }) => rel)
    expect(registering.sort()).toEqual([
      // `cms.hooks.filter`: `assertMayRegisterHook` runs first.
      'server/plugins/host/handlers/hooks.ts',
      // `cms.media.registerUrlTransformer`: gated by its own permission.
      'server/plugins/host/handlers/media.ts',
    ])
    const hooks = SERVER_SOURCES.find(({ rel }) => rel === 'server/plugins/host/handlers/hooks.ts')!.code
    const filterHandler = hooks.slice(hooks.indexOf('export async function handleHooksFilter'))
    expect(filterHandler.indexOf("assertMayRegisterHook(entry, 'filter', name)")).toBeGreaterThan(-1)
    expect(filterHandler.indexOf("assertMayRegisterHook(entry, 'filter', name)"))
      .toBeLessThan(filterHandler.indexOf('hookBus.filter('))
    const onHandler = hooks.slice(hooks.indexOf('export async function handleHooksOn'), hooks.indexOf('function isHostFilterName'))
    expect(onHandler.indexOf("assertMayRegisterHook(entry, 'event', event)")).toBeGreaterThan(-1)
    expect(onHandler.indexOf("assertMayRegisterHook(entry, 'event', event)")).toBeLessThan(onHandler.indexOf('hookBus.on('))
  })

  it('the names the bus types as guarded are the ones the table rules per table or per permission', () => {
    // `tsc` is the check: this constant does not compile unless the two
    // lists agree. Reading it here keeps it honest at run time as well.
    expect(GUARDED_EVENTS_MATCH_THEIR_RULES).toBe(true)
    const guardedByRule = Object.entries(HOST_EVENT_RULES)
      .filter(([, rule]) => isGuarded(rule))
      .map(([name]) => name)
    expect(guardedByRule.sort()).toEqual([
      'content.entry.created',
      'content.entry.deleted',
      'content.entry.updated',
      'member.created',
      'member.deleted',
      'member.signedIn',
      'member.tagged',
      'member.verified',
    ])
  })

  it('the sandbox copy of the mode permissions matches the manifest table', () => {
    const modes = Object.keys(CONTENT_ACCESS_MODE_PERMISSIONS) as Array<keyof typeof CONTENT_ACCESS_MODE_PERMISSIONS>
    expect(permissionsForModes(modes)).toEqual(modes.map((mode) => CONTENT_ACCESS_MODE_PERMISSIONS[mode]))
  })
})
