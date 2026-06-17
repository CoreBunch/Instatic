import { beforeEach, describe, expect, it } from 'bun:test'
import { getLayersCommands } from '@admin/spotlight/commands/layers'
import type { CommandRunContext } from '@admin/spotlight/types'
import { useEditorStore } from '@site/store/store'
import { makePage, makeSite, makeVC, makeVCNode, makeVCTree } from '../fixtures'

function freshStore(): void {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

function loadVisualComponentCanvas(): void {
  const page = makePage({ id: 'page-1', rootNodeId: 'page-root' })
  const vc = makeVC({
    id: 'vc-card',
    name: 'Card',
    tree: makeVCTree('vc-root', [
      makeVCNode({ id: 'vc-root', moduleId: 'base.body', children: ['vc-a', 'vc-b'] }),
      makeVCNode({ id: 'vc-a', moduleId: 'base.text', props: { text: 'A' } }),
      makeVCNode({ id: 'vc-b', moduleId: 'base.text', props: { text: 'B' } }),
    ]),
  })

  useEditorStore.getState().loadSite(makeSite({ pages: [page], visualComponents: [vc] }))
  useEditorStore.setState({
    activePageId: 'page-1',
    activeDocument: { kind: 'visualComponent', vcId: 'vc-card' },
  } as Parameters<typeof useEditorStore.setState>[0])
}

function command(id: string) {
  const found = getLayersCommands().find((candidate) => candidate.id === id)
  if (!found) throw new Error(`Command ${id} not found`)
  return found
}

async function runLayerCommand(commandId: string, selectedNodeIds: string[]): Promise<void> {
  useEditorStore.setState({
    selectedNodeId: selectedNodeIds[selectedNodeIds.length - 1] ?? null,
    selectedNodeIds,
  } as Parameters<typeof useEditorStore.setState>[0])

  const ctx: CommandRunContext = {
    workspace: 'site',
    pathname: '/admin/site',
    user: null as never,
    editor: {
      selectedNodeIds,
      activePageId: 'page-1',
      activeDocument: { kind: 'visualComponent', vcId: 'vc-card' },
      canUndo: false,
      canRedo: false,
      activeBreakpointId: 'desktop',
    },
    args: {},
    navigate: () => {},
    closeSpotlight: () => {},
    pushScope: () => {},
    popScope: () => {},
    runStepUp: async (action) => action(),
  }

  await command(commandId).run(ctx)
}

function vcChildren(): string[] {
  const vc = useEditorStore.getState().site!.visualComponents[0]
  return [...vc.tree.nodes['vc-root'].children]
}

beforeEach(() => {
  freshStore()
  loadVisualComponentCanvas()
})

describe('Spotlight layer commands', () => {
  it('moves selected Visual Component nodes within the active canvas tree', async () => {
    await runLayerCommand('layers.moveUp', ['vc-b'])
    expect(vcChildren()).toEqual(['vc-b', 'vc-a'])

    await runLayerCommand('layers.moveDown', ['vc-b'])
    expect(vcChildren()).toEqual(['vc-a', 'vc-b'])
  })

  it('navigates parent and child selection inside the active Visual Component tree', async () => {
    await runLayerCommand('layers.selectParent', ['vc-a'])
    expect(useEditorStore.getState().selectedNodeId).toBe('vc-root')

    await runLayerCommand('layers.selectFirstChild', ['vc-root'])
    expect(useEditorStore.getState().selectedNodeId).toBe('vc-a')
  })
})
