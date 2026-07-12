/**
 * Site plugin revision retention — keep the active revision plus the
 * immediately previous one (the rollback target); delete the rest.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  previousSitePluginRevision,
  sweepSitePluginRevisions,
} from '../../../server/plugins/sitePlugins/retention'

async function uploadsWithRevisions(versions: string[]): Promise<string> {
  const uploadsDir = await mkdtemp(join(tmpdir(), 'retention-'))
  for (const version of versions) {
    const dir = join(uploadsDir, 'plugins', 'site.demo', version)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'plugin.json'), '{}', 'utf8')
  }
  return uploadsDir
}

describe('sweepSitePluginRevisions', () => {
  test('keeps active + immediately previous, deletes older', async () => {
    const uploadsDir = await uploadsWithRevisions(['1.0.1+a', '1.0.2+b', '1.0.3+c'])
    try {
      const removed = await sweepSitePluginRevisions(uploadsDir, 'site.demo', '1.0.3+c')
      expect(removed).toEqual(['1.0.1+a'])
      const remaining = (await readdir(join(uploadsDir, 'plugins', 'site.demo'))).sort()
      expect(remaining).toEqual(['1.0.2+b', '1.0.3+c'])
    } finally {
      await rm(uploadsDir, { recursive: true, force: true })
    }
  })

  test('after a rollback, revisions newer than the active one are swept', async () => {
    const uploadsDir = await uploadsWithRevisions(['1.0.1+a', '1.0.2+b', '1.0.3+c'])
    try {
      const removed = await sweepSitePluginRevisions(uploadsDir, 'site.demo', '1.0.2+b')
      expect(removed.sort()).toEqual(['1.0.3+c'])
      const remaining = (await readdir(join(uploadsDir, 'plugins', 'site.demo'))).sort()
      expect(remaining).toEqual(['1.0.1+a', '1.0.2+b'])
    } finally {
      await rm(uploadsDir, { recursive: true, force: true })
    }
  })

  test('missing plugin dir is a no-op', async () => {
    const uploadsDir = await mkdtemp(join(tmpdir(), 'retention-'))
    try {
      expect(await sweepSitePluginRevisions(uploadsDir, 'site.ghost', '1.0.1+a')).toEqual([])
    } finally {
      await rm(uploadsDir, { recursive: true, force: true })
    }
  })
})

describe('previousSitePluginRevision', () => {
  test('returns the retained revision immediately below the active one', async () => {
    const uploadsDir = await uploadsWithRevisions(['1.0.2+b', '1.0.5+e'])
    try {
      expect(await previousSitePluginRevision(uploadsDir, 'site.demo', '1.0.5+e')).toBe('1.0.2+b')
      expect(await previousSitePluginRevision(uploadsDir, 'site.demo', '1.0.2+b')).toBeNull()
    } finally {
      await rm(uploadsDir, { recursive: true, force: true })
    }
  })
})
