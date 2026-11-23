/**
 * Architecture gate — plugin secret material never crosses the HTTP
 * boundary. Modelled on `ai-credentials-never-leak.test.ts`.
 *
 * Static scan of `server/handlers/**` (every HTTP-handler module):
 *
 *   - Handler files must not read `.ciphertext` / `.iv` — there is no
 *     legitimate handler reason to touch raw encryption material from
 *     `plugin_secrets` rows.
 *
 *   - Handler files must not import `resolvePluginSecretsForRuntime` — the
 *     decrypted-plaintext projection is reserved for the server-side
 *     runtime path (`server/plugins/settingsCache.ts` seeds the owning
 *     plugin's QuickJS worker mirror, and nothing else). Handlers
 *     reach the runtime record only through `refreshPluginSettingsCache`,
 *     whose return value feeds the worker — never a response body.
 *
 *   - The browser-bound presentation goes through `projectSecretSettings` /
 *     `listPluginSecretStates`, which only expose presence (`'***'` / `''`)
 *     and the per-field key-fingerprint state.
 *
 * Two scans for the hook bus. They are tripwires for the obvious mistake,
 * not a proof: what actually stops a leak to another plugin is the run-time
 * check in `hookBus` (`emit` refuses an owner-only event, `emitTo` refuses a
 * payload carrying anything but the event's listed keys) and the two-worker
 * test in `server/pluginSettingsChangedOwnerOnly.test.ts`.
 *
 *   - No production file passes an owner-only event name
 *     (`OWNER_ONLY_HOOK_EVENTS`) as a string literal to an `.emit(` call.
 *
 *   - A server file that calls one of the functions returning a plugin's
 *     decrypted settings record names `hookBus` only to tear listeners down
 *     (`reset`, `unregisterPlugin`), except `settingsSync.ts`, whose single
 *     use is the value-free `settings.changed` to the owning plugin.
 *
 * Out of their reach, by construction: an event name built at run time, and
 * a settings record handed as an argument to a module that never calls those
 * functions itself and broadcasts it under a plugin-namespaced event.
 */

import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, extname, relative } from 'path'
import { OWNER_ONLY_HOOK_EVENTS } from '@core/plugins/hookBus'

const REPO_ROOT = join(import.meta.dir, '../../../')
const HANDLERS_DIR = join(REPO_ROOT, 'server/handlers')

/** The only module allowed to import the plaintext runtime projection. */
const RUNTIME_RESOLUTION_ALLOWLIST = new Set([
  'server/plugins/settingsCache.ts',
])

function listFilesRecursive(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...listFilesRecursive(full))
    else if (extname(full) === '.ts') out.push(full)
  }
  return out
}

/** Production TypeScript under `server/` and `src/`, tests excluded. */
function listProductionSources(): string[] {
  return [join(REPO_ROOT, 'server'), join(REPO_ROOT, 'src')]
    .flatMap((dir) => listFilesRecursive(dir))
    .filter((file) => !file.includes('__tests__'))
}

