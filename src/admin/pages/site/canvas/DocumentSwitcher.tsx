/**
 * DocumentSwitcher — a compact, grouped, searchable dropdown that jumps the
 * canvas to any other document. Shared by the template and Visual Component
 * floating controls (it replaces inline rename: renaming lives in the Site
 * panel).
 *
 * The current document is shown as the trigger value (via `placeholder`, so the
 * Select's `value` stays empty) and is excluded from the list. Picking an entry
 * opens it — `openPageInCanvas` for pages / templates, `setActiveDocument` for
 * components. Options are grouped Pages / Templates / Components via `<optgroup>`
 * (the Select renders the group labels as headers).
 */

import { type CSSProperties } from 'react'
import { useEditorStore } from '@site/store/store'
import { isTemplatePage } from '@core/templates'
import { Select } from '@ui/components/Select'
import { measureToolbarValueWidth } from './measureToolbarText'
import styles from './DocumentSwitcher.module.css'

interface DocumentSwitcherCurrent {
  kind: 'page' | 'component'
  id: string
  label: string
}

/**
 * Shared stable empty-array fallback. A fresh `[]` literal per render is a new
 * reference each time, which both churns derived work and trips the
 * Zustand-stability gate; this module-level constant keeps the identity stable.
 */
const EMPTY_PAGES: never[] = []

/** Cap the trigger width (px) so a long document title can't blow out the toolbar. */
const MAX_SWITCHER_PX = 180
/** Space reserved after the value text for the gap + chevron. */
const CHEVRON_ALLOWANCE_PX = 20

export function DocumentSwitcher({ current }: { current: DocumentSwitcherCurrent }) {
  const pages = useEditorStore((s) => s.site?.pages ?? null)
  const components = useEditorStore((s) => s.site?.visualComponents ?? null)
  const openPageInCanvas = useEditorStore((s) => s.openPageInCanvas)
  const setActiveDocument = useEditorStore((s) => s.setActiveDocument)

  const isCurrentPage = (id: string) => current.kind === 'page' && current.id === id
  const isCurrentVc = (id: string) => current.kind === 'component' && current.id === id

  const regularPages = (pages ?? EMPTY_PAGES).filter((p) => !isTemplatePage(p) && !isCurrentPage(p.id))
  const templates = (pages ?? EMPTY_PAGES).filter((p) => isTemplatePage(p) && !isCurrentPage(p.id))
  const vcs = (components ?? EMPTY_PAGES).filter((c) => !isCurrentVc(c.id))

  function handleChange(rawValue: string) {
    const sep = rawValue.indexOf(':')
    if (sep === -1) return
    const kind = rawValue.slice(0, sep)
    const id = rawValue.slice(sep + 1)
    if (kind === 'vc') {
      setActiveDocument({ kind: 'visualComponent', vcId: id })
    } else {
      openPageInCanvas(id)
    }
  }

  const triggerWidth = Math.min(measureToolbarValueWidth(current.label), MAX_SWITCHER_PX) + CHEVRON_ALLOWANCE_PX

  return (
    <span className={styles.switcher} style={{ '--doc-switcher-w': `${triggerWidth}px` } as CSSProperties}>
      <Select
        fieldSize="sm"
        emphasis="strong"
        className={styles.select}
        menuMinWidth={220}
        value=""
        placeholder={current.label}
        aria-label="Switch document"
        data-testid="document-switcher"
        onChange={(event) => handleChange(event.target.value)}
      >
        {regularPages.length > 0 && (
          <optgroup label="Pages">
            {regularPages.map((p) => (
              <option key={p.id} value={`page:${p.id}`}>{p.title || p.slug || 'Untitled page'}</option>
            ))}
          </optgroup>
        )}
        {templates.length > 0 && (
          <optgroup label="Templates">
            {templates.map((p) => (
              <option key={p.id} value={`page:${p.id}`}>{p.title || p.slug || 'Untitled template'}</option>
            ))}
          </optgroup>
        )}
        {vcs.length > 0 && (
          <optgroup label="Components">
            {vcs.map((c) => (
              <option key={c.id} value={`vc:${c.id}`}>{c.name}</option>
            ))}
          </optgroup>
        )}
      </Select>
    </span>
  )
}
