/**
 * File-extension → CodeMirror language mapping for the Plugin IDE. Lives in
 * its own module (not next to a component) so Fast Refresh stays intact.
 */
import type { CodeLanguage } from '@site/code-editor/CodeMirrorEditor'

export function ideLanguageForPath(path: string): CodeLanguage {
  if (path.endsWith('.tsx') || path.endsWith('.jsx')) return 'tsx'
  if (path.endsWith('.ts') || path.endsWith('.js') || path.endsWith('.mjs')) return 'ts'
  if (path.endsWith('.css')) return 'css'
  if (path.endsWith('.json')) return 'json'
  if (path.endsWith('.md')) return 'markdown'
  if (path.endsWith('.html') || path.endsWith('.svg')) return 'html'
  return 'text'
}
