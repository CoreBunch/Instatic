/**
 * TemplateModeControl — floating control shown while editing a template page.
 *
 * Mirrors `VisualComponentModeControl` visually: a borderless, text-first pill
 * under the canvas notch. The template name is a `DocumentSwitcher` (jump to any
 * page / template / component); templates also get a preview-source dropdown —
 * the page (everywhere layout) or post (postTypes template) whose content fills
 * the outlet preview. The selection is session-only (`templatePreviewSelection`
 * in the UI slice); it never dirties or persists to the site document.
 */

import { type CSSProperties } from 'react'
import { selectActivePage, useEditorStore } from '@site/store/store'
import { isTemplatePage } from '@core/templates'
import { readProjectedDisplayTitle } from '@core/data/cells'
import { useTemplatePreviewContext } from '@site/hooks/useTemplatePreviewContext'
import { Button } from '@ui/components/Button'
import { Select } from '@ui/components/Select'
import { DocumentSwitcher } from './DocumentSwitcher'
import { measureToolbarValueWidth } from './measureToolbarText'
import styles from './TemplateModeControl.module.css'

export default function TemplateModeControl() {
  const activePage = useEditorStore(selectActivePage)
  const isVcMode = useEditorStore((s) => s.activeDocument?.kind === 'visualComponent')

  if (isVcMode || !activePage || !activePage.template?.enabled) return null

  const targetKind = activePage.template.target?.kind ?? null

  return (
    <div className={styles.control} data-testid="template-mode-control">
      <span className={styles.modeLabel}>Editing template</span>

      <DocumentSwitcher current={{ kind: 'page', id: activePage.id, label: activePage.title }} />

      {(targetKind === 'everywhere' || targetKind === 'postTypes') && (
        <>
          <span className={styles.divider} aria-hidden="true" />
          <PreviewSourceSelect templateId={activePage.id} page={activePage} />
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// PreviewSourceSelect — picks the page / post previewed in the outlet
// ---------------------------------------------------------------------------

interface PreviewSourceSelectProps {
  templateId: string
  page: NonNullable<ReturnType<typeof selectActivePage>>
}

/** Cap the preview-source trigger width (px) so a long title can't blow out the toolbar. */
const MAX_PREVIEW_PX = 150
/** Space reserved after the value text for the gap + chevron. */
const CHEVRON_ALLOWANCE_PX = 20

function PreviewSourceSelect({ templateId, page }: PreviewSourceSelectProps) {
  const selection = useEditorStore((s) => s.templatePreviewSelection[templateId] ?? null)
  const setSelection = useEditorStore((s) => s.setTemplatePreviewSelection)
  // Select the stable pages array (not a freshly-filtered one) so unrelated
  // store changes don't churn this subscription; filter in the render body
  // where the React Compiler memoizes it.
  const sitePages = useEditorStore((s) => s.site?.pages ?? null)
  const targetKind = page.template?.target?.kind ?? null
  const everywherePages = targetKind === 'everywhere' && sitePages
    ? sitePages.filter((p) => !isTemplatePage(p))
    : null

  const { rows, table, loading, error, refresh } = useTemplatePreviewContext(page)

  const options =
    everywherePages !== null
      ? everywherePages.map((p) => ({ value: p.id, label: p.title || p.slug || 'Untitled page' }))
      : rows.map((item) => ({
          value: item.id,
          label: readProjectedDisplayTitle(item.fields, table),
        }))

  if (targetKind === 'postTypes' && error && rows.length === 0) return <Button variant="ghost" size="sm" onClick={refresh}>Retry preview entries</Button>
  if (targetKind === 'postTypes' && loading) return <span role="status">Loading preview entries…</span>

  if (options.length === 0) return null

  // Default to the first option (the first real page / published row) when the
  // author hasn't picked one — matching the outlet's own default preview.
  const value = selection ?? String(options[0]?.value ?? '')

  // Size the trigger to the selected label (measured, capped) so there's no
  // dead space before the chevron in the tight toolbar.
  const selectedOption = options.find((option) => String(option.value) === value)
  const selectedText = typeof selectedOption?.label === 'string' ? selectedOption.label : ''
  const triggerWidth = Math.min(measureToolbarValueWidth(selectedText), MAX_PREVIEW_PX) + CHEVRON_ALLOWANCE_PX

  return (
    // The width custom property is set here (the Select root inherits it) since
    // `Select`'s own `style` prop is forwarded to its hidden native <select>.
    <span className={styles.previewGroup} style={{ '--tpl-preview-w': `${triggerWidth}px` } as CSSProperties}>
      <span className={styles.previewLabel}>Previewing</span>
      {error && <span role="alert" className={styles.previewLabel}>{error.message}</span>}
      <Select
        fieldSize="sm"
        emphasis="strong"
        className={styles.previewSelect}
        menuMinWidth={200}
        aria-label="Preview source"
        data-testid="template-preview-source"
        value={value}
        placeholder="Choose preview entry"
        options={options}
        onChange={(event) => setSelection(templateId, event.target.value)}
      />
    </span>
  )
}
