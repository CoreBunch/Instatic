import { beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { DEFAULT_SCRIPT_RUNTIME_CONFIG, normalizeSiteRuntimeConfig } from '@core/site-runtime'
import { makeSite } from '../fixtures'

function resetStore() {
  useEditorStore.setState({
    site: null,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
  })
}

describe('site runtime store actions', () => {
  beforeEach(() => {
    resetStore()
  })

  it('initializes runtime config when creating a site', () => {
    const site = useEditorStore.getState().createSite('Runtime Site')

    expect(site.runtime).toEqual(normalizeSiteRuntimeConfig(undefined))
    expect(useEditorStore.getState().siteRuntime).toEqual(site.runtime)
  })

  it('loads runtime config into the top-level store mirror', () => {
    const runtime = normalizeSiteRuntimeConfig({
      scripts: {
        'script-1': {
          ...DEFAULT_SCRIPT_RUNTIME_CONFIG,
          placement: 'head',
          timing: 'idle',
          priority: 5,
        },
      },
    })
    useEditorStore.getState().loadSite(makeSite({ runtime }))

    expect(useEditorStore.getState().siteRuntime.scripts['script-1']).toEqual({
      ...DEFAULT_SCRIPT_RUNTIME_CONFIG,
      placement: 'head',
      timing: 'idle',
      priority: 5,
    })
    expect(useEditorStore.getState().site?.runtime).toEqual(useEditorStore.getState().siteRuntime)
  })

  it('patches script runtime settings and participates in undo', () => {
    const store = useEditorStore.getState()
    store.createSite('Runtime Site')
    const fileId = useEditorStore.getState().createFile('src/scripts/confetti.ts', 'script')
    useEditorStore.setState({
      _historyPast: [],
      _historyFuture: [],
      canUndo: false,
      canRedo: false,
    })

    useEditorStore.getState().patchScriptRuntimeConfig(fileId, {
      runInCanvas: false,
      placement: 'head',
      priority: 25,
    })

    const afterPatch = useEditorStore.getState()
    expect(afterPatch.canUndo).toBe(true)
    expect(afterPatch.siteRuntime.scripts[fileId]).toEqual({
      ...DEFAULT_SCRIPT_RUNTIME_CONFIG,
      runInCanvas: false,
      placement: 'head',
      priority: 25,
    })
    expect(afterPatch.site?.runtime?.scripts[fileId]).toEqual(afterPatch.siteRuntime.scripts[fileId])

    afterPatch.undo()

    const afterUndo = useEditorStore.getState()
    expect(afterUndo.siteRuntime.scripts[fileId]).toBeUndefined()
    expect(afterUndo.site?.runtime?.scripts[fileId]).toBeUndefined()
  })

  it('ignores runtime settings for missing files and non-script files', () => {
    useEditorStore.getState().createSite('Runtime Site')
    const styleId = useEditorStore.getState().createFile('src/styles/site.css', 'style')
    useEditorStore.getState().patchScriptRuntimeConfig('missing-file', { placement: 'head' })
    useEditorStore.getState().patchScriptRuntimeConfig(styleId, { placement: 'head' })

    expect(useEditorStore.getState().siteRuntime.scripts).toEqual({})
  })

  it('removes script runtime settings when a script file is deleted', () => {
    useEditorStore.getState().createSite('Runtime Site')
    const fileId = useEditorStore.getState().createFile('src/scripts/confetti.ts', 'script')
    useEditorStore.getState().patchScriptRuntimeConfig(fileId, { placement: 'head' })

    useEditorStore.getState().deleteFile(fileId)

    expect(useEditorStore.getState().siteRuntime.scripts[fileId]).toBeUndefined()
    expect(useEditorStore.getState().site?.runtime?.scripts[fileId]).toBeUndefined()
  })

  it('makes dependency manifest edits undoable', () => {
    useEditorStore.getState().createSite('Runtime Site')
    useEditorStore.setState({
      _historyPast: [],
      _historyFuture: [],
      canUndo: false,
      canRedo: false,
    })

    useEditorStore.getState().setDependency('canvas-confetti', '^1.9.3')

    expect(useEditorStore.getState().canUndo).toBe(true)
    expect(useEditorStore.getState().packageJson.dependencies['canvas-confetti']).toBe('^1.9.3')
    expect(useEditorStore.getState().site?.packageJson?.dependencies['canvas-confetti']).toBe('^1.9.3')

    useEditorStore.getState().undo()

    expect(useEditorStore.getState().packageJson.dependencies['canvas-confetti']).toBeUndefined()
    expect(useEditorStore.getState().site?.packageJson?.dependencies['canvas-confetti']).toBeUndefined()
  })
})
