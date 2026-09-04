import { useState } from 'react'
import type { ControlProps } from './shared'
import { isValidUrl } from '@core/utils/urlValidation'
import { isPageRef, parsePageRef, makePageRef, pagePublicPath } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { Input } from '@ui/components/Input'
import { Select } from '@ui/components/Select'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { ControlRow } from '@ui/components/ControlRow'
import controlRowStyles from '@ui/components/ControlRow/ControlRow.module.css'
import styles from './controls.module.css'

const EMPTY_PAGES: { id: string; title: string; slug: string }[] = []

/**
 * URL property control with two modes:
 *   - URL  — free-text external/relative URL (validated by isValidUrl).
 *   - Page — pick an existing CMS page; stored as a dynamic `cms:page:<id>`
 *            reference that the publisher resolves to the page's current path,
 *            so the link survives slug renames.
 */
export function UrlControl({
  propKey,
  value,
  onChange,
  label,
  isOverride,
  disabled,
  layout,
}: ControlProps<string>) {
  const [error, setError] = useState(false)
  const pages = useEditorStore((s) => s.site?.pages ?? EMPTY_PAGES)

  const current = String(value ?? '')
  const ref = parsePageRef(current)
  const [mode, setMode] = useState<'url' | 'page'>(isPageRef(current) ? 'page' : 'url')

  const handleUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value
    const valid = isValidUrl(v)
    setError(!valid)
    if (valid) onChange(propKey, v)
  }

  const handlePagePick = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const pageId = e.target.value
    if (!pageId) return
    // Preserve an existing fragment when re-pointing the link to another page.
    onChange(propKey, makePageRef(pageId, ref?.fragment))
  }

  // In URL mode never show a page-ref token in the text field — it isn't a URL.
  const urlFieldValue = isPageRef(current) ? '' : current
  const selectedPageId = ref?.pageId ?? ''

  const pageOptions = [
    { label: 'Select a page…', value: '' },
    ...pages.map((p) => ({
      label: `${p.title || `/${p.slug}`} · ${pagePublicPath(p.slug)}`,
      value: p.id,
    })),
  ]

  return (
    <ControlRow
      propKey={propKey}
      label={label}
      layout={layout}
      isOverride={isOverride}
      disabled={disabled}
      labelSuffix={
        error ? (
          <span className={controlRowStyles.labelError} role="alert">
            Invalid URL
          </span>
        ) : undefined
      }
    >
      <div className={styles.urlControl}>
        <SegmentedControl<'url' | 'page'>
          look="tiles"
          fullWidth
          aria-label="Link type"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'url', label: 'URL' },
            { value: 'page', label: 'Page' },
          ]}
        />

        {mode === 'page' ? (
          <Select
            id={`ctrl-${propKey}`}
            value={selectedPageId}
            options={pageOptions}
            disabled={disabled}
            fieldSize="sm"
            onChange={handlePagePick}
          />
        ) : (
          <Input
            id={`ctrl-${propKey}`}
            type="url"
            value={urlFieldValue}
            placeholder="https://…"
            disabled={disabled}
            fieldSize="sm"
            onChange={handleUrlChange}
            invalid={error}
          />
        )}
      </div>
    </ControlRow>
  )
}
