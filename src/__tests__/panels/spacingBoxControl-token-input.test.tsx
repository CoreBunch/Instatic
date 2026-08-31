/**
 * SpacingBoxControl — shared TokenAwareInput behaviour
 *
 * The per-side spacing inputs used to hand-roll their own copy of the
 * token-autocomplete control (suggestion filtering, commit-on-Enter,
 * hover preview, the Suggested/All dropdown). That logic now lives in the
 * single deep `TokenAwareInput` primitive, and SpacingBoxControl renders it
 * with `fieldSize="xs"`, `overlay`, and `tooltipOnOverflow`.
 *
 * These tests pin that contract from both ends:
 *   1. TokenAwareInput, given the spacing control's exact prop combo,
 *      filters suggestions, commits the resolved token on Enter, and fires
 *      a preview when a token row is hovered.
 *   2. SpacingBoxControl's per-side field exhibits the SAME behaviour,
 *      proving it is genuinely backed by the shared component.
 *
 * Two further contracts of the same prop combo live here:
 *   - `tooltipOnOverflow`: hovering a truncated field shows the FULL stored
 *     value, with the overflow re-measured at hover time (geometry changes —
 *     hidden mounts, `field-sizing: content` — without the text changing).
 *   - px-implicit display: `200px` renders as `200`; a bare typed number
 *     commits as px; every other unit / keyword / token / expression is
 *     untouched.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { useState } from 'react'
import { act, render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import { TokenAwareInput } from '@site/property-controls/TokenAwareInput'
import type { Token } from '@site/property-controls/tokenUtils'
import { SpacingBoxControl } from '@site/panels/PropertiesPanel/SpacingBoxControl/SpacingBoxControl'
import { sideDisplayChars } from '@site/panels/PropertiesPanel/SpacingBoxControl/sideScrub'
import { useEditorStore } from '@site/store/store'
import { makeSite } from '../fixtures'

const TOKENS: ReadonlyArray<Token> = [
  { step: 'sm', varName: '--space-sm', valueExpr: 'var(--space-sm)', groupName: 'Spacing', prefix: 'space' },
  { step: 'md', varName: '--space-md', valueExpr: 'var(--space-md)', groupName: 'Spacing', prefix: 'space' },
  { step: 'lg', varName: '--space-lg', valueExpr: 'var(--space-lg)', groupName: 'Spacing', prefix: 'space' },
]

beforeEach(() => {
  localStorage.clear()
})
afterEach(cleanup)

// ---------------------------------------------------------------------------
// 1. Shared TokenAwareInput, driven with the spacing control's prop combo
// ---------------------------------------------------------------------------

describe('TokenAwareInput (spacing prop combo: xs + overlay + tooltipOnOverflow)', () => {
  it('filters suggestions by the typed prefix', () => {
    render(
      <TokenAwareInput
        value=""
        tokens={TOKENS}
        fieldSize="xs"
        overlay
        tooltipOnOverflow
        aria-label="margin top"
        menuAriaLabel="margin top spacing tokens"
        onCommit={() => {}}
        onPreview={() => {}}
        onClearPreview={() => {}}
      />,
    )

    const input = screen.getByLabelText('margin top')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'md' } })

    const menu = screen.getByRole('menu', { name: 'margin top spacing tokens' })
    // "Suggested" section is populated by the prefix filter.
    expect(within(menu).getByText('Suggested')).toBeTruthy()
    expect(within(menu).getByText('--space-md')).toBeTruthy()
  })

  it('commits the resolved token expression on Enter', () => {
    let committed: string | undefined | symbol = Symbol('uncalled')
    render(
      <TokenAwareInput
        value=""
        tokens={TOKENS}
        fieldSize="xs"
        overlay
        tooltipOnOverflow
        aria-label="margin top"
        onCommit={(resolved) => {
          committed = resolved
        }}
        onPreview={() => {}}
        onClearPreview={() => {}}
      />,
    )

    const input = screen.getByLabelText('margin top')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'md' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)

    expect(committed).toBe('var(--space-md)')
  })

  it('previews a token value when its row is hovered', () => {
    const previews: Array<string | undefined> = []
    render(
      <TokenAwareInput
        value=""
        tokens={TOKENS}
        fieldSize="xs"
        overlay
        tooltipOnOverflow
        aria-label="margin top"
        menuAriaLabel="margin top spacing tokens"
        onCommit={() => {}}
        onPreview={(resolved) => previews.push(resolved)}
        onClearPreview={() => {}}
      />,
    )

    const input = screen.getByLabelText('margin top')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'md' } })

    const menu = screen.getByRole('menu', { name: 'margin top spacing tokens' })
    const row = within(menu).getByText('--space-md').closest('[role="menuitem"]')
    expect(row).toBeTruthy()
    fireEvent.mouseEnter(row as Element)

    expect(previews).toContain('var(--space-md)')
  })
})

// ---------------------------------------------------------------------------
// 2. Overflow tooltip — full stored value on hover, measured at hover time
// ---------------------------------------------------------------------------

describe('TokenAwareInput overflow tooltip (tooltipOnOverflow)', () => {
  // happy-dom computes no layout: scrollWidth/clientWidth read 0. Stub them
  // at the PROTOTYPE level — arming/disarming the tooltip remounts the DOM
  // input (Tooltip wraps/unwraps its child), so an instance-level stub would
  // vanish with the node.
  let fieldOverflows = false
  beforeAll(() => {
    Object.defineProperty(HTMLInputElement.prototype, 'scrollWidth', {
      configurable: true,
      get: () => (fieldOverflows ? 60 : 0),
    })
    Object.defineProperty(HTMLInputElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => (fieldOverflows ? 30 : 0),
    })
  })
  afterAll(() => {
    Reflect.deleteProperty(HTMLInputElement.prototype, 'scrollWidth')
    Reflect.deleteProperty(HTMLInputElement.prototype, 'clientWidth')
  })
  beforeEach(() => {
    fieldOverflows = false
  })

  const renderField = (value: string) =>
    render(
      <TokenAwareInput
        value={value}
        tokens={TOKENS}
        fieldSize="xs"
        overlay
        tooltipOnOverflow
        aria-label="margin top"
        onCommit={() => {}}
      />,
    )

  it('hovering a truncated field shows the full stored value', () => {
    fieldOverflows = true
    renderField('220em')

    fireEvent.mouseEnter(screen.getByLabelText('margin top'))

    expect(screen.getByRole('tooltip').textContent).toContain('220em')
  })

  it('re-measures on hover: overflow appearing after mount still arms the tooltip', () => {
    // Mounts "not overflowing" — e.g. inside a hidden panel surface (0×0).
    renderField('220px')
    const stale = screen.getByLabelText('margin top')

    // Panel became visible / field-sizing capped the field: geometry changed
    // without the text changing. The hover measure arms the tooltip (which
    // remounts the input); the browser then refires the boundary event on
    // the node now under the pointer.
    fieldOverflows = true
    fireEvent.mouseEnter(stale)
    fireEvent.mouseEnter(screen.getByLabelText('margin top'))

    // The field shows the bare number; the tooltip the full stored value.
    expect((screen.getByLabelText('margin top') as HTMLInputElement).value).toBe('220')
    expect(screen.getByRole('tooltip').textContent).toContain('220px')
  })

  it('keeps focus on the input when focusing disarms the tooltip', () => {
    fieldOverflows = true
    renderField('220em')

    fireEvent.focus(screen.getByLabelText('margin top'))

    // Editing disables the Tooltip, which remounts the input — focus must
    // land on the remounted node, not die with the old one.
    expect(document.activeElement).toBe(screen.getByLabelText('margin top'))
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 3. px-implicit display — px is the hidden default unit
// ---------------------------------------------------------------------------

describe('TokenAwareInput px-implicit display', () => {
  const renderValue = (value: string | undefined) =>
    render(
      <TokenAwareInput
        value={value}
        tokens={TOKENS}
        fieldSize="xs"
        overlay
        tooltipOnOverflow
        aria-label="margin top"
        onCommit={() => {}}
      />,
    )

  it('renders px values as bare numbers', () => {
    renderValue('200px')
    expect((screen.getByLabelText('margin top') as HTMLInputElement).value).toBe('200')
  })

  it('keeps other units, keywords, tokens, and expressions as-is', () => {
    const cases: Array<[string, string]> = [
      ['4000em', '4000em'],
      ['50%', '50%'],
      ['auto', 'auto'],
      ['clamp(1rem, 2vw, 3rem)', 'clamp(1rem, 2vw, 3rem)'],
      ['var(--space-md)', 'md'],
      ['-70px', '-70'],
      ['0.5px', '0.5'],
    ]
    for (const [storedValue, shown] of cases) {
      const view = renderValue(storedValue)
      expect((screen.getByLabelText('margin top') as HTMLInputElement).value).toBe(shown)
      view.unmount()
    }
  })

  it('commits a bare typed number as px and an explicit unit as typed', () => {
    const commits: Array<string | undefined> = []
    render(
      <TokenAwareInput
        value=""
        tokens={TOKENS}
        fieldSize="xs"
        overlay
        tooltipOnOverflow
        aria-label="margin top"
        onCommit={(resolved) => commits.push(resolved)}
      />,
    )
    const input = screen.getByLabelText('margin top')

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '200' } })
    fireEvent.blur(input)

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '3rem' } })
    fireEvent.blur(input)

    expect(commits).toEqual(['200px', '3rem'])
  })
})

// ---------------------------------------------------------------------------
// 4. SpacingBoxControl per-side field is backed by the shared component
// ---------------------------------------------------------------------------

function seedSpacingTokens() {
  useEditorStore.setState({
    site: makeSite({
      settings: {
        shortcuts: {},
        framework: {
          spacing: {
            groups: [
              {
                id: 'group-space',
                name: 'Spacing',
                namingConvention: 'space',
                min: { size: 16, scaleRatio: 1.25 },
                max: { size: 28, scaleRatio: 1.414 },
                steps: 'sm,md,lg',
                baseScaleIndex: 1,
                mode: 'fluid',
                order: 0,
                createdAt: 0,
                updatedAt: 0,
              },
            ],
          },
        },
      },
    }),
  } as Parameters<typeof useEditorStore.setState>[0])
}

describe('SpacingBoxControl per-side input', () => {
  it('resolves a typed token step without opening a dropdown beside the field', () => {
    seedSpacingTokens()

    const changes: Array<[string, string | number | undefined]> = []
    const previews: Array<Record<string, unknown>> = []

    render(
      <SpacingBoxControl
        storedStyles={{}}
        currentStyles={{}}
        onChange={(property, value) => changes.push([property, value])}
        onRemove={() => {}}
        onPreview={(patch) => previews.push(patch)}
        onClearPreview={() => {}}
      />,
    )

    const input = screen.getByLabelText('padding top')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'md' } })

    // The scale lives in the value-editor popout's token grid now, so the
    // side field must NOT also float a suggestion list over the canvas.
    expect(screen.queryByRole('menu', { name: 'padding top spacing tokens' })).toBeNull()

    // Everything else the shared component gives the field still works:
    // as-you-type preview…
    expect(previews.some((p) => p.paddingTop === 'var(--space-md)')).toBe(true)

    // …and commit-on-Enter resolving the step to its variable.
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)
    expect(changes).toContainEqual(['paddingTop', 'var(--space-md)'])
  })

  it('commits an empty-state side edit only to the focused side', () => {
    seedSpacingTokens()

    const changes: Array<[string, string | number | undefined]> = []

    render(
      <SpacingBoxControl
        storedStyles={{}}
        currentStyles={{}}
        onChange={(property, value) => changes.push([property, value])}
        onRemove={() => {}}
      />,
    )

    const input = screen.getByLabelText('margin top')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '12px' } })
    fireEvent.blur(input)

    expect(changes).toEqual([['marginTop', '12px']])
  })

  it('allows uniform spacing to be unlinked without clearing values first', () => {
    seedSpacingTokens()

    render(
      <SpacingBoxControl
        storedStyles={{
          marginTop: '12px',
          marginRight: '12px',
          marginBottom: '12px',
          marginLeft: '12px',
        }}
        currentStyles={{}}
        onChange={() => {}}
        onRemove={() => {}}
      />,
    )

    const unlink = screen.getByRole('button', { name: 'Unlink Margin sides' })
    fireEvent.click(unlink)

    const relink = screen.getByRole('button', { name: 'Link all Margin sides' })
    expect(relink.getAttribute('aria-pressed')).toBe('false')
  })

  it('syncs the focused side across all sides when linking split spacing', () => {
    seedSpacingTokens()

    const changes: Array<[string, string | number | undefined]> = []

    render(
      <SpacingBoxControl
        storedStyles={{ marginTop: '12px' }}
        currentStyles={{}}
        onChange={(property, value) => changes.push([property, value])}
        onRemove={() => {}}
      />,
    )

    fireEvent.focus(screen.getByLabelText('margin top'))
    fireEvent.click(screen.getByRole('button', { name: 'Link all Margin sides' }))

    expect(changes).toEqual([
      ['marginTop', '12px'],
      ['marginRight', '12px'],
      ['marginBottom', '12px'],
      ['marginLeft', '12px'],
    ])
  })

  it('mirrors linked side drafts across every side while typing', () => {
    seedSpacingTokens()

    render(
      <SpacingBoxControl
        storedStyles={{
          marginTop: '8px',
          marginRight: '8px',
          marginBottom: '8px',
          marginLeft: '8px',
        }}
        currentStyles={{}}
        onChange={() => {}}
        onRemove={() => {}}
      />,
    )

    const input = screen.getByLabelText('margin top')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '12px' } })

    // The edited field shows the literal draft; the mirrored siblings render
    // the draft through the value channel, where px-implicit display strips
    // the default unit.
    expect((screen.getByLabelText('margin top') as HTMLInputElement).value).toBe('12px')
    expect((screen.getByLabelText('margin right') as HTMLInputElement).value).toBe('12')
    expect((screen.getByLabelText('margin bottom') as HTMLInputElement).value).toBe('12')
    expect((screen.getByLabelText('margin left') as HTMLInputElement).value).toBe('12')
  })
})

// ---------------------------------------------------------------------------
// 3. Value editor popout ↔ side input
// ---------------------------------------------------------------------------

/** Stores what the control writes, so the side inputs see the new value back. */
function ControlledSpacingBox({ initial }: { initial: Record<string, unknown> }) {
  const [styleBag, setStyleBag] = useState(initial)
  return (
    <SpacingBoxControl
      storedStyles={styleBag}
      currentStyles={styleBag}
      onChange={(property, value) => setStyleBag((bag) => ({ ...bag, [property]: value }))}
      onRemove={(property) =>
        setStyleBag((bag) => {
          const next = { ...bag }
          delete next[property as string]
          return next
        })
      }
    />
  )
}

