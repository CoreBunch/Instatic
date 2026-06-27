/**
 * SeoCodeEditor — editable sibling of `SeoCodeViewer`. Mounts the shared
 * CodeMirror 6 editor (lazy, ~150 kB) with a plain `<Textarea>` as the
 * Suspense fallback so the surface is editable before the chunk resolves and
 * in test DOMs. The container mirrors the live value in `data-content` so
 * callers/tests can read it without depending on CM6's measured-line render.
 *
 * CM6 reads `value` only on mount / `docKey` change, so programmatic edits
 * (the Robots tab's insert shortcuts) bump `docKey` to remount with the new
 * text; plain typing flows back through `onChange` without a remount.
 */
import { lazy, Suspense } from 'react'
import { Textarea } from '@ui/components/Input'
import type { CodeLanguage } from '@site/code-editor/CodeMirrorEditor'
import styles from './SeoCodeEditor.module.css'

const CodeMirrorEditor = lazy(() => import('@site/code-editor/CodeMirrorEditor'))

interface SeoCodeEditorProps {
  /** Remount key — bump to push a programmatic value change into CM6. */
  docKey: string
  value: string
  language: CodeLanguage
  onChange: (next: string) => void
  disabled?: boolean
  ariaLabel: string
  'data-testid'?: string
}

export function SeoCodeEditor({
  docKey,
  value,
  language,
  onChange,
  disabled = false,
  ariaLabel,
  'data-testid': testId,
}: SeoCodeEditorProps) {
  return (
    <div className={styles.editor} data-testid={testId} data-content={value}>
      {disabled ? (
        <Textarea className={styles.fallback} value={value} aria-label={ariaLabel} readOnly spellCheck={false} />
      ) : (
        <Suspense
          fallback={
            <Textarea
              className={styles.fallback}
              value={value}
              aria-label={ariaLabel}
              spellCheck={false}
              onChange={(e) => onChange(e.target.value)}
            />
          }
        >
          <CodeMirrorEditor
            docKey={docKey}
            value={value}
            language={language}
            changeDelayMs={0}
            onChange={onChange}
          />
        </Suspense>
      )}
    </div>
  )
}
