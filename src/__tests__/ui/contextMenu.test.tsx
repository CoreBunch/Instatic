import { afterEach, describe, expect, it, mock } from 'bun:test'
import React, { useRef, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ContextMenu, ContextMenuItem } from '@ui/components/ContextMenu'

afterEach(cleanup)

function PointContextMenuHarness({
  onClose,
  onTargetClick,
  animateExit,
}: {
  onClose: () => void
  onTargetClick: () => void
  animateExit?: boolean
}) {
  const [open, setOpen] = useState(true)

  return (
    <>
      <button type="button" onClick={onTargetClick}>
        Different element
      </button>
      {open && (
        <ContextMenu
          x={24}
          y={32}
          ariaLabel="Node options"
          animateExit={animateExit}
          onClose={() => {
            onClose()
            setOpen(false)
          }}
        >
          <ContextMenuItem onClick={() => {}}>Rename</ContextMenuItem>
        </ContextMenu>
      )}
    </>
  )
}

describe('ContextMenu', () => {
  it('renders viewport-fixed point menus in document.body instead of the caller subtree', () => {
    const { getByTestId } = render(
      <div data-testid="host">
        <ContextMenu
          x={24}
          y={32}
          ariaLabel="Portaled options"
          onClose={() => {}}
        >
          <ContextMenuItem onClick={() => {}}>Rename</ContextMenuItem>
        </ContextMenu>
      </div>,
    )

    const host = getByTestId('host')
    const menu = screen.getByRole('menu', { name: /portaled options/i })
    expect(host.contains(menu)).toBe(false)
    expect(document.body.contains(menu)).toBe(true)
  })

  it('lets the first outside click close a point menu and activate the clicked target', () => {
    const onClose = mock(() => {})
    const onTargetClick = mock(() => {})

    render(
      <PointContextMenuHarness
        onClose={onClose}
        onTargetClick={onTargetClick}
      />,
    )

    expect(screen.getByRole('menu', { name: /node options/i })).toBeDefined()

    const target = screen.getByRole('button', { name: /different element/i })
    fireEvent.mouseDown(target)
    fireEvent.click(target)

    // Default (no animateExit): close is synchronous.
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onTargetClick).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu', { name: /node options/i })).toBeNull()
  })

  it('defers close behind an exit animation when animateExit is set', async () => {
    const onClose = mock(() => {})
    const onTargetClick = mock(() => {})

    render(
      <PointContextMenuHarness
        onClose={onClose}
        onTargetClick={onTargetClick}
        animateExit
      />,
    )

    const target = screen.getByRole('button', { name: /different element/i })
    fireEvent.mouseDown(target)
    fireEvent.click(target)

    // The underlying target still activates immediately — the dismiss
    // listener doesn't cancel the event.
    expect(onTargetClick).toHaveBeenCalledTimes(1)

    // The menu plays its exit animation first; the caller's `onClose`
    // (the real unmount) is deferred until the animation window elapses.
    const menu = screen.getByRole('menu', { name: /node options/i })
    expect(menu.getAttribute('data-closing')).toBe('')
    expect(onClose).toHaveBeenCalledTimes(0)

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1)
    })
    expect(screen.queryByRole('menu', { name: /node options/i })).toBeNull()
  })

  it('re-flips an anchored menu when its content grows after the first measure', () => {
    // Regression: an anchored dropdown (e.g. ModelPicker) measures itself once
    // on open, but its content can grow afterwards as data lazy-loads. A menu
    // whose trigger sits near the viewport bottom auto-flips to `top` and pins
    // its top edge for the short height; once the content fills in, it must
    // recompute or it grows downward off-screen. A ResizeObserver on the menu
    // drives that recompute — here we stub the observer + rects to assert it.

    const realRO = globalThis.ResizeObserver
    const realRect = HTMLElement.prototype.getBoundingClientRect
    const realInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')
    const realInnerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')

    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true })
    Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true })

    // The menu mounts short, then grows once its (mock) content loads.
    let menuHeight = 40
    const rect = (r: Partial<DOMRect>): DOMRect => ({
      top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0,
      toJSON: () => ({}), ...r,
    }) as DOMRect

    HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.getAttribute('role') === 'menu') {
        return rect({ top: 0, left: 100, right: 320, width: 220, height: menuHeight })
      }
      if ((this as HTMLElement).dataset.anchor === 'true') {
        // Trigger pinned to the bottom of the 800px-tall viewport.
        return rect({ top: 760, bottom: 780, left: 100, right: 200, width: 100, height: 20 })
      }
      return realRect.call(this)
    }

    const observerCallbacks: ResizeObserverCallback[] = []
    class MockResizeObserver {
      constructor(cb: ResizeObserverCallback) {
        observerCallbacks.push(cb)
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver

    function AnchoredHarness() {
      const ref = useRef<HTMLButtonElement>(null)
      return (
        <>
          <button ref={ref} data-anchor="true" type="button">
            Trigger
          </button>
          <ContextMenu
            anchorRef={ref}
            triggerRef={ref}
            ariaLabel="Models"
            minWidth={220}
            maxHeight={320}
            onClose={() => {}}
          >
            <ContextMenuItem onClick={() => {}}>Item</ContextMenuItem>
          </ContextMenu>
        </>
      )
    }

    try {
      render(<AnchoredHarness />)
      const menu = screen.getByRole('menu', { name: /models/i })

      // First measure: short menu flips above the trigger, top edge at
      //   760 - 40 - 6(offset) = 714.
      expect(menu.style.getPropertyValue('--context-menu-y')).toBe('714px')

      // Content loads → menu grows. The ResizeObserver fires → recompute with
      // the capped height (min(500, 320)=320): 760 - 320 - 6 = 434, so the menu
      // now sits fully on-screen instead of overflowing the bottom.
      menuHeight = 500
      act(() => {
        for (const cb of observerCallbacks) cb([], {} as ResizeObserver)
      })
      expect(menu.style.getPropertyValue('--context-menu-y')).toBe('434px')
    } finally {
      globalThis.ResizeObserver = realRO
      HTMLElement.prototype.getBoundingClientRect = realRect
      if (realInnerHeight) Object.defineProperty(window, 'innerHeight', realInnerHeight)
      if (realInnerWidth) Object.defineProperty(window, 'innerWidth', realInnerWidth)
    }
  })

  it('caps a match-anchor dropdown to its explicit max width', () => {
    const realRect = HTMLElement.prototype.getBoundingClientRect
    const realInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')
    const realInnerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')

    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true })
    Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true })

    const rect = (r: Partial<DOMRect>): DOMRect => ({
      top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0,
      toJSON: () => ({}), ...r,
    }) as DOMRect

    HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.getAttribute('role') === 'menu') {
        return rect({ top: 0, left: 100, right: 620, width: 520, height: 40 })
      }
      if ((this as HTMLElement).dataset.anchor === 'true') {
        return rect({ top: 100, bottom: 120, left: 100, right: 1300, width: 1200, height: 20 })
      }
      return realRect.call(this)
    }

    function AnchoredHarness() {
      const ref = useRef<HTMLButtonElement>(null)
      return (
        <>
          <button ref={ref} data-anchor="true" type="button">
            Trigger
          </button>
          <ContextMenu
            anchorRef={ref}
            triggerRef={ref}
            ariaLabel="Wide dropdown"
            matchAnchorWidth
            minWidth={240}
            maxWidth={520}
            onClose={() => {}}
          >
            <ContextMenuItem onClick={() => {}}>Very long selector row</ContextMenuItem>
          </ContextMenu>
        </>
      )
    }

    try {
      render(<AnchoredHarness />)
      const menu = screen.getByRole('menu', { name: /wide dropdown/i })

      expect(menu.style.getPropertyValue('--context-menu-width')).toBe('520px')
      expect(menu.style.getPropertyValue('--context-menu-max-width')).toBe('520px')
      expect(menu.style.getPropertyValue('--context-menu-x')).toBe('100px')
    } finally {
      HTMLElement.prototype.getBoundingClientRect = realRect
      if (realInnerHeight) Object.defineProperty(window, 'innerHeight', realInnerHeight)
      if (realInnerWidth) Object.defineProperty(window, 'innerWidth', realInnerWidth)
    }
  })

  it('dismisses on a click inside a same-origin iframe document', async () => {
    function IframeDismissHarness({ onClose }: { onClose: () => void }) {
      const [doc, setDoc] = useState<Document | null>(null)
      const [open, setOpen] = useState(true)
      return (
        <>
          <iframe
            title="canvas"
            srcDoc="<body></body>"
            ref={(el) => setDoc(el?.contentDocument ?? null)}
          />
          {open && (
            <ContextMenu
              x={24}
              y={32}
              ariaLabel="Node options"
              animateExit
              onClose={() => {
                onClose()
                setOpen(false)
              }}
            />
          )}
          {/* Render a click target into the iframe document so a mousedown
              fires on the iframe's document, not the parent's. */}
          {doc?.body &&
            (() => {
              if (!doc.getElementById('inside')) {
                const btn = doc.createElement('button')
                btn.id = 'inside'
                btn.textContent = 'inside'
                doc.body.appendChild(btn)
              }
              return null
            })()}
        </>
      )
    }

    const onClose = mock(() => {})
    const { container } = render(<IframeDismissHarness onClose={onClose} />)

    const iframe = container.querySelector('iframe') as HTMLIFrameElement
    await waitFor(() => {
      expect(iframe.contentDocument?.getElementById('inside')).toBeTruthy()
    })

    const insideButton = iframe.contentDocument!.getElementById('inside')!
    fireEvent.mouseDown(insideButton)

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })
})
