import { describe, expect, it } from 'bun:test'
import { installCanvasDetailsPreview, revealSelectedDetails } from '@site/canvas/useCanvasDetailsPreview'

function fixture() {
  const doc = document.implementation.createHTMLDocument('Accordion preview')
  doc.body.innerHTML = `<details data-node-id="day"><summary data-node-id="summary"><span data-node-id="label">Monday</span><a href="#">Link</a></summary><p data-node-id="body">Schedule</p><details data-node-id="nested"><summary>More</summary><p data-node-id="nested-body">More content</p></details></details>`
  // Mirror the canvas selection handler that cancels authored native activation.
  doc.addEventListener('click', (event) => event.preventDefault(), true)
  const details = doc.querySelector('details')!
  const label = doc.querySelector('span')!
  return { doc, details, label }
}

describe('editor-only details preview', () => {
  it('toggles from a summary child while preserving selection propagation', () => {
    const { doc, details, label } = fixture()
    const dispose = installCanvasDetailsPreview(doc)
    let selected = 0
    label.addEventListener('click', (event) => { event.preventDefault(); selected++ })
    label.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(details.open).toBe(true)
    label.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(details.open).toBe(false)
    expect(selected).toBe(2)
    dispose()
  })

  it('supports Enter and Space without toggling for repeated keydown or other keys', () => {
    const { doc, details, label } = fixture()
    const dispose = installCanvasDetailsPreview(doc)
    for (const [key, repeat, expected] of [['Enter', false, true], ['Enter', true, true], ['ArrowDown', false, true], [' ', false, false]] as const) {
      label.dispatchEvent(new KeyboardEvent('keydown', { key, repeat, bubbles: true, cancelable: true }))
      expect(details.open).toBe(expected)
    }
    dispose()
  })

  it('leaves links, body clicks and readonly composed content alone', () => {
    const { doc, details } = fixture()
    const dispose = installCanvasDetailsPreview(doc)
    for (const target of [doc.querySelector('a')!, doc.querySelector('p')!]) {
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      expect(details.open).toBe(false)
    }
    doc.body.setAttribute('data-instatic-readonly-id', 'template')
    doc.querySelector('span')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(details.open).toBe(false)
    dispose()
  })

  it('reveals nested content selected in Layers without reopening a selected summary', () => {
    const { doc, details } = fixture()
    revealSelectedDetails(doc, 'label')
    expect(details.open).toBe(false)
    revealSelectedDetails(doc, 'nested-body')
    expect(details.open).toBe(true)
    expect(doc.querySelectorAll('details')[1]!.open).toBe(true)
  })

  it('removes handlers on cleanup and keeps independent frames independent', () => {
    const first = fixture()
    const second = fixture()
    const dispose = installCanvasDetailsPreview(first.doc)
    first.label.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(first.details.open).toBe(true)
    expect(second.details.open).toBe(false)
    dispose()
    first.label.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(first.details.open).toBe(true)
  })
})
