import { afterEach, expect, it } from 'bun:test'
import { Suspense, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { FloatingPanel } from '@ui/components/FloatingPanel'

afterEach(cleanup)

function PanelHarness() {
  const trigger = useRef<HTMLButtonElement>(null)
  const chip = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [editingColor, setEditingColor] = useState(false)
  return <>
    <button ref={trigger} onClick={() => setOpen(true)}>Edit border</button>
    {open && <Suspense fallback={null}>
      <FloatingPanel title="Border" anchorRef={trigger} closeLabel="Close border" width={288} onClose={() => setOpen(false)}>
        <button ref={chip} onClick={() => setEditingColor(true)}>Edit color</button>
        {createPortal(<div role="listbox" aria-label="Border styles" />, document.body)}
        {editingColor && <FloatingPanel title="Color" anchorRef={chip} closeLabel="Close color" width={286}
          onClose={() => setEditingColor(false)}>
          <input aria-label="Color value" />
        </FloatingPanel>}
      </FloatingPanel>
    </Suspense>}
  </>
}

it('keeps child portals open and dismisses on a separate menu regardless of DOM order', async () => {
  render(<PanelHarness />)
  fireEvent.click(screen.getByRole('button', { name: 'Edit border' }))
  const dialog = await screen.findByRole('dialog', { name: 'Border' })
  fireEvent.pointerDown(screen.getByRole('listbox', { name: 'Border styles' }))
  expect(dialog.isConnected).toBe(true)

  const otherMenu = render(<div role="menu" aria-label="Other menu" />)
  fireEvent.pointerDown(otherMenu.getByRole('menu', { name: 'Other menu' }))
  expect(dialog.isConnected).toBe(false)
})

it('restores focus to the nested trigger on Back and the original trigger on Escape', async () => {
  render(<PanelHarness />)
  const trigger = screen.getByRole('button', { name: 'Edit border' })
  fireEvent.click(trigger)
  const colorTrigger = await screen.findByRole('button', { name: 'Edit color' })
  fireEvent.click(colorTrigger)
  const colorDialog = await screen.findByRole('dialog', { name: 'Color' })
  expect(document.activeElement).toBe(colorDialog)
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  expect(document.activeElement).toBe(colorTrigger)
  fireEvent.keyDown(colorTrigger, { key: 'Escape' })
  expect(document.activeElement).toBe(trigger)
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('moves only for the captured pointer and stops on lost capture', async () => {
  render(<PanelHarness />)
  fireEvent.click(screen.getByRole('button', { name: 'Edit border' }))
  const dialog = await screen.findByRole('dialog', { name: 'Border' })
  const title = screen.getByText('Border', { selector: 'span' })
  const header = title.parentElement!
  header.setPointerCapture = () => {}
  const readLeft = () => dialog.style.getPropertyValue('--floating-panel-x')
  const start = readLeft()
  const pointer = { pointerId: 1, button: 0, isPrimary: true, clientX: 100, clientY: 100 }
  fireEvent.pointerDown(title, pointer)
  fireEvent.pointerMove(header, { ...pointer, pointerId: 2, clientX: 200 })
  expect(readLeft()).toBe(start)
  fireEvent.pointerMove(header, { ...pointer, clientX: 200 })
  expect(readLeft()).not.toBe(start)
  fireEvent.lostPointerCapture(header, pointer)
  const released = readLeft()
  fireEvent.pointerMove(header, { ...pointer, clientX: 300 })
  expect(readLeft()).toBe(released)
})
