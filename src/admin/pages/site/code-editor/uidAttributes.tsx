/**
 * uidAttributes — the God Mode HTML panel's `uid="…"` attributes, shown as
 * the Instatic mark instead of noise.
 *
 * The projection HTML carries a `uid` on every element so the uid-preserving
 * import can match nodes back (docs/features/html-import.md). Authors never
 * need to read or type them, so on screen each attribute is REPLACED by a
 * small clickable mark; the text stays in the document untouched, which is
 * what the apply path reads. Clicking a mark reveals that one uid inline
 * (the mark stays, pressed, in front of it); clicking again hides it. The
 * reveal set is keyed by uid value, so it survives edits elsewhere.
 *
 * Hidden attributes are atomic ranges: the caret steps over them as one
 * unit and a backspace deletes the whole attribute, never half of it.
 *
 * Part of the lazy CodeMirror chunk (see codemirror-lazy-only.test.ts).
 */
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { DatabaseSolidIcon } from 'pixel-art-icons/icons/database-solid'

const toggleUid = StateEffect.define<string>()

/** Uids currently shown as text; everything else is folded behind its mark. */
const revealedUids = StateField.define<ReadonlySet<string>>({
  create: () => new Set(),
  update: (revealed, tr) => {
    let next: Set<string> | null = null
    for (const effect of tr.effects) {
      if (!effect.is(toggleUid)) continue
      next ??= new Set(revealed)
      if (next.has(effect.value)) next.delete(effect.value)
      else next.add(effect.value)
    }
    return next ?? revealed
  },
})

// One rendered icon, cloned per widget: the pixel-art icon is a React
// component, and a React root per mark would be wasteful for a page with
// hundreds of elements. Rendered once at module load — this module lives in
// the lazily imported CodeMirror chunk, so that is outside any React render
// or effect (flushSync inside a lifecycle is not allowed).
const iconTemplate = (() => {
  const host = document.createElement('span')
  flushSync(() => {
    createRoot(host).render(<DatabaseSolidIcon size={11} aria-hidden="true" />)
  })
  return host
})()

function iconNode(): HTMLElement {
  return iconTemplate.cloneNode(true) as HTMLElement
}

class UidMark extends WidgetType {
  readonly uid: string
  readonly revealed: boolean

  constructor(uid: string, revealed: boolean) {
    super()
    this.uid = uid
    this.revealed = revealed
  }

  eq(other: UidMark): boolean {
    return other.uid === this.uid && other.revealed === this.revealed
  }

  toDOM(view: EditorView): HTMLElement {
    const mark = document.createElement('button')
    mark.type = 'button'
    mark.className = 'cm-uidMark'
    mark.title = this.revealed ? 'Hide uid' : `Show uid ${this.uid}`
    mark.setAttribute('aria-label', mark.title)
    mark.setAttribute('aria-pressed', this.revealed ? 'true' : 'false')
    mark.appendChild(iconNode())
    mark.addEventListener('mousedown', (event) => {
      event.preventDefault()
      view.dispatch({ effects: toggleUid.of(this.uid) })
    })
    return mark
  }

  ignoreEvent(): boolean {
    return true
  }
}

function buildDecorations(view: EditorView): DecorationSet {
  const revealed = view.state.field(revealedUids)
  const decorations: { from: number; to: number; decoration: Decoration }[] = []
  const tree = syntaxTree(view.state)
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== 'Attribute') return
        const nameNode = node.node.getChild('AttributeName')
        if (!nameNode || view.state.sliceDoc(nameNode.from, nameNode.to) !== 'uid') return false
        const valueNode = node.node.getChild('AttributeValue')
        if (!valueNode) return false
        const uid = view.state.sliceDoc(valueNode.from, valueNode.to).replace(/^["']|["']$/g, '')
        if (revealed.has(uid)) {
          decorations.push({ from: node.from, to: node.from, decoration: Decoration.widget({ widget: new UidMark(uid, true), side: -1 }) })
        } else {
          decorations.push({ from: node.from, to: node.to, decoration: Decoration.replace({ widget: new UidMark(uid, false) }) })
        }
        return false
      },
    })
  }
  return Decoration.set(decorations.map((d) => d.decoration.range(d.from, d.to)), true)
}

const uidMarksPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
    }

    update(update: ViewUpdate) {
      const revealChanged = update.transactions.some((tr) => tr.effects.some((effect) => effect.is(toggleUid)))
      if (
        update.docChanged
        || update.viewportChanged
        || revealChanged
        || syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = buildDecorations(update.view)
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
    provide: (plugin) => EditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none),
  },
)

const uidMarkTheme = EditorView.baseTheme({
  '.cm-uidMark': {
    display: 'inline-flex',
    alignItems: 'center',
    verticalAlign: 'middle',
    padding: '0 var(--space-3xs)',
    border: 'none',
    borderRadius: 'var(--radius-sm)',
    background: 'transparent',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    lineHeight: '1',
  },
  '.cm-uidMark:hover': {
    color: 'var(--text)',
    background: 'var(--overlay-10)',
  },
  '.cm-uidMark[aria-pressed="true"]': {
    color: 'var(--accent-1)',
  },
})

export function uidAttributes(): Extension {
  return [revealedUids, uidMarksPlugin, uidMarkTheme]
}
