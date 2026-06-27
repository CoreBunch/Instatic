/**
 * SeoCodeViewer — read-only, syntax-highlighted code display for the SEO
 * workspace (robots.txt preview, sitemap entry sample, JSON-LD schema).
 *
 * Mounts the shared CodeMirror 6 editor in `readOnly` mode. CM6 is ~150 kB
 * min+gz, so it stays behind React.lazy — the plain <Code> block renders as
 * the Suspense fallback, which also keeps tests and first paint cheap.
 */
import { lazy, Suspense } from 'react'
import { Code } from '@ui/components/Code'
import type { CodeLanguage } from '@site/code-editor/CodeMirrorEditor'
import styles from './SeoCodeViewer.module.css'

const CodeMirrorEditor = lazy(() => import('@site/code-editor/CodeMirrorEditor'))

interface SeoCodeViewerProps {
  /** Stable identity — remounts the CM6 view when it changes. */
  docKey: string
  value: string
  language: CodeLanguage
  'data-testid'?: string
}

export function SeoCodeViewer({ docKey, value, language, 'data-testid': testId }: SeoCodeViewerProps) {
  return (
    /* data-code mirrors the displayed text: CM6 renders only measured-
       visible lines (none in test DOMs), so assertions read the attribute
       instead of racing the lazy chunk. */
    <div className={styles.viewer} data-testid={testId} data-code={value}>
      <Suspense fallback={<Code className={styles.fallback}>{value}</Code>}>
        <CodeMirrorEditor
          docKey={`${docKey}:${value.length}:${hashText(value)}`}
          value={value}
          language={language}
          readOnly
          changeDelayMs={0}
        />
      </Suspense>
    </div>
  )
}

/**
 * Tiny content hash folded into the docKey so the read-only view remounts
 * when the displayed text changes (CM6 only reads `value` on mount).
 */
function hashText(text: string): number {
  let hash = 0
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0
  }
  return hash
}
