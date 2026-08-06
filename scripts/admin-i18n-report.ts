import { readFile } from 'node:fs/promises'
import { extractAdminMessages } from './lib/adminI18n'
import { adminLiteralZhCN } from '../src/admin/i18n/literalCatalog'

const requestedArea = Bun.argv.find((argument) => argument.startsWith('--area='))?.slice(7)
const missingOnly = Bun.argv.includes('--missing')
const occurrences = []

function areaFor(filePath: string): string {
  const pageMatch = filePath.match(/^src\/admin\/pages\/([^/]+)\//)
  if (pageMatch?.[1]) return pageMatch[1]
  if (filePath.startsWith('src/admin/modals/')) return 'modals'
  if (filePath.startsWith('src/admin/spotlight/')) return 'spotlight'
  return 'shared'
}

const glob = new Bun.Glob('src/admin/**/*.{ts,tsx}')
for await (const filePath of glob.scan({ cwd: process.cwd(), onlyFiles: true })) {
  if (
    filePath.includes('/__tests__/') ||
    filePath.includes('/i18n/') ||
    filePath.endsWith('.test.ts') ||
    filePath.endsWith('.test.tsx')
  ) {
    continue
  }
  const area = areaFor(filePath)
  if (requestedArea && requestedArea !== area) continue
  const source = await readFile(filePath, 'utf8')
  occurrences.push(...extractAdminMessages(source, filePath).map((item) => ({ ...item, area })))
}

const messages = new Map<string, { area: string; references: string[] }>()
for (const item of occurrences) {
  const current = messages.get(item.message)
  const reference = `${item.filePath}:${item.line}`
  if (current) {
    if (!current.references.includes(reference)) current.references.push(reference)
  } else {
    messages.set(item.message, { area: item.area, references: [reference] })
  }
}

const rows = [...messages.entries()].sort(([left], [right]) => left.localeCompare(right))
for (const [message, details] of rows) {
  if (missingOnly && message in adminLiteralZhCN) continue
  process.stdout.write(`${JSON.stringify(message)}\t${details.area}\t${details.references.join(',')}\n`)
}
const missingCount = rows.filter(([message]) => !(message in adminLiteralZhCN)).length
process.stderr.write(`${rows.length} unique messages, ${missingCount} missing across ${occurrences.length} occurrences\n`)
