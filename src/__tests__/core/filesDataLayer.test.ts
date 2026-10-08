/**
 * Files Data Layer tests
 *
 * Covers:
 *  1. pathValidation — isSafePath / normalizePath (positive + negative per rule)
 *  2. filesSlice CRUD — createFile / deleteFile / renameFile / updateFileContent / updateFileBlob
 *  3. filesSlice guards — invalid path throws, collision throws, rename collision throws
 *  4. validateSite — files field accepted shapes, dedup, drop on unsafe paths
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import { isSafePath, normalizePath } from '@core/files/pathValidation'
import { useEditorStore } from '@site/store/store'
import { validateSite, SiteValidationError } from '@core/persistence/validate'
import type { SiteDocument } from '@core/page-tree'

// ============================================================================
// 1. pathValidation
// ============================================================================

describe('normalizePath', () => {
  it('collapses single-dot segments', () => {
    expect(normalizePath('src/./foo.ts')).toBe('src/foo.ts')
  })

  it('collapses multiple dot segments', () => {
    expect(normalizePath('src/./bar/./baz.ts')).toBe('src/bar/baz.ts')
  })

  it('leaves normal paths unchanged', () => {
    expect(normalizePath('src/components/Button.tsx')).toBe('src/components/Button.tsx')
  })

  it('leaves root-level file unchanged', () => {
    expect(normalizePath('package.json')).toBe('package.json')
  })

  it('does NOT resolve .. segments (those are rejected by isSafePath)', () => {
    expect(normalizePath('src/../foo.ts')).toBe('src/../foo.ts')
  })
})

describe('isSafePath', () => {
  // ── Valid paths ──────────────────────────────────────────────────────────

  it('accepts a typical component path', () => {
    expect(isSafePath('src/components/Button.tsx')).toBe(true)
  })

  it('accepts a root-level config file', () => {
    expect(isSafePath('package.json')).toBe(true)
  })

  it('accepts a public asset path', () => {
    expect(isSafePath('public/logo.png')).toBe(true)
  })

  it('accepts a script path', () => {
    expect(isSafePath('src/hooks/useTheme.ts')).toBe(true)
  })

  it('accepts a style path', () => {
    expect(isSafePath('src/styles/globals.css')).toBe(true)
  })

  it('accepts a doc path', () => {
    expect(isSafePath('README.md')).toBe(true)
  })

  // ── Rule 1 — empty string ────────────────────────────────────────────────

  it('rejects empty string', () => {
    expect(isSafePath('')).toBe(false)
  })

  // ── Rule 2 — POSIX only ──────────────────────────────────────────────────

  it('rejects backslash path (Windows separator)', () => {
    expect(isSafePath('src\\components\\Button.tsx')).toBe(false)
  })

  // ── Rule 3 — no leading slash ────────────────────────────────────────────

  it('rejects leading forward slash (absolute path)', () => {
    expect(isSafePath('/src/foo.ts')).toBe(false)
  })

  // ── Rule 4 — no .. segments ──────────────────────────────────────────────

  it('rejects path starting with ..', () => {
    expect(isSafePath('../traversal.ts')).toBe(false)
  })

  it('rejects path with .. in the middle', () => {
    expect(isSafePath('src/../traversal.ts')).toBe(false)
  })

  it('rejects .. at the end', () => {
    expect(isSafePath('src/foo/..')).toBe(false)
  })

  // ── Rule 5 — reserved src/pages/ prefix ─────────────────────────────────

  it('rejects path starting with src/pages/', () => {
    expect(isSafePath('src/pages/Home.tsx')).toBe(false)
  })

  it('rejects the exact reserved prefix src/pages/ (with trailing slash after normalize)', () => {
    // normalizePath('src/pages/./') → 'src/pages/' — still reserved
    expect(isSafePath('src/pages/')).toBe(false)
  })

  it('accepts src/pagesSomething (not the reserved prefix)', () => {
    // "src/pagesConfig.ts" starts with "src/pages" but NOT "src/pages/"
    expect(isSafePath('src/pagesConfig.ts')).toBe(true)
  })

  // ── Dot-segments normalized before validation ────────────────────────────

  it('normalizing a dot-segment path passes validation', () => {
    const normalized = normalizePath('src/./components/Button.tsx')
    expect(isSafePath(normalized)).toBe(true)
  })

  it('normalizing a reserved-prefix path with dots still rejects', () => {
    const normalized = normalizePath('src/./pages/Home.tsx')
    expect(isSafePath(normalized)).toBe(false)
  })
})

// ============================================================================
// 2+3. filesSlice CRUD
// ============================================================================

function getStore() {
  return useEditorStore.getState()
}

function freshStore() {
  useEditorStore.setState({
    site: null,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    hasUnsavedChanges: false,
  })
  return getStore()
}

function setupSite() {
  const s = freshStore()
  s.createSite('Test')
  return useEditorStore.getState()
}

// ── createFile ───────────────────────────────────────────────────────────────

describe('filesSlice.createFile', () => {
  it('adds a file to site.files and returns its id', () => {
    const s = setupSite()
    const id = s.createFile('src/foo.ts', 'script')
    const files = useEditorStore.getState().site!.files
    expect(files).toHaveLength(1)
    expect(files[0].id).toBe(id)
    expect(files[0].path).toBe('src/foo.ts')
    expect(files[0].type).toBe('script')
  })

  it('normalizes dot-segments in the path', () => {
    setupSite()
    const id = getStore().createFile('src/./components/Button.tsx', 'component')
    const files = useEditorStore.getState().site!.files
    expect(files.find((f) => f.id === id)?.path).toBe('src/components/Button.tsx')
  })

  it('initializes text content to empty string for non-asset types', () => {
    setupSite()
    const id = getStore().createFile('src/foo.ts', 'script')
    expect(useEditorStore.getState().site!.files.find((f) => f.id === id)?.content).toBe('')
  })

  it('accepts custom initial content', () => {
    setupSite()
    const id = getStore().createFile('src/foo.ts', 'script', 'export const x = 1')
    expect(useEditorStore.getState().site!.files.find((f) => f.id === id)?.content).toBe('export const x = 1')
  })

  it('does not set content for asset type', () => {
    setupSite()
    const id = getStore().createFile('public/logo.png', 'asset')
    expect(useEditorStore.getState().site!.files.find((f) => f.id === id)?.content).toBeUndefined()
  })

  it('throws when no site is loaded', () => {
    freshStore()
    expect(() => getStore().createFile('src/foo.ts', 'script')).toThrow()
  })

  it('throws on invalid path (leading slash)', () => {
    setupSite()
    expect(() => getStore().createFile('/absolute.ts', 'script')).toThrow()
  })

  it('throws on path traversal (..)', () => {
    setupSite()
    expect(() => getStore().createFile('../evil.ts', 'script')).toThrow()
  })

  it('throws on reserved src/pages/ prefix', () => {
    setupSite()
    expect(() => getStore().createFile('src/pages/Home.tsx', 'component')).toThrow()
  })

  it('throws on empty path', () => {
    setupSite()
    expect(() => getStore().createFile('', 'script')).toThrow()
  })

  it('throws on collision (same path)', () => {
    setupSite()
    getStore().createFile('src/foo.ts', 'script')
    expect(() => getStore().createFile('src/foo.ts', 'script')).toThrow()
  })

  it('records createdAt and updatedAt timestamps', () => {
    const before = Date.now()
    setupSite()
    const id = getStore().createFile('src/foo.ts', 'script')
    const after = Date.now()
    const file = useEditorStore.getState().site!.files.find((f) => f.id === id)!
    expect(file.createdAt).toBeGreaterThanOrEqual(before)
    expect(file.createdAt).toBeLessThanOrEqual(after)
  })
})

// ── deleteFile ───────────────────────────────────────────────────────────────

describe('filesSlice.deleteFile', () => {
  it('removes the file by id', () => {
    setupSite()
    const id = getStore().createFile('src/foo.ts', 'script')
    getStore().deleteFile(id)
    expect(useEditorStore.getState().site!.files).toHaveLength(0)
  })

  it('is a no-op for an unknown id (does not throw)', () => {
    setupSite()
    expect(() => getStore().deleteFile('nonexistent-id')).not.toThrow()
  })

  it('leaves other files intact', () => {
    setupSite()
    const id1 = getStore().createFile('src/a.ts', 'script')
    const id2 = getStore().createFile('src/b.ts', 'script')
    getStore().deleteFile(id1)
    const files = useEditorStore.getState().site!.files
    expect(files).toHaveLength(1)
    expect(files[0].id).toBe(id2)
  })

  it('clears activeEditorFileId when deleting the open file', () => {
    setupSite()
    const id = getStore().createFile('src/open.ts', 'script')
    getStore().openInEditor(id)

    getStore().deleteFile(id)

    expect(useEditorStore.getState().activeEditorFileId).toBeNull()
  })

  it('keeps activeEditorFileId when deleting a different file', () => {
    setupSite()
    const openId = getStore().createFile('src/open.ts', 'script')
    const deleteId = getStore().createFile('src/delete.ts', 'script')
    getStore().openInEditor(openId)

    getStore().deleteFile(deleteId)

    expect(useEditorStore.getState().activeEditorFileId).toBe(openId)
  })
})

// ── renameFile ───────────────────────────────────────────────────────────────

describe('filesSlice.renameFile', () => {
  it('updates the file path', () => {
    setupSite()
    const id = getStore().createFile('src/old.ts', 'script')
    getStore().renameFile(id, 'src/new.ts')
    const file = useEditorStore.getState().site!.files.find((f) => f.id === id)!
    expect(file.path).toBe('src/new.ts')
  })

  it('normalizes dot-segments in the new path', () => {
    setupSite()
    const id = getStore().createFile('src/foo.ts', 'script')
    getStore().renameFile(id, 'src/./bar.ts')
    const file = useEditorStore.getState().site!.files.find((f) => f.id === id)!
    expect(file.path).toBe('src/bar.ts')
  })

  it('allows renaming to the same path (no-op, no throw)', () => {
    setupSite()
    const id = getStore().createFile('src/foo.ts', 'script')
    expect(() => getStore().renameFile(id, 'src/foo.ts')).not.toThrow()
    expect(useEditorStore.getState().site!.files.find((f) => f.id === id)?.path).toBe('src/foo.ts')
  })

  it('throws on collision with ANOTHER file', () => {
    setupSite()
    getStore().createFile('src/a.ts', 'script')
    const id2 = getStore().createFile('src/b.ts', 'script')
    expect(() => getStore().renameFile(id2, 'src/a.ts')).toThrow()
  })

  it('throws on invalid new path (.. traversal)', () => {
    setupSite()
    const id = getStore().createFile('src/foo.ts', 'script')
    expect(() => getStore().renameFile(id, '../evil.ts')).toThrow()
  })

  it('throws on invalid new path (reserved src/pages/ prefix)', () => {
    setupSite()
    const id = getStore().createFile('src/foo.ts', 'script')
    expect(() => getStore().renameFile(id, 'src/pages/Foo.tsx')).toThrow()
  })

  it('is a no-op for an unknown id (does not throw)', () => {
    setupSite()
    expect(() => getStore().renameFile('nonexistent-id', 'src/new.ts')).not.toThrow()
  })
})

// ── updateFileContent ─────────────────────────────────────────────────────────

describe('filesSlice.updateFileContent', () => {
  it('updates content', () => {
    setupSite()
    const id = getStore().createFile('src/foo.ts', 'script', '')
    getStore().updateFileContent(id, 'export const x = 42')
    expect(useEditorStore.getState().site!.files.find((f) => f.id === id)?.content).toBe('export const x = 42')
  })

  it('updates updatedAt on content change', () => {
    setupSite()
    const id = getStore().createFile('src/foo.ts', 'script', '')
    const before = Date.now()
    getStore().updateFileContent(id, 'new content')
    const updatedAt = useEditorStore.getState().site!.files.find((f) => f.id === id)!.updatedAt
    const after = Date.now()
    expect(updatedAt).toBeGreaterThanOrEqual(before)
    expect(updatedAt).toBeLessThanOrEqual(after)
  })

  it('is a no-op for unknown id', () => {
    setupSite()
    expect(() => getStore().updateFileContent('nonexistent', 'x')).not.toThrow()
  })

  it('ejects a generated file when content is edited', () => {
    setupSite()
    const id = getStore().createFile('package.json', 'config', '{}')
    useEditorStore.setState((state) => ({
      site: state.site
        ? {
            ...state.site,
            files: state.site.files.map((file) =>
              file.id === id ? { ...file, generated: true, ejected: false } : file,
            ),
          }
        : state.site,
    }))

    getStore().updateFileContent(id, '{ "name": "custom" }')

    const file = useEditorStore.getState().site!.files.find((f) => f.id === id)!
    expect(file.generated).toBe(true)
    expect(file.ejected).toBe(true)
  })
})

// ── updateFileBlob ────────────────────────────────────────────────────────────

describe('filesSlice.updateFileBlob', () => {
  it('rejects an invalid binary write atomically and keeps the previous payload', () => {
    setupSite()
    const id = getStore().createFile('public/logo.png', 'asset')
    const blob = { mimeType: 'image/png', base64: 'YWJj' }
    getStore().updateFileBlob(id, blob)
    expect(() => getStore().updateFileBlob(id, { mimeType: 'text/html', base64: 'YWJj' })).toThrow()
    expect(() => getStore().updateFileBlob(id, { mimeType: 'image/png', base64: 'bad==' })).toThrow()
    expect(useEditorStore.getState().site!.files.find((file) => file.id === id)?.blob).toEqual(blob)
    expect(() => getStore().renameFile(id, 'public/admin/logo.png')).toThrow()
    expect(useEditorStore.getState().site!.files.find((file) => file.id === id)?.path).toBe('public/logo.png')
  })
  it('stores blob on an asset file', () => {
    setupSite()
    const id = getStore().createFile('public/logo.png', 'asset')
    const blob = { mimeType: 'image/png', base64: 'YWJjMTIz' }
    getStore().updateFileBlob(id, blob)
    expect(useEditorStore.getState().site!.files.find((f) => f.id === id)?.blob).toEqual(blob)
  })

  it('is a no-op for unknown id', () => {
    setupSite()
    expect(() =>
      getStore().updateFileBlob('nonexistent', { mimeType: 'image/png', base64: '' }),
    ).not.toThrow()
  })

  it('ejects a generated asset when blob is edited', () => {
    setupSite()
    const id = getStore().createFile('public/logo.png', 'asset')
    useEditorStore.setState((state) => ({
      site: state.site
        ? {
            ...state.site,
            files: state.site.files.map((file) =>
              file.id === id ? { ...file, generated: true, ejected: false } : file,
            ),
          }
        : state.site,
    }))

    getStore().updateFileBlob(id, { mimeType: 'image/png', base64: 'YWJjMTIz' })

    const file = useEditorStore.getState().site!.files.find((f) => f.id === id)!
    expect(file.generated).toBe(true)
    expect(file.ejected).toBe(true)
  })
})

// ── round-trip ───────────────────────────────────────────────────────────────

describe('filesSlice — round-trip create → read → update → delete', () => {
  it('complete CRUD cycle', () => {
    setupSite()
    const s = getStore()

    // create
    const id = s.createFile('src/utils/helpers.ts', 'script', '// initial')
    expect(useEditorStore.getState().site!.files).toHaveLength(1)

    // read
    const file = useEditorStore.getState().site!.files.find((f) => f.id === id)!
    expect(file.path).toBe('src/utils/helpers.ts')
    expect(file.content).toBe('// initial')

    // update content
    getStore().updateFileContent(id, '// updated')
    expect(useEditorStore.getState().site!.files.find((f) => f.id === id)?.content).toBe('// updated')

    // rename
    getStore().renameFile(id, 'src/utils/helpers-v2.ts')
    expect(useEditorStore.getState().site!.files.find((f) => f.id === id)?.path).toBe('src/utils/helpers-v2.ts')

    // delete
    getStore().deleteFile(id)
    expect(useEditorStore.getState().site!.files).toHaveLength(0)
  })
})

// ============================================================================
// 6. validateSite — files field
// ============================================================================

function minimalValidRaw(): Record<string, unknown> {
  return {
    id: 'proj-1',
    name: 'Test SiteDocument',
    createdAt: 1000,
    updatedAt: 2000,
    breakpoints: [{ id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' }],
    settings: { colorTokens: {}, shortcuts: {} },
    styleRules: {},
    files: [],
    visualComponents: [],
    pages: [
      {
        id: 'page-1',
        title: 'Home',
        slug: 'index',
        rootNodeId: 'root',
        nodes: {
          root: {
            id: 'root',
            moduleId: 'base.body',
            props: {},
            children: [],
            breakpointOverrides: {},
            classIds: [],
          },
        },
      },
    ],
  }
}

describe('validateSite — files field', () => {
  it('accepts and returns a valid files array', () => {
    const raw = minimalValidRaw()
    raw.files = [
      {
        id: 'f1',
        path: 'src/foo.ts',
        type: 'script',
        content: 'export const x = 1',
        createdAt: 1000,
        updatedAt: 2000,
      },
    ]
    const site = validateSite(raw)
    expect(site.files).toHaveLength(1)
    expect(site.files[0].id).toBe('f1')
    expect(site.files[0].path).toBe('src/foo.ts')
    expect(site.files[0].content).toBe('export const x = 1')
  })

  it('normalizes dot-segments in file paths during validation', () => {
    const raw = minimalValidRaw()
    raw.files = [
      { id: 'f1', path: 'src/./foo.ts', type: 'script', content: '', createdAt: 1000, updatedAt: 2000 },
    ]
    const site = validateSite(raw)
    expect(site.files[0].path).toBe('src/foo.ts')
  })

  it('silently drops files with unsafe paths (does not reject the whole site)', () => {
    const raw = minimalValidRaw()
    raw.files = [
      { id: 'bad', path: '../evil.ts', type: 'script', content: '', createdAt: 1000, updatedAt: 2000 },
      { id: 'good', path: 'src/safe.ts', type: 'script', content: '', createdAt: 1000, updatedAt: 2000 },
    ]
    const site = validateSite(raw)
    expect(site.files).toHaveLength(1)
    expect(site.files[0].id).toBe('good')
  })

  it('silently drops files with invalid types', () => {
    const raw = minimalValidRaw()
    raw.files = [
      { id: 'bad', path: 'src/foo.ts', type: 'invalid-type', content: '', createdAt: 1000, updatedAt: 2000 },
      { id: 'good', path: 'src/bar.ts', type: 'component', content: '', createdAt: 1000, updatedAt: 2000 },
    ]
    const site = validateSite(raw)
    expect(site.files).toHaveLength(1)
    expect(site.files[0].id).toBe('good')
  })

  it('deduplicates files with the same path (keeps first occurrence)', () => {
    const raw = minimalValidRaw()
    raw.files = [
      { id: 'f1', path: 'src/foo.ts', type: 'script', content: 'first', createdAt: 1000, updatedAt: 2000 },
      { id: 'f2', path: 'src/foo.ts', type: 'script', content: 'second', createdAt: 1000, updatedAt: 2000 },
    ]
    const site = validateSite(raw)
    expect(site.files).toHaveLength(1)
    expect(site.files[0].id).toBe('f1')
  })

  it('does not mutate the input object destructively (existing fields preserved)', () => {
    const raw = minimalValidRaw()
    raw.files = []
    const site = validateSite(raw)
    // Existing shell fields must be intact after files processing
    expect(site.id).toBe('proj-1')
    expect(site.name).toBe('Test SiteDocument')
    expect(site.breakpoints).toHaveLength(1)
    expect(site.files).toEqual([])
  })

  it('validates blob field on asset files', () => {
    const raw = minimalValidRaw()
    raw.files = [
      {
        id: 'a1',
        path: 'public/img.png',
        type: 'asset',
        blob: { mimeType: 'image/png', base64: 'YWJj' },
        createdAt: 1000,
        updatedAt: 2000,
      },
    ]
    const site = validateSite(raw)
    expect(site.files[0].blob?.mimeType).toBe('image/png')
    expect(site.files[0].blob?.base64).toBe('YWJj')
  })

  it('rejects malformed blobs without silently discarding binary content', () => {
    const raw = minimalValidRaw()
    raw.files = [
      {
        id: 'a1',
        path: 'public/img.png',
        type: 'asset',
        blob: { mimeType: 123, base64: true }, // malformed
        createdAt: 1000,
        updatedAt: 2000,
      },
    ]
    expect(() => validateSite(raw)).toThrow(SiteValidationError)
  })

  it('does not throw a SiteValidationError for an empty files array', () => {
    const raw = minimalValidRaw()
    raw.files = []
    expect(() => validateSite(raw)).not.toThrow(SiteValidationError)
  })
})
