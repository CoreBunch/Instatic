import { link, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { GlobalWindow } from 'happy-dom'
import { safeParseJson } from '@core/utils/jsonValidate'
import { MappingSchema, type Mapping } from './source'

const [input, output, rules] = Bun.argv.slice(2)
if (!input || !output || Bun.argv.length > 5) {
  console.error('Usage: bun run wordpress:convert SOURCE.zip NEW-SITE.zip [mapping.json]')
  process.exit(2)
}
const report = output + '.report.json'
if (await Bun.file(output).exists() || await Bun.file(report).exists()) throw new Error('Choose a new output path')
let mapping: Mapping = {}
if (rules) {
  const parsed = safeParseJson(await Bun.file(rules).text(), MappingSchema)
  if (!parsed.ok) throw parsed.error
  mapping = parsed.value
}
function offline(): never { throw new Error('Offline conversion') }
const win = new GlobalWindow({ settings: { enableJavaScriptEvaluation: false, disableJavaScriptFileLoading: true,
  enableCSSFileLoading: false, enableIframePageLoading: false, fetch: { interceptor: { beforeAsyncRequest: offline, beforeSyncRequest: offline } } } })
Object.assign(globalThis, { window: win, document: win.document })
for (const key of ['DOMParser','XMLSerializer','Node','Element','HTMLElement','Text','CSSStyleSheet','CSSRule','CSSStyleRule',
  'CSSMediaRule','CSSKeyframesRule','CSSStyleDeclaration','localStorage'] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: win[key] })
}
try {
  const { convert } = await import('./convert')
  const result = await convert(new Uint8Array(await Bun.file(input).arrayBuffer()), mapping)
  // Finish both writes before exposing the archive. Hard links claim new
  // names atomically so concurrent conversions cannot overwrite each other.
  const temp = await mkdtemp(join(dirname(output), '.wordpress-convert-'))
  try {
    const stagedReport = join(temp, 'report')
    const stagedZip = join(temp, 'archive')
    await writeFile(stagedReport, JSON.stringify(result.report, null, 2), { mode: 0o600 })
    await writeFile(stagedZip, result.archive, { mode: 0o600 })
    await link(stagedReport, report)
    try { await link(stagedZip, output) } catch (error) {
      await unlink(report)
      throw error
    }
  } finally { await rm(temp, { recursive: true, force: true }) }
  console.info(`Created ${output} and ${report} (${result.report.warnings.length} review items)`)
} finally { await win.happyDOM.close() }
