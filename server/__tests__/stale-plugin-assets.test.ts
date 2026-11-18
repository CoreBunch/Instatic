/**
 * Retiring plugin versions at the right moment.
 *
 * Published HTML links a plugin's frontend assets by version, and only a
 * publish rewrites those links. Deleting the old version during the UPGRADE
 * therefore broke every page already on disk — on a real site it 404'd jQuery,
 * GSAP, Lenis, Splide and the boot script across all six pages at once, with
 * no warning and no prompt to re-publish.
 *
 * These pin the two halves: the sweep removes what a fresh publish has stopped
 * referencing, and it refuses to touch anything it cannot account for.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sweepStalePluginVersionAssets } from '../publish/stalePluginAssets'
import type { DbClient } from '../db/client'

let uploadsDir = ''

/** A DbClient stub whose only job is to answer the installed-plugins query. */
function dbWithInstalled(installed: Array<{ id: string; version: string }>): DbClient {
  const rows = installed.map((p) => ({
    id: p.id,
    version: p.version,
    manifest_json: { id: p.id, name: p.id, version: p.version, apiVersion: 1 },
    enabled: true,
    status: 'active',
    settings_json: {},
    granted_permissions_json: [],
    installed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }))
  const client = (async () => ({ rows, rowCount: rows.length })) as unknown as DbClient
  return client
}

async function seedVersion(pluginId: string, version: string): Promise<void> {
  const dir = join(uploadsDir, 'plugins', pluginId, version, 'frontend')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'app.js'), '// bundle')
}

const versionsOf = async (pluginId: string): Promise<string[]> =>
  (await readdir(join(uploadsDir, 'plugins', pluginId), { withFileTypes: true }))
    .filter((e) => e.isDirectory()).map((e) => e.name).sort()

beforeEach(async () => { uploadsDir = await mkdtemp(join(tmpdir(), 'instatic-sweep-')) })
afterEach(async () => { await rm(uploadsDir, { recursive: true, force: true }) })

describe('sweepStalePluginVersionAssets', () => {
  test('removes the superseded version and keeps the installed one', async () => {
    await seedVersion('acme.demo', '1.0.0')
    await seedVersion('acme.demo', '1.1.0')
    const result = await sweepStalePluginVersionAssets(dbWithInstalled([{ id: 'acme.demo', version: '1.1.0' }]), uploadsDir)
    expect(result.removed).toBe(1)
    expect(await versionsOf('acme.demo')).toEqual(['1.1.0'])
  })

  test('removes several versions when publishes lagged behind upgrades', async () => {
    for (const v of ['1.0.0', '1.1.0', '1.2.0', '1.3.0']) await seedVersion('acme.demo', v)
    const result = await sweepStalePluginVersionAssets(dbWithInstalled([{ id: 'acme.demo', version: '1.3.0' }]), uploadsDir)
    expect(result.removed).toBe(3)
    expect(await versionsOf('acme.demo')).toEqual(['1.3.0'])
  })

  test('a single installed version is left alone', async () => {
    await seedVersion('acme.demo', '1.0.0')
    const result = await sweepStalePluginVersionAssets(dbWithInstalled([{ id: 'acme.demo', version: '1.0.0' }]), uploadsDir)
    expect(result.removed).toBe(0)
    expect(await versionsOf('acme.demo')).toEqual(['1.0.0'])
  })

  test('a plugin with no installed record is never touched', async () => {
    // Uninstall already removes the tree, so anything still here is
    // unexplained — and unexplained is a bad reason to delete from a live
    // volume during a publish.
    await seedVersion('mystery.plugin', '9.9.9')
    const result = await sweepStalePluginVersionAssets(dbWithInstalled([]), uploadsDir)
    expect(result.removed).toBe(0)
    expect(await versionsOf('mystery.plugin')).toEqual(['9.9.9'])
  })

  test('only the named plugin is swept', async () => {
    await seedVersion('acme.demo', '1.0.0')
    await seedVersion('acme.demo', '1.1.0')
    await seedVersion('other.plugin', '2.0.0')
    await sweepStalePluginVersionAssets(dbWithInstalled([
      { id: 'acme.demo', version: '1.1.0' },
      { id: 'other.plugin', version: '2.0.0' },
    ]), uploadsDir)
    expect(await versionsOf('other.plugin')).toEqual(['2.0.0'])
  })

  test('a site with no plugins directory is not an error', async () => {
    const result = await sweepStalePluginVersionAssets(dbWithInstalled([]), uploadsDir)
    expect(result.removed).toBe(0)
  })
})
