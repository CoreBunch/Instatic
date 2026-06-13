import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { SiteDocument } from '@core/page-tree'
import { isSafePath, normalizePath } from '@core/files/pathValidation'

interface SiteScriptWorkspace {
  rootDir: string
  entryPointByFileId: Map<string, string>
  cleanup: () => Promise<void>
}

export async function materializeSiteScriptWorkspace(site: SiteDocument): Promise<SiteScriptWorkspace> {
  const tempDir = await mkdtemp(join(tmpdir(), 'instatic-site-runtime-'))
  const rootDir = await realpath(tempDir)
  const entryPointByFileId = new Map<string, string>()

  try {
    for (const file of site.files) {
      if (file.type !== 'script' || typeof file.content !== 'string') continue

      const normalized = normalizePath(file.path)
      if (!isSafePath(normalized)) continue

      const absolutePath = resolve(rootDir, normalized)
      if (!absolutePath.startsWith(rootDir)) continue

      await mkdir(dirname(absolutePath), { recursive: true })
      await writeFile(absolutePath, file.content, 'utf8')
      entryPointByFileId.set(file.id, absolutePath)
    }
  } catch (error) {
    await rm(rootDir, { recursive: true, force: true })
    throw error
  }

  return {
    rootDir,
    entryPointByFileId,
    cleanup: () => rm(rootDir, { recursive: true, force: true }),
  }
}