describe('SpacingBoxControl — value editor popout writes back into the side input', () => {
  it('updates the focused side input when a preset chip commits', () => {
    seedSpacingTokens()
    render(<ControlledSpacingBox initial={{ marginTop: '18px' }} />)

    const input = screen.getByLabelText('margin top') as HTMLInputElement
    expect(input.value).toBe('18')

    // Focusing opens the popout beside the field — the field keeps focus.
    fireEvent.focus(input)
    fireEvent.click(screen.getByRole('button', { name: '32' }))

    // A focused-but-untouched field must follow the store, or its stale draft
    // gets committed back over the popout's value on the next blur.
    expect((screen.getByLabelText('margin top') as HTMLInputElement).value).toBe('32')
  })

  it('tracks the slider live, before the drag is released', () => {
    seedSpacingTokens()
    render(<ControlledSpacingBox initial={{ marginTop: '18px' }} />)

    const input = screen.getByLabelText('margin top') as HTMLInputElement
    fireEvent.focus(input)

    const slider = screen.getByLabelText('Margin top slider')
    fireEvent.pointerDown(slider, { pointerId: 1 })
    fireEvent.change(slider, { target: { value: '64' } })

    // Still mid-drag: nothing is committed yet, but the field already reads
    // what the canvas is previewing.
    expect((screen.getByLabelText('margin top') as HTMLInputElement).value).toBe('64')

    fireEvent.pointerUp(slider, { pointerId: 1 })
    expect((screen.getByLabelText('margin top') as HTMLInputElement).value).toBe('64')
  })

  it('offers the spacing scale as token chips that commit var(--space-*)', () => {
    seedSpacingTokens()
    render(<ControlledSpacingBox initial={{ marginTop: '18px' }} />)

    fireEvent.focus(screen.getByLabelText('margin top'))
    fireEvent.click(screen.getByRole('button', { name: 'md' }))

    expect((screen.getByLabelText('margin top') as HTMLInputElement).value).toBe('md')
  })

  it('lets a margin slider go negative but keeps padding at zero', () => {
    seedSpacingTokens()
    render(<ControlledSpacingBox initial={{ marginTop: '18px', paddingTop: '4px' }} />)

    fireEvent.focus(screen.getByLabelText('margin top'))
    expect((screen.getByLabelText('Margin top slider') as HTMLInputElement).min).toBe('-512')

    fireEvent.focus(screen.getByLabelText('padding top'))
    expect((screen.getByLabelText('Padding top slider') as HTMLInputElement).min).toBe('0')
  })

  it('keeps the typed draft while the user is mid-keystroke', () => {
    seedSpacingTokens()
    render(<ControlledSpacingBox initial={{ paddingTop: '4px' }} />)

    const input = screen.getByLabelText('padding top') as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '12px' } })

    // Typing wins over the external value: no caret-stealing rewrite to `12`.
    expect((screen.getByLabelText('padding top') as HTMLInputElement).value).toBe('12px')
  })
})

