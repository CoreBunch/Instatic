/**
 * HTML → module mapping rules for the HTML importer.
 *
 * Rules are tested in order; the first match wins. The catch-all `*` rule
 * is always last and guarantees every element produces a node — nothing
 * falls through.
 *
 * Verified prop names against module source:
 *   base.text    — `text` (string), `tag` (TextTag)
 *   base.link    — `text` (string), `href`, `target`   (NOT `label`)
 *   base.button  — `label` (string), `href`, `target`, `disabled`
 *   base.image   — `src` only (alt comes from media library, not a prop)
 *   base.container — `tag` (builtin name | 'custom'), `customTag` (free text)
 *   base.form + form controls — semantic form primitives.
 *
 * BUILTIN_HTML_TAGS in base.container: div, section, article, main, header,
 * footer, nav, aside, ul, ol. Tags outside that set MUST use tag:'custom' +
 * customTag so resolveHtmlTag emits the real element name.
 */

import { normalizeImportedText } from './text'
import { normalizeIdentifierValue } from '@core/utils/identifier'

export interface ImportRule {
  /** CSS selector tested via `el.matches()`. */
  match: string
  /** Returns the moduleId and props for this element. */
  map: (el: Element) => { moduleId: string; props: Record<string, unknown> }
  /**
   * When truthy the walker recurses into the element's children and sets
   * `node.children` to their IDs. Leaf modules (text, image, button) omit
   * this flag so they remain childless.
   *
   * A predicate form lets a rule decide per element — used by the anchor rule
   * so a text-only `<a>` stays a leaf (text prop) while an `<a>` wrapping an
   * icon/`<svg>` recurses to preserve that nested content.
   */
  recurse?: boolean | ((el: Element) => boolean)
}

/** True when the element has at least one element (non-text) child. */
function hasElementChild(el: Element): boolean {
  return el.children.length > 0
}

const TEXT_INPUT_TYPES = [
  'text',
  'email',
  'password',
  'search',
  'tel',
  'url',
  'number',
  'date',
  'time',
  'datetime-local',
  'file',
  'hidden',
] as const

function attr(el: Element, name: string): string {
  return el.getAttribute(name) ?? ''
}

function normalizedAttr(el: Element, name: string): string {
  return attr(el, name).trim().toLowerCase()
}

function numberAttr(el: Element, name: string, fallback: number = 0): number {
  const raw = attr(el, name).trim()
  if (!raw) return fallback
  const value = Number(raw)
  return Number.isFinite(value) ? value : fallback
}

function formControlFieldId(el: Element): string {
  return attr(el, 'data-instatic-field-id') || attr(el, 'name') || attr(el, 'id')
}

function formIdentifier(el: Element): string {
  return normalizeIdentifierValue(
    attr(el, 'data-instatic-form-id') || attr(el, 'id') || attr(el, 'name'),
    'form',
  )
}

function optionalFormIdentifier(el: Element): string {
  return normalizeIdentifierValue(attr(el, 'form'))
}

function integerAttr(el: Element, name: string, fallback: number, min: number): number {
  return Math.max(min, Math.floor(numberAttr(el, name, fallback)))
}

function normalizeInputType(el: Element): typeof TEXT_INPUT_TYPES[number] {
  const type = normalizedAttr(el, 'type') || 'text'
  return TEXT_INPUT_TYPES.includes(type as typeof TEXT_INPUT_TYPES[number])
    ? type as typeof TEXT_INPUT_TYPES[number]
    : 'text'
}

function normalizeFormMethod(el: Element): 'get' | 'post' | 'dialog' {
  const method = normalizedAttr(el, 'method') || 'get'
  return method === 'post' || method === 'dialog' ? method : 'get'
}

function submitLabel(el: Element): string {
  const label = attr(el, 'value') || normalizeImportedText(el.textContent ?? '')
  return label || 'Submit'
}

