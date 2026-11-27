/**
 * `instatic-plugin dev` — which watcher events trigger a rebuild.
 *
 * The build writes `dist/` and short-lived facades into the plugin source. If
 * the watcher took those writes for edits, every rebuild would trigger the next
 * one. `fs.watch` reports paths with the platform separator, so each case is
 * checked with both `/` and `\` (Windows).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shouldIgnoreChange } from '../../core/plugin-sdk/cli/dev'

let pluginDir = ''

beforeAll(async () => {
  pluginDir = await mkdtemp(join(tmpdir(), 'instatic-plugin-dev-'))
  await mkdir(join(pluginDir, 'server'))
})

afterAll(async () => {
  await rm(pluginDir, { recursive: true, force: true })
})

const bothSeparators = (path: string) => [path, path.replaceAll('/', '\\')]

describe('shouldIgnoreChange', () => {
  it.each([
    ...bothSeparators('dist/modules/index.js'),
    'dist',
    ...bothSeparators('server/__sandbox-facade-1795384207186.ts'),
    '__modules-facade.ts',
    ...bothSeparators('node_modules/pkg/index.js'),
    ...bothSeparators('.git/index'),
    '.DS_Store',
  ])('ignores %s, written by the build or the tooling', (fileName) => {
    expect(shouldIgnoreChange(pluginDir, fileName)).toBe(true)
  })

  it('ignores an event for an existing folder, which Windows reports around each facade', () => {
    expect(shouldIgnoreChange(pluginDir, 'server')).toBe(true)
  })

  it.each([
    ...bothSeparators('modules/hello.ts'),
    ...bothSeparators('server/index.ts'),
    // Starts with "dist" but is a source file, not the build output.
    ...bothSeparators('src/distance.ts'),
    // A removed folder no longer exists, and its removal does need a rebuild.
    'removed-folder',
  ])('rebuilds for %s', (fileName) => {
    expect(shouldIgnoreChange(pluginDir, fileName)).toBe(false)
  })
})
