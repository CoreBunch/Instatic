/**
 * IdeFileEditor — one co-edited code buffer in the Plugin IDE.
 *
 * Lazy-mounts the collab CodeMirror module (CodeMirror stays out of the
 * eager admin graph) bound to the file's Y.Text: keystrokes stream live
 * over the site socket, peers' edits and carets render in place, undo is
 * per-file and local-only.
 */
import { lazy, Suspense, useSyncExternalStore } from 'react'
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
  /**
   * The session's rebind generation. A relay reset replaces the Y.Text this
   * buffer is bound to; keying the mount on the generation remounts the
   * editor onto the fresh text instead of leaving it on the destroyed one.
   */
  generation: number
  readOnly: boolean
}

export function IdeFileEditor({ session, fileId, path, generation, readOnly }: IdeFileEditorProps) {
  // The live Y.Text is read through the session's sync subscription, not as
  // a plain derived value: a relay reset swaps the underlying doc while
  // `session` and `fileId` stay the same, so the React Compiler would keep
  // handing back the memoized, destroyed text. Both snapshots are stable
  // per binding (map lookups), which is what useSyncExternalStore needs.
  const text = useSyncExternalStore(session.onSyncChange, () => session.contentText(fileId))
  const undoManager = useSyncExternalStore(
    session.onSyncChange,
    () => (text ? session.undoManagerFor(fileId) : null),
  )
  if (!text) {
    return <div className={styles.editorEmpty}>This file has no editable text content.</div>
  }

  return (
    <Suspense fallback={<div className={styles.editorEmpty}>Loading editor…</div>}>
      <div className={styles.editorMount} data-testid="ide-code-editor">
        <CollabCodeMirrorEditor
          docKey={`${fileId}:${generation}`}
          language={ideLanguageForPath(path)}
          text={text}
          awareness={session.provider.awareness}
          undoManager={undoManager ?? false}
          readOnly={readOnly}
        />
      </div>
    </Suspense>
  )
}
