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
  it('keeps shared primitives localized without importing the admin layer', () => {
    const uiRoot = join(REPO_ROOT, 'src/ui')
    const files = readdirSync(uiRoot, { recursive: true, encoding: 'utf8' })
      .filter((file) => /\.tsx?$/.test(file) && !file.includes('/__tests__/') && !/\.test\./.test(file))
    for (const file of files) {
      const source = readFileSync(join(uiRoot, file), 'utf8')
      expect(source).not.toMatch(/from ['"]@admin\//)
      // Raw diagnostic formatting in .ts helpers is not rendered primitive chrome.
      if (file.startsWith('i18n/') || !file.endsWith('.tsx')) continue
      expect(extractAdminMessages(source, file).map(({ message }) => `${file}: ${message}`)).toEqual([])
    }
  })
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

  it('extracts custom control labels without translating identifiers or user content', () => {
    const source = `
      export function Example({ error, value }: { error: boolean; value: string }) {
        return <Control
          publishTitle={error ? 'Cannot publish' : 'Publish site'}
          mainAriaLabel="Edit class"
          removeTooltip="Remove class"
          groupLabel="Color categories"
          value="Publish site"
          name="Edit class"
          data-testid="Remove class"
        >{value}</Control>
      }
    `
    const occurrences = extractAdminMessages(source, '/repo/src/admin/Example.tsx')
    expect(occurrences.map(({ message }) => message)).toEqual([
      'Cannot publish', 'Publish site', 'Edit class', 'Remove class', 'Color categories',
    ])
    const result = transformAdminMessages(source, '/repo/src/admin/Example.tsx', {
      'Cannot publish': '无法发布', 'Publish site': '发布站点', 'Edit class': '编辑类',
      'Remove class': '移除类', 'Color categories': '颜色分类',
    })
    expect(result?.code).toContain('mainAriaLabel={__instaticAdminLocalize("Edit class", "编辑类")}')
    expect(result?.code).toContain('value="Publish site"')
    expect(result?.code).toContain('name="Edit class"')
    expect(result?.code).toContain('data-testid="Remove class"')
    expect(result?.code).toContain('>{value}</Control>')
    expect(() => new Bun.Transpiler({ loader: 'tsx' }).transformSync(result!.code)).not.toThrow()
  })

  it('keeps complete singular and plural messages in publish and import flows', () => {
    const messages = allOccurrences().map(({ message }) => message)
    expect(messages).toContain('1 code error')
    expect(messages).toContain('{0} code errors')
    expect(messages).toContain('Nothing was imported. 1 file already uploaded stays in the Media Library.')
    expect(messages).toContain('Nothing was imported. {0} files already uploaded stay in the Media Library.')
    expect(messages).not.toContain('{0} code error{1}')
  })

  it('localizes default copy and subtitles without changing default form data or layout enums', () => {
    const source = `
      export function Example({ label = 'Search', value = 'Search' }) {
        return <Panel body="bare"><Control eyebrow="Data model" meta="Installed font" label={label} value={value} /></Panel>
      }
      export function WithFallback(fallbackHint = 'Saved reference') {
        return <span>{fallbackHint}</span>
      }
    `
    const catalog = {
      Search: '搜索', 'Data model': '数据模型', 'Installed font': '已安装字体', 'Saved reference': '已保存的引用',
    }
    expect(extractAdminMessages(source, '/repo/src/admin/Example.tsx').map(({ message }) => message))
      .toEqual(['Search', 'Data model', 'Installed font', 'Saved reference'])
    const result = transformAdminMessages(source, '/repo/src/admin/Example.tsx', catalog)
    expect(result?.code).toContain('label = __instaticAdminLocalize("Search", "搜索")')
    expect(result?.code).toContain("value = 'Search'")
    expect(result?.code).toContain('body="bare"')
    expect(result?.code).toContain('fallbackHint = __instaticAdminLocalize("Saved reference", "已保存的引用")')
    expect(() => new Bun.Transpiler({ loader: 'tsx' }).transformSync(result!.code)).not.toThrow()
  })

  it('localizes custom metadata labels but never identifiers and option values', () => {
    const source = `export const provider = { id: 'local', shortLabel: 'Local models', value: 'Local models' }`
    expect(extractAdminMessages(source, '/repo/src/admin/provider.ts').map(({ message }) => message))
      .toEqual(['Local models'])
    const result = transformAdminMessages(source, '/repo/src/admin/provider.ts', { 'Local models': '本地模型' })
    expect(result?.code).toContain('get shortLabel() { return __instaticAdminLocalize("Local models", "本地模型") }')
    expect(result?.code).toContain("id: 'local'")
    expect(result?.code).toContain("value: 'Local models'")
  })

  it('preserves JSX entity semantics in English without decoding ordinary JS strings', () => {
    const source = `export function Example() {
      const label = 'Literal &amp; text'
      return <div aria-label="Choose &quot;one&quot;">Account &amp; security{label}</div>
    }`
    const messages = extractAdminMessages(source, '/repo/src/admin/Example.tsx').map(({ message }) => message)
    expect(messages).toEqual(['Literal &amp; text', 'Choose "one"', 'Account & security'])
    const result = transformAdminMessages(source, '/repo/src/admin/Example.tsx', {
      'Account & security': '账户与安全', 'Choose "one"': '选择“一个”',
    })
    expect(result?.code).toContain('__instaticAdminLocalize("Account & security", "账户与安全")')
    expect(result?.code).toContain("const label = 'Literal &amp; text'")
    expect(() => new Bun.Transpiler({ loader: 'tsx' }).transformSync(result!.code)).not.toThrow()
  })

  it('localizes helper labels declared inside JSX map callbacks', () => {
    const source = `export function Example({ items }) {
      return <div>{items.map(item => {
        const actionLabel = item.open ? \`Close ${'${item.label}'} panel\` : \`Open ${'${item.label}'} panel\`
        return <button aria-label={actionLabel}>{item.label}</button>
      })}</div>
    }`
    const catalog = { 'Close {0} panel': '关闭{0}面板', 'Open {0} panel': '打开{0}面板' }
    expect(extractAdminMessages(source, '/repo/src/admin/Example.tsx').map(({ message }) => message))
      .toEqual(['Close {0} panel', 'Open {0} panel'])
    const result = transformAdminMessages(source, '/repo/src/admin/Example.tsx', catalog)
    expect(result?.code).toContain('__instaticAdminFormat("Close {0} panel", "关闭{0}面板", [item.label])')
    expect(() => new Bun.Transpiler({ loader: 'tsx' }).transformSync(result!.code)).not.toThrow()
  })
})
