import type { SiteFile } from '@core/files/schemas'
import type { CodeLanguage } from './CodeMirrorEditor'

/** Map a SiteFile to the editor's highlighting language (no CM6 imports here). */
export function fileLanguage(file: Pick<SiteFile, 'type' | 'path'>): CodeLanguage {
  switch (file.type) {
    case 'component': return 'tsx'
    case 'script':
      if (/\.tsx$/.test(file.path)) return 'tsx'
      if (/\.jsx$/.test(file.path)) return 'jsx'
      if (/\.[cm]?js$/.test(file.path)) return 'javascript'
      return 'ts'
    case 'style': return 'css'
    case 'config':
      if (file.path.endsWith('.json')) return 'json'
      if (file.path.endsWith('.ts') || file.path.endsWith('.mts')) return 'ts'
      return 'text'
    case 'doc': return 'markdown'
    default: return 'text'
  }
}
