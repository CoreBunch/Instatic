import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '../../..')

function sourceFiles(directory: string): string[] {
  const absolute = resolve(ROOT, directory)
  const files: string[] = []
  for (const entry of readdirSync(absolute)) {
    const path = join(absolute, entry)
    if (statSync(path).isDirectory()) {
      files.push(...sourceFiles(relative(ROOT, path)))
    } else if (/\.(ts|tsx)$/.test(entry)) {
      files.push(path)
    }
  }
  return files
}

describe('managed platform boundaries', () => {
  it('keeps the platform browser app independent from the CMS admin and site editor', () => {
    for (const path of sourceFiles('src/platform')) {
      const source = readFileSync(path, 'utf8')
      expect(source, relative(ROOT, path)).not.toMatch(/from ['"]@admin\//)
      expect(source, relative(ROOT, path)).not.toMatch(/from ['"]@site\//)
      expect(source, relative(ROOT, path)).not.toMatch(/from ['"]\.\.\/admin\//)
    }
  })

  it('keeps control-plane modules out of the exportable site runtime', () => {
    for (const path of sourceFiles('site-runtime')) {
      const source = readFileSync(path, 'utf8')
      expect(source, relative(ROOT, path)).not.toMatch(/server\/platform|src\/platform|@workos-inc/)
    }
  })
})
