/**
 * Apply authored presentation to a canvas iframe's real `<body>` element.
 *
 * Both the editable `base.body` module and template composition use this
 * helper so body classes and inline styles follow one lifecycle: apply only
 * the fields they own, then restore the exact previous values on cleanup.
 * Restoring individual declarations (instead of `cssText`) preserves the
 * iframe sizing/overflow reset maintained independently by the frame surface.
 */

import { CANVAS_BODY_RESET_PROPERTIES } from './iframeBodyReset'

export interface IframeBodyPresentation {
  className?: string
  style?: Record<string, string | number>
  /** Sanitized authored attributes that publish on the real `<body>`. */
  attributes?: Record<string, string>
}

interface PreviousInlineStyle {
  property: string
  value: string
  priority: string
}

interface PreviousAttribute {
  name: string
  value: string | null
}

// Canvas plumbing owns these fields regardless of authored body attributes.
// The shared HTML-attribute sanitizer already rejects most of them; keeping the
// list here is defence-in-depth for imperative callers and protects the exact
// attributes Agent readiness/selection depends on.
const EDITOR_OWNED_BODY_ATTRIBUTES = new Set([
  'class',
  'style',
  'tabindex',
  'data-breakpoint-id',
  'data-node-id',
  'data-module-id',
  'data-canvas-selected',
  'data-hovered',
])

export function applyIframeBodyPresentation(
  body: HTMLElement,
  presentation: IframeBodyPresentation,
): () => void {
  const previousClassName = presentation.className === undefined
    ? undefined
    : body.className

  if (presentation.className !== undefined) {
    body.className = presentation.className
  }

  const declarations = normaliseInlineStyles(presentation.style)
  if (body.dataset.instaticIframeInteraction === 'canvas') {
    for (const property of CANVAS_BODY_RESET_PROPERTIES) declarations.delete(property)
  }
  // Snapshot every touched declaration BEFORE applying any of them. A
  // shorthand such as `background` can mutate its longhands, so interleaving
  // snapshot/apply would record already-mutated values for a later
  // `backgroundColor` entry and restore the wrong cascade on cleanup.
  const previousStyles: PreviousInlineStyle[] = [...declarations.keys()].map(
    (property) => ({
      property,
      value: body.style.getPropertyValue(property),
      priority: body.style.getPropertyPriority(property),
    }),
  )
  for (const [property, value] of declarations) {
    body.style.setProperty(property, value)
  }

  const attributes = Object.entries(presentation.attributes ?? {})
    .filter(([name]) => !EDITOR_OWNED_BODY_ATTRIBUTES.has(name))
  const previousAttributes: PreviousAttribute[] = attributes.map(([name]) => ({
    name,
    value: body.getAttribute(name),
  }))
  for (const [name, value] of attributes) body.setAttribute(name, value)

  return () => {
    if (previousClassName !== undefined) body.className = previousClassName
    for (const previous of previousStyles) {
      if (previous.value) {
        body.style.setProperty(previous.property, previous.value, previous.priority)
      } else {
        body.style.removeProperty(previous.property)
      }
    }
    for (const previous of previousAttributes) {
      if (previous.value === null) body.removeAttribute(previous.name)
      else body.setAttribute(previous.name, previous.value)
    }
  }
}

function normaliseInlineStyles(
  style: Record<string, string | number> | undefined,
): Map<string, string> {
  const declarations = new Map<string, string>()
  for (const [property, value] of Object.entries(style ?? {})) {
    declarations.set(toCssPropertyName(property), String(value))
  }
  return declarations
}

function toCssPropertyName(property: string): string {
  if (property.startsWith('--')) return property
  const kebab = property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
  // `msTransition` is the one vendor-prefixed DOM style key whose JS spelling
  // starts lowercase but whose CSS spelling still needs the leading dash.
  return kebab.startsWith('ms-') ? `-${kebab}` : kebab
}
