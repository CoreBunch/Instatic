/**
 * Tabs primitive — Button-based ARIA tabs with automatic activation.
 *
 * Covers the contract the admin pages rely on:
 *   - triggers render as role="tab" Buttons (primary when active)
 *   - clicking a tab activates it; panels lazy-mount by default
 *   - keepMounted panels stay in the DOM (hidden) while inactive
 *   - arrow keys move focus AND activate (automatic activation),
 *     with roving tabindex on the triggers
 *   - testId lands on the underlying button
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Tab, TabList, TabPanel, Tabs } from '@ui/components/Tabs'

afterEach(cleanup)

type Section = 'one' | 'two' | 'three'

function Harness({ keepMountedTwo = false }: { keepMountedTwo?: boolean }) {
  const [value, setValue] = useState<Section>('one')
  return (
    <Tabs value={value} onChange={setValue}>
      <TabList ariaLabel="Test sections">
        <Tab value="one" testId="tab-one">One</Tab>
        <Tab value="two" testId="tab-two">Two</Tab>
        <Tab value="three" testId="tab-three">Three</Tab>
      </TabList>
      <TabPanel value="one"><p>Panel one</p></TabPanel>
      <TabPanel value="two" keepMounted={keepMountedTwo}><p>Panel two</p></TabPanel>
      <TabPanel value="three"><p>Panel three</p></TabPanel>
    </Tabs>
  )
}

describe('Tabs', () => {
  it('renders an ARIA tablist of Button triggers with roving tabindex', () => {
    render(<Harness />)

    const list = screen.getByRole('tablist', { name: 'Test sections' })
    expect(list).toBeDefined()

    const active = screen.getByRole('tab', { name: 'One' })
    const inactive = screen.getByRole('tab', { name: 'Two' })
    expect(active.getAttribute('aria-selected')).toBe('true')
    expect(active.getAttribute('tabindex')).toBe('0')
    expect(inactive.getAttribute('aria-selected')).toBe('false')
    expect(inactive.getAttribute('tabindex')).toBe('-1')
  })

  it('activates on click and lazy-mounts panels by default', () => {
    render(<Harness />)

    expect(screen.getByText('Panel one')).toBeDefined()
    // Inactive panel children are NOT mounted by default.
    expect(screen.queryByText('Panel two')).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: 'Two' }))

    expect(screen.getByRole('tab', { name: 'Two' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('Panel two')).toBeDefined()
    expect(screen.queryByText('Panel one')).toBeNull()
  })

  it('keeps keepMounted panels in the DOM (hidden) while inactive', () => {
    render(<Harness keepMountedTwo />)

    // Mounted even though "one" is active…
    const panelTwoText = screen.getByText('Panel two')
    // …but hidden via the panel wrapper.
    expect(panelTwoText.closest('[role="tabpanel"]')?.hasAttribute('hidden')).toBe(true)

    fireEvent.click(screen.getByRole('tab', { name: 'Two' }))
    expect(panelTwoText.closest('[role="tabpanel"]')?.hasAttribute('hidden')).toBe(false)
  })

  it('wires aria-controls / aria-labelledby between tab and panel', () => {
    render(<Harness />)

    const tab = screen.getByRole('tab', { name: 'One' })
    const panel = screen.getByText('Panel one').closest('[role="tabpanel"]')!
    expect(tab.getAttribute('aria-controls')).toBe(panel.getAttribute('id'))
    expect(panel.getAttribute('aria-labelledby')).toBe(tab.getAttribute('id'))
  })

  it('moves focus and activates with arrow keys (automatic activation)', () => {
    render(<Harness />)

    const list = screen.getByRole('tablist', { name: 'Test sections' })
    const one = screen.getByRole('tab', { name: 'One' })
    const two = screen.getByRole('tab', { name: 'Two' })
    const three = screen.getByRole('tab', { name: 'Three' })

    one.focus()
    fireEvent.keyDown(list, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(two)
    expect(two.getAttribute('aria-selected')).toBe('true')

    // Wraps from the last tab back to the first.
    fireEvent.keyDown(list, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(one)
    fireEvent.keyDown(list, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(three)
    expect(three.getAttribute('aria-selected')).toBe('true')

    fireEvent.keyDown(list, { key: 'Home' })
    expect(document.activeElement).toBe(one)
    expect(one.getAttribute('aria-selected')).toBe('true')
  })

  it('forwards testId to the underlying button', () => {
    render(<Harness />)
    expect(screen.getByTestId('tab-two')).toBe(screen.getByRole('tab', { name: 'Two' }))
  })
})
