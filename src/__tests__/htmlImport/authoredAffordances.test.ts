/**
 * authoredAffordances.test.ts — HTML import must not quietly rewrite the
 * affordances an author wrote.
 *
 * Each case here is a defect found while authoring a full site through the MCP
 * surface: the import reported success, the markup came back subtly different,
 * and the behaviour that depended on it silently stopped working.
 */

import { describe, it, expect } from 'bun:test'
// Self-registers all base modules with the global registry singleton.
import '@modules/base'
import { registry } from '@core/module-engine'
import type { PageNode } from '@core/page-tree'
import { importHtml } from '@core/htmlImport'

/** Find the first imported node produced by `moduleId`. */
function firstNodeOf(html: string, moduleId: string): PageNode {
  const result = importHtml(html)
  const node = Object.values(result.nodes).find((candidate) => candidate.moduleId === moduleId)
  if (!node) {
    const seen = [...new Set(Object.values(result.nodes).map((n) => n.moduleId))].join(', ')
    throw new Error(`No ${moduleId} node imported. Got: ${seen}`)
  }
  return node
}

/** Render a node's module to public HTML, as the publisher would. */
function renderNode(node: PageNode, children: string[] = []): string {
  const module = registry.getOrThrow(node.moduleId)
  const defaults = (module.defaults ?? {}) as Record<string, unknown>
  return module.render({ ...defaults, ...node.props } as never, children).html
}

describe('select options', () => {
  it('keeps an explicitly empty option value instead of substituting the label', () => {
    // `<option value="">All crops</option>` is the conventional "no filter"
    // choice. Substituting the label makes it a real value, so a filter that
    // compares against '' silently matches nothing.
    const node = firstNodeOf('<select><option value="">All crops</option></select>', 'base.option')
    expect(node.props.value).toBe('')
    expect(node.props.label).toBe('All crops')
  })

  it('still falls back to the text when no value attribute is present', () => {
    const node = firstNodeOf('<select><option>Tomato</option></select>', 'base.option')
    expect(node.props.value).toBe('Tomato')
  })

  it('preserves a non-empty value verbatim', () => {
    const node = firstNodeOf('<select><option value="tomato">Tomato</option></select>', 'base.option')
    expect(node.props.value).toBe('tomato')
  })

  it('round-trips an empty value through render', () => {
    const node = firstNodeOf('<select><option value="">Any status</option></select>', 'base.option')
    expect(renderNode(node)).toContain('value=""')
  })
})

describe('reset buttons', () => {
  it('keeps type="reset" on a button element', () => {
    const node = firstNodeOf('<form><button type="reset">Reset</button></form>', 'base.button')
    expect(node.props.buttonType).toBe('reset')
    expect(renderNode(node)).toContain('type="reset"')
  })

  it('keeps type="reset" on an input element', () => {
    const node = firstNodeOf('<form><input type="reset" value="Reset"></form>', 'base.button')
    expect(node.props.buttonType).toBe('reset')
    expect(renderNode(node)).toContain('type="reset"')
  })

  it('leaves an ordinary button as type="button"', () => {
    const node = firstNodeOf('<button type="button">Open</button>', 'base.button')
    expect(node.props.buttonType).toBe('button')
    expect(renderNode(node)).toContain('type="button"')
  })

  it('does not turn a link-styled button into a reset control', () => {
    const node = firstNodeOf('<button>Standalone</button>', 'base.button')
    expect(renderNode(node)).toContain('type="button"')
  })
})

describe('form attributes', () => {
  it('preserves safe custom data attributes on a form', () => {
    // A progressive-enhancement script binds to this hook; dropping it makes
    // the script exit before initialising, with no error anywhere.
    const node = firstNodeOf(
      '<form data-recipe-filters data-analytics-id="filters"><input name="q"></form>',
      'base.form',
    )
    const attrs = node.props.htmlAttributes as Record<string, string>
    expect(attrs).toBeDefined()
    expect(attrs['data-recipe-filters']).toBe('')
    expect(attrs['data-analytics-id']).toBe('filters')
  })

  it('renders preserved attributes onto the published form', () => {
    const node = firstNodeOf('<form data-recipe-filters><input name="q"></form>', 'base.form')
    expect(renderNode(node)).toContain('data-recipe-filters')
  })

  it('does not duplicate the form wiring instatic generates itself', () => {
    const node = firstNodeOf(
      '<form action="/search" method="get" data-keep="yes"><input name="q"></form>',
      'base.form',
    )
    const attrs = (node.props.htmlAttributes ?? {}) as Record<string, string>
    expect(attrs['data-keep']).toBe('yes')
    expect(attrs.action).toBeUndefined()
    expect(attrs.method).toBeUndefined()

    const html = renderNode(node)
    expect(html.match(/\saction=/g) ?? []).toHaveLength(1)
    expect(html.match(/\smethod=/g) ?? []).toHaveLength(1)
  })

  it('preserves an aria hook on a form', () => {
    const node = firstNodeOf('<form aria-label="Filter recipes"><input name="q"></form>', 'base.form')
    const attrs = node.props.htmlAttributes as Record<string, string>
    expect(attrs['aria-label']).toBe('Filter recipes')
  })
})
