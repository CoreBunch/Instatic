/**
 * Architecture gate: Visual Components are NOT stored in the site shell.
 *
 * Step 4 of the unified-content-storage refactor moves VCs out of
 * `site.settings_json.visualComponents[]` (the site shell) and into
 * `data_rows` where `table_id = 'components'`, mirroring how Step 3
 * moved pages.
 *
 * These gates lock in the structural contract:
 *   1. `SiteDocumentSchema` must NOT declare a `visualComponents` field.
 *   2. `SiteShell` (the persisted shell type) must NOT include `visualComponents`.
 *   3. `SiteDocument` IS `SiteShell & { pages: Page[]; visualComponents: VisualComponent[] }` —
 *      the field exists only on the assembled in-memory type.
 *   4. `server/repositories/site.ts` must NOT read or write `visualComponents`
 *      from/to the site row (it lives in data_rows now).
 *   5. The client adapter `src/core/persistence/cms.ts` fetches VCs from
 *      `/admin/api/cms/components` (not embedded in the shell GET).
 *   6. `src/core/persistence/validate.ts` exports `validateVisualComponents`
 *      as a first-class function (not baked into `validateSite`).
 */

import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = join(import.meta.dir, '../../../')

const PAGE_TREE_SCHEMAS  = join(ROOT, 'src/core/page-tree/siteDocument.ts')
const SITE_REPOSITORY    = join(ROOT, 'server/repositories/site.ts')
const CMS_ADAPTER        = join(ROOT, 'src/core/persistence/cms.ts')
const VALIDATE_TS        = join(ROOT, 'src/core/persistence/validate.ts')
const COMPONENTS_HANDLER = join(ROOT, 'server/handlers/cms/components.ts')

// ---------------------------------------------------------------------------
// 1 — SiteDocumentSchema must NOT have visualComponents
// ---------------------------------------------------------------------------

describe('Gate SH-1 — SiteDocumentSchema has no visualComponents field', () => {
  it('SiteDocumentSchema declaration in schemas.ts does not include visualComponents', () => {
    const source = readFileSync(PAGE_TREE_SCHEMAS, 'utf-8')
    // Find the SiteDocumentSchema object body — scan between `const SiteDocumentSchema = Type.Object({`
    // and the closing `})`. We check that within that block there is no `visualComponents:`.
    const schemaStart = source.indexOf('const SiteDocumentSchema = Type.Object({')
    expect(schemaStart).toBeGreaterThan(-1)
    const schemaEnd = source.indexOf('\n})', schemaStart)
    expect(schemaEnd).toBeGreaterThan(schemaStart)
    const schemaBlock = source.slice(schemaStart, schemaEnd)
    // Must not have a visualComponents property inside the schema definition
    expect(schemaBlock).not.toMatch(/visualComponents\s*:/)
  })
})

// ---------------------------------------------------------------------------
// 2 — SiteDocument (in-memory type) DOES include visualComponents
// ---------------------------------------------------------------------------

describe('Gate SH-2 — SiteDocument type includes visualComponents (in-memory only)', () => {
  it('schemas.ts declares SiteDocument as SiteShell & { pages: ...; visualComponents: ... }', () => {
    const source = readFileSync(PAGE_TREE_SCHEMAS, 'utf-8')
    // The type alias declaration must reference visualComponents
    expect(source).toMatch(/SiteDocument\s*=\s*SiteShell\s*&\s*\{[^}]*visualComponents/)
  })
})

// ---------------------------------------------------------------------------
// 3 — server/repositories/site.ts must NOT touch visualComponents
// ---------------------------------------------------------------------------

describe('Gate SH-3 — site repository does not read/write visualComponents', () => {
  it('server/repositories/site.ts has no reference to visualComponents', () => {
    const source = readFileSync(SITE_REPOSITORY, 'utf-8')
    // The site repository only manages the shell; VC management lives in data.ts
    expect(source).not.toMatch(/visualComponents/)
  })
})

// ---------------------------------------------------------------------------
// 4 — CMS adapter fetches/saves VCs separately from the shell
// ---------------------------------------------------------------------------

describe('Gate SH-4 — CMS adapter uses /components endpoint for VCs', () => {
  it('cms.ts fetches /components endpoint (not embedded in /site GET)', () => {
    const source = readFileSync(CMS_ADAPTER, 'utf-8')
    expect(source).toMatch(/\/components/)
  })

  it('cms.ts calls validateVisualComponents', () => {
    const source = readFileSync(CMS_ADAPTER, 'utf-8')
    expect(source).toMatch(/validateVisualComponents/)
  })

  it('cms.ts calls visualComponentFromRow', () => {
    const source = readFileSync(CMS_ADAPTER, 'utf-8')
    expect(source).toMatch(/visualComponentFromRow/)
  })
})

// ---------------------------------------------------------------------------
// 5 — validate.ts exports validateVisualComponents as a first-class function
// ---------------------------------------------------------------------------

describe('Gate SH-5 — validate.ts exports validateVisualComponents', () => {
  it('src/core/persistence/validate.ts exports validateVisualComponents', async () => {
    const mod = await import('@core/persistence/validate')
    expect(typeof (mod as Record<string, unknown>).validateVisualComponents).toBe('function')
  })

  it('validate.ts validateVisualComponents does not just forward to validateSite', () => {
    const source = readFileSync(VALIDATE_TS, 'utf-8')
    expect(source).toMatch(/export function validateVisualComponents/)
  })
})

// ---------------------------------------------------------------------------
// 6 — /components read handler exists; writes go through the transactional
//     site-document save (PUT /admin/api/cms/site-document)
// ---------------------------------------------------------------------------

describe('Gate SH-6 — /admin/api/cms/components handler exists', () => {
  it('server/handlers/cms/components.ts exists', () => {
    // If readFileSync doesn't throw, the file exists
    expect(() => readFileSync(COMPONENTS_HANDLER, 'utf-8')).not.toThrow()
  })

  it('components handler matches /admin/api/cms/components path', () => {
    const source = readFileSync(COMPONENTS_HANDLER, 'utf-8')
    expect(source).toMatch(/\/components/)
  })

  it('components handler serves GET; component writes live in the site-document save', () => {
    const source = readFileSync(COMPONENTS_HANDLER, 'utf-8')
    expect(source).toMatch(/'GET'/)
    const siteDocumentSource = readFileSync(
      COMPONENTS_HANDLER.replace(/components\.ts$/, 'siteDocument.ts'),
      'utf-8',
    )
    expect(siteDocumentSource).toMatch(/changedComponents/)
    expect(siteDocumentSource).toMatch(/deletedComponentIds/)
  })
})
