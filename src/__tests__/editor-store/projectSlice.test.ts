import { beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '../../core/editor-store/store'

beforeEach(() => {
  useEditorStore.setState({
    project: null,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    selectedNodeId: null,
    hoveredNodeId: null,
    hasUnsavedChanges: false,
  })
})

describe('projectSlice lifecycle', () => {
  it('can create a project with a route-owned id', () => {
    const project = useEditorStore.getState().createProject('Route Project', 'route-project-id')

    expect(project.id).toBe('route-project-id')
    expect(useEditorStore.getState().project?.id).toBe('route-project-id')
  })
})