function mapLoopProps(el: Element): Record<string, unknown> {
  const tableId = attr(el, 'data-table-id')
  const customTag = attr(el, 'data-custom-tag')
  const tag = attr(el, 'data-tag')
  return {
    sourceId: attr(el, 'data-source-id'),
    filters: tableId ? { tableId } : {},
    orderBy: attr(el, 'data-order-by'),
    direction: normalizedAttr(el, 'data-direction') === 'asc' ? 'asc' : 'desc',
    limit: integerAttr(el, 'data-limit', 10, 1),
    offset: integerAttr(el, 'data-offset', 0, 0),
    pagination: normalizedAttr(el, 'data-pagination') === 'infinite' ? 'infinite' : 'none',
    pageSize: integerAttr(el, 'data-page-size', 10, 1),
    ...(customTag ? { tag: 'custom', customTag } : tag ? { tag } : {}),
  }
}

export const HTML_TO_MODULE_RULES: ImportRule[] = [
  // CMS content outlet → base.outlet (LEAF). The agent (and any hand-authored
  // template HTML) writes `<instatic-outlet>` to mark where matched content —
  // a page tree or the current entry body — flows in. base.outlet is childless,
  // so we never recurse; any inner markup is ignored (the composer fills it).
  {
    match: 'instatic-outlet',
    map: () => ({ moduleId: 'base.outlet', props: {} }),
  },

  // CMS loop → base.loop (RECURSE). The agent writes this custom element when
  // it needs a real Loop module while staying in the HTML-native insert path.
  // Children become loop variants; each iteration resolves `{currentEntry.*}`
  // tokens against the selected source item.
  {
    match: 'instatic-loop',
    map: (el) => ({ moduleId: 'base.loop', props: mapLoopProps(el) }),
    recurse: true,
  },

  // Headings / paragraphs / inline phrasing → base.text (LEAF).
  // Props: `text` + `tag`.
  {
    match: 'h1, h2, h3, h4, h5, h6, p, span, small, strong, em',
    // Leaf when it holds only text → base.text. But when it WRAPS element
    // children (`<h2>Get the<br>file-based</h2>`, `<span><span>k</span><span>v</span></span>`)
    // recurse to a container so the nested structure + line breaks survive
    // instead of being flattened into one merged string.
    map: (el) =>
      hasElementChild(el)
        ? {
            moduleId: 'base.container',
            props: { tag: 'custom', customTag: el.tagName.toLowerCase() },
          }
        : {
            moduleId: 'base.text',
            props: { text: normalizeImportedText(el.textContent ?? ''), tag: el.tagName.toLowerCase() },
          },
    recurse: hasElementChild,
  },

  // Forms and form controls → first-class form modules. Imported third-party
  // forms default to custom mode so they do not become CMS endpoints until an
  // author explicitly binds them to a data table.
  {
    match: 'form',
    map: (el) => {
      const mode = normalizedAttr(el, 'data-instatic-form-mode') === 'cms' ? 'cms' : 'custom'
      const redirectUrl = attr(el, 'data-instatic-success-redirect')
      const successMessage = attr(el, 'data-instatic-success-message')
      return {
        moduleId: 'base.form',
        props: {
          mode,
          formId: formIdentifier(el),
          targetTableId: mode === 'cms' ? attr(el, 'data-instatic-target-table') : '',
          action: attr(el, 'action'),
          method: normalizeFormMethod(el),
          successBehavior: redirectUrl ? 'redirect' : 'message',
          redirectUrl,
          ...(successMessage ? { successMessage } : {}),
        },
      }
    },
    recurse: true,
  },

  {
    match: 'label',
    map: (el) =>
      hasElementChild(el)
        ? {
            moduleId: 'base.container',
            props: { tag: 'custom', customTag: 'label' },
          }
        : {
            moduleId: 'base.label',
            props: {
              text: normalizeImportedText(el.textContent ?? ''),
              targetMode: attr(el, 'for') ? 'explicit' : 'auto',
              targetId: attr(el, 'for'),
            },
          },
    recurse: hasElementChild,
  },

  {
    match: 'textarea',
    map: (el) => ({
      moduleId: 'base.textarea',
      props: {
        fieldId: formControlFieldId(el),
        name: attr(el, 'name'),
        id: attr(el, 'id'),
        placeholder: attr(el, 'placeholder'),
        value: el.textContent ?? '',
        required: el.hasAttribute('required'),
        disabled: el.hasAttribute('disabled'),
        readOnly: el.hasAttribute('readonly'),
        rows: numberAttr(el, 'rows', 4),
        minLength: numberAttr(el, 'minlength'),
        maxLength: numberAttr(el, 'maxlength'),
      },
    }),
  },

  {
    match: 'select',
    map: (el) => ({
      moduleId: 'base.select',
      props: {
        fieldId: formControlFieldId(el),
        name: attr(el, 'name'),
        id: attr(el, 'id'),
        required: el.hasAttribute('required'),
        disabled: el.hasAttribute('disabled'),
        multiple: el.hasAttribute('multiple'),
      },
    }),
    recurse: true,
  },

  {
    match: 'optgroup',
    map: (el) => ({
      moduleId: 'base.option-group',
      props: {
        label: attr(el, 'label') || normalizeImportedText(el.textContent ?? ''),
        disabled: el.hasAttribute('disabled'),
      },
    }),
    recurse: true,
  },

  {
    match: 'option',
    map: (el) => ({
      moduleId: 'base.option',
      props: {
        value: attr(el, 'value') || normalizeImportedText(el.textContent ?? ''),
        label: attr(el, 'label') || normalizeImportedText(el.textContent ?? ''),
        selected: el.hasAttribute('selected'),
        disabled: el.hasAttribute('disabled'),
      },
    }),
  },

  {
    match: 'input',
    map: (el) => {
      const type = normalizedAttr(el, 'type') || 'text'
      const common = {
        fieldId: formControlFieldId(el),
        name: attr(el, 'name'),
        id: attr(el, 'id'),
        value: attr(el, 'value'),
        required: el.hasAttribute('required'),
        disabled: el.hasAttribute('disabled'),
      }

      if (type === 'checkbox' || type === 'radio') {
        return {
          moduleId: type === 'checkbox' ? 'base.checkbox' : 'base.radio',
          props: {
            ...common,
            value: attr(el, 'value') || 'on',
            checked: el.hasAttribute('checked'),
          },
        }
      }

      if (type === 'submit') {
        return {
          moduleId: 'base.submit',
          props: {
            label: submitLabel(el),
            disabled: el.hasAttribute('disabled'),
            formId: optionalFormIdentifier(el),
          },
        }
      }

      if (type === 'button' || type === 'reset') {
        return {
          moduleId: 'base.button',
          props: {
            label: submitLabel(el),
            disabled: el.hasAttribute('disabled'),
          },
        }
      }

      return {
        moduleId: 'base.input',
        props: {
          ...common,
          inputType: normalizeInputType(el),
          placeholder: attr(el, 'placeholder'),
          readOnly: el.hasAttribute('readonly'),
          autocomplete: attr(el, 'autocomplete'),
          min: attr(el, 'min'),
          max: attr(el, 'max'),
          minLength: numberAttr(el, 'minlength'),
          maxLength: numberAttr(el, 'maxlength'),
          pattern: attr(el, 'pattern'),
        },
      }
    },
  },

  // btn-classed anchors → base.button (prop `label`). LEAF — base.button
  // cannot have children, so a btn wrapping an icon keeps only its label.
  {
    match: 'a.btn',
    map: (el) => ({
      moduleId: 'base.button',
      props: {
        label: normalizeImportedText(el.textContent ?? ''),
        href: el.getAttribute('href') ?? '',
        target: el.getAttribute('target') ?? '_self',
      },
    }),
  },

  // Plain anchors → base.link (prop `text`). Recurse ONLY when the anchor wraps
  // element children (an icon / inline `<svg>` / `<img>`) so that nested
  // content is preserved as real child nodes; a text-only link stays a leaf and
  // keeps using its `text` prop. base.link allows children, so this is safe.
  {
    match: 'a',
    map: (el) => ({
      moduleId: 'base.link',
      props: {
        text: normalizeImportedText(el.textContent ?? ''),
        href: el.getAttribute('href') ?? '',
        target: el.getAttribute('target') ?? '_self',
      },
    }),
    recurse: hasElementChild,
  },

  // Inline SVG → base.svg (LEAF). The whole element (including its
  // path/circle/… children) is captured verbatim in `outerHTML`; the publisher
  // sanitises it via the SVG DOMPurify profile. We do NOT recurse — children
  // are part of the markup, not separate nodes.
  {
    match: 'svg',
    map: (el) => ({
      moduleId: 'base.svg',
      props: {
        svg: el.outerHTML,
        title: el.getAttribute('aria-label') ?? '',
      },
    }),
  },

  // Images. `src` only — alt text is sourced from the media library asset,
  // not stored as a per-instance prop. LEAF.
  {
    match: 'img',
    map: (el) => ({
      moduleId: 'base.image',
      props: { src: el.getAttribute('src') ?? '' },
    }),
  },

  // Buttons → base.button or base.submit. A button without type submits only
  // when it is inside a form; outside forms it remains a regular base.button,
  // preserving the pre-existing HTML-import behavior for standalone buttons.
  {
    match: 'button',
    map: (el) => {
      const type = normalizedAttr(el, 'type')
      if (type === 'submit' || (!type && el.closest('form'))) {
        return {
          moduleId: 'base.submit',
          props: {
            label: submitLabel(el),
            disabled: el.hasAttribute('disabled'),
            formId: optionalFormIdentifier(el),
          },
        }
      }
      return {
        moduleId: 'base.button',
        props: { label: normalizeImportedText(el.textContent ?? ''), disabled: el.hasAttribute('disabled') },
      }
    },
  },

  // ul / ol are BUILTIN_HTML_TAGS for base.container → container + RECURSE.
  {
    match: 'ul, ol',
    map: (el) => ({
      moduleId: 'base.container',
      props: { tag: el.tagName.toLowerCase() },
    }),
    recurse: true,
  },

  // Semantic containers (all in BUILTIN_HTML_TAGS). RECURSE.
  {
    match: 'div, section, article, main, header, footer, nav, aside',
    map: (el) => ({
      moduleId: 'base.container',
      props: { tag: el.tagName.toLowerCase() },
    }),
    recurse: true,
  },

  // Void HTML elements. Browsers never give these DOM children, and React
  // throws if you render children inside a void tag
  // ("input is a void element tag and must neither have 'children' nor use
  // 'dangerouslySetInnerHTML'"). Map to base.container with tag:'custom' so
  // resolveHtmlTag emits the real tag name, but leave recurse unset (false)
  // so the node stays childless.
  //
  // Note: <img> is already matched above as base.image and <input> is matched
  // above as a form primitive. This rule covers the remaining void elements:
  // area, base, br, col, embed, hr, link, meta, param, source, track, wbr.
  {
    match: 'area, base, br, col, embed, hr, link, meta, param, source, track, wbr',
    map: (el) => ({
      moduleId: 'base.container',
      props: { tag: 'custom', customTag: el.tagName.toLowerCase() },
    }),
    // recurse intentionally omitted — void elements must remain childless.
  },

  // Catch-all for every other tag (li, figure, blockquote, form, table,
  // dialog, …). MUST use tag:'custom' + customTag so resolveHtmlTag
  // emits the real element name — tag:'div' + customTag would render <div>.
  // RECURSE.
  {
    match: '*',
    map: (el) => ({
      moduleId: 'base.container',
      props: { tag: 'custom', customTag: el.tagName.toLowerCase() },
    }),
    recurse: true,
  },
]