/** Names that hand out, or pass along, a plugin's decrypted settings record. */
const RUNTIME_RECORD_ACCESSORS =
  /\b(getCachedPluginSettings|primePluginSettingsCache|refreshPluginSettingsCache|persistAndSyncPluginSettings|resolvePluginSecretsForRuntime)\s*\(/

/** The one place a holder of the runtime record may use the hook bus, and how. */
const SETTINGS_SYNC = 'server/plugins/host/settingsSync.ts'
const SANCTIONED_SETTINGS_EMIT = "hookBus.emitTo(pluginId, 'settings.changed', { pluginId })"

/** Code with comments removed, so a mention in prose is not a finding. */
function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('plugin-secrets-never-leak gate', () => {
  it('no HTTP handler file touches raw encryption material or the plaintext runtime projection', () => {
    const files = listFilesRecursive(HANDLERS_DIR)
    expect(files.length).toBeGreaterThan(0)

    const violations: { file: string; finding: string }[] = []

    for (const file of files) {
      const src = readFileSync(file, 'utf8')
      const rel = relative(REPO_ROOT, file).replaceAll('\\', '/')

      const PATTERNS: Array<{ name: string; re: RegExp }> = [
        { name: '.ciphertext member access', re: /\.ciphertext\b/ },
        // `\.iv\b` is too noisy (matches `.invoke` etc.). Require an
        // ASCII boundary specifically after the `iv` field.
        { name: '.iv member access', re: /\.iv(?=[\s,;)\]}.])/ },
        { name: 'import of resolvePluginSecretsForRuntime (plaintext projection)', re: /resolvePluginSecretsForRuntime/ },
      ]

      for (const pattern of PATTERNS) {
        if (pattern.re.test(src)) {
          violations.push({ file: rel, finding: pattern.name })
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `[plugin-secrets-never-leak] handler files touch plugin secret material:\n` +
        violations.map((v) => `  ${v.file} → ${v.finding}`).join('\n') +
        `\n\nProject plugin_secrets rows through listPluginSecretStates() / projectSecretSettings() before serialising.`,
      )
    }
    expect(violations).toHaveLength(0)
  })

  it('resolvePluginSecretsForRuntime is imported only by the sanctioned runtime modules', () => {
    const serverFiles = listFilesRecursive(join(REPO_ROOT, 'server'))
    const offenders: string[] = []
    for (const file of serverFiles) {
      const rel = relative(REPO_ROOT, file).replaceAll('\\', '/')
      if (rel === 'server/repositories/pluginSecrets.ts') continue // declaration site
      const src = readFileSync(file, 'utf8')
      // Match actual imports/usages, not doc-comment mentions: an import
      // clause or a call site.
      const imports = /import\s*\{[^}]*\bresolvePluginSecretsForRuntime\b[^}]*\}/.test(src)
      const calls = /\bresolvePluginSecretsForRuntime\s*\(/.test(src)
      if ((imports || calls) && !RUNTIME_RESOLUTION_ALLOWLIST.has(rel)) {
        offenders.push(rel)
      }
    }
    expect(offenders).toEqual([])
  })

  it('no owner-only event name is passed to an emit call', () => {
    const names = OWNER_ONLY_HOOK_EVENTS.map((name) => name.replaceAll('.', '\\.')).join('|')
    const broadcast = new RegExp(`\\.emit\\(\\s*['"\`](?:${names})['"\`]`)
    const offenders = listProductionSources()
      .filter((file) => broadcast.test(withoutComments(readFileSync(file, 'utf8'))))
      .map((file) => relative(REPO_ROOT, file).replaceAll('\\', '/'))
    expect(offenders).toEqual([])
  })

  it('a file that reads decrypted plugin settings does not touch the hook bus', () => {
    const findings: string[] = []
    for (const file of listFilesRecursive(join(REPO_ROOT, 'server'))) {
      const rel = relative(REPO_ROOT, file).replaceAll('\\', '/')
      const code = withoutComments(readFileSync(file, 'utf8'))
      if (!RUNTIME_RECORD_ACCESSORS.test(code)) continue
      // Every line naming the bus, however it is reached (a cast, an alias
      // assignment, a destructure), except the import itself.
      const busLines = code
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /\bhookBus\b/.test(line) && !line.startsWith('import '))
      for (const line of busLines) {
        if (rel === SETTINGS_SYNC && line === `await ${SANCTIONED_SETTINGS_EMIT}`) continue
        // Tearing listeners down sends nothing.
        if (/^hookBus\.(?:reset|unregisterPlugin)\([\w.]*\)$/.test(line)) continue
        findings.push(`${rel} → ${line}`)
      }
    }
    expect(findings).toEqual([])

    // The sanctioned call is there, exactly once.
    const syncCode = withoutComments(readFileSync(join(REPO_ROOT, SETTINGS_SYNC), 'utf8'))
    expect(syncCode.split(SANCTIONED_SETTINGS_EMIT)).toHaveLength(2)
  })

  it('plugin handler responses funnel through the wire-safe secret projection', () => {
    const sharedSrc = readFileSync(
      join(REPO_ROOT, 'server/handlers/cms/plugins/shared.ts'),
      'utf8',
    )
    const settingsSrc = readFileSync(
      join(REPO_ROOT, 'server/handlers/cms/plugins/settings.ts'),
      'utf8',
    )
    expect(sharedSrc.includes('listPluginSecretStates(')).toBe(true)
    expect(sharedSrc.includes('projectSecretSettings(')).toBe(true)
    expect(settingsSrc.includes('projectSecretSettings(')).toBe(true)
  })
})
