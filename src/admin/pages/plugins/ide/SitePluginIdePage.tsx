/**
 * SitePluginIdePage — the full-screen Plugin IDE
 * (`/admin/plugins/develop/:localId`).
 *
 * Renders in the same workspace canvas shell Content/Data/Media use:
 * standard toolbar + section nav, a resizable left file tree, the co-edited
 * CodeMirror buffer with the diagnostics strip beneath it, and the
 * collapsible manifest panel on the right (edge-notch reopen, persisted
 * layout — all owned by the layout).
 *
 * Everything here co-edits live: files are CRDT state on the site socket,
 * peers' carets render inline, and there is no save button — Cmd+S re-runs
 * diagnostics for muscle memory.
 */
import { useEffect, useState } from 'react'
import { AdminWorkspaceCanvasLayout } from '@admin/layouts/AdminWorkspaceCanvasLayout/AdminWorkspaceCanvasLayout'
import { useNavigate, useParams } from '@admin/lib/routing'
import { useAuthenticatedAdminUser } from '@admin/sessionContext'
import { canEditStructure, canInstallPlugins } from '@admin/access'
import { ConfirmDeleteDialog } from '@admin/shared/dialogs/ConfirmDeleteDialog/ConfirmDeleteDialog'
import { SITE_PLUGIN_LOCAL_ID_PATTERN, sitePluginFolder } from '@core/site-plugins'
import { useSitePluginIde } from './useSitePluginIde'
import { useIdePeers, usePublishIdePresence } from './idePresence'
import { FileTreePane } from './FileTreePane'
import { IdeFileEditor } from './IdeFileEditor'
import { DiagnosticsStrip } from './DiagnosticsStrip'
import { ManifestPane } from './ManifestPane'
import { IdeActions } from './IdeActions'
import { IdeSidebar } from './IdeSidebar'
import styles from './SitePluginIdePage.module.css'

export function SitePluginIdePage() {
  const params = useParams<{ localId: string }>()
  const rawLocalId = params.localId ?? ''
  const localId = SITE_PLUGIN_LOCAL_ID_PATTERN.test(rawLocalId) ? rawLocalId : null

  if (!localId) {
    return (
      <AdminWorkspaceCanvasLayout
        workspace="pluginIde"
        contentCanvas={(
          <div className={styles.missing} role="alert">
            <h1 className={styles.missingTitle}>Unknown site plugin</h1>
            <p>“{rawLocalId}” is not a valid site plugin id.</p>
          </div>
        )}
      />
    )
  }

  return <SitePluginIde localId={localId} />
}

interface PendingDelete {
  title: string
  description: string
  confirmLabel: string
  commit: () => void
}

function SitePluginIde({ localId }: { localId: string }) {
  const currentUser = useAuthenticatedAdminUser()
  const navigate = useNavigate()
  const canEdit = canEditStructure(currentUser)
  const canInstall = canInstallPlugins(currentUser)
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null)

  const vm = useSitePluginIde(localId)
  const { session, files, activeFileId, selectFile, runValidation } = vm
  const peers = useIdePeers(session, localId)

  const activeFile = files.find((file) => file.id === activeFileId) ?? null
  const folder = sitePluginFolder(localId)

  usePublishIdePresence(
    session,
    currentUser,
    localId,
    activeFile ? { fileId: activeFile.id, path: activeFile.path } : null,
  )

  // Auto-select plugin.json (or the first file) once files arrive.
  useEffect(() => {
    if (activeFileId && files.some((file) => file.id === activeFileId)) return
    const manifest = files.find((file) => file.path === `${folder}plugin.json`)
    selectFile(manifest?.id ?? files[0]?.id ?? null)
  }, [files, activeFileId, folder, selectFile])

  // Cmd+S — there is nothing to save (edits persist live); honor the muscle
  // memory by re-running diagnostics instead of the browser save dialog.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        runValidation()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [runValidation])

  return (
    <AdminWorkspaceCanvasLayout
      workspace="pluginIde"
      contentSidebar={(
        <IdeSidebar>
          <FileTreePane
            localId={localId}
            files={files}
            activeFileId={activeFileId}
            peers={peers}
            canEdit={canEdit}
            onSelect={selectFile}
            onCreate={(relativePath) => {
              if (!session) return
              const id = session.createFile(`${folder}${relativePath}`)
              selectFile(id)
            }}
            onRename={(fileId, relativePath) => {
              session?.renameFile(fileId, `${folder}${relativePath}`)
            }}
            onDelete={(fileId) => {
              const file = files.find((entry) => entry.id === fileId)
              setPendingDelete({
                title: `Delete ${file?.path.slice(folder.length) ?? 'this file'}?`,
                description: 'The file is removed from the live draft for every editor.',
                confirmLabel: 'Delete file',
                commit: () => {
                  session?.deleteFile(fileId)
                  if (activeFileId === fileId) selectFile(null)
                },
              })
            }}
          />
        </IdeSidebar>
      )}
      contentCanvas={(
        <div className={styles.editorColumn} data-testid="ide-editor-column">
          <div className={styles.editorArea}>
            {!session || !vm.synced ? (
              <div className={styles.editorEmpty} role="status">
                Connecting to the live draft…
              </div>
            ) : activeFile ? (
              <IdeFileEditor
                session={session}
                fileId={activeFile.id}
                path={activeFile.path}
                readOnly={!canEdit}
              />
            ) : (
              <div className={styles.editorEmpty}>
                {files.length === 0
                  ? `No source yet — this plugin has no files under ${folder}.`
                  : 'Select a file to start editing.'}
              </div>
            )}
          </div>
          <DiagnosticsStrip
            diagnostics={vm.diagnostics}
            validating={vm.validating}
            synced={vm.synced}
          />
        </div>
      )}
      contentRightPanel={
        session ? (
          <ManifestPane
            session={session}
            localId={localId}
            files={files}
            summary={vm.summary}
            canEdit={canEdit}
            onOpenRawJson={() => {
              const manifest = files.find((file) => file.path === `${folder}plugin.json`)
              if (manifest) selectFile(manifest.id)
            }}
          />
        ) : null
      }
      toolbarRightSlot={(
        <>
          <IdeActions
            summary={vm.summary}
            peers={peers}
            canInstall={canInstall}
            activating={vm.activating}
            onActivate={() => void vm.activate()}
            onPreview={vm.openPreview}
            onRollback={() => void vm.rollback()}
            onSetEnabled={(enabled) => void vm.setEnabled(enabled)}
            onRestart={() => void vm.restart()}
            onRerunDiagnostics={vm.runValidation}
            onOpenSettings={() => navigate('/admin/plugins')}
            onDelete={() =>
              setPendingDelete({
                title: `Delete site plugin “${localId}”?`,
                description:
                  'Removes the runtime plugin, its generated revisions, settings and secrets, AND the source folder from the draft.',
                confirmLabel: 'Delete site plugin',
                commit: () => void vm.deletePlugin(),
              })
            }
            onShowDiagnostics={vm.runValidation}
          />
          {pendingDelete && (
            <ConfirmDeleteDialog
              title={pendingDelete.title}
              description={pendingDelete.description}
              confirmLabel={pendingDelete.confirmLabel}
              onCancel={() => setPendingDelete(null)}
              onConfirm={() => {
                pendingDelete.commit()
                setPendingDelete(null)
              }}
            />
          )}
        </>
      )}
    />
  )
}
