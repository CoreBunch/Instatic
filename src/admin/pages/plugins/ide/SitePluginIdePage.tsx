/**
 * SitePluginIdePage — the full-screen Plugin IDE
 * (`/admin/plugins/develop/:localId`).
 *
 * Renders in the same workspace canvas shell Content/Data/Media use:
 * standard toolbar + section nav, a resizable left file tree, and the
 * co-edited CodeMirror buffer with the diagnostics strip beneath it. There
 * is no right panel — plugin.json is edited as raw JSON in the buffer, and
 * the diagnostics strip names every manifest mistake.
 *
 * Everything here co-edits live: files are CRDT state on the site socket,
 * peers' carets render inline, and there is no save button — Cmd+S re-runs
 * diagnostics for muscle memory.
 */
import { useEffect, useState } from 'react'
import { AdminWorkspaceCanvasLayout } from '@admin/layouts/AdminWorkspaceCanvasLayout/AdminWorkspaceCanvasLayout'
import { useNavigate, useParams } from '@admin/lib/routing'
import { useAuthenticatedAdminUser } from '@admin/sessionContext'
import {
  canEditPlugins,
  canInstallPlugins,
  canManagePluginLifecycle,
  canUseAiChat,
} from '@admin/access'
import { ConfirmDeleteDialog } from '@admin/shared/dialogs/ConfirmDeleteDialog/ConfirmDeleteDialog'
import { SITE_PLUGIN_LOCAL_ID_PATTERN, sitePluginFolder } from '@core/site-plugins'
import { useSitePluginIde } from './useSitePluginIde'
import { useIdePeers, usePublishIdePresence } from './idePresence'
import { FileTreePane } from './FileTreePane'
import { SitePluginPermissionReviewDialog } from './SitePluginPermissionReviewDialog'
import { IdeFileEditor } from './IdeFileEditor'
import { DiagnosticsStrip } from './DiagnosticsStrip'
import { IdeActions } from './IdeActions'
import { IdeSidebar, type IdePanelId } from './IdeSidebar'
import { PluginIdeAgentMount } from './agent/PluginIdeAgentMount'
import { usePluginIdeToolBridge } from './agent/usePluginIdeToolBridge'
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
  const canEdit = canEditPlugins(currentUser)
  const canInstall = canInstallPlugins(currentUser)
  const canManageLifecycle = canManagePluginLifecycle(currentUser)
  const canChat = canUseAiChat(currentUser)
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [activePanel, setActivePanel] = useState<IdePanelId | null>('files')

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

  // Agent + MCP tool surface — registered for the whole page mount so an
  // external MCP client reaches the open IDE even with the AI panel closed.
  usePluginIdeToolBridge({
    localId,
    folder,
    session,
    files,
    activeFile: activeFile ? { id: activeFile.id, path: activeFile.path } : null,
    summary: vm.summary,
    diagnostics: vm.diagnostics,
    selectFile,
    canEdit,
    currentUser: {
      id: currentUser?.id ?? '',
      displayName: currentUser?.displayName ?? '',
      email: currentUser?.email ?? '',
    },
  })

  // Auto-select plugin.json (or the first file) once files arrive. Only
  // while synced: during a relay reset the file list is empty for a moment,
  // and reacting to that would drop the active buffer and land the user in
  // the manifest when the reseeded doc (same file ids) comes back.
  useEffect(() => {
    if (!vm.synced) return
    if (activeFileId && files.some((file) => file.id === activeFileId)) return
    const manifest = files.find((file) => file.path === `${folder}plugin.json`)
    selectFile(manifest?.id ?? files[0]?.id ?? null)
  }, [vm.synced, files, activeFileId, folder, selectFile])

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
        <IdeSidebar
          activePanel={activePanel}
          onActivePanelChange={setActivePanel}
          canUseAiChat={canChat}
          agentPanel={<PluginIdeAgentMount isVisible={activePanel === 'agent'} />}
          filesPanel={(
            <FileTreePane
              onClose={() => setActivePanel(null)}
              localId={localId}
              pluginName={vm.summary?.name ?? localId}
              activeVersion={vm.summary?.activeVersion ?? null}
              files={files}
              activeFileId={activeFileId}
              peers={peers}
              canEdit={canEdit}
              ready={vm.synced}
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
          )}
        />
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
                generation={vm.generation}
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
            runtimeError={vm.summary?.state === 'runtime-error' ? vm.summary.lastError : null}
            validating={vm.validating}
            synced={vm.synced}
          />
        </div>
      )}
      toolbarRightSlot={(
        <>
          <IdeActions
            summary={vm.summary}
            peers={peers}
            canInstall={canInstall}
            canManageLifecycle={canManageLifecycle}
            activating={vm.activating}
            onActivate={() => {
              // Grant-changing activations are consent moments — show the
              // review (what will be granted/revoked) before building.
              const summary = vm.summary
              const grantsChange =
                summary !== null &&
                (summary.newPermissions.length > 0 || summary.removedPermissions.length > 0)
              if (grantsChange) setReviewOpen(true)
              else void vm.activate()
            }}
            onPreview={vm.openPreview}
            onRollback={() => void vm.rollback()}
            onSetEnabled={(enabled) => void vm.setEnabled(enabled)}
            onRestart={() => void vm.restart()}
            onRunDiagnostics={vm.runValidation}
            onOpenPluginsPage={() => navigate('/admin/plugins')}
            onDelete={() =>
              setPendingDelete({
                title: `Delete site plugin “${localId}”?`,
                description:
                  'Removes the runtime plugin, its generated revisions, settings and secrets, AND the source folder from the draft.',
                confirmLabel: 'Delete site plugin',
                commit: () => void vm.deletePlugin(),
              })
            }
          />
          {reviewOpen && vm.summary && (
            <SitePluginPermissionReviewDialog
              summary={vm.summary}
              busy={vm.activating}
              onClose={() => setReviewOpen(false)}
              onConfirm={() => {
                void vm.activate().finally(() => setReviewOpen(false))
              }}
            />
          )}
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
