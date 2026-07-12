/**
 * IdeFileEditor — one co-edited code buffer in the Plugin IDE.
 *
 * Lazy-mounts the collab CodeMirror module (CodeMirror stays out of the
 * eager admin graph) bound to the file's Y.Text: keystrokes stream live
 * over the site socket, peers' edits and carets render in place, undo is
 * per-file and local-only.
 */
import { lazy, Suspense } from 'react'
import type { IdeCollabSession } from './ideCollab'
import { ideLanguageForPath } from './ideLanguage'
import styles from './SitePluginIdePage.module.css'

const CollabCodeMirrorEditor = lazy(
  () => import('@site/code-editor/CollabCodeMirrorEditor'),
)

interface IdeFileEditorProps {
  session: IdeCollabSession
  fileId: string
  path: string
  readOnly: boolean
}

export function IdeFileEditor({ session, fileId, path, readOnly }: IdeFileEditorProps) {
  const text = session.contentText(fileId)
  if (!text) {
    return <div className={styles.editorEmpty}>This file has no editable text content.</div>
  }

  return (
    <Suspense fallback={<div className={styles.editorEmpty}>Loading editor…</div>}>
      <div className={styles.editorMount} data-testid="ide-code-editor">
        <CollabCodeMirrorEditor
          docKey={fileId}
          language={ideLanguageForPath(path)}
          text={text}
          awareness={session.provider.awareness}
          undoManager={session.undoManagerFor(fileId) ?? false}
          readOnly={readOnly}
        />
      </div>
    </Suspense>
  )
}
