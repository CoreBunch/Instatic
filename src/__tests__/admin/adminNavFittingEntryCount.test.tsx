/**
 * `useFittingEntryCount` decides which admin navigation entries stay in the
 * toolbar row and which move into the trailing "More" menu.
 *
 * The test DOM has no layout engine, so the three box metrics the hook reads
 * (`clientWidth`, `offsetWidth`, `offsetLeft`) are derived here from `data-*`
 * attributes: entries sit left to right with no gap.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { useRef } from 'react'
import { render, screen } from '@testing-library/react'
import { useFittingEntryCount } from '@admin/shared/AdminSectionNavigation/useFittingEntryCount'

const MORE_WIDTH = 60
const METRICS = ['clientWidth', 'offsetWidth', 'offsetLeft'] as const
const originals = new Map<string, PropertyDescriptor | undefined>()

beforeAll(() => {
  for (const metric of METRICS) {
    originals.set(metric, Object.getOwnPropertyDescriptor(HTMLElement.prototype, metric))
  }
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) { return Number(this.dataset.available ?? 0) },
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) { return Number(this.dataset.width ?? 0) },
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetLeft', {
    configurable: true,
    get(this: HTMLElement) {
      let left = 0
      for (let node = this.previousElementSibling; node; node = node.previousElementSibling) {
        left += Number((node as HTMLElement).dataset.width ?? 0)
      }
      return left
    },
  })
})

afterAll(() => {
  for (const metric of METRICS) {
    const original = originals.get(metric)
    if (original) Object.defineProperty(HTMLElement.prototype, metric, original)
    else Reflect.deleteProperty(HTMLElement.prototype, metric)
  }
})

function Row({ widths, available }: { widths: number[]; available: number }) {
  const rowRef = useRef<HTMLElement>(null)
  const moreRef = useRef<HTMLButtonElement>(null)
  const fit = useFittingEntryCount(rowRef, moreRef, widths.length)
  return (
    <>
      <nav ref={rowRef} data-available={available}>
        {widths.map((width, index) => (
          <span key={index} data-admin-nav-entry="" data-width={width} />
        ))}
        <button ref={moreRef} type="button" data-width={MORE_WIDTH} />
      </nav>
      <output data-testid="fit">{`${fit.count} kept, more at ${fit.moreLeft}`}</output>
    </>
  )
}

function fitFor(widths: number[], available: number): string {
  const view = render(<Row widths={widths} available={available} />)
  const text = screen.getByTestId('fit').textContent ?? ''
  view.unmount()
  return text
}

describe('useFittingEntryCount', () => {
  it('keeps every entry when the row has room for all of them', () => {
    expect(fitFor([100, 100, 100], 300)).toBe('3 kept, more at 0')
  })

  it('keeps as many entries as fit beside the More trigger and puts it after them', () => {
    // 4 x 100 needs 400; 350 are available, 60 of which the trigger takes.
    expect(fitFor([100, 100, 100, 100], 350)).toBe('2 kept, more at 200')
  })

  it('keeps an entry that ends exactly where the More trigger begins', () => {
    expect(fitFor([100, 100, 100, 100], 360)).toBe('3 kept, more at 300')
  })

  it('moves every entry into More when not even the first fits', () => {
    expect(fitFor([100, 100], 120)).toBe('0 kept, more at 0')
  })
})
