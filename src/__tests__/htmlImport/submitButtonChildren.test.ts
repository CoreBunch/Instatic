/**
 * Icon-only submit buttons keep their icon through import and publish.
 *
 * base.submit was a leaf whose only content was the `label` string, with a
 * 'Submit' fallback when the button had no text. Real markup often puts an
 * icon there instead of text: a newsletter form's arrow as an inline `<svg>`,
 * a search box's magnifier as an icon-font `<i>`, an `<img>` of a button
 * graphic. Every one of them imported and published as the literal word
 * "Submit". The importer now recurses into submit buttons with element
 * children, and base.submit renders children when it has them, `label` when
 * it doesn't: the base.link contract.
 */
import { describe, it, expect } from 'bun:test'
import '@modules/base'
import { importHtml } from '@core/htmlImport'
import { SubmitModule } from '@modules/base/forms'

/** Import `html` and return the base.submit node plus its resolved children. */
function submitNodeOf(html: string) {
  const result = importHtml(`<html><body>${html}</body></html>`)
  const node = Object.values(result.nodes).find((n) => n.moduleId === 'base.submit')
  if (!node) throw new Error('no base.submit node was produced')
  return { node, kids: node.children.map((id) => result.nodes[id]!) }
}

describe('submit buttons with element children recurse', () => {
  it('keeps an inline <svg> arrow as a base.svg child', () => {
    const { node, kids } = submitNodeOf(
      '<form><button type="submit" style="width:45px">' +
        '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="12" viewBox="0 0 13 12">' +
        '<path d="M7.21 11.7L12.21 6.7"/></svg></button></form>',
    )
    expect(kids.length).toBe(1)
    expect(kids[0]!.moduleId).toBe('base.svg')
    expect(String(kids[0]!.props.svg)).toContain('<svg')
    // Label keeps the childless fallback; render ignores it while children exist.
    expect(node.props.label).toBe('Submit')
  })

  it('keeps an icon-font <i> child with its classes', () => {
    const { kids } = submitNodeOf(
      '<form><button type="submit"><i class="fa fa-search"></i></button></form>',
    )
    expect(kids.length).toBe(1)
    expect(kids[0]!.props.customTag).toBe('i')
    expect(kids[0]!.classIds).toContain('fa')
    expect(kids[0]!.classIds).toContain('fa-search')
  })

  it('keeps an <img> child', () => {
    const { kids } = submitNodeOf(
      '<form><button type="submit"><img src="https://example.com/btn-img.svg" alt="Submit"></button></form>',
    )
    expect(kids.length).toBe(1)
    expect(kids[0]!.moduleId).toBe('base.image')
    expect(kids[0]!.props.src).toBe('https://example.com/btn-img.svg')
  })

  it('keeps the text beside an icon as a base.text child and in the label', () => {
    const { node, kids } = submitNodeOf(
      '<form><button type="submit">Send <i class="icon-arrow"></i></button></form>',
    )
    expect(kids.length).toBe(2)
    expect(kids[0]!.moduleId).toBe('base.text')
    expect(String(kids[0]!.props.text)).toContain('Send')
    expect(kids[1]!.props.customTag).toBe('i')
    expect(node.props.label).toBe('Send')
  })

  it('a text-only submit stays a leaf with its label', () => {
    const { node, kids } = submitNodeOf('<form><button type="submit">Send</button></form>')
    expect(kids.length).toBe(0)
    expect(node.props.label).toBe('Send')
  })

  it('a typeless button inside a form is treated as a submit and recurses', () => {
    const { kids } = submitNodeOf(
      '<form><button><i class="icon-magnifier"></i></button></form>',
    )
    expect(kids.length).toBe(1)
    expect(kids[0]!.props.customTag).toBe('i')
  })
})

describe('base.submit render: children win, label is the fallback', () => {
  const props = { ...SubmitModule.defaults, label: 'Submit', disabled: false, formId: '' }

  it('renders children when present and omits the label', () => {
    const html = SubmitModule.render!(props, ['<svg viewBox="0 0 13 12"></svg>']).html
    expect(html).toContain('<svg viewBox="0 0 13 12"></svg>')
    expect(html).not.toContain('>Submit<')
    expect(html).toContain('type="submit"')
  })

  it('renders the label when there are no children', () => {
    const html = SubmitModule.render!(props, []).html
    expect(html).toContain('>Submit</button>')
  })
})
