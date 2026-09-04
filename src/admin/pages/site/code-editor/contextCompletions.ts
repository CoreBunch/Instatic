/**
 * contextCompletions — installs the God Mode context completion sources as
 * language data, so each is APPENDED to its language's default sources
 * (lang-html tags/attributes, lang-css properties/values, lang-javascript
 * keywords/scope) rather than replacing them. The catalog is read through a
 * getter on every completion, so a panel can hand the editor fresh data
 * (a new class, loaded table schemas) without remounting the view.
 *
 * Part of the lazy CodeMirror chunk (see codemirror-lazy-only.test.ts).
 */
import type { Extension } from '@codemirror/state'
import { htmlLanguage } from '@codemirror/lang-html'
import { cssLanguage } from '@codemirror/lang-css'
import { javascriptLanguage } from '@codemirror/lang-javascript'
import type { EditorCompletionCatalog } from './completionCatalog'
import { htmlContextCompletion } from './htmlContextCompletions'
import { cssContextCompletion } from './cssContextCompletions'
import { jsContextCompletion } from './jsContextCompletions'

type CatalogOf<K extends EditorCompletionCatalog['kind']> = Extract<EditorCompletionCatalog, { kind: K }>

function ofKind<K extends EditorCompletionCatalog['kind']>(
  getCatalog: () => EditorCompletionCatalog | null,
  kind: K,
): () => CatalogOf<K> | null {
  return () => {
    const catalog = getCatalog()
    return catalog && catalog.kind === kind ? (catalog as CatalogOf<K>) : null
  }
}

export function contextCompletions(getCatalog: () => EditorCompletionCatalog | null): Extension {
  return [
    htmlLanguage.data.of({ autocomplete: htmlContextCompletion(ofKind(getCatalog, 'html')) }),
    cssLanguage.data.of({ autocomplete: cssContextCompletion(ofKind(getCatalog, 'css')) }),
    javascriptLanguage.data.of({ autocomplete: jsContextCompletion(ofKind(getCatalog, 'js')) }),
  ]
}