// ---------------------------------------------------------------------------
// 4. Band scrub — dragging a segment scrubs its side's value
// ---------------------------------------------------------------------------

function sideLabel(ariaLabel: string): HTMLElement {
  const input = screen.getByLabelText(ariaLabel) as HTMLInputElement
  const label = document.querySelector(`label[for="${input.id}"]`)
  if (!(label instanceof HTMLElement)) throw new Error(`no label for ${ariaLabel}`)
  return label
}

function press(label: HTMLElement, x: number, y: number) {
  fireEvent.pointerDown(label, { button: 0, pointerId: 1, clientX: x, clientY: y })
}

function moveTo(x: number, y: number) {
  // The scrub listens on window, outside React's event system — wrap in act
  // so the preview's state updates (field drafts) flush before assertions.
  act(() => {
    window.dispatchEvent(
      new MouseEvent('pointermove', { clientX: x, clientY: y, cancelable: true }),
    )
  })
}

describe('SpacingBoxControl — band scrub', () => {
  it('previews while dragging and commits once on release', () => {
    seedSpacingTokens()
    const changes: Array<[string, string | number | undefined]> = []
    const previews: Array<Record<string, unknown>> = []
    render(
      <SpacingBoxControl
        storedStyles={{ marginRight: '10px' }}
        currentStyles={{}}
        onChange={(property, value) => changes.push([property, value])}
        onRemove={() => {}}
        onPreview={(patch) => previews.push(patch)}
        onClearPreview={() => {}}
      />,
    )

    press(sideLabel('margin right'), 100, 100)
    moveTo(130, 100) // +30px to the right = +30 on the right side

    expect(changes).toEqual([]) // still a preview
    expect(previews.some((p) => p.marginRight === '40px')).toBe(true)
    // The side field mirrors the scrub draft live.
    expect((screen.getByLabelText('margin right') as HTMLInputElement).value).toBe('40')

    window.dispatchEvent(new MouseEvent('pointerup'))
    expect(changes).toEqual([['marginRight', '40px']])
  })

  it('a press without movement is a click, not a scrub', () => {
    seedSpacingTokens()
    const changes: Array<[string, string | number | undefined]> = []
    render(
      <SpacingBoxControl
        storedStyles={{ marginTop: '10px' }}
        currentStyles={{}}
        onChange={(property, value) => changes.push([property, value])}
        onRemove={() => {}}
      />,
    )

    press(sideLabel('margin top'), 100, 100)
    moveTo(101, 100) // below the threshold
    window.dispatchEvent(new MouseEvent('pointerup'))

    expect(changes).toEqual([])
  })

  it('scrubs the top side away-from-centre (drag up = grow) and Escape cancels', () => {
    seedSpacingTokens()
    const changes: Array<[string, string | number | undefined]> = []
    const previews: Array<Record<string, unknown>> = []
    render(
      <SpacingBoxControl
        storedStyles={{ marginTop: '10px' }}
        currentStyles={{}}
        onChange={(property, value) => changes.push([property, value])}
        onRemove={() => {}}
        onPreview={(patch) => previews.push(patch)}
        onClearPreview={() => {}}
      />,
    )

    press(sideLabel('margin top'), 100, 100)
    moveTo(100, 80) // 20px up
    expect(previews.some((p) => p.marginTop === '30px')).toBe(true)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    window.dispatchEvent(new MouseEvent('pointerup'))
    expect(changes).toEqual([])
  })

  it('floors padding at zero but lets margin go negative', () => {
    seedSpacingTokens()
    const changes: Array<[string, string | number | undefined]> = []
    const previews: Array<Record<string, unknown>> = []
    render(
      <SpacingBoxControl
        storedStyles={{ paddingLeft: '5px', marginLeft: '5px' }}
        currentStyles={{}}
        onChange={(property, value) => changes.push([property, value])}
        onRemove={() => {}}
        onPreview={(patch) => previews.push(patch)}
        onClearPreview={() => {}}
      />,
    )

    // Left side grows leftward; dragging right shrinks. 40px right of a 5px
    // padding clamps at 0; the same drag takes the margin to -35.
    press(sideLabel('padding left'), 100, 100)
    moveTo(140, 100)
    window.dispatchEvent(new MouseEvent('pointerup'))
    expect(changes).toContainEqual(['paddingLeft', '0px'])

    press(sideLabel('margin left'), 100, 100)
    moveTo(140, 100)
    window.dispatchEvent(new MouseEvent('pointerup'))
    expect(changes).toContainEqual(['marginLeft', '-35px'])
  })
})

