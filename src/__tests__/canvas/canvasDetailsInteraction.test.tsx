import { beforeEach, expect, it } from 'bun:test'
import React from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import { useEditorStore } from '@site/store/store'
import { CanvasRoot } from '@site/canvas/CanvasRoot'
import { waitForCanvasNodeInFrame } from './iframeCanvasQuery'
import '@modules/base'

beforeEach(cleanup)

it.each(['design', 'live'] as const)('opens details in %s without persisting open or losing layer selection', async (view) => {
  useEditorStore.setState({ canvasView: view })
  const site = useEditorStore.getState().createSite('Accordion')
  const page = site.pages[0]!
  const detailsId = useEditorStore.getState().insertNode('base.container', { tag: 'custom', customTag: 'details' }, page.rootNodeId)
  const summaryId = useEditorStore.getState().insertNode('base.container', { tag: 'custom', customTag: 'summary' }, detailsId)
  const labelId = useEditorStore.getState().insertNode('base.text', { text: 'Monday' }, summaryId)
  useEditorStore.getState().insertNode('base.text', { text: 'Schedule' }, detailsId)
  render(<DndContext><CanvasRoot /></DndContext>)
  const details = await waitForCanvasNodeInFrame<HTMLDetailsElement>('desktop', detailsId)
  const label = await waitForCanvasNodeInFrame('desktop', labelId)
  const before = JSON.stringify(useEditorStore.getState().site)
  await act(async () => { fireEvent.click(label) })
  expect(details.open).toBe(true)
  expect(useEditorStore.getState().selectedNodeId).toBe(labelId)
  expect(JSON.stringify(useEditorStore.getState().site)).toBe(before)
  await act(async () => { fireEvent.click(label) })
  expect(details.open).toBe(false)
  expect(JSON.stringify(useEditorStore.getState().site)).toBe(before)
})
