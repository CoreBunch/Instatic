import { describe, expect, it } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  extractAdminMessages,
  transformAdminMessages,
  type AdminMessageOccurrence,
} from '../../../scripts/lib/adminI18n'
import { adminLiteralZhCN } from '../../admin/i18n/literalCatalog'

const REPO_ROOT = join(import.meta.dir, '../../..')
const ADMIN_ROOT = join(REPO_ROOT, 'src/admin')

function adminSourceFiles(): string[] {
  return readdirSync(ADMIN_ROOT, { recursive: true, encoding: 'utf8' })
    .filter((filePath) => filePath.endsWith('.ts') || filePath.endsWith('.tsx'))
    .filter((filePath) => !filePath.includes('/__tests__/'))
    .filter((filePath) => !filePath.startsWith('i18n/'))
    .filter((filePath) => !filePath.endsWith('.test.ts') && !filePath.endsWith('.test.tsx'))
    .map((filePath) => join(ADMIN_ROOT, filePath))
}

function allOccurrences(): AdminMessageOccurrence[] {
  return adminSourceFiles().flatMap((absolutePath) => {
    const filePath = relative(REPO_ROOT, absolutePath)
    return extractAdminMessages(readFileSync(absolutePath, 'utf8'), filePath)
  })
}

describe('admin i18n architecture', () => {
  it('has a Simplified Chinese translation for every extracted admin message', () => {
    const missing = allOccurrences()
      .filter(({ message }) => !(message in adminLiteralZhCN))
      .map(({ filePath, line, message }) => `${filePath}:${line} ${JSON.stringify(message)}`)

    expect(missing).toEqual([])
  })

  it('uses empty translations only for English plural suffix fragments', () => {
    const empty = Object.entries(adminLiteralZhCN)
      .filter(([, translation]) => translation.length === 0)
      .map(([message]) => message)

    expect(empty).toEqual(['ies', 'y'])
  })

  it('localizes JSX, accessible attributes, templates, and static configuration', () => {
    const source = `
      export function Example({ count }: { count: number }) {
        const command = { title: 'Dashboard' }
        return <button aria-label="Open Dashboard">Dashboard {\`${'${count}'} items\`}{command.title}</button>
      }
    `
    const result = transformAdminMessages(source, '/repo/src/admin/Example.tsx', {
      Dashboard: '仪表盘',
      'Open Dashboard': '打开仪表盘',
      '{0} items': '{0} 项',
    })

    expect(result).not.toBeNull()
    expect(result?.code).toContain('__instaticAdminLocalize("Dashboard", "仪表盘")')
    expect(result?.code).toContain('__instaticAdminLocalize("Open Dashboard", "打开仪表盘")')
    expect(result?.code).toContain('__instaticAdminFormat("{0} items", "{0} 项", [count])')
    expect(result?.code).toContain('get title() { return __instaticAdminLocalize')
  })
})
