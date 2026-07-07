import { beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { makeSite } from '../fixtures'

function resetStore() {
  useEditorStore.setState({
    site: makeSite(),
    activePageId: 'page-1',
    selectedNodeId: null,
    selectedNodeIds: [],
    activeClassId: null,
    selectedSelectorClassId: null,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(resetStore)

describe('framework typography & spacing store actions', () => {
  it('createFrameworkTypographyGroup works after a prior mutation has frozen the store (no `framework` settings)', () => {
    // Regression: previously `createFrameworkTypographyGroup` called
    // `ensureFrameworkTypography(site)` on the Mutative-frozen live site,
    // throwing `TypeError: Cannot add property framework, object is not
    // extensible` when `site.settings.framework` was undefined.
    expect(useEditorStore.getState().site!.settings.framework).toBeUndefined()

    // Any prior mutation freezes the state via Mutative's `create`.
    useEditorStore.getState().updateSiteName('Renamed')

    expect(() => {
      useEditorStore.getState().createFrameworkTypographyGroup()
    }).not.toThrow()

    const groups = useEditorStore.getState().site!.settings.framework!.typography!.groups
    expect(groups).toHaveLength(1)
  })

  it('duplicateFrameworkTypographyGroup works after a prior mutation has frozen the store', () => {
    const created = useEditorStore.getState().createFrameworkTypographyGroup()
    // The previous action already produced frozen state; duplicate should
    // not blow up reading the live site.
    expect(() => {
      useEditorStore.getState().duplicateFrameworkTypographyGroup(created.id)
    }).not.toThrow()
    const groups = useEditorStore.getState().site!.settings.framework!.typography!.groups
    expect(groups).toHaveLength(2)
  })

  it('createFrameworkSpacingGroup works after a prior mutation has frozen the store (no `framework` settings)', () => {
    // Regression: same bug as above for the spacing scale.
    expect(useEditorStore.getState().site!.settings.framework).toBeUndefined()

    useEditorStore.getState().updateSiteName('Renamed')

    expect(() => {
      useEditorStore.getState().createFrameworkSpacingGroup()
    }).not.toThrow()

    const groups = useEditorStore.getState().site!.settings.framework!.spacing!.groups
    expect(groups).toHaveLength(1)
  })

  it('duplicateFrameworkSpacingGroup works after a prior mutation has frozen the store', () => {
    const created = useEditorStore.getState().createFrameworkSpacingGroup()
    expect(() => {
      useEditorStore.getState().duplicateFrameworkSpacingGroup(created.id)
    }).not.toThrow()
    const groups = useEditorStore.getState().site!.settings.framework!.spacing!.groups
    expect(groups).toHaveLength(2)
  })

  it('createFrameworkColorToken works after a prior mutation has frozen the store (no `framework` settings)', () => {
    // Regression: same bug pattern would have hit color creation when
    // `framework` settings were absent on a frozen site (the live tests
    // happened to hide it because color creation usually ran first).
    expect(useEditorStore.getState().site!.settings.framework).toBeUndefined()

    useEditorStore.getState().updateSiteName('Renamed')

    expect(() => {
      useEditorStore.getState().createFrameworkColorToken({
        slug: 'primary',
        lightValue: 'hsla(238, 100%, 62%, 1)',
        generateUtilities: {
          text: true,
          background: false,
          border: false,
          fill: false,
        },
      })
    }).not.toThrow()

    const tokens = useEditorStore.getState().site!.settings.framework!.colors.tokens
    expect(tokens).toHaveLength(1)
  })
})
