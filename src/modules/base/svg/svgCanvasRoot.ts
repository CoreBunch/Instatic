import type { CSSProperties } from 'react'
import { readCssDeclarationBag } from '@core/css-substitution'
import { bagToReactStyle } from '@core/publisher'

interface SvgCanvasRoot {
  attributes: Record<string, string>
  className?: string
  style?: CSSProperties
  innerHtml: string
}

const SVG_ATTRIBUTE_NAME_OVERRIDES: Record<string, string> = {
  class: 'className',
  tabindex: 'tabIndex',
  'xml:base': 'xmlBase',
  'xml:lang': 'xmlLang',
  'xml:space': 'xmlSpace',
  'xmlns:xlink': 'xmlnsXlink',
  'xlink:actuate': 'xlinkActuate',
  'xlink:arcrole': 'xlinkArcrole',
  'xlink:href': 'xlinkHref',
  'xlink:role': 'xlinkRole',
  'xlink:show': 'xlinkShow',
  'xlink:title': 'xlinkTitle',
  'xlink:type': 'xlinkType',
}

function reactSvgAttributeName(name: string): string {
  if (name.startsWith('aria-') || name.startsWith('data-')) return name
  const override = SVG_ATTRIBUTE_NAME_OVERRIDES[name]
  if (override) return override
  return name.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())
}

/**
 * Split already-sanitized SVG markup into the root element React must own and
 * the safe inner markup it may inject.
 *
 * The publisher injects node classes and inline styles onto the SVG root. The
 * editor must own that same root so percentage sizing, selector matching, and
 * selection geometry resolve against identical DOM. Root presentation
 * attributes are converted to React's SVG prop spelling; authored inline
 * styles pass through the publisher's CSS gate before being merged by the
 * editor component.
 */
export function parseSvgCanvasRoot(markup: string): SvgCanvasRoot | null {
  // Published SVG markup lives inside an HTML document, where common legacy
  // references such as `xlink:href` do not require an explicit xmlns:xlink
  // declaration. Parsing as strict XML rejects that valid inline-HTML shape
  // wholesale and makes the editor show "No SVG" while publish still works.
  // Use the same HTML parsing context as the public page, then retain the
  // module's one-SVG-root invariant explicitly.
  const doc = new DOMParser().parseFromString(markup, 'text/html')
  const root = doc.body.firstElementChild
  const hasSignificantRootText = Array.from(doc.body.childNodes).some(
    (node) => node.nodeType === 3 && Boolean(node.textContent?.trim()),
  )
  if (
    !root ||
    doc.body.children.length !== 1 ||
    hasSignificantRootText ||
    root.localName.toLowerCase() !== 'svg'
  ) {
    return null
  }

  const attributes: Record<string, string> = {}
  let className: string | undefined
  let style: CSSProperties | undefined

  for (const attribute of Array.from(root.attributes)) {
    if (attribute.name === 'class') {
      className = attribute.value.trim() || undefined
      continue
    }
    if (attribute.name === 'style') {
      // XML-parsed SVG elements do not expose a consistently populated
      // CSSStyleDeclaration across browser/test DOM implementations. Let an
      // HTML element parse the already-sanitized declaration text, then pass
      // the result through the publisher's property/value gate.
      const styleProbe = document.createElement('div')
      styleProbe.setAttribute('style', attribute.value)
      style = bagToReactStyle(
        readCssDeclarationBag(styleProbe.style),
      ) as CSSProperties | undefined
      continue
    }
    attributes[reactSvgAttributeName(attribute.name)] = attribute.value
  }

  return {
    attributes,
    className,
    style,
    innerHtml: root.innerHTML,
  }
}
