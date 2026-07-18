import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '../../..')

describe('site runtime isolation', () => {
  it('has no imports from the builder, CMS server, modules, or external packages', async () => {
    const source = await readFile(join(ROOT, 'site-runtime/runtime.ts'), 'utf8')
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1])
    expect(imports).toEqual(['node:path'])
    expect(source).not.toContain('/admin/api/')
    expect(source).not.toContain('DATABASE_URL')
  })

  it('builds the deployment image from only the generic runtime and public artifact', async () => {
    const dockerfile = await readFile(join(ROOT, 'site-runtime/Dockerfile'), 'utf8')
    expect(dockerfile).toContain('COPY --chown=bun:bun runtime.ts ./runtime.ts')
    expect(dockerfile).toContain('COPY --chown=bun:bun public ./public')
    expect(dockerfile).not.toMatch(/COPY .*\b(?:server|src|dist|node_modules)\b/)
  })

  it('materializes an explicit three-file deployment shell', async () => {
    const source = await readFile(join(ROOT, 'server/publish/siteArtifact.ts'), 'utf8')
    expect(source).toContain("copyFile(join(runtimeTemplateDir, 'runtime.ts')")
    expect(source).toContain("copyFile(join(runtimeTemplateDir, 'Dockerfile')")
    expect(source).toContain("copyFile(join(runtimeTemplateDir, 'railway.json')")
    expect(source).not.toContain("copyFile(join(runtimeTemplateDir, '../server')")
  })
})
