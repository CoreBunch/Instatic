/**
 * Site plugin revision retention — keep the five highest builds plus the
 * active one, list the retained builds newest first, delete the rest.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  RETAINED_REVISIONS,
  listSitePluginRevisions,
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

const SEVEN = ['1.0.1+a', '1.0.2+b', '1.0.3+c', '1.0.4+d', '1.0.5+e', '1.0.6+f', '1.0.7+g']

describe('sweepSitePluginRevisions', () => {
  test(`keeps the ${RETAINED_REVISIONS} highest builds when the newest is active`, async () => {
    const uploadsDir = await uploadsWithRevisions(SEVEN)
    try {
      const removed = await sweepSitePluginRevisions(uploadsDir, 'site.demo', '1.0.7+g')
      expect(removed.sort()).toEqual(['1.0.1+a', '1.0.2+b'])
      const remaining = (await readdir(join(uploadsDir, 'plugins', 'site.demo'))).sort()
      expect(remaining).toEqual(['1.0.3+c', '1.0.4+d', '1.0.5+e', '1.0.6+f', '1.0.7+g'])
    } finally {
      await rm(uploadsDir, { recursive: true, force: true })
    }
  })

  test('an active build outside the top five is kept too (deep rollback)', async () => {
    const uploadsDir = await uploadsWithRevisions(SEVEN)
    try {
      const removed = await sweepSitePluginRevisions(uploadsDir, 'site.demo', '1.0.1+a')
      expect(removed).toEqual(['1.0.2+b'])
      const remaining = (await readdir(join(uploadsDir, 'plugins', 'site.demo'))).sort()
      expect(remaining).toEqual(['1.0.1+a', '1.0.3+c', '1.0.4+d', '1.0.5+e', '1.0.6+f', '1.0.7+g'])
    } finally {
      await rm(uploadsDir, { recursive: true, force: true })
    }
  })

  test('after a rollback the newer builds stay retained (roll forward is possible)', async () => {
    const uploadsDir = await uploadsWithRevisions(['1.0.1+a', '1.0.2+b', '1.0.3+c'])
    try {
      expect(await sweepSitePluginRevisions(uploadsDir, 'site.demo', '1.0.2+b')).toEqual([])
      const remaining = (await readdir(join(uploadsDir, 'plugins', 'site.demo'))).sort()
      expect(remaining).toEqual(['1.0.1+a', '1.0.2+b', '1.0.3+c'])
    } finally {
      await rm(uploadsDir, { recursive: true, force: true })
    }
  })

  test('entries that are not version-shaped are swept; a missing plugin dir is a no-op', async () => {
    const uploadsDir = await uploadsWithRevisions(['1.0.1+a', 'stray'])
    try {
      expect(await sweepSitePluginRevisions(uploadsDir, 'site.demo', '1.0.1+a')).toEqual(['stray'])
      expect(await sweepSitePluginRevisions(uploadsDir, 'site.ghost', '1.0.1+a')).toEqual([])
    } finally {
      await rm(uploadsDir, { recursive: true, force: true })
    }
  })
})

describe('listSitePluginRevisions', () => {
  test('lists retained builds newest first with a build time', async () => {
    const uploadsDir = await uploadsWithRevisions(['1.0.2+b', '1.0.10+j', '1.0.5+e'])
    try {
      const revisions = await listSitePluginRevisions(uploadsDir, 'site.demo')
      expect(revisions.map((revision) => revision.version)).toEqual(['1.0.10+j', '1.0.5+e', '1.0.2+b'])
      for (const revision of revisions) {
        expect(revision.builtAt).toBeGreaterThan(Date.now() - 60_000)
      }
      expect(await listSitePluginRevisions(uploadsDir, 'site.ghost')).toEqual([])
    } finally {
      await rm(uploadsDir, { recursive: true, force: true })
    }
  })
})