describe('SpacingBoxControl — band width follows its widest side value', () => {
  it('counts the characters a side will actually render', () => {
    // px is implicit in the display, tokens render as their short step.
    expect(sideDisplayChars('1093px', TOKENS)).toBe(4)
    expect(sideDisplayChars('var(--space-md)', TOKENS)).toBe(2)
    expect(sideDisplayChars('auto', TOKENS)).toBe(4)
    expect(sideDisplayChars('50%', TOKENS)).toBe(3)
  })

  it('sets --side-chars on each box from the widest left/right value', () => {
    seedSpacingTokens()
    const { container } = render(
      <SpacingBoxControl
        storedStyles={{ marginLeft: '1093px', marginRight: '5px', paddingLeft: '4px' }}
        currentStyles={{}}
        onChange={() => {}}
        onRemove={() => {}}
      />,
    )

    const values = Array.from(container.querySelectorAll<HTMLElement>('[style]'))
      .map((el) => el.getAttribute('style') ?? '')
      .filter((style) => style.includes('--side-chars'))
    // Margin box: "1093" → 4; padding box: "4" vs unset right ("0") → 1.
    expect(values.some((style) => style.includes('--side-chars: 4'))).toBe(true)
    expect(values.some((style) => style.includes('--side-chars: 1'))).toBe(true)
  })
})
