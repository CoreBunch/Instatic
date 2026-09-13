import { beforeEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import { useEditorStore } from '@site/store/store'
import { CanvasRoot } from '@site/canvas/CanvasRoot'
import { waitForCanvasNodeInFrame } from './iframeCanvasQuery'
import '@modules/base'

function renderCanvas() {
  return render(<DndContext><CanvasRoot /></DndContext>)
}

// No hand-written store partial here: the preload resets every app store
// before each test. This file used to seed one, and the field it forgot to
// mention (`canvasView`) is exactly what broke it. See
// `src/__tests__/fixtures/storeIsolation.ts`.
beforeEach(() => {
  cleanup()
})

describe('canvas form controls', () => {
  // Reproduces the leak that made the next test fail on CI and pass locally.
  // `it` bodies run in declaration order, so this guarantees the real test
  // always runs against a store a previous test has already dirtied. In live
  // view `CanvasRoot` renders one preview frame with form-control suppression
  // deliberately off, which is what the real test used to assert against.
  it('is isolated from a leaked live canvas view', () => {
    useEditorStore.setState({ canvasView: 'live' })
    expect(useEditorStore.getState().canvasView).toBe('live')
  })

  it('prevents native form-control activation while preserving canvas node selection', async () => {
    expect(useEditorStore.getState().canvasView).toBe('design')

    const site = useEditorStore.getState().createSite('Form Controls')
    const page = site.pages[0]!
    const formId = useEditorStore.getState().insertNode('base.form', {
      mode: 'cms',
      formId: 'contact',
      targetTableId: '',
    }, page.rootNodeId)
    const inputId = useEditorStore.getState().insertNode('base.input', {
      inputType: 'email',
      name: 'email',
      id: 'email',
      autocomplete: 'email',
    }, formId)
    const selectId = useEditorStore.getState().insertNode('base.select', {
      name: 'plan',
      id: 'plan',
    }, formId)
    const submitId = useEditorStore.getState().insertNode('base.submit', {
      label: 'Send',
      formId: '',
    }, formId)

    renderCanvas()

    const form = await waitForCanvasNodeInFrame<HTMLFormElement>('desktop', formId)
    const input = await waitForCanvasNodeInFrame<HTMLInputElement>('desktop', inputId)
    const select = await waitForCanvasNodeInFrame<HTMLSelectElement>('desktop', selectId)
    const submit = await waitForCanvasNodeInFrame<HTMLButtonElement>('desktop', submitId)
    let submitted = false
    form.addEventListener('submit', (event) => {
      submitted = true
      event.preventDefault()
    })

    let inputMouseDown = true
    await act(async () => {
      inputMouseDown = fireEvent.mouseDown(input)
    })
    expect(inputMouseDown).toBe(false)
    expect(useEditorStore.getState().selectedNodeId).toBe(inputId)

    let selectMouseDown = true
    await act(async () => {
      selectMouseDown = fireEvent.pointerDown(select)
    })
    expect(selectMouseDown).toBe(false)
    expect(useEditorStore.getState().selectedNodeId).toBe(selectId)

    await act(async () => {
      fireEvent.click(select!)
    })
    expect(useEditorStore.getState().selectedNodeId).toBe(selectId)

    await act(async () => {
      fireEvent.click(input!)
    })
    expect(useEditorStore.getState().selectedNodeId).toBe(inputId)

    let submitMouseDown = true
    await act(async () => {
      submitMouseDown = fireEvent.mouseDown(submit)
      fireEvent.click(submit)
    })
    expect(submitMouseDown).toBe(false)
    expect(submitted).toBe(false)
    expect(useEditorStore.getState().selectedNodeId).toBe(submitId)
  })
})
