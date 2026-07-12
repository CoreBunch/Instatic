/**
 * Site plugin workspace materializer — writes one plugin's draft files into
 * an isolated temp directory (prefix stripped) so the shared builder core
 * can bundle them. Same pattern as `materializeSiteScriptWorkspace`
 * (server/publish/runtime/virtualSiteWorkspace.ts): path-safety checks,
 * realpath'd temp root, cleanup callback.
 */
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { SiteFile } from '@core/files/schemas'
import { isSafePath, normalizePath } from '@core/files/pathValidation'
import { sitePluginFolder } from '@core/site-plugins'

export interface SitePluginWorkspace {
  rootDir: string
  cleanup: () => Promise<void>
}

/** Write plugins/<localId>/** files into a temp dir, prefix stripped. */
export async function materializeSitePluginWorkspace(
  localId: string,
  files: readonly SiteFile[],
): Promise<SitePluginWorkspace> {
  const tempDir = await mkdtemp(join(tmpdir(), `instatic-site-plugin-${localId}-`))
  const rootDir = await realpath(tempDir)
  const prefix = sitePluginFolder(localId)
  try {
    for (const file of files) {
      if (typeof file.content !== 'string') continue
      if (!file.path.startsWith(prefix)) continue
      const relative = normalizePath(file.path.slice(prefix.length))
      if (!relative || !isSafePath(relative)) continue
      const absolutePath = resolve(rootDir, relative)
      if (!absolutePath.startsWith(rootDir + '/')) continue
      await mkdir(dirname(absolutePath), { recursive: true })
      await writeFile(absolutePath, file.content, 'utf8')
    }
  } catch (error) {
    await rm(rootDir, { recursive: true, force: true })
    throw error
  }
  return { rootDir, cleanup: () => rm(rootDir, { recursive: true, force: true }) }
}
